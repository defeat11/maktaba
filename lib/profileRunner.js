// Profiles the whole catalogue, in the same shape as the other batch jobs in
// lib/ so it can be started from a route and watched from the UI.
//
// Unlike batchOverview this costs no agent budget: everything it records is
// measured off the disk, so it is safe to run across every project as often as
// wanted.

const { profileProject } = require('./profiler');
const { getProjects, saveProfile } = require('./store');
const { logInfo, logError } = require('./logger');
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

/**
 * Profiles projects with bounded concurrency. Higher than the doctor scan's
 * because nothing is launched here — this only reads files.
 *
 * @param {Array<Object>} projects Projects to profile
 * @param {number} concurrency How many to read at once
 */
async function runPool(projects, concurrency) {
  let index = 0;

  async function worker() {
    while (index < projects.length && !state.stopped) {
      const project = projects[index++];
      if (!project) continue;
      state.inProgress.push(project.id);
      try {
        const profile = profileProject(project);
        if (profile) {
          await saveProfile(project.id, profile);
          state.done++;
          state.results.push({ id: project.id, name: project.name, ok: true, runtime: profile.runtime });
        } else {
          state.failed++;
          state.results.push({ id: project.id, name: project.name, ok: false, reason: 'unreadable' });
        }
      } catch (err) {
        state.failed++;
        state.results.push({ id: project.id, name: project.name, ok: false, reason: err.message });
        logError('profile-runner', err);
      } finally {
        state.inProgress = state.inProgress.filter(x => x !== project.id);
      }
    }
  }

  const workers = [];
  const limit = Math.min(concurrency, projects.length);
  for (let i = 0; i < limit; i++) workers.push(worker());

  Promise.all(workers).then(() => {
    state.running = false;
    logInfo('profile-runner', `Profiling complete. Total: ${state.total}, done: ${state.done}, failed: ${state.failed}.`);
  }).catch(err => {
    state.running = false;
    logError('profile-runner', err);
  });
}

/**
 * Starts profiling every catalogued project that still exists on disk.
 *
 * @param {Object} [opts] Options: { onlyStale: true } to skip fresh profiles
 * @returns {Object} Start result
 */
async function startProfiling(opts = {}) {
  if (state.running) return { started: false, reason: 'already running' };

  const all = await getProjects();
  let targets = all.filter(p => p.path && fs.existsSync(p.path));

  if (opts.onlyStale) {
    const cutoff = Date.now() - (opts.maxAgeHours || 24) * 3600000;
    targets = targets.filter(p => {
      if (!p.profile) return true;
      try {
        const prof = typeof p.profile === 'string' ? JSON.parse(p.profile) : p.profile;
        return !prof.profiledAt || new Date(prof.profiledAt).getTime() < cutoff;
      } catch (err) {
        return true;
      }
    });
  }

  if (targets.length === 0) return { started: false, reason: 'nothing to profile', total: 0 };

  state.running = true;
  state.total = targets.length;
  state.done = 0;
  state.failed = 0;
  state.inProgress = [];
  state.results = [];
  state.startedAt = new Date().toISOString();
  state.stopped = false;

  logInfo('profile-runner', `Profiling ${targets.length} projects.`);
  runPool(targets, opts.concurrency || 6);

  return { started: true, total: state.total };
}

function getProfilingProgress() {
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

function stopProfiling() {
  state.stopped = true;
  state.running = false;
  return { stopped: true };
}

module.exports = { startProfiling, getProfilingProgress, stopProfiling };
