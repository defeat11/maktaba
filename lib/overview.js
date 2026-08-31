const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Computes a reliable stack tag list without AI based on file markers and dependencies.
 * 
 * @param {string} projectPath Absolute path to project directory.
 * @param {string} projectType Project classification (Node, Python, PHP, Static, etc.)
 * @returns {string} Comma-separated list of technologies.
 */
function computeStack(projectPath, projectType) {
  const stack = [];

  let pkg = null;
  let allDeps = {};
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {})
      };
      stack.push('Node.js');
    }
  } catch (err) {
    // Ignore read/parse errors
  }

  // Check dependencies
  if (allDeps.next) stack.push('Next.js');
  else if (allDeps.react) stack.push('React');

  if (allDeps.vue) stack.push('Vue');
  if (allDeps.svelte) stack.push('Svelte');
  if (allDeps.vite) stack.push('Vite');
  if (allDeps.express) stack.push('Express');
  if (allDeps.koa) stack.push('Koa');
  if (allDeps.fastify) stack.push('Fastify');

  // File markers
  if (fs.existsSync(path.join(projectPath, 'manage.py'))) {
    stack.push('Django');
    stack.push('Python');
  }

  // Flask check
  let hasFlask = false;
  try {
    const reqPath = path.join(projectPath, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      const content = fs.readFileSync(reqPath, 'utf8');
      if (/flask/i.test(content)) hasFlask = true;
    }
    const pipPath = path.join(projectPath, 'Pipfile');
    if (fs.existsSync(pipPath)) {
      const content = fs.readFileSync(pipPath, 'utf8');
      if (/flask/i.test(content)) hasFlask = true;
    }
  } catch (e) {}

  if (hasFlask) {
    stack.push('Flask');
    stack.push('Python');
  }

  if (projectType === 'Python' && !stack.includes('Python')) {
    stack.push('Python');
  }

  if (projectType === 'PHP') {
    stack.push('PHP');
  }

  if (projectType === 'Static' || fs.existsSync(path.join(projectPath, 'index.html'))) {
    if (!stack.includes('Static HTML')) {
      stack.push('Static HTML');
    }
  }

  // Deduplicate and return joined string
  const uniqueStack = [...new Set(stack)];
  return uniqueStack.join(', ');
}

/**
 * Runs the ACP delegate script to analyze the project in a read-only manner.
 * 
 * @param {string} projectPath Path to the project directory.
 * @param {string} prompt Prompt for the AI agent.
 * @returns {Promise<Object>} Object containing command output and code.
 */
