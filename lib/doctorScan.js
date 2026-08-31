const { runVerifier } = require('./fixer');
const { saveDoctorHealth, getProjects } = require('./store');
const { logInfo, logError } = require('./logger');
const path = require('path');
const fs = require('fs');

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

// Scan progress lives only in memory, so every restart used to send the scan
// back to project zero — and the logs record 189 server boots. With ~60 targets
// the cycle is long enough that it kept being interrupted before finishing.
// This sidecar file lets a cycle survive a restart.
const CURSOR_PATH = path.join(__dirname, '..', 'scan-cursor.json');
// A cycle older than this is stale; start fresh rather than resuming into it.
const CYCLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Two consecutive inconclusive timeouts and we stop trying that project. Six
// consecutive scheduled scans died on the SAME project (web-client),
// so without a skip list, resuming just turns that into a permanent boot loop
// that never reaches the rest of the catalog.
const MAX_TIMEOUTS_BEFORE_SKIP = 2;

// This installation's own root, resolved once.
const SELF_PATH = path.resolve(__dirname, '..').toLowerCase();

function readCursor() {
  try {
    if (!fs.existsSync(CURSOR_PATH)) return { startedAt: null, scanned: [], timeouts: {}, skipped: [] };
    const parsed = JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf8'));
    return {
      startedAt: parsed.startedAt || null,
      scanned: Array.isArray(parsed.scanned) ? parsed.scanned : [],
      timeouts: parsed.timeouts && typeof parsed.timeouts === 'object' ? parsed.timeouts : {},
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : []
    };
  } catch (err) {
    logError('doctor-scan', `Unreadable scan cursor, starting fresh: ${err.message}`);
    return { startedAt: null, scanned: [], timeouts: {}, skipped: [] };
  }
}

function writeCursor(cursor) {
  try {
    fs.writeFileSync(CURSOR_PATH, JSON.stringify(cursor, null, 2), 'utf8');
  } catch (err) {
    logError('doctor-scan', `Failed to persist scan cursor: ${err.message}`);
  }
}

/**
 * Marks one project as finished in the persisted cursor, and tracks repeated
 * inconclusive timeouts so a project that always hangs is eventually skipped.
 *
 * @param {string} id Project id
 * @param {boolean} timedOut Whether this project produced an inconclusive timeout
 */
function recordScanned(id, timedOut) {
  const cursor = readCursor();
  if (!cursor.scanned.includes(id)) cursor.scanned.push(id);

  if (timedOut) {
    cursor.timeouts[id] = (cursor.timeouts[id] || 0) + 1;
    if (cursor.timeouts[id] >= MAX_TIMEOUTS_BEFORE_SKIP && !cursor.skipped.includes(id)) {
      cursor.skipped.push(id);
      logInfo('doctor-scan', `Project ${id} timed out ${cursor.timeouts[id]} times in a row — skipping it in future scans until reset.`);
    }
  } else {
    delete cursor.timeouts[id];
  }

  writeCursor(cursor);
}

/**
 * Clears the resume cursor once a full cycle finishes.
 * The skip list and timeout counters deliberately survive — they describe
 * projects, not this cycle.
 */
function completeCycle() {
  const cursor = readCursor();
  writeCursor({ startedAt: null, scanned: [], timeouts: cursor.timeouts, skipped: cursor.skipped });
}

/**
 * Runs the bounded concurrency project worker pool for doctor scan.
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
        logInfo('doctor-scan', `Starting doctor scan for project: ${project.name} (${id})`);
        
        const verifyRunPath = path.join(__dirname, '..', 'tools', 'verifyRun.js');
        const { code, output } = await runVerifier(verifyRunPath, id, project.path);

        // See tools/verifyRun.js for the exit-code contract. Anything that is
        // not a confirmed pass or a confirmed failure is 'unknown', and only a
        // confirmed failure may ever become an AI repair target.
        let doctorHealth;
        if (code === 0) doctorHealth = 'ok';
        else if (code === 1) doctorHealth = 'broken';
        else doctorHealth = 'unknown';

        const doctorLastScanAt = new Date().toISOString();
        const doctorLastOutput = (output || '').slice(-500);

        // Save immediately
        await saveDoctorHealth(id, { doctorHealth, doctorLastScanAt, doctorLastOutput });

        // Exit 3 with a timeout message is the case worth counting: the project
        // started and simply never told us anything.
        const timedOut = code === 3 && /Timed out/i.test(output || '');
        recordScanned(id, timedOut);

        if (doctorHealth === 'ok') {
          state.done++;
          state.results.push({ id, name: project.name, ok: true });
          logInfo('doctor-scan', `Successfully completed doctor scan for project: ${project.name} (${id}) -> ${doctorHealth}`);
        } else {
          state.failed++;
          state.results.push({ id, name: project.name, ok: false, health: doctorHealth });
          logInfo('doctor-scan', `Doctor scan for project ${project.name} (${id}) -> ${doctorHealth} (exit ${code})`);
        }
      } catch (err) {
        state.failed++;
        state.results.push({ id, name: project.name, ok: false });
        logError('doctor-scan', `Unexpected error during doctor scan for project ${project.name}: ${err.message}`);
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
    // Only a cycle that ran to the end clears the cursor; a stopped cycle keeps
    // it so the next start resumes instead of restarting.
    if (!state.stopped) completeCycle();
    logInfo('doctor-scan', `Doctor scan completed. Total: ${state.total}, Done: ${state.done}, Failed: ${state.failed}, Stopped: ${state.stopped}`);
  }).catch(err => {
    state.running = false;
    logError('doctor-scan', `Unexpected error in doctor worker pool: ${err.message}`);
  });
}

/**
 * Starts background doctor scan.
 * 
 * @param {Array<Object>} projects Target projects
 * @returns {Object} Start result status
 */
