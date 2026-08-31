const express = require('express');
const fs = require('fs');
const path = require('path');
const net = require('net');

const logger = require('./lib/logger');
const { logError, logInfo } = logger;
const { getProjects, saveProjects, saveOverview, setUserClassification, saveAiProfile, setExcludeFromAutoFix } = require('./lib/store');
const { scanProjects } = require('./lib/scanner');
const { extractMetadata } = require('./lib/metadata');
const { findDuplicates } = require('./lib/duplicates');
const { generateOverview } = require('./lib/overview');
const { classifyProject } = require('./lib/classifier');
const { groupBackups } = require('./lib/backups');
const { runFullScan } = require('./lib/scanPipeline');
const runner = require('./lib/runner');
const screenshot = require('./lib/screenshot');
const winshot = require('./lib/winshot');
const batchOverview = require('./lib/batchOverview');
const fixer = require('./lib/fixer');
const doctorScan = require('./lib/doctorScan');
const doctorQueue = require('./lib/doctorQueue');

// Register process exception logging handlers
process.on('uncaughtException', (err) => {
  logError('system-uncaught', err);
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  logError('system-unhandled', reason instanceof Error ? reason : new Error(String(reason)));
  console.error('Unhandled Rejection:', reason);
});

const app = express();
const PORT = process.env.PORT || 4500;

// The default 100 KB ceiling is too low for the gateway: a conversation of
// twenty messages at the 24,000-character cap each is roughly half a megabyte,
// so a legitimate request would be rejected by the body parser before any of
// our code saw it. This server is loopback-only and the gateway is token-gated,
// so the larger ceiling costs nothing.
app.use(express.json({ limit: '2mb' }));

// Reject requests whose Host header is not a loopback name.
//
// This server has no authentication and can spawn processes and run shell
// commands, so it must only ever answer the machine it runs on. Binding to
// 127.0.0.1 (see app.listen below) stops other machines from connecting, but
// it does NOT stop DNS rebinding: a page the user visits can point a hostname
// it controls at 127.0.0.1 and then reach this server as same-origin. The
// browser sends its own hostname in Host, and that is the part rebinding
// cannot forge — so checking Host closes the hole that binding alone leaves.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
app.use((req, res, next) => {
  const host = req.headers.host;
  if (!host) return res.status(400).json({ error: 'Missing Host header' });
  // strip the port: "127.0.0.1:4500" -> "127.0.0.1", "[::1]:4500" -> "[::1]"
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0];
  if (!LOOPBACK_HOSTS.has(hostname.toLowerCase())) {
    logError('security-host', new Error(`Rejected request with non-loopback Host: ${host}`), {
      method: req.method,
      path: req.originalUrl
    });
    return res.status(403).json({ error: 'Forbidden: this server only serves localhost.' });
  }
  next();
});

// Ensure public and shots directories exist
const publicDir = path.join(__dirname, 'public');
const shotsDir = path.join(__dirname, 'public/shots');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}
if (!fs.existsSync(shotsDir)) {
  fs.mkdirSync(shotsDir, { recursive: true });
}

// Serve static files from public/ and public/shots
app.use(express.static(publicDir));
app.use('/shots', express.static(shotsDir));

// Root route
app.get('/', (req, res) => {
  res.json({ ok: true });
});

// GET /api/health -> ultra-cheap liveness probe for the guardian watchdog.
// Deliberately touches neither the database nor the filesystem. The guardian
// used to probe /api/projects, which does one fs.existsSync per project (101
// sync calls) and got slow enough during a doctor scan to trip the 8s timeout —
// so the watchdog killed the server mid-scan, every scan. Keep this handler
// free of I/O.
app.get('/api/health', (req, res) => {
  let scan = { running: false, ageMs: 0 };
  try {
    const progress = doctorScan.getScanProgress();
    if (progress && progress.running) {
      scan = {
        running: true,
        ageMs: progress.startedAt ? Date.now() - new Date(progress.startedAt).getTime() : 0
      };
    }
  } catch (err) {
    // A probe must never fail; an unreadable scan state is not a health problem.
  }
  res.json({
    ok: true,
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    scan
  });
});

