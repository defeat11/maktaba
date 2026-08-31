const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const acpResolver = require('./acpResolver');
const launcher = require('./launcher');
const snapshotGuard = require('./snapshotGuard');
const logger = require('./logger');
const { logError } = logger;

/**
 * Runs the verifyRun tool on a project to capture output/exit code.
 */
function runVerifier(verifyRunPath, projectId, projectPath) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn('node', [verifyRunPath, projectId], {
      cwd: projectPath,
      windowsHide: true
    });

    const timeoutTimer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          const { execSync } = require('child_process');
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch (e) {}
    }, 25000); // 25s timeout

    child.stdout.on('data', (data) => {
      output += data.toString('utf8');
    });

    child.stderr.on('data', (data) => {
      output += data.toString('utf8');
    });

    child.on('exit', (code) => {
      clearTimeout(timeoutTimer);
      resolve({ code, output });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      resolve({ code: -1, output: output + '\n' + err.message });
    });
  });
}

/**
 * How long an agent may run before it is killed.
 *
 * Five minutes was too short for the first real repair that reached this stage:
 * تردد المودم needed `pip install -r requirements.txt`, and playwright pulls
 * browser binaries, so the agent was killed mid-download at exactly 300s having
 * changed nothing. A dependency install is a legitimate repair and has to be
 * allowed to finish. Override with delegateTimeoutMinutes in config.json.
 */
function delegateTimeoutMs() {
  const DEFAULT_MINUTES = 15;
  try {
    const configPath = path.join(__dirname, '..', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const m = Number(config.delegateTimeoutMinutes);
      // Bounded on both sides: too small kills real work, too large lets a
      // stuck agent hold a slot for hours.
      if (Number.isFinite(m) && m >= 1 && m <= 60) return m * 60000;
    }
  } catch (err) {
    logError('fixer-config', err);
  }
  return DEFAULT_MINUTES * 60000;
}

/**
 * Runs the acp/agy delegate to fix the project.
 */
function runDelegate(delegate, verifyCmd, prompt, projectPath) {
  const DELEGATE_TIMEOUT_MS = delegateTimeoutMs();
  // Every AI path that writes to a user project funnels through here
  // (fixer.fixProject, deepDoctor.runDeep, and the supervisor's auto-fix), so
  // this is the one place a restore point has to be taken. No snapshot, no
  // agent — refusing is always better than an unrecoverable edit.
  // Budget gate. canSpendBudget existed but was wired only into doctorQueue —
  // the one AI path that has never processed a single project — so in practice
  // it capped nothing. Checking here covers fixer, deepDoctor and the
  // supervisor's auto-fix in one place.
  const doctorGuard = require('./doctorGuard');
  if (!doctorGuard.canSpendBudget()) {
    const status = doctorGuard.getBudgetStatus();
    const msg = `تجاوز السقف اليومي لاستدعاءات الذكاء (${status.spent}/${status.limit}). لن يُستدعى الوكيل.`;
    logError('fixer-budget', new Error(msg));
    return Promise.reject(new Error(msg));
  }

  const guard = snapshotGuard.snapshot(projectPath);
  if (!guard.ok) {
    const msg = `Refusing to run the agent on ${projectPath}: ${guard.reason}`;
    logError('fixer-snapshot', new Error(msg));
    return Promise.reject(new Error(msg));
  }
  snapshotGuard.pruneSnapshots();
  doctorGuard.recordSpend();

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    let child;
    const env = { ...process.env, ACP_DELEGATE_OPEN: '0' };
    
    if (delegate.mode === 'node') {
      child = spawn('node', [delegate.delegatePath, '--json', '--verify', verifyCmd, prompt], {
        cwd: projectPath,
        windowsHide: true,
        env
      });
    } else {
      child = spawn([delegate.cmd, '--json', '--verify', verifyCmd, `"${prompt.replace(/"/g, '\\"')}"`].join(' '), [], {
        cwd: projectPath,
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
      reject(new Error(`Delegate timeout (${Math.round(DELEGATE_TIMEOUT_MS / 60000)} min)`));
    }, DELEGATE_TIMEOUT_MS);

    child.stdout.on('data', (data) => {
      stdout += data.toString('utf8');
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString('utf8');
    });

    child.on('exit', (code) => {
      clearTimeout(timeoutTimer);
      // Put the user's uncommitted work back. The stash was taken to protect
      // it, not to remove it: a repair that succeeds while their
      // work-in-progress is still sitting in a stash has emptied their folder.
      const restored = snapshotGuard.restoreStashedWork(projectPath, guard);
      resolve({
        code, stdout, stderr,
        restore: {
          kind: guard.kind,
          handle: guard.handle,
          hint: guard.restoreHint,
          stashRestored: restored.restored,
          stashWarning: restored.reason
        }
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      reject(err);
    });
  });
}

// One JSON object per line, same shape of append-only log as logger.js uses
// for errors. Before this, everything known about a fix attempt was four
// columns that the next attempt overwrote, so "which fixes actually worked?"
// could only be answered by grepping Arabic prose out of app.log.
const FIX_HISTORY_PATH = path.join(__dirname, '..', 'logs', 'fix-history.jsonl');

/**
 * Appends one fix attempt to the history log. Never throws: logging must not
 * be able to fail a repair.
 *
 * @param {Object} project The project that was worked on
 * @param {string} trigger What started this attempt
 * @param {number} startedAt Epoch ms when the attempt began
 * @param {Object} result The result object being returned to the caller
 * @param {Object|null} restore Restore handle from the snapshot guard
 */
function recordFixAttempt(project, trigger, startedAt, result, restore) {
  try {
    const dir = path.dirname(FIX_HISTORY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      projectId: project && project.id ? project.id : null,
      projectName: project && project.name ? project.name : null,
      path: project && project.path ? project.path : null,
      trigger,
      ok: result.ok === true,
      verified: result.verified === true,
      verifyExit: result.verifyExit !== undefined ? result.verifyExit : null,
      summary: (result.summary || '').slice(0, 500),
      durationMs: Date.now() - startedAt,
      restoreKind: restore ? restore.kind : null,
      restoreHandle: restore ? restore.handle : null
    };
    // Bounded, but far more generously than the chatter logs: this is the only
    // record of which repairs actually worked, so it is analytics rather than
    // noise. 50 MB / 20k attempts is decades of use at the observed rate.
    logger.appendBounded(FIX_HISTORY_PATH, JSON.stringify(entry) + '\n',
      50 * 1024 * 1024, 20000);
  } catch (err) {
    logError('fix-history', err);
  }
}

function parseJSONFromOutput(stdout) {
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('No JSON object found in delegate stdout');
  }
  const jsonStr = stdout.substring(firstBrace, lastBrace + 1);
  return JSON.parse(jsonStr);
}

