const store = require('./store');
const { logInfo, logError } = require('./logger');
const doctorGuard = require('./doctorGuard');
const deepDoctor = require('./deepDoctor');

const state = {
  running: false,
  total: 0,
  done: 0,
  failed: 0,
  inProgress: [],
  results: [],
  startedAt: null,
  stopped: false
};

/**
 * Runs the doctor fix queue sequentially (concurrency = 1).
 * 
 * @param {Array<Object>} projects Target projects list
 */
async function runQueueLoop(projects) {
  // A quarantined project is dropped before the queue starts. The fix queue
  // hands an AI agent write access and then launches the result to verify it,
  // so it is a launch path like any other.
  const gate = require('./quarantine').filterLaunchable(projects);
  if (gate.blocked.length) {
    logInfo('doctor-queue', `Skipping ${gate.blocked.length} quarantined project(s).`);
  }
  projects = gate.allowed;

  // 1. Before first element: run backup and store the initial projects length reference count
  try {
    doctorGuard.backupDbBeforeCycle();
  } catch (backupErr) {
    logError('doctor-queue', `Failed to run backup before cycle: ${backupErr.message}`);
  }

  let refCount = 0;
  try {
    const allProj = await store.getProjects();
    refCount = allProj.length;
  } catch (err) {
    logError('doctor-queue', `Failed to read reference count of projects: ${err.message}`);
  }

  for (let i = 0; i < projects.length; i++) {
    if (state.stopped) {
      logInfo('doctor-queue', 'Doctor queue execution was stopped by user request.');
      break;
    }

    const project = projects[i];
    const id = project.id;
    state.inProgress.push(id);

    // 2. check doctorGuard budget — a cheap pre-check so we do not start a
    // project we cannot finish. The spend itself is now recorded at the actual
    // agent-invocation chokepoints (fixer.runDelegate, aiOnboard, overview);
    // recording it here as well would charge the budget twice per project,
    // once for the queue and again for each real call it makes.
    if (!doctorGuard.canSpendBudget()) {
      logInfo('doctor-queue', 'تجاوز السقف اليومي');
      state.inProgress = state.inProgress.filter(x => x !== id);
      break;
    }

    logInfo('doctor-queue', `Starting doctor fix for project: ${project.name} (${id})`);

    let report;
    try {
      report = await deepDoctor.runDeep(project);
    } catch (err) {
      report = {
        ok: false,
        runVerified: false,
        error: err.message || 'Unknown error'
      };
    }

    // 3. Process result
    let newAttempts = (project.doctorFixAttempts || 0);
    let newHealth = project.doctorHealth;
    let newNeedsReview = !!project.doctorNeedsReview;
    let lastFixAt = null;
    let lastFixSummary = null;

    if (report && report.ok && report.runVerified) {
      newHealth = 'ok';
      newAttempts = 0;
      state.done++;
      state.results.push({ id, name: project.name, ok: true });
      logInfo('doctor-queue', `Successfully fixed and verified project: ${project.name} (${id})`);
    } else {
      newAttempts += 1;
      lastFixAt = new Date().toISOString();
      const rawSummary = (report && (report.fixSummary || report.error)) || 'خطأ غير معروف أثناء التشغيل.';
      lastFixSummary = String(rawSummary).substring(0, 500);
      // deepDoctor sets needsReview when every proposed fix was tagged unsafe
      // for automatic application. Retrying that project would just spend
      // budget to reach the same conclusion — escalate to the user now.
      if (newAttempts >= 2 || (report && report.needsReview === true)) {
        newNeedsReview = true;
      }
      state.failed++;
      state.results.push({ id, name: project.name, ok: false });
      logError('doctor-queue', `Failed to fix/verify project ${project.name}: ${lastFixSummary}`);
    }

    // Save status to database
    try {
      await store.saveDoctorFixStatus(id, {
        doctorHealth: newHealth,
        doctorFixAttempts: newAttempts,
        doctorLastFixAt: lastFixAt,
        doctorLastFixSummary: lastFixSummary,
        doctorNeedsReview: newNeedsReview
      });
    } catch (saveErr) {
      logError('doctor-queue', `Failed to save doctor fix status for project ${project.name}: ${saveErr.message}`);
    }

    state.inProgress = state.inProgress.filter(x => x !== id);

    // 4. check safety count
    try {
      const safetyResult = await doctorGuard.checkRowCountSafe(refCount);
      if (safetyResult && safetyResult.safe === false) {
        const errorMsg = `Critical row count safety violation! Before: ${safetyResult.before}, After: ${safetyResult.after}. Stopping queue.`;
        logError('doctor-queue', errorMsg);
        break;
      }
    } catch (safetyErr) {
      logError('doctor-queue', `Error during row count safety check: ${safetyErr.message}`);
    }
  }

  state.running = false;
  logInfo('doctor-queue', `Doctor queue completed. Total: ${state.total}, Done: ${state.done}, Failed: ${state.failed}, Stopped: ${state.stopped}`);
}

/**
 * Starts background sequentially processed doctor fix queue.
 * 
 * @returns {Object} Start status result
 */
function startQueue() {
  if (state.running) {
    return { started: false, reason: 'already running' };
  }

  state.running = true;
  state.total = 0;
  state.done = 0;
  state.failed = 0;
  state.inProgress = [];
  state.results = [];
  state.startedAt = new Date().toISOString();
  state.stopped = false;

  // Start processing pool asynchronously without blocking the caller route
  (async () => {
    try {
      const allProjects = await store.getProjects();
      const targets = allProjects.filter(p => {
        // Strictly 'broken' — never 'unknown'. An unknown result means the
        // check could not reach a verdict (timeout, spawn failure, unsupported
        // launch plan); sending an agent to rewrite working code on the
        // strength of a failed measurement is the worst thing this pipeline
        // could do. Also skip rows the last scan could not find on disk.
        return p.doctorHealth === 'broken' &&
               p.excludeFromAutoFix !== true &&
               p.missing !== true &&
               (p.doctorFixAttempts || 0) < 2;
      });

      state.total = targets.length;
      if (targets.length === 0) {
        state.running = false;
        logInfo('doctor-queue', 'No broken projects found matching auto-fix criteria. Doctor queue finished immediately.');
        return;
      }

      logInfo('doctor-queue', `Kicked off doctor fix queue for ${targets.length} projects.`);
      await runQueueLoop(targets);
    } catch (err) {
      state.running = false;
      logError('doctor-queue', `Error in doctor queue loop: ${err.message}`);
    }
  })();

  return { started: true, total: state.total };
}

/**
 * Gets a shallow copy of the current queue progress state.
 * 
 * @returns {Object} Current state progress representation
 */
function getProgress() {
  return {
    running: state.running,
    total: state.total,
    done: state.done,
    failed: state.failed,
    inProgress: [...state.inProgress],
    results: state.results.slice(-50),
    startedAt: state.startedAt,
    stopped: state.stopped
  };
}

/**
 * Flags the current running queue process to halt.
 * 
 * @returns {Object} Stopped state acknowledgment
 */
function stopQueue() {
  state.stopped = true;
  logInfo('doctor-queue', 'Received request to stop the doctor fix queue.');
  return { stopped: true };
}

module.exports = {
  startQueue,
  getProgress,
  stopQueue
};