function startScan(projects) {
  if (state.running) {
    return { started: false, reason: 'already running' };
  }

  const concurrency = 2; // Maximum 2 concurrently running projects

  // Resume an interrupted cycle rather than starting over. Without this a
  // restart halfway through means the tail of the catalog is never reached —
  // the recorded scans averaged 15 of 101 projects before dying.
  const cursor = readCursor();
  const cycleAge = cursor.startedAt ? Date.now() - new Date(cursor.startedAt).getTime() : Infinity;
  const resuming = cursor.scanned.length > 0 && cycleAge < CYCLE_MAX_AGE_MS;

  let queue = projects;
  if (resuming) {
    const alreadyScanned = new Set(cursor.scanned);
    queue = projects.filter(p => !alreadyScanned.has(p.id));
    logInfo('doctor-scan', `Resuming interrupted scan: ${cursor.scanned.length} already done, ${queue.length} remaining.`);
  } else {
    writeCursor({ startedAt: new Date().toISOString(), scanned: [], timeouts: cursor.timeouts, skipped: cursor.skipped });
  }

  if (queue.length === 0) {
    completeCycle();
    logInfo('doctor-scan', 'Nothing left to scan in this cycle; cursor cleared.');
    state.running = false;
    return { started: false, reason: 'cycle already complete', total: 0 };
  }

  // Initialize state
  state.running = true;
  state.total = queue.length;
  state.done = 0;
  state.failed = 0;
  state.inProgress = [];
  state.results = [];
  state.startedAt = new Date().toISOString();
  state.stopped = false;

  logInfo('doctor-scan', `Kicked off doctor scan for ${state.total} projects with concurrency of ${concurrency}.`);

  // Start processing pool asynchronously
  runPool(queue, concurrency);

  return { started: true, total: state.total, resumed: resuming };
}

/**
 * Gets a shallow copy of the current scan progress state.
 * 
 * @returns {Object} Current state progress representation
 */