// GET /api/projects -> get projects from store
app.get('/api/projects', async (req, res) => {
  try {
    let projects = await getProjects();
    if (req.query.primariesOnly === '1') {
      projects = projects.filter(p => p.isPrimary !== false);
    }
    const projectsWithShot = projects.map(p => ({
      ...p,
      hasShot: fs.existsSync(path.join(shotsDir, `${p.id}.png`))
    }));
    res.json(projectsWithShot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/export.csv -> export projects as CSV file
app.get('/api/projects/export.csv', async (req, res) => {
  try {
    let projects = await getProjects();
    if (req.query.primariesOnly === '1') {
      projects = projects.filter(p => p.isPrimary !== false);
    }

    const headers = ['name', 'path', 'type', 'status', 'port', 'classification'];

    const escapeCSVValue = (val) => {
      if (val === null || val === undefined) return '';
      let str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        str = '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const rows = projects.map(p => {
      const status = (runner.status(p.id) && runner.status(p.id).status) || 'stopped';
      const port = p.assignedPort !== null && p.assignedPort !== undefined ? p.assignedPort : (p.port || '');
      const classification = p.userClassification || p.classification || '';

      return [
        p.name || '',
        p.path || '',
        p.type || '',
        status,
        port,
        classification
      ];
    });

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(escapeCSVValue).join(','))
    ].join('\r\n');

    // UTF-8 BOM
    const bom = '\ufeff';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="maktaba-projects.csv"');
    
    res.send(Buffer.from(bom + csvContent, 'utf-8'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/processes/badge -> get count of new processes
app.get('/api/processes/badge', async (req, res) => {
  try {
    const psscan = require('./lib/psscan');
    const { newCount } = await psscan.getNewProcessCount();
    res.json({ newCount });
  } catch (err) {
    logError('server-processes-badge', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/processes -> scan processes and return JSON (saves snapshot as a side-effect)
app.get('/api/processes', async (req, res) => {
  try {
    const psscan = require('./lib/psscan');
    const processes = await psscan.scanProcesses();
    const identityKeys = processes.map(p => p.identityKey);
    psscan.saveProcessSnapshot(identityKeys);
    res.json(processes);
  } catch (err) {
    logError('server-processes', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/processes/coverage -> how much of the machine the scan can see
//
// One ratio, deliberately, and no list of the rest. "I can see 74 of 626" is
// worth knowing about yourself; a browsable table of the other 552 would make
// this a task manager.
app.get('/api/processes/coverage', (req, res) => {
  try {
    res.json(require('./lib/psscan').getCoverage());
  } catch (err) {
    logError('server-processes', err);
    res.status(500).json({ error: err.message });
  }
});

// (A second app.get('/api/processes/badge') used to sit here. Express dispatches
// to the first registration, so it had never run since it was added. Removed
// rather than kept as a twin: two identical-looking handlers where only one
// executes is a trap for whoever edits the wrong one.)


// POST /api/scan -> run full scan over roots and save
app.post('/api/scan', async (req, res) => {
  try {
    const configPath = path.join(__dirname, 'config.json');
    let currentConfig = { roots: ['C:\\projects'], maxDepth: 4, skipDirs: [] };
    if (fs.existsSync(configPath)) {
      try {
        currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (err) {
        console.error('Failed to parse config.json, using fallback config:', err.message);
      }
    }

    const result = await runFullScan(currentConfig);
    res.json({ count: result.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Probe a port with net connection
function probePort(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let hasResolved = false;

    const cleanup = () => {
      socket.destroy();
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      if (!hasResolved) {
        hasResolved = true;
        cleanup();
        resolve(true);
      }
    });

    const handleError = () => {
      if (!hasResolved) {
        hasResolved = true;
        cleanup();
        resolve(false);
      }
    };

    socket.on('error', handleError);
    socket.on('timeout', handleError);

    // Actually initiate the connection (this was missing -> probe always timed out).
    socket.connect(port, '127.0.0.1');
  });
}

// POST /api/projects/:id/run -> start project, wait for port, capture screenshot
app.post('/api/projects/:id/run', async (req, res) => {
  try {
    const id = req.params.id;
    const projects = await getProjects();
    let project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // AI Onboarding on first run
    if (!project.aiProfile && !project.runCommand) {
      try {
        const r = await require('./lib/aiOnboard').analyzeProject(project);
        if (r.ok) {
          const profile = r.profile;
          const updates = {
            aiProfile: profile,
            aiAnalyzedAt: r.analyzedAt
          };

          if (profile.runCommand && project.userRunCommandSet !== true) {
            updates.runCommand = profile.runCommand;
            updates.userRunCommandSet = false;
          }

          if (typeof profile.port === 'number' && Number.isInteger(profile.port) && !project.userPortSet) {
            updates.assignedPort = profile.port;
          }

          await saveAiProfile(id, updates);

          // Re-fetch project to use the new settings in run
          const refreshedProjects = await getProjects();
          project = refreshedProjects.find(p => p.id === id);
        }
      } catch (e) {
        logError('server-run-onboard-error', e);
      }
    }

    // 1. Start project process and wait for port (could resolve to a number or null)
    const runningPort = await runner.start(project);

    // 2. Determine capture method and take screenshot
    let method = 'desktop';
    const shotPath = path.join(shotsDir, `${id}.png`);

    if (runningPort) {
      logInfo('server-run', `Project ${id} started on port ${runningPort}. Probing port...`);
      
      let isReachable = false;
      const launchPlan = require('./lib/launcher').planLaunch(project);
      const isScriptOrCustomOrMulti = launchPlan && (launchPlan.kind === 'script' || launchPlan.kind === 'custom' || launchPlan.kind === 'multi');

      if (isScriptOrCustomOrMulti) {
        logInfo('server-run', `Project kind is ${launchPlan.kind}. Initiating up to 6 probes...`);
        for (let attempt = 1; attempt <= 6; attempt++) {
          isReachable = await probePort(runningPort, 1500);
          logInfo('server-run', `Probe attempt ${attempt}/6 result: ${isReachable}`);
          if (isReachable) {
            break;
          }
          if (attempt < 6) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }
      } else {
        isReachable = await probePort(runningPort, 2500);
      }

      if (isReachable) {
        logInfo('server-run', `Port ${runningPort} is reachable. Capturing web screenshot...`);
        try {
          await screenshot.capture(`http://127.0.0.1:${runningPort}`, shotPath);
          method = 'web';
        } catch (shotErr) {
          logError('server-run-shot', new Error(`Failed web screenshot capture: ${shotErr.message}`));
          method = 'desktop';
        }
      } else {
        logInfo('server-run', `Port ${runningPort} is not reachable. Falling back to desktop capture...`);
        method = 'desktop';
      }
    } else {
      logInfo('server-run', `Project ${id} has no port (non-web). Using desktop capture...`);
      method = 'desktop';
    }

    // 3. Desktop capture fallback
    if (method === 'desktop') {
      logInfo('server-run', `Waiting 4 seconds for window display before desktop capture...`);
      await new Promise(resolve => setTimeout(resolve, 4000));
      try {
        await winshot.captureDesktop(shotPath);
      } catch (winshotErr) {
        logError('server-run-winshot', winshotErr);
      }
    }

    const projectStatus = runner.status(id);

    // Stopping IS the true reverse here, and only here: Maktaba started this
    // process, so ending it returns the machine to where it was. The same
    // command aimed at a process Maktaba did not start would not be an undo.
    require('./lib/actionLog').record({
      action: 'run',
      projectId: id,
      projectName: project.name,
      before: 'stopped',
      after: projectStatus.status,
      undo: projectStatus.status === 'running' ? { type: 'stop-project' } : null,
      undoReason: projectStatus.status === 'running' ? null : 'المشروع لم يبقَ قيد التشغيل.'
    });

    res.json({
      port: runningPort,
      status: projectStatus.status,
      shot: `/shots/${id}.png?t=${Date.now()}`,
      method: method
    });
  } catch (err) {
    // A quarantine is a decision, not a failure. Reporting it as a 500 would
    // send the reader looking for a broken project instead of at a switch they
    // themselves set.
    if (err.code === 'QUARANTINED') {
      return res.status(409).json({ error: err.message, quarantined: true, since: err.since || null });
    }
    logError('server-run', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/stop -> stop project
app.post('/api/projects/:id/stop', async (req, res) => {
  try {
    const id = req.params.id;
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);

    runner.stop(id);
    const projectStatus = runner.status(id);

    // No undo payload, on purpose. Starting a program again is a new action,
    // not the reversal of a stop: the process is gone, its state with it, and
    // presenting a fresh launch as "undo" would promise something this cannot
    // deliver.
    require('./lib/actionLog').record({
      action: 'stop',
      projectId: id,
      projectName: project ? project.name : null,
      before: 'running',
      after: projectStatus.status,
      undo: null,
      undoReason: 'إعادة التشغيل ليست تراجعاً — العملية انتهت، وتشغيلها من جديد إجراء آخر.'
    });

    res.json({ status: projectStatus.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/open -> open the project folder (or its entry file) in Windows Explorer
app.post('/api/projects/:id/open', async (req, res) => {
  try {
    const id = req.params.id;
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project || !project.path) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Resolve target: 'folder' (default) opens the directory; 'file' opens the entry file if present.
    const wantFile = req.body && req.body.target === 'file' && project.entryFile;
    let target = project.path;
    if (wantFile) {
      const candidate = path.join(project.path, project.entryFile);
      if (fs.existsSync(candidate)) target = candidate;
    }

    // Only ever open a path that belongs to a known project (no arbitrary input).
    if (process.platform === 'win32') {
      // NOTE: do NOT pass windowsHide:true here — it sets SW_HIDE in the
      // STARTUPINFO, which explorer.exe applies to the folder window, opening it
      // hidden. explorer.exe also returns exit code 1 even on success, so we
      // don't treat that as an error.
      const { spawn } = require('child_process');
      // Capture each child and attach an 'error' listener: a failed spawn emits an
      // async 'error' event that would otherwise become an uncaughtException.
      let opener;
      if (wantFile) {
        // Highlight (select) the file inside its folder rather than trying to execute it.
        opener = spawn('explorer.exe', ['/select,' + target], { detached: true });
      } else {
        opener = spawn('explorer.exe', [target], { detached: true });
      }
      opener.on('error', (e) => logError('open', e));
      opener.unref();
    } else {
      const openerCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const opener = require('child_process').spawn(openerCmd, [target], { detached: true });
      opener.on('error', (e) => logError('open', e));
      opener.unref();
    }
    logInfo('open', `Opened in OS file manager: ${target}`);
    res.json({ ok: true, opened: target });
  } catch (err) {
    logError('open', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/open-editor -> open the project folder in VS Code editor
app.post('/api/projects/:id/open-editor', async (req, res) => {
  try {
    const id = req.params.id;
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project || !project.path) {
      return res.status(404).json({ error: 'المشروع غير موجود.' });
    }

    const { spawn } = require('child_process');
    await new Promise((resolve, reject) => {
      const child = spawn('code', [project.path], {
        shell: true,
        detached: true
      });
      let resolved = false;
      child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
      child.on('spawn', () => {
        if (!resolved) {
          resolved = true;
          child.unref();
          resolve();
        }
      });
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.unref();
          resolve();
        }
      }, 500);
    });

    logInfo('open-editor', `Opened project ${id} in VS Code: ${project.path}`);
    res.json({ ok: true });
  } catch (err) {
    logError('open-editor', err);
    res.status(500).json({ error: 'تعذّر فتح VS Code — تأكد أنه مثبّت وأمر code متاح' });
  }
});

// GET /api/projects/:id/logs -> return logs ring buffer
app.get('/api/projects/:id/logs', (req, res) => {
  const id = req.params.id;
  const logs = runner.getLogs(id);
  res.json({ logs });
});

// GET /api/projects/:id/status -> return running status + port
app.get('/api/projects/:id/status', (req, res) => {
  const id = req.params.id;
  const projectStatus = runner.status(id);
  res.json(projectStatus);
});

// POST /api/projects/:id/overview -> generate and save AI overview
app.post('/api/projects/:id/overview', async (req, res) => {
  try {
    const id = req.params.id;
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const overviewObj = await generateOverview(project);
    await saveOverview(id, overviewObj);
    res.json(overviewObj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/overviews/generate-all -> start batch overview generation
app.post('/api/overviews/generate-all', async (req, res) => {
  try {
    const scope = (req.body && req.body.scope) || 'primaries';
    const onlyMissing = req.body && req.body.onlyMissing !== undefined ? req.body.onlyMissing : true;
    
    const projects = await getProjects();
    const targets = projects.filter(p => {
      // 1. exclude backups (isPrimary === false)
      if (p.isPrimary === false) return false;
      // 2. exclude classification 'not-project'
      if (p.classification === 'not-project') return false;
      // 3. if scope==='primaries' keep classification 'confirmed' OR 'likely'
      if (scope === 'primaries') {
        if (p.classification !== 'confirmed' && p.classification !== 'likely') {
          return false;
        }
      }
      // 4. if onlyMissing (default true) skip projects that already have a non-empty overview
      if (onlyMissing && p.overview && p.overview.trim().length > 0) {
        return false;
      }
      return true;
    });

    logInfo('server-batch', `Request to generate AI overviews for ${targets.length} projects under scope "${scope}".`);
    const result = batchOverview.startBatch(targets, { concurrency: 4, onlyMissing });
    
    res.json({
      started: result.started,
      total: result.total,
      scope: scope
    });
  } catch (err) {
    logError('server-batch-start', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/overviews/progress -> get current batch progress status
app.get('/api/overviews/progress', (req, res) => {
  try {
    res.json(batchOverview.getProgress());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/overviews/stop -> halt overview generation batch
app.post('/api/overviews/stop', (req, res) => {
  try {
    res.json(batchOverview.stopBatch());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/doctor/scan -> start batch doctor scan
app.post('/api/doctor/scan', async (req, res) => {
  try {
    // A doctor scan launches every catalogued project for real. The test suite
    // calls this route only to check it answers 200, so it must stop here —
    // the same guard /api/doctor/fix-queue/start already has.
    if (process.env.MAKTABA_TEST === '1') {
      return res.json({ started: true, total: 0 });
    }
    const targets = await doctorScan.getScanTargets();

    logInfo('server-doctor', `Request to start doctor scan for ${targets.length} projects.`);
    const result = doctorScan.startScan(targets);
    
    res.json({
      started: result.started,
      total: result.total
    });
  } catch (err) {
    logError('server-doctor-start', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/doctor/alert -> check if doctor scan has broken or needs-review projects
app.get('/api/doctor/alert', async (req, res) => {
  try {
    const projects = await getProjects();
    const targets = projects.filter(p => {
      if (p.classification !== 'confirmed' && p.classification !== 'likely') {
        return false;
      }
      if (p.excludeFromAutoFix === true) {
        return false;
      }
      return true;
    });

    const brokenCount = targets.filter(p => p.doctorHealth === 'broken').length;
    const reviewCount = targets.filter(p => p.doctorNeedsReview === true).length;

    res.json({
      show: (brokenCount + reviewCount) > 0,
      brokenCount,
      reviewCount
    });
  } catch (err) {
    logError('server-doctor-alert', err);
    res.status(500).json({ error: err.message });
  }
});


// Which projects have an AI operation running right now, so a duplicate
// request is refused rather than launching a second agent against the same
// folder. The frontend guards too, but a guard that lives only in the browser
// is not a guard: a re-render, a second tab or a stale page defeats it, and the
// cost here is a real agent run writing to the user's files.
const aiOpsInFlight = new Map();

/**
 * Runs an AI operation for a project unless one is already in flight.
 *
 * @param {string} id Project id
 * @param {string} label Operation name, reported on conflict
 * @param {Function} work Async function performing the operation
 * @returns {Promise<{busy: boolean, since?: string, label?: string, result?: any}>}
 */
async function withAiLock(id, label, work) {
  const existing = aiOpsInFlight.get(id);
  if (existing) {
    return { busy: true, label: existing.label, since: existing.startedAt };
  }
  aiOpsInFlight.set(id, { label, startedAt: new Date().toISOString() });
  try {
    return { busy: false, result: await work() };
  } finally {
    aiOpsInFlight.delete(id);
  }
}

// ─── Program registry ──────────────────────────────────────────────────────
// Maktaba as the place that knows every program on this machine: what each one
// is, and what can start itself without being asked.

// POST /api/profile/run -> profile every catalogued project (no agent budget)
app.post('/api/profile/run', async (req, res) => {
  try {
    const runner = require('./lib/profileRunner');
    const onlyStale = req.body && req.body.onlyStale === true;
    res.json(await runner.startProfiling({ onlyStale }));
  } catch (err) {
    logError('server-profile-start', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/profile/progress -> how the profiling run is going
app.get('/api/profile/progress', (req, res) => {
  try {
    res.json(require('./lib/profileRunner').getProfilingProgress());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:id/profile -> the measured detail sheet for one program
app.get('/api/projects/:id/profile', async (req, res) => {
  try {
    const project = (await getProjects()).find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'المشروع غير موجود.' });
    let profile = null;
    if (project.profile) {
      try {
        profile = typeof project.profile === 'string' ? JSON.parse(project.profile) : project.profile;
      } catch (e) { /* a corrupt profile is reported as absent, not as an error */ }
    }
    res.json({ id: project.id, name: project.name, path: project.path, profile });
  } catch (err) {
    logError('server-profile-get', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── OpenRouter free-model playground ──────────────────────────────────────
// The key lives only on this machine and is never sent to the browser: the page
// learns whether one is configured, never what it is.

// GET /api/openrouter/status -> is a key configured (a boolean, never the key)
app.get('/api/openrouter/status', (req, res) => {
  try {
    res.json({ configured: require('./lib/openrouter').hasKey() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/openrouter/key -> store the key, or clear it with { clear: true }
app.post('/api/openrouter/key', (req, res) => {
  try {
    const or = require('./lib/openrouter');
    if (req.body && req.body.clear === true) return res.json(or.clearKey());
    const result = or.saveKey(req.body && req.body.key);
    // The key is never echoed back, not even on success.
    res.status(result.ok ? 200 : 400).json({ ok: result.ok, error: result.error || null });
  } catch (err) {
    logError('server-openrouter-key', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/openrouter/models -> every model OpenRouter serves free, with details
app.get('/api/openrouter/models', async (req, res) => {
  try {
    const or = require('./lib/openrouter');
    const data = await or.listFreeModels(req.query.refresh === '1');
    res.json({ ...data, configured: or.hasKey() });
  } catch (err) {
    logError('server-openrouter-models', err);
    res.status(502).json({ error: err.message });
  }
});

// POST /api/openrouter/chat -> talk to one model, proxied so the key stays here
app.post('/api/openrouter/chat', async (req, res) => {
  try {
    const { model, messages, temperature, maxTokens } = req.body || {};
    const result = await require('./lib/openrouter').chat(model, messages, { temperature, maxTokens });
    res.json(result);
  } catch (err) {
    logError('server-openrouter-chat', err, { model: req.body && req.body.model });
    res.status(400).json({ error: err.message });
  }
});

// GET /api/ports/ledger -> who actually owns each listening port
//
// Distinct from /api/ports/conflicts, which compares the catalogue against
// itself and never looks at the machine. This looks at the machine: 67 ports
// listening, and until now 13 of them attributable.
app.get('/api/ports/ledger', async (req, res) => {
  try {
    const projects = await getProjects();
    res.json(await require('./lib/portLedger').portLedger(projects));
  } catch (err) {
    logError('server-port-ledger', err);
    res.status(500).json({ ok: false, reason: err.message, rows: [] });
  }
});

// ─── What Maktaba did, and how to take it back ─────────────────────────────
// Measured in app.log before this existed: 219 lines for starting a project,
// 10 for stopping one, and zero for changing a port or a classification. Those
// changed silently and could not be reversed.

// GET /api/actions -> the decisions taken, newest first
app.get('/api/actions', (req, res) => {
  try {
    res.json({ actions: require('./lib/actionLog').list(parseInt(req.query.limit, 10) || 50) });
  } catch (err) {
    logError('server-actions', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/actions/:seq/undo -> replay the payload recorded with that action
app.post('/api/actions/:seq/undo', async (req, res) => {
  try {
    const result = await require('./lib/actionLog').undo(req.params.seq);
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    logError('server-actions-undo', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Adopting a process Maktaba did not start ──────────────────────────────
// Measured: psscan ties 23 live processes to catalogued projects, 13 of them
// holding ports, and none could be stopped — stop() only knew the children
// start() spawned.

// GET /api/projects/adoptable -> live processes Maktaba could take ownership of
app.get('/api/projects/adoptable', async (req, res) => {
  try {
    const psscan = require('./lib/psscan');
    const rows = await psscan.scanProcesses();
    const runner = require('./lib/runner');

    const adoptable = rows
      .filter(r => r.matchedProjectId && r.confidence === 'high'
        && r.matchedMethod !== 'listening_port'
        && !/guardian/i.test(String(r.commandLine || ''))
        && runner.status(r.matchedProjectId).status === 'stopped')
      .map(r => ({
        projectId: r.matchedProjectId,
        projectName: r.matchedProjectName,
        pid: r.pid,
        kind: r.kind,
        matchedMethod: r.matchedMethod,
        listeningPorts: r.listeningPorts || [],
        startedAt: r.startedAt,
        commandLine: r.commandLine
      }));
    res.json({ adoptable });
  } catch (err) {
    logError('server-adoptable', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/adopt -> take ownership of one running process
app.post('/api/projects/:id/adopt', async (req, res) => {
  try {
    const projects = await getProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'المشروع غير موجود.' });

    // Re-read the live process table rather than trusting whatever the page
    // sent: a pid from a stale page could belong to something else entirely by
    // now, and this is the call that later authorises a kill.
    const rows = await require('./lib/psscan').scanProcesses();
    const observed = rows.find(r => r.matchedProjectId === project.id && Number(r.pid) === Number(req.body && req.body.pid));
    if (!observed) {
      return res.status(409).json({ ok: false, error: 'لم تعد هذه العملية مرتبطة بهذا المشروع — أعِد الفحص.' });
    }

    const result = require('./lib/runner').adopt(project, observed);
    if (!result.ok) return res.status(409).json(result);

    require('./lib/actionLog').record({
      action: 'adopt',
      projectId: project.id,
      projectName: project.name,
      before: 'external',
      after: 'adopted (pid ' + observed.pid + ')',
      // Stopping IS the reverse of adopting-then-managing, and only because the
      // adoption is what gave Maktaba the right to stop it at all.
      undo: { type: 'stop-project' }
    });

    res.json(result);
  } catch (err) {
    logError('server-adopt', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Quarantine: the one switch that means "do not launch this" ────────────

// GET /api/quarantine -> what is held, and what the profiler suggests holding
app.get('/api/quarantine', async (req, res) => {
  try {
    const q = require('./lib/quarantine');
    const projects = await getProjects();
    const held = projects.filter(p => q.isQuarantined(p)).map(p => ({
      id: p.id, name: p.name, path: p.path,
      reason: p.quarantineReason || null, at: p.quarantineAt || null
    }));
    res.json({ held, suggestions: q.suggestions(projects) });
  } catch (err) {
    logError('server-quarantine', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/quarantine -> hold or release one project
app.post('/api/projects/:id/quarantine', async (req, res) => {
  try {
    const { enabled, reason } = req.body || {};
    const q = require('./lib/quarantine');
    const result = await q.setQuarantine(req.params.id, !!enabled, reason);
    if (!result.ok) return res.status(404).json(result);

    require('./lib/actionLog').record({
      action: 'quarantine',
      projectId: req.params.id,
      projectName: result.project.name,
      before: result.before.quarantine,
      after: result.after.quarantine,
      undo: { type: 'set-quarantine', enabled: result.before.quarantine,
        reason: result.before.quarantineReason, at: result.before.quarantineAt }
    });

    res.json({ ok: true, quarantine: result.after.quarantine, reason: result.after.quarantineReason });
  } catch (err) {
    logError('server-quarantine-set', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/containers -> containers belonging to catalogued projects
// Only those. A container that references no project of yours is counted, not
// listed — this is a library of your programs, not a Docker dashboard.
app.get('/api/containers', async (req, res) => {
  try {
    const projects = await getProjects();
    res.json(await require('./lib/containers').forProjects(projects));
  } catch (err) {
    logError('server-containers', err);
    res.status(500).json({ available: false, reason: err.message, containers: [] });
  }
});

// ─── Restore points: what Maktaba took, and what it never gave back ────────
// Stashing a project's uncommitted work is invisible from the outside. Three
// stashes sat on this machine unreturned, one holding nineteen files the user
// needed, and nothing in the app could have shown them.

// GET /api/restore-points -> the ledger plus any stash still sitting in a project
app.get('/api/restore-points', async (req, res) => {
  try {
    const rp = require('./lib/restorePoints');
    const projects = await getProjects();
    const state = rp.reconcile(projects);
    res.json({ ...state, ledger: rp.list(50) });
  } catch (err) {
    logError('server-restore-points', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/restore-points/return -> put one stash back into its project
app.post('/api/restore-points/return', async (req, res) => {
  try {
    const { projectId, sha } = req.body || {};
    const projects = await getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) return res.status(404).json({ ok: false, error: 'المشروع غير موجود.' });

    const result = require('./lib/restorePoints').returnWork(project.path, sha);
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    logError('server-restore-return', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Model benchmark: which free model is actually best ────────────────────
// "Best" here is measured, never assumed. See lib/modelBench.js for the probes.

// POST /api/models/bench/run -> score the free models
app.post('/api/models/bench/run', async (req, res) => {
  try {
    const { limit, onlyStaleHours, onlyFailed } = req.body || {};
    res.json(await require('./lib/modelBench').runBenchmark({ limit, onlyStaleHours, onlyFailed }));
  } catch (err) {
    logError('server-model-bench', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/models/bench/progress -> how far the benchmark has got
app.get('/api/models/bench/progress', (req, res) => {
  try {
    res.json(require('./lib/modelBench').getBenchProgress());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/models/bench/stop -> abandon a running benchmark
app.post('/api/models/bench/stop', (req, res) => {
  try {
    res.json(require('./lib/modelBench').stopBenchmark());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/models/scores -> every scored model, best first
app.get('/api/models/scores', (req, res) => {
  try {
    const mb = require('./lib/modelBench');
    res.json({ models: mb.rankModels(), progress: mb.getBenchProgress() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/models/best -> the model to use now, optionally for a given skill
app.get('/api/models/best', (req, res) => {
  try {
    const need = {};
    for (const key of ['arabic', 'json', 'code', 'reasoning']) {
      if (req.query[key] === '1') need[key] = true;
    }
    if (req.query.minContext) need.minContext = parseInt(req.query.minContext, 10) || 0;
    res.json({ best: require('./lib/modelBench').bestModel(need), need });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Which free models are actually open to you ────────────────────────────
// "Free" in the catalogue means the price is zero. It does not mean you can use
// it: models listed free have answered 403 "only available on agentic
// harnesses", 402 "needs credits", and 502 from the provider behind them.

// GET /api/models/availability -> what is open, what is not, and why
app.get('/api/models/availability', (req, res) => {
  try {
    const ma = require('./lib/modelAvailability');
    res.json(Object.assign(ma.summarise(), { progress: ma.getProgress(), labels: ma.LABELS }));
  } catch (err) {
    logError('server-model-availability', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/models/availability/run -> ask each model the smallest question
app.post('/api/models/availability/run', async (req, res) => {
  try {
    const { onlyStaleHours, limit } = req.body || {};
    res.json(await require('./lib/modelAvailability').runSweep({ onlyStaleHours, limit }));
  } catch (err) {
    logError('server-model-availability-run', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/models/availability/stop -> abandon a running sweep
app.post('/api/models/availability/stop', (req, res) => {
  try {
    res.json(require('./lib/modelAvailability').stopSweep());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Gateway: Maktaba as an OpenAI-compatible endpoint ─────────────────────
// Any tool that speaks the OpenAI protocol can point at
// http://127.0.0.1:4500/api/gateway/v1 and reach the free models through here,
// without ever holding the OpenRouter key itself.

// GET /api/gateway/status -> readiness, current best model, base URL
app.get('/api/gateway/status', (req, res) => {
  try {
    res.json(require('./lib/gateway').status());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gateway/token -> issue a token, or revoke with { revoke: true }
app.post('/api/gateway/token', (req, res) => {
  try {
    const gw = require('./lib/gateway');
    if (req.body && req.body.revoke === true) return res.json(gw.revokeToken());
    res.json(gw.createToken());
  } catch (err) {
    logError('server-gateway-token', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gateway/health -> which models the router is resting, and why
app.get('/api/gateway/health', (req, res) => {
  try {
    res.json(require('./lib/modelRouter').health());
  } catch (err) {
    logError('server-gateway-health', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gateway/health/reset -> put a model back in rotation by hand
app.post('/api/gateway/health/reset', (req, res) => {
  try {
    res.json(require('./lib/modelRouter').reset((req.body && req.body.model) || undefined));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gateway/usage -> what the gateway has served
app.get('/api/gateway/usage', (req, res) => {
  try {
    res.json(require('./lib/gateway').getUsage(parseInt(req.query.limit, 10) || 50));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Everything below /api/gateway/v1 is the public protocol surface and needs the
// token. The rest of this server is unauthenticated because only this machine
// can reach it — but the gateway spends a real quota, and anything on this
// machine includes any page the browser happens to be showing.
function gatewayAuth(req, res, next) {
  const check = require('./lib/gateway').authorize(req);
  if (!check.ok) {
    return res.status(check.status).json({ error: { message: check.error, type: 'authentication_error' } });
  }
  next();
}

app.get(['/api/gateway/v1/models', '/api/gateway/models'], gatewayAuth, async (req, res) => {
  try {
    res.json(await require('./lib/gateway').listModels());
  } catch (err) {
    logError('server-gateway-models', err);
    res.status(502).json({ error: { message: err.message, type: 'upstream_error' } });
  }
});

app.post(['/api/gateway/v1/chat/completions', '/api/gateway/chat/completions'], gatewayAuth, async (req, res) => {
  const gw = require('./lib/gateway');
  const body = req.body || {};
  const started = Date.now();
  try {
    const result = await gw.complete(body);
    const payload = gw.toOpenAiShape(result, body.model);
    const usage = result.usage || {};

    gw.recordUsage({
      ok: true,
      requested: body.model || null,
      routedTo: result.routedTo,
      auto: result.auto,
      ms: Date.now() - started,
      tokensIn: usage.prompt_tokens || 0,
      tokensOut: usage.completion_tokens || 0,
      attempts: result.attempts.length
    });

    if (body.stream === true) {
      // The reply is sent as a single SSE chunk rather than token by token.
      // Clients that require streaming work; they just receive the answer in
      // one piece. Real incremental streaming would mean giving up the
      // fallback chain, which is the more useful half of this gateway.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const chunk = {
        id: payload.id,
        object: 'chat.completion.chunk',
        created: payload.created,
        model: payload.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: payload.choices[0].message.content }, finish_reason: null }]
      };
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      res.write('data: ' + JSON.stringify({
        id: payload.id, object: 'chat.completion.chunk', created: payload.created, model: payload.model,
        choices: [{ index: 0, delta: {}, finish_reason: payload.choices[0].finish_reason }]
      }) + '\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    res.json(payload);
  } catch (err) {
    gw.recordUsage({
      ok: false,
      requested: body.model || null,
      ms: Date.now() - started,
      error: String(err.message).slice(0, 200)
    });
    logError('server-gateway-chat', err, { model: body.model });
    res.status(err.status || 502).json({
      error: { message: err.message, type: 'gateway_error', attempts: err.attempts || null }
    });
  }
});

// GET /api/audit -> the latest fleet audit, as written by the daily run
app.get('/api/audit', (req, res) => {
  try {
    const reportPath = path.join(__dirname, 'logs', 'fleet-audit.json');
    if (!fs.existsSync(reportPath)) {
      return res.json({ generatedAt: null, counts: null, findings: [], note: 'لم يُشغَّل تدقيق بعد.' });
    }
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const ageHours = Math.round((Date.now() - new Date(report.generatedAt).getTime()) / 3600000);
    res.json({ ...report, ageHours });
  } catch (err) {
    logError('server-audit', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/audit/run -> run the fleet audit now instead of waiting for 09:00
app.post('/api/audit/run', (req, res) => {
  try {
    const { spawn } = require('child_process');
    // Detached with its own output handling: the audit walks every repository
    // and questions Windows about scheduled tasks, so it outlives a request.
    const child = spawn(process.execPath, [path.join(__dirname, 'tools', 'fleet-audit.js')], {
      cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true
    });
    child.unref();
    logInfo('server-audit', 'Fleet audit started on request.');
    res.json({ started: true, pid: child.pid });
  } catch (err) {
    logError('server-audit-run', err);
    res.status(500).json({ started: false, error: err.message });
  }
});

// GET /api/system/registry -> everything that can start itself on this machine
app.get('/api/system/registry', async (req, res) => {
  try {
    const projects = await getProjects();
    res.json(await require('./lib/systemRegistry').scanSystem(projects));
  } catch (err) {
    logError('server-system-registry', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/doctor/budget -> today's AI spend against the daily cap.
// The cap silently stopped work before this; now the UI can show it.
app.get('/api/doctor/budget', (req, res) => {
  try {
    res.json(require('./lib/doctorGuard').getBudgetStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/doctor/scan/skipped -> projects the scanner has given up on
app.get('/api/doctor/scan/skipped', (req, res) => {
  try {
    res.json(doctorScan.getSkipList());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/doctor/scan/skipped/reset -> attempt the skipped projects again
app.post('/api/doctor/scan/skipped/reset', (req, res) => {
  try {
    res.json(doctorScan.resetSkipList());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/doctor/scan/progress -> get current scan progress status
app.get('/api/doctor/scan/progress', (req, res) => {
  try {
    res.json(doctorScan.getScanProgress());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/doctor/scan/stop -> halt doctor scan
app.post('/api/doctor/scan/stop', (req, res) => {
  try {
    res.json(doctorScan.stopScan());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/doctor/fix-queue/start -> start sequential doctor fix queue
app.post('/api/doctor/fix-queue/start', (req, res) => {
  try {
    // Never spend real agy budget as a side effect of the test suite —
    // integration-test.js calls this route just to check it responds 200.
    if (process.env.MAKTABA_TEST === '1') {
      return res.json({ started: true, total: 0 });
    }
    const result = doctorQueue.startQueue();
    res.json(result);
  } catch (err) {
    logError('server-doctor-fix-queue-start', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/doctor/fix-queue/progress -> get doctor fix queue progress
app.get('/api/doctor/fix-queue/progress', (req, res) => {
  try {
    res.json(doctorQueue.getProgress());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/doctor/fix-queue/stop -> halt doctor fix queue
app.post('/api/doctor/fix-queue/stop', (req, res) => {
  try {
    res.json(doctorQueue.stopQueue());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/doctor-reset -> reset doctor attempts and needsReview
app.post('/api/projects/:id/doctor-reset', async (req, res) => {
  try {
    const id = req.params.id;
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'المشروع غير موجود.' });
    }
    const store = require('./lib/store');
    await store.saveDoctorFixStatus(id, {
      doctorFixAttempts: 0,
      doctorNeedsReview: false
    });
    res.json({ ok: true, id });
  } catch (err) {
    logError('server-doctor-reset', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/classify -> manually classify a project
app.post('/api/projects/:id/classify', async (req, res) => {
  try {
    const id = req.params.id;
    const { value } = req.body;
    if (value !== 'project' && value !== 'not-project' && value !== null && value !== undefined) {
      return res.status(400).json({ error: 'Invalid classification value' });
    }

    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const previous = project.userClassification === undefined ? null : project.userClassification;
    const updatedProject = await setUserClassification(id, value === undefined ? null : value);

    // Recorded after the change succeeded, and carrying the OLD value as the
    // payload that reverses it. Working the reverse out later would mean
    // guessing at a value that has since moved on.
    require('./lib/actionLog').record({
      action: 'classify',
      projectId: id,
      projectName: project.name,
      before: previous,
      after: value === undefined ? null : value,
      undo: { type: 'set-classification', value: previous }
    });

    res.json(updatedProject);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/port -> manually set/override a project port
app.post('/api/projects/:id/port', async (req, res) => {
  try {
    const id = req.params.id;
    const { port } = req.body;

    const { isValidPort } = require('./lib/portManager');
    if (!isValidPort(port)) {
      return res.status(400).json({ error: 'منفذ غير صالح. يجب أن يكون رقماً بين 1024 و 65535.' });
    }

    const targetPort = parseInt(port, 10);
    if (targetPort === 4500) {
      return res.status(400).json({ error: 'المنفذ 4500 محجوز لتطبيق المكتبة.' });
    }

    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'المشروع غير موجود.' });
    }

    // Check if the port is already assigned to a DIFFERENT primary project
    const conflict = projects.find(p => 
      p.id !== id && 
      p.isPrimary !== false && 
      p.classification !== 'not-project' && 
      p.assignedPort === targetPort
    );

    if (conflict) {
      return res.status(409).json({ error: 'البورت مستخدم من مشروع آخر' });
    }

    // Captured before the mutation, because this is the only moment the old
    // value is still knowable.
    const previousPort = project.assignedPort === undefined ? null : project.assignedPort;
    const previousUserSet = project.userPortSet === true;

    // Set assignedPort and userPortSet on target project
    project.assignedPort = targetPort;
    project.userPortSet = true;

    // Propagate to its backups: any project with backupOf === id gets the same assignedPort
    for (const p of projects) {
      if (p.backupOf === id) {
        p.assignedPort = targetPort;
      }
    }

    await saveProjects(projects);

    require('./lib/actionLog').record({
      action: 'set-port',
      projectId: id,
      projectName: project.name,
      before: previousPort,
      after: targetPort,
      undo: { type: 'set-port', port: previousPort, userPortSet: previousUserSet }
    });

    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ports/conflicts -> get all port conflicts (if any)
app.get('/api/ports/conflicts', async (req, res) => {
  try {
    const projects = await getProjects();
    const portMap = new Map(); // port -> array of ids

    for (const p of projects) {
      if (p.isPrimary !== false && p.classification !== 'not-project' && p.assignedPort) {
        const port = p.assignedPort;
        if (!portMap.has(port)) {
          portMap.set(port, []);
        }
        portMap.get(port).push(p.id);
      }
    }

    const conflicts = [];
    for (const [port, ids] of portMap.entries()) {
      if (ids.length > 1) {
        conflicts.push({ port, ids });
      }
    }

    res.json(conflicts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/fix -> run AI diagnostics and fixes
app.post('/api/projects/:id/fix', async (req, res) => {
  try {
    const id = req.params.id;
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const locked = await withAiLock(id, 'fix', async () => {
      logInfo('fix-start', `Starting AI Fix for project ${id} (${project.name})`);
      const r = await fixer.fixProject(project, { trigger: 'manual-fix' });
      logInfo('fix-finish', `Finished AI Fix for project ${id} (${project.name}). Result ok: ${r.ok}, verified: ${r.verified}`);
      return r;
    });

    if (locked.busy) {
      return res.status(409).json({
        error: `عملية ذكاء (${locked.label}) تعمل بالفعل على هذا المشروع.`,
        busy: true
      });
    }
    const result = locked.result;

    res.json(result);
  } catch (err) {
    logError('fix-error', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/deep -> run unified AI Deep Doctor
//
// This route had its own deep-only guard. It now shares the single per-project
// AI lock: two different AI routes running against the same folder at once is
// exactly as bad as the same route twice, and a deep-only guard could not see
// an /analyze or /fix already in flight.
app.post('/api/projects/:id/deep', async (req, res) => {
  const id = req.params.id;

  try {
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const locked = await withAiLock(id, 'deep-doctor', async () => {
      logInfo('deep-start', `Starting AI Deep Doctor for project ${id} (${project.name})`);
      const deepDoctor = require('./lib/deepDoctor');
      const result = await deepDoctor.runDeep(project);
      logInfo('deep-finish', `Finished AI Deep Doctor for project ${id} (${project.name}). Result ok: ${result.ok}`);
      return result;
    });

    if (locked.busy) {
      return res.status(409).json({
        ok: false,
        busy: true,
        error: `عملية ذكاء (${locked.label}) قيد التنفيذ بالفعل لهذا المشروع — انتظر حتى تنتهي (قد تستغرق عدة دقائق).`
      });
    }

    res.json(locked.result);
  } catch (err) {
    logError('deep-error', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/review/queue -> get lists of uncertain classifications and backups needing review
app.get('/api/review/queue', async (req, res) => {
  try {
    const projects = await getProjects();
    
    // classReview = projects where classification in ['likely','weak'] AND (userClassification == null) AND isPrimary !== false AND classification !== 'not-project'
    const classReview = projects
      .filter(p => 
        ['likely', 'weak'].includes(p.classification) && 
        p.userClassification === null && 
        p.isPrimary !== false && 
        p.classification !== 'not-project'
      )
      .map(p => ({
        id: p.id,
        name: p.name,
        path: p.path,
        type: p.type,
        confidence: p.confidence,
        signals: p.signals
      }));

    // backupReview = projects where isPrimary === false AND backupUncertain === true AND (userBackupDecision == null)
    const backupReview = projects
      .filter(p => 
        p.isPrimary === false && 
        p.backupUncertain === true && 
        p.userBackupDecision === null
      )
      .map(p => {
        const primary = projects.find(pr => pr.id === p.backupOf);
        return {
          id: p.id,
          name: p.name,
          path: p.path,
          modifiedAt: p.modifiedAt,
          primary: primary ? { id: primary.id, name: primary.name, path: primary.path } : null
        };
      });

    res.json({
      classReview,
      backupReview,
      classReviewCount: classReview.length,
      backupReviewCount: backupReview.length
    });
  } catch (err) {
    logError('review-queue', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/backup-decision -> record manual decision for backup grouping and update sets
app.post('/api/projects/:id/backup-decision', async (req, res) => {
  try {
    const id = req.params.id;
    const { decision } = req.body;
    if (decision !== 'independent' && decision !== 'backup' && decision !== null) {
      return res.status(400).json({ error: 'Invalid decision value' });
    }

    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    logInfo('backup-decision', `Recording backup decision "${decision}" for project ${id} (${project.name})`);
    project.userBackupDecision = decision;

    // Save initial update
    await saveProjects(projects);

    // Re-run grouping: call groupBackups(allProjects) then assignPorts(allProjects) then saveProjects(allProjects)
    groupBackups(projects);
    const { assignPorts } = require('./lib/portManager');
    assignPorts(projects);
    await saveProjects(projects);

    res.json({ ok: true });
  } catch (err) {
    logError('backup-decision-error', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/ai-judge -> perform on-demand AI classification/backup assessment
app.post('/api/projects/:id/ai-judge', async (req, res) => {
  try {
    const id = req.params.id;
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    logInfo('ai-judge-start', `AI Judge request for project ${id} (${project.name})`);
    const acpResolver = require('./lib/acpResolver');
    const delegate = acpResolver.resolveDelegate();
    if (!delegate) {
      return res.json({ ok: false, recommendation: '', reasoning: 'أداة acp غير متوفرة.' });
    }

    let prompt = "مهمة قراءة فقط لا تعدّل شيئاً. افحص المجلد وأجب باختصار: (1) هل هذا مشروع برمجي حقيقي ومستقل أم مجرد قالب/مخلفات/جزء من مشروع آخر؟ (2) ";
    if (project.backupOf) {
      const primary = projects.find(pr => pr.id === project.backupOf);
      const primaryPath = primary ? primary.path : 'الموقع الرئيسي';
      prompt += `بالنظر إلى المشروع المشابه في المسار ${primaryPath}، هل هذا نسخة احتياطية/قديمة منه أم مشروع مستقل؟ `;
    }
    prompt += "أعطِ توصية واضحة بكلمة (مشروع / ليس مشروعاً / نسخة احتياطية / مستقل) ثم سطر تعليل قصير.";

    // Spawn delegate
    const { spawn } = require('child_process');
    const env = { ...process.env, ACP_DELEGATE_OPEN: '0' };
    
    let stdout = '';
    let stderr = '';
    
    let child;
    if (delegate.mode === 'node') {
      child = spawn('node', [delegate.delegatePath, '--json', '--read-only', prompt], {
        cwd: project.path,
        windowsHide: true,
        env
      });
    } else {
      child = spawn([delegate.cmd, '--json', '--read-only', `"${prompt.replace(/"/g, '\\"')}"`].join(' '), [], {
        cwd: project.path,
        shell: true,
        windowsHide: true,
        env
      });
    }

    const timeoutTimer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          const { execSync } = require('child_process');
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch (e) {}
    }, 180000); // 3 minutes timeout

    child.stdout.on('data', (data) => {
      stdout += data.toString('utf8');
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString('utf8');
    });

    const runResult = await new Promise((resolve) => {
      child.on('exit', (code) => {
        clearTimeout(timeoutTimer);
        resolve({ code });
      });
      child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        resolve({ code: -1, error: err });
      });
    });

    if (runResult.error) {
      throw runResult.error;
    }

    // Parse delegate stdout JSON
    const firstBrace = stdout.indexOf('{');
    const lastBrace = stdout.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      throw new Error('No JSON output from acp/agy judge command');
    }
    const jsonStr = stdout.substring(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(jsonStr);

    logInfo('ai-judge-finish', `AI Judge finished for project ${id} (${project.name})`);
    res.json({
      ok: true,
      reasoning: (parsed.summary || '').trim()
    });
  } catch (err) {
    logError('ai-judge-error', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/healthcheck => get healthcheck status
app.post('/api/projects/:id/healthcheck', async (req, res) => {
  try {
    const id = req.params.id;
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'المشروع غير موجود.' });
    }

    const healthcheck = require('./lib/healthcheck');
    const result = await healthcheck.checkProject(project, runner);
    res.json(result);
  } catch (err) {
    logError('server-healthcheck-route', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/healthfix => diagnose & fix project page health
app.post('/api/projects/:id/healthfix', async (req, res) => {
  try {
    const id = req.params.id;
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'المشروع غير موجود.' });
    }

    const healthcheck = require('./lib/healthcheck');
    const healthResult = await healthcheck.checkProject(project, runner);

    const errorDetails = [
      ...(healthResult.problems || []),
      ...(healthResult.consoleErrors || []),
      ...(healthResult.failedRequests || [])
    ].join('\n');

    const acpResolver = require('./lib/acpResolver');
    const delegate = acpResolver.resolveDelegate();
    if (!delegate) {
      return res.status(500).json({ error: 'أداة acp غير متوفرة.' });
    }

    const verifyHealthPath = path.resolve(__dirname, 'tools/verifyHealth.js');
    const verifyCmd = `node "${verifyHealthPath}" ${project.id}`;

    const prompt = `هذا المشروع يعاني من مشاكل صحية (الصفحة لا تعمل بشكل سليم). المشاكل المكتشفة:\n${errorDetails}\nأصلح الكود/المشروع لحل هذه المشاكل وضمان عمل الصفحة بدون أخطاء.`;

    logInfo('healthfix-start', `Starting AI health fix for project ${id} (${project.name})`);
    
    const { runDelegate, parseJSONFromOutput } = require('./lib/fixer');
    const delegateResult = await runDelegate(delegate, verifyCmd, prompt, project.path);
    const parsed = parseJSONFromOutput(delegateResult.stdout);

    const verify = parsed.verify;
    const fixed = !!(verify && verify.ok === true);
    const verified = !!(verify && verify.ok);
    const summary = (parsed.summary || '').trim();

    logInfo('healthfix-finish', `Finished AI health fix for project ${id}. Fixed: ${fixed}`);

    res.json({
      ok: true,
      fixed,
      verified,
      summary
    });
  } catch (err) {
    logError('server-healthfix-route', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/autostart => toggle autostart
app.post('/api/projects/:id/autostart', async (req, res) => {
  try {
    const id = req.params.id;
    const { enabled } = req.body;
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'المشروع غير موجود.' });
    }

    const previousAutoStart = project.autoStart === true;
    project.autoStart = !!enabled;
    await saveProjects(projects);

    require('./lib/actionLog').record({
      action: 'autostart',
      projectId: id,
      projectName: project.name,
      before: previousAutoStart,
      after: project.autoStart,
      undo: { type: 'set-autostart', enabled: previousAutoStart }
    });

    res.json({ ok: true, autoStart: project.autoStart });
  } catch (err) {
    logError('server-autostart-route', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/favorite => toggle favorite
app.post('/api/projects/:id/favorite', async (req, res) => {
  try {
    const id = req.params.id;
    const { enabled } = req.body;
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'المشروع غير موجود.' });
    }

    project.favorite = !!enabled;
    await saveProjects(projects);
    res.json({ ok: true, favorite: project.favorite });
  } catch (err) {
    logError('server-favorite-route', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/exclude-autofix => toggle exclude from auto-fix
app.post('/api/projects/:id/exclude-autofix', async (req, res) => {
  try {
    const id = req.params.id;
    const { excluded } = req.body;
    
    const project = await setExcludeFromAutoFix(id, !!excluded);
    res.json({ ok: true, excludeFromAutoFix: project.excludeFromAutoFix });
  } catch (err) {
    if (err.message === 'Project not found') {
      return res.status(404).json({ error: 'المشروع غير موجود.' });
    }
    logError('server-exclude-autofix-route', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/run-command => set custom run command
app.post('/api/projects/:id/run-command', async (req, res) => {
  try {
    const id = req.params.id;
    const { command } = req.body;
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'المشروع غير موجود.' });
    }

    const hasCommand = typeof command === 'string' && command.trim();
    project.runCommand = hasCommand ? command.trim() : null;
    project.userRunCommandSet = !!hasCommand;
    await saveProjects(projects);
    res.json({ ok: true, runCommand: project.runCommand });
  } catch (err) {
    logError('server-run-command-route', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/analyze -> run AI onboarding/analysis
app.post('/api/projects/:id/analyze', async (req, res) => {
  try {
    const id = req.params.id;
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'المشروع غير موجود.' });
    }

    const locked = await withAiLock(id, 'analyze', async () => {
      const result = await require('./lib/aiOnboard').analyzeProject(project);
      if (result.ok) {
        const profile = result.profile;
        const updates = {
          aiProfile: profile,
          aiAnalyzedAt: result.analyzedAt
        };

        if (profile.runCommand && project.userRunCommandSet !== true) {
          updates.runCommand = profile.runCommand;
          updates.userRunCommandSet = false;
        }

        if (typeof profile.port === 'number' && Number.isInteger(profile.port) && !project.userPortSet) {
          updates.assignedPort = profile.port;
        }

        await saveAiProfile(id, updates);
      }
      return result;
    });

    if (locked.busy) {
      return res.status(409).json({
        error: `عملية ذكاء (${locked.label}) تعمل بالفعل على هذا المشروع منذ ${locked.since}.`,
        busy: true
      });
    }

    const result = locked.result;
    res.json({
      ok: result.ok,
      profile: result.profile || null,
      error: result.error || null
    });
  } catch (err) {
    logError('server-analyze-route', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:id/launch-info => get smart launch info plan
app.get('/api/projects/:id/launch-info', async (req, res) => {
  try {
    const id = req.params.id;
    const projects = await getProjects();
    const project = projects.find(p => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'المشروع غير موجود.' });
    }

    try {
      const { planLaunch } = require('./lib/launcher');
      const plan = planLaunch(project);
      const commandStr = plan.cmd + (plan.args && plan.args.length ? (' ' + plan.args.join(' ')) : '');
      res.json({
        ok: true,
        kind: plan.kind,
        command: commandStr,
        runCommand: project.runCommand || null,
        isCustom: plan.kind === 'custom',
        isScript: plan.kind === 'script'
      });
    } catch (err) {
      res.json({
        ok: false,
        command: null,
        error: err.message
      });
    }
  } catch (err) {
    logError('server-launch-info-route', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/running => get currently running projects
app.get('/api/running', async (req, res) => {
  try {
    const running = runner.listRunning();
    const projects = await getProjects();
    const result = running.map(r => {
      const p = projects.find(proj => proj.id === r.id);
      const uptimeMs = r.startedAt ? (Date.now() - new Date(r.startedAt).getTime()) : 0;
      return {
        id: r.id,
        name: p ? p.name : 'Unknown',
        path: p ? p.path : '',
        status: r.status,
        port: r.port,
        kind: r.kind,
        autoStart: p ? !!p.autoStart : false,
        uptimeMs: uptimeMs > 0 ? uptimeMs : 0
      };
    });
    res.json(result);
  } catch (err) {
    logError('server-running-route', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/live => get supervisor status
app.get('/api/live', async (req, res) => {
  try {
    const supervisor = require('./lib/supervisor');
    const liveStatus = await supervisor.getLiveStatus();
    res.json(liveStatus);
  } catch (err) {
    logError('server-live-route', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/live/start-all => start all autostart projects
app.post('/api/live/start-all', async (req, res) => {
  try {
    const supervisor = require('./lib/supervisor');
    await supervisor.startAll();
    res.json({ ok: true });
  } catch (err) {
    logError('server-start-all-route', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/autostart/boot => check if Windows autostart is installed
app.get('/api/autostart/boot', (req, res) => {
  try {
    const autostart = require('./tools/install-autostart');
    res.json({ installed: autostart.isInstalled() });
  } catch (err) {
    logError('server-boot-get-route', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/autostart/boot => toggle Windows autostart installation
app.post('/api/autostart/boot', (req, res) => {
  try {
    const { enabled } = req.body;
    const autostart = require('./tools/install-autostart');
    const uninstall = require('./tools/uninstall-autostart');

    if (enabled) {
      const result = autostart.install();
      if (!result.ok) {
        throw new Error(result.error || 'Failed to install startup script');
      }
    } else {
      const result = uninstall.uninstall();
      if (!result.ok) {
        throw new Error(result.error || 'Failed to uninstall startup script');
      }
    }

    res.json({ ok: true, installed: autostart.isInstalled() });
  } catch (err) {
    logError('server-boot-post-route', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/errors -> return the last 200 lines of error.log
app.get('/api/logs/errors', (req, res) => {
  const errorLogPath = path.join(__dirname, 'logs/error.log');
  if (!fs.existsSync(errorLogPath)) {
    return res.type('text/plain').send('لا توجد أخطاء مسجلة حالياً.');
  }
  try {
    const content = fs.readFileSync(errorLogPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const lastLines = lines.slice(-200).join('\n');
    res.type('text/plain').send(lastLines);
  } catch (err) {
    logError('logs-endpoint', err);
    res.status(500).send('فشل قراءة ملف الأخطاء.');
  }
});

// GET /api/reports/errors -> structured, grouped error summary (powers the report UI)
app.get('/api/reports/errors', (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 5000);
    res.json(logger.summarizeErrors(limit));
  } catch (err) {
    logError('reports-errors', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reports/errors/generate -> (re)generate logs/ERROR-REPORT.md and return it
app.post('/api/reports/errors/generate', (req, res) => {
  try {
    const result = logger.generateErrorReport();
    res.json({ ok: true, path: result.path, summary: result.summary, markdown: result.markdown });
  } catch (err) {
    logError('reports-generate', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/errors/download -> download the generated Markdown report
app.get('/api/reports/errors/download', (req, res) => {
  try {
    const result = logger.generateErrorReport();
    res.type('text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ERROR-REPORT.md"');
    res.send(result.markdown);
  } catch (err) {
    logError('reports-download', err);
    res.status(500).json({ error: err.message });
  }
});

// Express global error handler — converts any uncaught route error into a logged 500.
app.use((err, req, res, next) => {
  logError('express-global', err, { method: req.method, path: req.originalUrl });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal Server Error: ' + err.message });
});

// Start listening on port 4500, loopback only — this server spawns processes
// and runs shell commands with no authentication, so it must never be reachable
// from the network.
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Server listening on port ${PORT}`);

  // Refresh the human-readable error report on every boot so logs/ERROR-REPORT.md
  // always reflects the latest captured errors (never throws — best effort).
  try { logger.generateErrorReport(); } catch (e) { console.error('report gen on boot failed:', e.message); }

  if (process.env.MAKTABA_TEST !== '1') {
    // Run initial auto-scan in the background if the database is empty
    (async () => {
      try {
        const existing = await getProjects();
        if (existing.length === 0) {
          logInfo('startup', 'DB empty — running initial auto-scan in background');
          
          // Load config from config.json with fallback
          const configPath = path.join(__dirname, 'config.json');
          let currentConfig = { roots: ['C:\\projects'], maxDepth: 4, skipDirs: [] };
          if (fs.existsSync(configPath)) {
            try {
              currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            } catch (err) {
              console.error('Failed to parse config.json, using fallback config:', err.message);
            }
          }

          runFullScan(currentConfig)
            .then(r => logInfo('startup', 'initial scan done: ' + r.count))
            .catch(e => logError('startup-scan', e));
        }
      } catch (e) {
        logError('startup-scan-init', e);
      }
    })();

    // Trigger supervisor auto-start and health check loop
    require('./lib/supervisor').startAll().catch(e => logError('supervisor-boot', e));

    // Trigger periodic doctor scans scheduler
    require('./lib/doctorScheduler').start();
  }
});

// Fail loudly and exit non-zero when the port is taken. Without this the bind
// error reaches the process-wide uncaughtException handler, which logs and
// keeps going — leaving a live node process with no HTTP listener that the
// guardian then restarts forever. Deliberately no automatic port fallback:
// the guardian probes port 4500 literally, so a server that slid to 4501 would
// look permanently dead to it.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`المنفذ ${PORT} مشغول — مكتبة تعمل بالفعل (أو عملية أخرى تحتجز المنفذ).`);
    logError('server-listen', err, { port: PORT });
    process.exit(1);
  }
  logError('server-listen', err, { port: PORT });
  throw err;
});

// Handle clean shutdown of browser instance
process.on('SIGTERM', async () => {
  await screenshot.closeBrowser();
  server.close(() => {
    process.exit(0);
  });
});
process.on('SIGINT', async () => {
  await screenshot.closeBrowser();
  server.close(() => {
    process.exit(0);
  });
});

module.exports = { app, server };
