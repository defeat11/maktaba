const fs = require('fs');
const path = require('path');
const { spawn, execSync, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const logFile = path.join(root, 'maktaba_evolution.log');

function log(level, message, meta = {}) {
  const ts = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : '';
  const line = `[${ts}] [${level.toUpperCase()}] ${message}${metaStr}\n`;
  
  process.stdout.write(line);
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (err) {
    console.error('Failed to write to evolution log:', err);
  }
}

log('INFO', '🚀 Master Supervisor starting in continuous background mode with Scope Lock enabled.');

let isEvolving = false;
let cycleCount = 0;

async function runCheck(cmd, args, env = {}) {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, {
      cwd: root,
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: true
    });
    let stdout = '';
    let stderr = '';
    cp.stdout.on('data', (d) => { stdout += d.toString(); });
    cp.stderr.on('data', (d) => { stderr += d.toString(); });
    cp.on('close', (code) => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    cp.on('error', (err) => {
      resolve({ code: -1, stdout: '', stderr: err.message });
    });
  });
}

function checkScopeLock() {
  try {
    const gitStatus = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    const diffStat = spawnSync('git', ['diff', '--stat'], { cwd: root, encoding: 'utf8' });
    
    return {
      clean: !gitStatus.stdout || gitStatus.stdout.trim().length === 0,
      changes: gitStatus.stdout ? gitStatus.stdout.trim().split('\n').map(s => s.trim()) : [],
      diffSummary: diffStat.stdout ? diffStat.stdout.trim() : 'No diff'
    };
  } catch (e) {
    return { clean: false, error: e.message };
  }
}

function parseRoadmapPending() {
  const roadmapPath = path.join(root, 'roadmap.md');
  if (!fs.existsSync(roadmapPath)) return [];
  const content = fs.readFileSync(roadmapPath, 'utf8');
  const matches = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^###\s+\[\s*\]\s+([^:]+):([\s\S]*)$/);
    if (m) {
      matches.push({ id: m[1].trim(), title: m[2].trim() });
    }
  }
  return matches;
}

async function supervisorCycle() {
  cycleCount++;
  log('INFO', `🔄 [Cycle #${cycleCount}] Running Scope Lock & System Health Audit...`);

  // 1. Audit Scope Lock
  const scope = checkScopeLock();
  if (scope.clean) {
    log('INFO', `🛡️ Scope Lock Status: Clean & Untampered. Working directory matches target repository tree.`);
  } else {
    log('WARN', `🛡️ Scope Lock Notice: Changes detected in repository`, { changes: scope.changes });
  }

  // 2. Run Test Suite Validation
  log('INFO', `🧪 Running Master Verification Suite (Tests + Smoke)...`);
  const testRes = await runCheck('node', ['--check', 'public/app.js']);
  const unitRes = await runCheck('npm', ['run', 'test:unit']);
  const smokeRes = await runCheck('node', ['tools/smoke.js']);

  const allPassed = testRes.code === 0 && unitRes.code === 0 && smokeRes.code === 0;
  if (allPassed) {
    log('SUCCESS', `✅ All Tests Passed! [Syntax: OK, Unit: OK, Smoke: OK]`);
  } else {
    log('ERROR', `❌ Test Suite Failed!`, {
      syntaxCode: testRes.code,
      unitCode: unitRes.code,
      smokeCode: smokeRes.code,
      unitStderr: unitRes.stderr || unitRes.stdout.slice(-300)
    });
  }

  // 3. Check for Pending Roadmap Evolution Tasks
  const pendingTasks = parseRoadmapPending();
  const tasksNeedingEvolution = pendingTasks.filter(t => {
    const branchName = `evolve/${t.id}`;
    const branchExists = spawnSync('git', ['branch', '--list', branchName], { cwd: root, encoding: 'utf8' });
    const exists = branchExists.stdout && branchExists.stdout.includes(branchName);
    if (exists) {
      log('INFO', `📌 Task [${t.id}] has branch '${branchName}' ready for review/merge. Standing by.`);
    }
    return !exists;
  });

  log('INFO', `📋 Pending Roadmap Tasks: ${pendingTasks.length} (Needing Evolution: ${tasksNeedingEvolution.length})`);

  if (tasksNeedingEvolution.length > 0 && !isEvolving) {
    isEvolving = true;
    log('INFO', `⚡ Triggering Autonomous Evolution Loop for ${tasksNeedingEvolution.length} pending task(s)...`);
    
    try {
      const evolveRes = await runCheck('node', ['tools/evolve.js', '--max', '1']);
      log('INFO', `🧬 Evolution Loop Cycle Result (code ${evolveRes.code}):`, {
        output: evolveRes.stdout.slice(-1000) || evolveRes.stderr.slice(-1000)
      });
    } catch (evolveErr) {
      log('ERROR', `❌ Evolution Loop Encountered Error: ${evolveErr.message}`);
    } finally {
      isEvolving = false;
    }
  } else if (pendingTasks.length === 0) {
    log('INFO', `✨ All Roadmap tasks are currently up-to-date and implemented. Supervisor standing by on continuous watch.`);
  }
}

// Initial Run
supervisorCycle().catch(err => log('FATAL', `Supervisor cycle failed: ${err.message}`));

// Continuous loop every 30 seconds
const INTERVAL_MS = 30000;
setInterval(() => {
  supervisorCycle().catch(err => log('FATAL', `Supervisor cycle failed: ${err.message}`));
}, INTERVAL_MS);

log('INFO', `⏱️ Master Supervisor scheduled for continuous inspection every ${INTERVAL_MS / 1000}s.`);