function getScanProgress() {
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
 * Flags the current running scan process to halt.
 * 
 * @returns {Object} Stopped state acknowledgment
 */
function stopScan() {
  state.stopped = true;
  logInfo('doctor-scan', 'Received request to stop the doctor scan.');
  return { stopped: true };
}

/**
 * Gets target projects list for scanning based on classification and exclusions.
 * 
 * @returns {Promise<Array<Object>>} Filtered target projects
 */
// Paths that are catalogued as projects but are not the user's own code:
// package-manager caches, tool scratch dirs, downloaded bundles, archived
// copies. A doctor scan LAUNCHES every target for real (tools/verifyRun.js
// spawns it with shell:true), and anything it marks 'broken' becomes a
// candidate for an AI agent to rewrite — so third-party code must never be a
// target. Override or extend via `doctorScanExcludePatterns` in config.json.
const DEFAULT_EXCLUDE_PATTERNS = [
  '[\\\\/]\\.[A-Za-z0-9_-]+[\\\\/]',          // .bun/ .codex/ .grok/ .openclaw/ ...
  '[\\\\/]Downloads[\\\\/]',
  '[\\\\/]AppData[\\\\/]',
  '[\\\\/]node_modules[\\\\/]',
  '[\\\\/][^\\\\/]*cache[^\\\\/]*[\\\\/]',
  '[\\\\/](_archive|backups?)[\\\\/]',
  '[\\\\/](\\.tmp|temp|tmp)[\\\\/]'
];

function loadExcludePatterns() {
  let sources = DEFAULT_EXCLUDE_PATTERNS;
  try {
    const configPath = path.join(__dirname, '..', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (Array.isArray(config.doctorScanExcludePatterns)) {
        sources = config.doctorScanExcludePatterns;
      }
    }
  } catch (err) {
    logError('doctor-scan', `Failed to read doctorScanExcludePatterns, using defaults: ${err.message}`);
  }
  const compiled = [];
  for (const src of sources) {
    try {
      compiled.push(new RegExp(src, 'i'));
    } catch (err) {
      logError('doctor-scan', `Ignoring invalid exclude pattern ${src}: ${err.message}`);
    }
  }
  return compiled;
}

async function getScanTargets() {
  const projects = await getProjects();
  const excludes = loadExcludePatterns();
  const cursor = readCursor();
  const permanentlySkipped = new Set(cursor.skipped);
  const skipped = { classification: 0, optedOut: 0, thirdParty: 0, gone: 0, hangs: 0, self: 0, quarantined: 0 };

  const targets = projects.filter(p => {
    // 0. quarantined by the user. This scan LAUNCHES what it checks, and it is
    // the only automated task that does, so the quarantine is checked before
    // every other rule — including the ones that would otherwise let a
    // watchdog through.
    if (require('../lib/quarantine').isQuarantined(p)) {
      skipped.quarantined++;
      return false;
    }
    // 1. classification equals confirmed or likely only
    if (p.classification !== 'confirmed' && p.classification !== 'likely') {
      skipped.classification++;
      return false;
    }
    // 2. exclude any project with project.excludeFromAutoFix === true
    if (p.excludeFromAutoFix === true) {
      skipped.optedOut++;
      return false;
    }
    // 3. never run or "fix" code the user did not write
    if (p.path && excludes.some(re => re.test(p.path))) {
      skipped.thirdParty++;
      return false;
    }
    // 4. a path that no longer exists would fail its verifier and be marked
    //    'broken' — a false positive that sends an agent after a dead folder
    if (p.path && !fs.existsSync(p.path)) {
      skipped.gone++;
      return false;
    }
    // 5. maktaba's own installation. Launching it means starting a second
    //    server on the port this one already holds, from inside the process
    //    doing the scanning. It catalogues itself like any other folder, so it
    //    has to be excluded explicitly.
    if (p.path && path.resolve(p.path).toLowerCase() === SELF_PATH) {
      skipped.self++;
      return false;
    }
    // 6. a project the last real scan could not find. Its stored verdict
    //    describes a folder that is no longer there, so re-running it would
    //    only reconfirm a fiction — and it can never be refreshed either,
    //    because step 4 keeps it out of every future scan. Excluding it here
    //    is what stops a frozen 'broken' showing up as a repair candidate.
    if (p.missing === true) {
      skipped.gone++;
      return false;
    }
    // 7. a project that hung through repeated scans: keep it out so one bad
    //    target cannot consume the cycle every time
    if (permanentlySkipped.has(p.id)) {
      skipped.hangs++;
      return false;
    }
    return true;
  });

  // Never truncate coverage silently: say what was dropped and why.
  logInfo(
    'doctor-scan',
    `Scan targets: ${targets.length} of ${projects.length} ` +
    `(skipped ${skipped.classification} unclassified, ${skipped.optedOut} opted out, ` +
    `${skipped.thirdParty} third-party/cache paths, ${skipped.gone} missing from disk, ${skipped.self} self, ` +
    `${skipped.hangs} repeatedly hanging)`
  );

  return targets;
}

/**
 * Reports which projects the scanner has given up on, and why.
 *
 * @returns {{skipped: Array<string>, timeouts: Object}}
 */
function getSkipList() {
  const cursor = readCursor();
  return { skipped: cursor.skipped, timeouts: cursor.timeouts };
}

/**
 * Clears the permanent skip list so hanging projects are attempted again —
 * the manual reset the skip decision promises.
 *
 * @returns {{cleared: number}}
 */
function resetSkipList() {
  const cursor = readCursor();
  const cleared = cursor.skipped.length;
  writeCursor({ startedAt: cursor.startedAt, scanned: cursor.scanned, timeouts: {}, skipped: [] });
  logInfo('doctor-scan', `Skip list cleared (${cleared} projects will be attempted again).`);
  return { cleared };
}

module.exports = {
  startScan,
  getScanProgress,
  stopScan,
  getScanTargets,
  getSkipList,
  resetSkipList
};