function runDelegate(projectPath, prompt, resolved) {
  // The batch-overview path is the single largest consumer of agent calls
  // (concurrency 4 over the whole catalog) and never imported doctorGuard at
  // all, so the daily cap did not apply to it.
  const doctorGuard = require('./doctorGuard');
  if (!doctorGuard.canSpendBudget()) {
    const status = doctorGuard.getBudgetStatus();
    return Promise.reject(new Error(`تجاوز السقف اليومي لاستدعاءات الذكاء (${status.spent}/${status.limit}).`));
  }
  doctorGuard.recordSpend();

  return new Promise((resolve, reject) => {
    const child = resolved.mode === 'node'
      ? spawn(
          'node',
          [resolved.delegatePath, '--json', '--read-only', prompt],
          {
            cwd: projectPath,
            windowsHide: true,
            env: { ...process.env, ACP_DELEGATE_OPEN: '0' }
          }
        )
      : spawn(
          [resolved.cmd, '--json', '--read-only', `"${prompt.replace(/"/g, '\\"')}"`].join(' '),
          [],
          {
            cwd: projectPath,
            windowsHide: true,
            shell: true,
            env: { ...process.env, ACP_DELEGATE_OPEN: '0' }
          }
        );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // 3 minutes timeout (180000ms)
    const timeout = setTimeout(() => {
      // On Windows the delegate is launched via a shell wrapper (shell: true);
      // child.kill() would only terminate cmd.exe and leak the real process,
      // so kill the whole process tree with taskkill (same pattern as lib/fixer.js).
      try {
        if (process.platform === 'win32') {
          const { execSync } = require('child_process');
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch (err) {
        // Ignore kill errors
      }
      reject(new Error('Process timed out after 180000ms'));
    }, 180000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Parses stdout from the ACP delegate script.
 * Looks for the ACP result block and extracts status and summary.
 * 
 * @param {string} stdout Raw stdout content.
 * @returns {Object} Parsed result.
 */
function parseDelegateJson(stdout) {
  // With --json the delegate prints a single structured JSON object whose
  // `summary` field is the FULL last message (untruncated, formatting preserved),
  // unlike the text block whose summary is collapsed and clipped to 240 chars.
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(stdout.slice(start, end + 1));
    if (typeof obj.summary !== 'string') return null;
    return { ok: obj.status === 'ok', status: obj.status || 'unknown', summary: obj.summary.trim() };
  } catch {
    return null;
  }
}

function parseDelegateOutput(stdout) {
  const blockStartMarker = '===== ACP-DELEGATE-RESULT =====';
  const startIdx = stdout.indexOf(blockStartMarker);
  if (startIdx === -1) {
    return { ok: false, status: 'error', summary: 'Could not find delegate result block.' };
  }

  const contentStart = startIdx + blockStartMarker.length;
  const endIdx = stdout.indexOf('=====', contentStart);
  const block = endIdx === -1 ? stdout.slice(contentStart) : stdout.slice(contentStart, endIdx);

  // Extract status value
  const statusMatch = block.match(/^status:\s*([^\r\n]+)/m);
  const status = statusMatch ? statusMatch[1].trim() : 'unknown';

  // Extract summary text
  const summaryMarker = 'summary:';
  const summaryIdx = block.indexOf(summaryMarker);
  if (summaryIdx === -1) {
    return { ok: false, status, summary: 'Could not find summary in result block.' };
  }

  let summaryContent = block.slice(summaryIdx + summaryMarker.length);
  
  // Strip trailing blocks (like viewer: or replay_html:)
  const stopLabels = ['viewer:', 'replay_html:'];
  let earliestStop = summaryContent.length;
  for (const label of stopLabels) {
    const idx = summaryContent.indexOf(label);
    if (idx !== -1 && idx < earliestStop) {
      earliestStop = idx;
    }
  }
  
  summaryContent = summaryContent.slice(0, earliestStop).trim();

  return {
    ok: status === 'ok',
    status,
    summary: summaryContent
  };
}

/**
 * Generates a detailed AI-based overview and pre-calculated stack of a project.
 * 
 * @param {Object} project The project object containing path and type.
 * @returns {Promise<Object>} Result object { ok, overview, generatedAt, stack }
 */
async function generateOverview(project) {
  const nowStr = new Date().toISOString();
  
  if (!project || !project.path) {
    return { ok: false, overview: 'خطأ: مسار المشروع غير محدد.', generatedAt: nowStr, stack: '' };
  }

  // Compute technology stack tag list without AI
  const stackString = computeStack(project.path, project.type);

  const { resolveDelegate } = require('./acpResolver');
  const resolved = resolveDelegate();
  if (!resolved) {
    return {
      ok: false,
      overview: 'تعذّر العثور على أداة acp — عيّن ACP_DELEGATE_PATH أو ثبّت antigravity-acp.',
      generatedAt: nowStr,
      stack: stackString
    };
  }

  try {
    // Rich, structured Arabic prompt asking for thorough details (up to 350 words)
    const prompt = "مهمة قراءة فقط — لا تعدّل ولا تنشئ ولا تحذف أي ملف. حلّل المشروع في هذا المجلد وأعطني نظرة عامة مفصلة بالعربية (في حدود 350 كلمة) مقسمة بوضوح إلى العناوين التالية:\n## ما هو المشروع\n## اللغة والتقنيات\n## البنية والملفات المهمة\n## طريقة التشغيل والمنفذ\n## ملاحظات ومشاكل";

    const { stdout, stderr } = await runDelegate(project.path, prompt, resolved);

    // Check for authentication issues
    const rawOutputLower = (stdout + '\n' + stderr).toLowerCase();
    if (
      rawOutputLower.includes('auth_required') ||
      rawOutputLower.includes('not logged into antigravity')
    ) {
      const { logError } = require('./logger');
      logError('overview', new Error('Authentication required or not logged into Antigravity.'));
      return {
        ok: false,
        overview: 'تعذّر توليد النظرة العامة — شغّل agy مرة واحدة لتسجيل الدخول ثم أعد المحاولة.',
        generatedAt: nowStr,
        stack: stackString
      };
    }

    // Prefer the JSON result (full, faithful text); fall back to the text block.
    const parsed = parseDelegateJson(stdout) || parseDelegateOutput(stdout);

    if (!parsed.ok) {
      const { logError } = require('./logger');
      logError('overview', new Error(`Delegate execution failed. Status: ${parsed.status}, Summary: ${parsed.summary}`));
      return {
        ok: false,
        overview: 'تعذّر توليد النظرة العامة — شغّل agy مرة واحدة لتسجيل الدخول ثم أعد المحاولة.',
        generatedAt: nowStr,
        stack: stackString
      };
    }

    return {
      ok: true,
      overview: parsed.summary,
      generatedAt: nowStr,
      stack: stackString
    };

  } catch (err) {
    const { logError } = require('./logger');
    logError('overview', err);
    return {
      ok: false,
      overview: 'خطأ: ' + err.message,
      generatedAt: nowStr,
      stack: stackString
    };
  }
}

module.exports = {
  generateOverview
};
