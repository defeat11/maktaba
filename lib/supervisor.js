const fs = require('fs');
const path = require('path');
const { getProjects } = require('./store');
const runner = require('./runner');
const { logInfo, logError } = require('./logger');

// Internal meta map: id -> { restarts, lastError, lastStartedAt, backoffUntil, gaveUp }
const meta = {};
let supervisorInterval = null;

// A project that will not stay up is a problem to report, not a loop to run
// forever. Before this cap the supervisor logged 447 restart attempts for one
// project (peaking at #355) — 94% of every error the app ever recorded — and
// never once said it was failing; the user had to notice and switch autoStart
// off by hand.
const MAX_RESTARTS = 5;
// Restarts only count when they fail quickly. A project that ran fine for this
// long before dying is a fresh incident, not a continuing crash loop.
const STABLE_MS = 60000;

/**
 * Reads a boolean flag from config.json.
 *
 * @param {string} key Config key
 * @param {boolean} fallback Value when the key is absent or unreadable
 * @returns {boolean}
 */
function configFlag(key, fallback) {
  try {
    const configPath = path.join(__dirname, '..', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (typeof config[key] === 'boolean') return config[key];
    }
  } catch (err) {
    logError('supervisor-config', err);
  }
  return fallback;
}

/**
 * Starts all primary projects that have autoStart set to true.
 */
async function startAll() {
  try {
    const projects = await getProjects();
    const candidates = projects.filter(p => p.autoStart === true && p.isPrimary !== false);
    // A quarantined project is not started at logon either. The supervisor
    // retries on failure, so without this it would relaunch a blocked program
    // every fifteen seconds until it burned through MAX_RESTARTS.
    const { allowed: targets, blocked } = require('./quarantine').filterLaunchable(candidates);
    if (blocked.length) {
      logInfo('supervisor', `Skipping ${blocked.length} quarantined project(s) at startup.`);
    }

    logInfo('supervisor', `Supervisor starting all auto-start projects. Found: ${targets.length}`);

    for (const project of targets) {
      if (!meta[project.id]) {
        meta[project.id] = { restarts: 0, lastError: null, lastStartedAt: null, backoffUntil: 0 };
      }
      
      const m = meta[project.id];
      m.lastStartedAt = new Date();

      logInfo('supervisor', `Auto-starting project ${project.id} (${project.name})...`);
      try {
        await runner.start(project);
      } catch (err) {
        m.lastError = err.message;
        logError('supervisor-auto-start', err);
      }
    }

    // Initialize supervisor interval check if not already running
    if (!supervisorInterval) {
      supervisorInterval = setInterval(async () => {
        try {
          const latestProjects = await getProjects();
          const autoStartProjects = latestProjects.filter(p => p.autoStart === true && p.isPrimary !== false);

          for (const project of autoStartProjects) {
            const st = runner.status(project.id);
            const isAlive = st.status === 'running' || st.status === 'starting';

            if (isAlive) {
              // Only a genuinely stable run clears the crash counter. Clearing
              // it on any sighting (including the transient 'starting' state)
              // is what let the counter climb forever without ever tripping a
              // cap: every restart briefly looked healthy.
              const m = meta[project.id];
              if (m && st.startedAt && (Date.now() - new Date(st.startedAt).getTime()) >= STABLE_MS) {
                if (m.restarts > 0) {
                  logInfo('supervisor', `Project ${project.id} (${project.name}) has been stable for ${Math.round(STABLE_MS / 1000)}s — clearing restart counter (was ${m.restarts}).`);
                }
                m.restarts = 0;
                m.gaveUp = false;
              }
            } else {
              if (!meta[project.id]) {
                meta[project.id] = { restarts: 0, lastError: null, lastStartedAt: null, backoffUntil: 0, gaveUp: false };
              }

              const m = meta[project.id];

              // Already declared beyond automatic recovery: stay quiet until
              // the user intervenes. getLiveStatus surfaces gaveUp to the UI.
              if (m.gaveUp) continue;

              if (m.restarts >= MAX_RESTARTS) {
                m.gaveUp = true;
                logError(
                  'supervisor-gave-up',
                  new Error(`Project ${project.name} (${project.id}) failed to stay up after ${m.restarts} restarts. Giving up — needs manual attention. Last error: ${m.lastError || 'unknown'}`)
                );
                continue;
              }

              // The AI auto-fix path writes to the user's project folder with
              // no human in the loop, so it is off unless explicitly enabled,
              // and it honours the same opt-out flag the doctor pipeline does.
              // excludeFromAutoFix was previously ignored here entirely — the
              // user had an opt-out switch that this code path did not read.
              if (m.restarts >= 3 && !m.aiFixTried
                  && project.excludeFromAutoFix !== true
                  && configFlag('supervisorAutoFix', false)) {
                m.aiFixTried = true;
                logInfo('supervisor', `محاولة إصلاح ذكي تلقائي للمشروع ${project.name} (${project.id})...`);
                require('./fixer').fixProject(project, { trigger: 'supervisor' })
                  .then(fixResult => {
                    const summary = JSON.stringify(fixResult);
                    logInfo('supervisor', `نتيجة الإصلاح الذكي التلقائي للمشروع ${project.name}: ${summary.slice(0, 300)}`);
                  })
                  .catch(fixErr => {
                    logError('supervisor-auto-fix', fixErr);
                  });
              }

              const now = Date.now();

              if (now >= m.backoffUntil) {
                m.restarts++;
                m.lastStartedAt = new Date();
                // Exponential backoff up to 60 seconds (5s * restarts)
                const backoffMs = Math.min(60000, 5000 * m.restarts);
                m.backoffUntil = now + backoffMs;

                logInfo('supervisor', `Project ${project.id} (${project.name}) is not running. Attempting auto-restart #${m.restarts}. Backoff until: ${new Date(m.backoffUntil).toISOString()}`);
                
                runner.start(project).catch(err => {
                  m.lastError = err.message;
                  logError('supervisor-restart', err);
                });
              }
            }
          }
        } catch (intervalErr) {
          logError('supervisor-interval-error', intervalErr);
        }
      }, 15000);
    }
  } catch (err) {
    logError('supervisor-startAll-failed', err);
  }
}

/**
 * Retrieves live status of all auto-start projects.
 * 
 * @returns {Promise<Array<Object>>}
 */
async function getLiveStatus() {
  try {
    const projects = await getProjects();
    const autoStartProjects = projects.filter(p => p.autoStart === true && p.isPrimary !== false);

    return autoStartProjects.map(p => {
      const st = runner.status(p.id);
      const m = meta[p.id] || { restarts: 0, lastError: null, lastStartedAt: null, gaveUp: false };

      const isRunning = st.status === 'running' || st.status === 'starting';
      const uptimeMs = isRunning && st.startedAt ? (Date.now() - new Date(st.startedAt).getTime()) : 0;

      return {
        id: p.id,
        name: p.name,
        path: p.path,
        status: st.status,
        port: st.port,
        restarts: m.restarts,
        lastError: m.lastError,
        uptimeMs,
        // The supervisor has stopped trying to restart this one; the UI should
        // say so rather than showing an endlessly "restarting" project.
        gaveUp: !!m.gaveUp,
        maxRestarts: MAX_RESTARTS
      };
    });
  } catch (err) {
    logError('supervisor-getLiveStatus-failed', err);
    return [];
  }
}

/**
 * Returns restart count for a project.
 * 
 * @param {string} id Project ID
 * @returns {number}
 */
function restartCount(id) {
  return (meta[id] && meta[id].restarts) || 0;
}

module.exports = {
  startAll,
  getLiveStatus,
  restartCount
};