/**
 * Attempt to diagnose and fix a project using acp/agy delegate.
 * @param {Object} project Project metadata.
 * @returns {Promise<Object>} Result details.
 */
async function fixProject(project, options = {}) {
  // Repairing a project means running it — runVerifier launches it before and
  // after the agent writes. So this is a launch path, and it is gated here
  // rather than inside runVerifier: fixProject is the only way in, and it is
  // where the project row already exists. doctorQueue filters the queue too,
  // but a gate that relies on every caller remembering is not a gate.
  const held = require('./quarantine').launchBlock(project);
  if (held.blocked) {
    logError('fixer', new Error('Refused to repair quarantined project ' + (project && project.name) + ': ' + held.reason));
    return {
      ok: false,
      quarantined: true,
      reason: held.reason,
      summary: 'محجور — لم يُشغَّل ولم يُعدَّل: ' + held.reason
    };
  }

  const startedAt = Date.now();
  const trigger = options.trigger || 'manual-fix';
  try {
    const delegate = acpResolver.resolveDelegate();
    if (!delegate) {
      const result = { ok: false, verified: false, fixed: false, summary: 'أداة acp غير متوفرة.' };
      recordFixAttempt(project, trigger, startedAt, result, null);
      return result;
    }

    const verifyRunPath = path.join(__dirname, '..', 'tools', 'verifyRun.js');
    const verifyCmd = `node "${verifyRunPath}" ${project.id}`;

    // First, capture the CURRENT error
    const initialVerify = await runVerifier(verifyRunPath, project.id, project.path);
    const errorContext = (initialVerify.output || '').slice(-2000);

    const plan = launcher.planLaunch(project);
    const prompt = `هذا المشروع يفشل عند التشغيل (أمر التشغيل من نوع ${plan.kind}). إليك مخرجات الخطأ:\n${errorContext}\nأصلح المشروع ليعمل بنجاح: عالج خطأ الكود/الاستيراد، وإن لزم ثبّت الحزم الناقصة (npm install). لا تغيّر وظيفة المشروع ولا تعد كتابته من الصفر — أصلح فقط ما يمنع التشغيل.`;

    const delegateResult = await runDelegate(delegate, verifyCmd, prompt, project.path);
    const parsed = parseJSONFromOutput(delegateResult.stdout);

    const verify = parsed.verify;
    const summary = (parsed.summary || '').trim();
    const errorContextHadOutput = errorContext.length > 0;

    // The agent is always invoked with --verify, so a missing verify block
    // means it exited before running the check — not that the project is
    // fine. Reporting ok:true here is what produced 23 consecutive results
    // reading {"ok":true,"fixed":false,"verified":false,"summary":""}: the UI
    // showed a success for a fix that never happened.
    if (!verify) {
      const result = {
        ok: false,
        verified: false,
        fixed: false,
        // The agent's own summary is kept, but never on its own: an optimistic
        // "I fixed it" with no verification behind it is exactly the false
        // signal this change exists to remove.
        summary: summary
          ? `⚠ لم يُنفَّذ التحقق — ما يلي ادّعاء الوكيل فقط: ${summary}`
          : 'الوكيل خرج دون تنفيذ أمر التحقق — لم يُطبَّق أي إصلاح.',
        verifyExit: null,
        errorContextHadOutput,
        restore: delegateResult.restore || null
      };
      recordFixAttempt(project, trigger, startedAt, result, delegateResult.restore);
      return result;
    }

    // One honest signal. `fixed` used to be a second copy of the same
    // expression as `verified`, so it could never disagree and never added
    // information; it is kept only because the UI still reads both.
    const verified = verify.ok === true;
    const result = {
      ok: true,
      verified,
      fixed: verified,
      summary,
      verifyExit: verify.exitCode !== undefined ? verify.exitCode : null,
      errorContextHadOutput,
      restore: delegateResult.restore || null
    };
    recordFixAttempt(project, trigger, startedAt, result, delegateResult.restore);
    return result;
  } catch (err) {
    const result = {
      ok: false,
      verified: false,
      fixed: false,
      summary: 'خطأ: ' + err.message
    };
    // Failures are exactly what needs measuring, so the exception path logs
    // too — otherwise the history would only ever record successes.
    recordFixAttempt(project, trigger, startedAt, result, null);
    return result;
  }
}

module.exports = {
  fixProject,
  runVerifier,
  runDelegate,
  parseJSONFromOutput
};
