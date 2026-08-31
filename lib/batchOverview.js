const { generateOverview } = require('./overview');
const { saveOverview } = require('./store');
const { logInfo, logError } = require('./logger');

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
 * Runs the bounded concurrency project worker pool.
 * 
 * @param {Array<Object>} projects Target projects list
 * @param {number} concurrency Bounded concurrency worker count
 */
async function runPool(projects, concurrency) {
  let index = 0;

  async function worker() {
    while (index < projects.length && !state.stopped) {
      const project = projects[index++];
      if (!project) continue;

      const id = project.id;
      state.inProgress.push(id);

      try {
        logInfo('batch-overview', `Starting AI overview for project: ${project.name} (${id})`);
        
        const result = await generateOverview(project);
        
        // Save the result to database/JSON store
        await saveOverview(id, result);

        if (result.ok) {
          state.done++;
          state.results.push({ id, name: project.name, ok: true });
          logInfo('batch-overview', `Successfully generated AI overview for project: ${project.name} (${id})`);
        } else {
          state.failed++;
          state.results.push({ id, name: project.name, ok: false });
          logError('batch-overview', `Failed to generate overview for project ${project.name}: ${result.overview}`);
        }
      } catch (err) {
        state.failed++;
        state.results.push({ id, name: project.name, ok: false });
        logError('batch-overview', `Unexpected error during overview for project ${project.name}: ${err.message}`);
      } finally {
        state.inProgress = state.inProgress.filter(x => x !== id);
      }
    }
  }

  // Spawn worker pool
  const workers = [];
  const limit = Math.min(concurrency, projects.length);
  for (let i = 0; i < limit; i++) {
    workers.push(worker());
  }

  // Process pool concurrently
  Promise.all(workers).then(() => {
    state.running = false;
    logInfo('batch-overview', `Batch overview completed. Total: ${state.total}, Done: ${state.done}, Failed: ${state.failed}, Stopped: ${state.stopped}`);
  }).catch(err => {
    state.running = false;
    logError('batch-overview', `Unexpected error in batch worker pool: ${err.message}`);
  });
}

/**
 * Starts background batch generation of AI overviews.
 * 
 * @param {Array<Object>} projects Target projects
 * @param {Object} opts Options containing concurrency config
 * @returns {Object} Start result status
 */
function startBatch(projects, opts = {}) {
  if (state.running) {
    return { started: false, reason: 'already running' };
  }

  // Check the budget for the WHOLE batch up front. The per-call gate alone
  // would let a 50-project batch start, die at item 9 when the cap is hit, and
  // report itself finished with 41 projects silently skipped.
  const doctorGuard = require('./doctorGuard');
  const budget = doctorGuard.getBudgetStatus();
  if (budget.remaining <= 0) {
    return {
      started: false,
      reason: `تجاوز السقف اليومي (${budget.spent}/${budget.limit}). حاول غداً أو ارفع doctorDailyBudget في config.json.`,
      budget
    };
  }
  if (projects.length > budget.remaining) {
    return {
      started: false,
      reason: `الدفعة تحتاج ${projects.length} استدعاء والمتبقي اليوم ${budget.remaining} فقط (${budget.spent}/${budget.limit}). قلّل العدد أو ارفع doctorDailyBudget في config.json.`,
      budget
    };
  }

  const concurrency = opts.concurrency || 4;

  // Initialize state
  state.running = true;
  state.total = projects.length;
  state.done = 0;
  state.failed = 0;
  state.inProgress = [];
  state.results = [];
  state.startedAt = new Date().toISOString();
  state.stopped = false;

  logInfo('batch-overview', `Kicked off batch overview generation for ${state.total} projects with concurrency of ${concurrency}.`);

  // Start processing pool asynchronously without blocking the caller route
  runPool(projects, concurrency);

  return { started: true, total: state.total };
}

/**
 * Gets a shallow copy of the current batch progress state.
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
 * Flags the current running batch process to halt.
 * 
 * @returns {Object} Stopped state acknowledgment
 */
function stopBatch() {
  state.stopped = true;
  logInfo('batch-overview', 'Received request to stop the batch overview generation.');
  return { stopped: true };
}

module.exports = {
  startBatch,
  getProgress,
  stopBatch
};
