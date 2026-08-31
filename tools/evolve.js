const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { resolveDelegate } = require('../lib/acpResolver');

const root = path.join(__dirname, '..');

// Helper to execute git commands safely
function runGit(args, cwd = root) {
  const result = spawnSync('git', args, {
    cwd: cwd,
    encoding: 'utf8',
    windowsHide: true
  });
  return result;
}

// (A) Verify git repository
try {
  const checkGit = runGit(['rev-parse', '--is-inside-work-tree']);
  if (checkGit.status !== 0) {
    console.error(`Error: "${root}" is not a git repository.`);
    process.exit(1);
  }
} catch (e) {
  console.error(`Error verifying git repository: ${e.message}`);
  process.exit(1);
}

// (B) Read and parse roadmap.md
const roadmapPath = path.join(root, 'roadmap.md');
if (!fs.existsSync(roadmapPath)) {
  console.error(`Error: roadmap.md not found in "${root}"`);
  process.exit(1);
}

function parseRoadmap(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  
  const tasks = [];
  let currentTask = null;
  let inTaskBody = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Match: ### [ ] <id>: <title>
    const headerMatch = line.match(/^###\s+\[\s*([\s\S]*?)\s*\]\s+([^:]+):([\s\S]*)$/);
    if (headerMatch) {
      const status = headerMatch[1].trim().toLowerCase(); // 'x' or ''
      const id = headerMatch[2].trim();
      const title = headerMatch[3].trim();

      if (currentTask) {
        tasks.push(currentTask);
        currentTask = null;
      }

      if (status === 'x') {
        inTaskBody = false;
        continue;
      }

      currentTask = {
        id,
        title,
        verify: 'npm test',
        bodyLines: []
      };
      inTaskBody = true;
      continue;
    }

    // Match section separator or next section
    if (line.trim() === '---' || line.startsWith('##')) {
      if (currentTask) {
        tasks.push(currentTask);
        currentTask = null;
      }
      inTaskBody = false;
      continue;
    }

    if (inTaskBody && currentTask) {
      // Check for verify: **verify:** `command`
      const verifyMatch = line.match(/^\*\*verify:\*\*\s*`([^`]+)`/i);
      if (verifyMatch) {
        currentTask.verify = verifyMatch[1].trim();
      } else {
        currentTask.bodyLines.push(line);
      }
    }
  }

  if (currentTask) {
    tasks.push(currentTask);
  }

  return tasks.map(task => ({
    id: task.id,
    title: task.title,
    verify: task.verify,
    body: task.bodyLines.join('\n').trim()
  }));
}

const allPendingTasks = parseRoadmap(roadmapPath);

// (C) Parse flags
const args = process.argv.slice(2);
let max = 3;
let concurrency = null;
let open = false;
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max' && args[i + 1]) {
    max = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--concurrency' && args[i + 1]) {
    concurrency = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--open') {
    open = true;
  } else if (args[i] === '--dry-run') {
    dryRun = true;
  }
}

// Select only the first max pending tasks
const selectedTasks = allPendingTasks.slice(0, max);

if (selectedTasks.length === 0) {
  console.log('No pending tasks found in roadmap.md.');
  process.exit(0);
}

if (dryRun) {
  console.log(`Dry-run selected tasks (max ${max}):`);
  selectedTasks.forEach(t => {
    console.log(`- ID: ${t.id}`);
    console.log(`  Title: ${t.title}`);
    console.log(`  Verify: ${t.verify}`);
  });
  process.exit(0);
}

// Compute concurrency
if (concurrency === null) {
  const cpus = os.cpus().length;
  const halfCpus = Math.floor(cpus / 2);
  const minCpus = Math.max(1, halfCpus);
  concurrency = Math.min(selectedTasks.length, minCpus);
}

const SAFETY_HEADER = `قيود صارمة: عدّل فقط داخل هذا المشروع. لا تنشئ ملفات تكتب بيانات اختبار. لا تستدعِ saveProjects ولا أي دالة كتابة ببيانات وهمية. لا تحذف أو تفرّغ db.sqlite ولا db.json. لا تلمس قاعدة البيانات. اكتب كوداً نظيفاً متسقاً مع نمط المشروع.

قيد واجهة دائم: أي مهمة تضيف قدرة جديدة للمستخدم تضعها افتراضياً داخل قائمة "الإجراءات" المنسدلة (للشريط العلوي) أو قائمة (⋮) الخاصة بالبطاقة — لا يُضاف زر مرئي جديد أبداً بالشريط العلوي ولا بصف إجراءات البطاقة. الشريط العلوي محدود بأربعة عناصر ثابتة فقط (البحث/الفلترة، إعادة المسح، قائمة "⚡ الإجراءات"، تبديل الوضع الليلي)، وصف إجراءات البطاقة محدود بزرّين فقط (زر أساسي واحد + قائمة ⋮). أي استثناء يتطلب سطراً صريحاً بجسم المهمة يثبت أن القدرة الجديدة تُستخدم يومياً وتُحتاج خلال أقل من ثانيتين — بدون هذا التبرير الصريح، القدرة الجديدة تذهب للقائمة تلقائياً.`;

// Unique smoke-test port per task so parallel verifies don't collide on one port.
let smokePortSeq = 4600;

// Helper to run the delegate agent on a task
function runDelegate(verifyCmd, taskText, wt, smokePort) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const env = {
      ...process.env,
      ACP_AGY_CWD: wt,
      SMOKE_PORT: String(smokePort)
    };
    if (!open) {
      env.ACP_DELEGATE_OPEN = '0';
    }

    // The delegate location is never hardcoded: set ACP_DELEGATE_PATH, or let
    // lib/acpResolver.js find it (env var, config.json, sibling checkout, PATH).
    const resolved = resolveDelegate();
    if (!resolved || resolved.mode !== 'node') {
      resolve({ code: -1, stdout: '', stderr: 'ACP delegate not found. Set ACP_DELEGATE_PATH.' });
      return;
    }

    const cp = spawn(
      'node',
      [
        resolved.delegatePath,
        '--json',
        '--ephemeral',
        '--verify',
        verifyCmd,
        taskText
      ],
      {
        cwd: root,
        env: env,
        windowsHide: true
      }
    );

    cp.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    cp.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    cp.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    cp.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
    });
  });
}

function parseDelegateOutput(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch (err) {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      const block = stdout.substring(start, end + 1);
      try {
        return JSON.parse(block);
      } catch (e) {
        throw new Error('Failed parsing JSON block from stdout: ' + e.message);
      }
    }
    throw new Error('No JSON block found in delegate stdout.');
  }
}

// (D) Execute tasks with concurrency pool
async function runTask(task) {
  const { id, title, verify, body } = task;
  const branch = `evolve/${id}`;
  // Isolated copy lives INSIDE the repo (gitignored) so Node resolves node_modules
  // by directory ascent (maktaba/node_modules). A tmpdir copy can't see the deps,
  // so `npm test` crashes with MODULE_NOT_FOUND for any project that requires a package.
  const wt = path.join(root, '.evolve-worktrees', `${id}-${process.pid}`);

  // Initialize result object
  const taskResult = {
    id,
    title,
    status: 'failed',
    verified: false,
    branch: 'N/A',
    files: [],
    summary: '',
    failReason: ''
  };

  try {
    // 1. Clean up old branch if exists
    runGit(['branch', '-D', branch]);

    // Clean up isolated copy directory if it exists on disk
    if (fs.existsSync(wt)) {
      fs.rmSync(wt, { recursive: true, force: true });
    }
    fs.mkdirSync(wt, { recursive: true });

    // 2. Seed an ISOLATED, STANDALONE copy of HEAD's tracked tree — NOT a
    // `git worktree`. Verified by direct reproduction: the agy CLI resolves
    // its own "active project" by git-repo identity, not literal cwd, so a
    // linked worktree (which shares this repo's identity via a `.git` file
    // pointing back here) gets silently resolved back to THIS checkout
    // instead of the worktree — the agent's edits landed in the live repo,
    // not the isolated copy, and the automated verify-gate below was
    // effectively a no-op. A standalone copy with its own independent `.git`
    // has no such shared identity, so agy correctly treats it as its own
    // project (also verified by reproduction).
    const archive = spawnSync('git', ['archive', 'HEAD'], { cwd: root, windowsHide: true });
    if (archive.status !== 0) {
      throw new Error(`Failed to archive HEAD: ${archive.stderr?.toString() || archive.error?.message}`);
    }
    const untar = spawnSync('tar', ['-xf', '-'], { cwd: wt, input: archive.stdout, windowsHide: true });
    if (untar.status !== 0) {
      throw new Error(`Failed to extract isolated copy: ${untar.stderr?.toString() || untar.error?.message}`);
    }
    runGit(['init', '-q'], wt);
    runGit(['add', '-A'], wt);
    const baseCommit = runGit(['-c', 'user.email=evolve@maktaba.local', '-c', 'user.name=evolve', 'commit', '-q', '-m', 'base', '--no-verify'], wt);
    if (baseCommit.status !== 0) {
      throw new Error(`Failed to create base commit in isolated copy: ${baseCommit.stderr}`);
    }

    // 3. Construct task message
    const taskText = `${SAFETY_HEADER}\n\n${body}`;

    // 4. Invoke delegate and wait (unique smoke port keeps parallel verifies isolated)
    const smokePort = smokePortSeq++;
    const runRes = await runDelegate(verify, taskText, wt, smokePort);

    // 5. Extract JSON output
    let delegateJSON = null;
    try {
      delegateJSON = parseDelegateOutput(runRes.stdout);
    } catch (parseErr) {
      throw new Error(`Failed to parse agent response: ${parseErr.message}\nExit code: ${runRes.code}\nStderr: ${runRes.stderr}`);
    }

    const status = delegateJSON.status;
    const verifyRes = delegateJSON.verify;
    taskResult.files = delegateJSON.files || [];
    taskResult.summary = delegateJSON.summary || '';

    // 6. Make decision
    const isSuccess = (status === 'ok') && verifyRes && (verifyRes.ok === true);
    if (verifyRes && verifyRes.ok) {
      taskResult.verified = true;
    }

    if (isSuccess) {
      // Stage files and check changes (inside the isolated standalone repo)
      runGit(['add', '-A'], wt);
      const statusRes = runGit(['status', '--porcelain'], wt);
      const hasChanges = statusRes.stdout && statusRes.stdout.trim().length > 0;

      if (hasChanges) {
        const commitRes = runGit(['commit', '-m', `evolve(${id}): ${title}`], wt);
        if (commitRes.status === 0) {
          // Import the isolated repo's tip commit into THIS repo as a real
          // local branch via `fetch` — this only transfers objects/refs and
          // never touches this repo's working tree or index, so it's safe
          // even while other tasks run concurrently against the same main
          // checkout. The two repos share no history, so review/merge later
          // needs `git diff`/cherry-pick rather than a plain fast-forward.
          const fetchRes = runGit(['fetch', wt, `HEAD:refs/heads/${branch}`]);
          if (fetchRes.status === 0) {
            taskResult.status = 'passed';
            taskResult.branch = branch;
            // Report the files actually committed (not transient files the agent
            // touched then deleted — those mislead in the report).
            const committed = runGit(['show', '--pretty=format:', '--name-only', branch]);
            if (committed.status === 0 && committed.stdout) {
              const committedFiles = committed.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
              if (committedFiles.length) taskResult.files = committedFiles;
            }
          } else {
            taskResult.status = 'failed';
            throw new Error(`Failed to import isolated commit into main repo: ${fetchRes.stderr}`);
          }
        } else {
          taskResult.status = 'failed';
          throw new Error(`Git commit failed: ${commitRes.stderr}`);
        }
      } else {
        taskResult.status = 'no-changes';
      }
    } else {
      taskResult.status = 'failed';
      const reasons = [];
      if (status !== 'ok') reasons.push(`agent stopReason=${delegateJSON.stopReason || status}`);
      if (verifyRes && verifyRes.ok === false) {
        const lastLine = String(verifyRes.output || '').split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
        reasons.push(`verify FAILED exit=${verifyRes.exitCode}: ${lastLine}`);
      }
      if (!verifyRes && status === 'ok') reasons.push('verify did not run');
      taskResult.failReason = reasons.join(' | ') || 'unknown';
    }

  } catch (err) {
    taskResult.status = 'failed';
    taskResult.summary = `Error: ${err.message}`;
    taskResult.failReason = taskResult.failReason || `Error: ${err.message}`;
  } finally {
    // 7. Remove the isolated copy directory (plain rmdir — it's a standalone
    // repo, not a linked worktree, so there's no `git worktree remove` step).
    if (fs.existsSync(wt)) {
      try {
        fs.rmSync(wt, { recursive: true, force: true });
      } catch (e) {}
    }

    // 8. If task failed or no-changes, delete branch
    if (taskResult.status === 'failed' || taskResult.status === 'no-changes') {
      runGit(['branch', '-D', branch]);
      taskResult.branch = 'N/A';
    }
  }

  return taskResult;
}

// Simple concurrency pool
async function runPool(tasks, limit, runFn) {
  let index = 0;
  const results = [];

  async function worker() {
    while (index < tasks.length) {
      const currentIndex = index++;
      const task = tasks[currentIndex];
      results[currentIndex] = await runFn(task);
    }
  }

  const workers = [];
  const count = Math.min(limit, tasks.length);
  for (let i = 0; i < count; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

// Run evolution loop
runPool(selectedTasks, concurrency, runTask).then(results => {
  // (E) Generate report and output
  
  // Write evolve-report.md
  let reportMd = `# تقرير حلقة التطوير (Evolve Report)\n\n`;
  reportMd += `**تاريخ التشغيل**: ${new Date().toLocaleString('ar-EG')}\n\n`;
  reportMd += `| المهمة (ID) | العنوان | الحالة | التحقق (Verified) | الفرع (Branch) | ملفات معدلة | الملخص |\n`;
  reportMd += `|---|---|---|---|---|---|---|\n`;

  results.forEach(r => {
    const verifiedText = r.verified ? 'نعم' : 'لا';
    const filesText = (r.files && r.files.length > 0) ? r.files.map(f => `\`${f}\``).join(', ') : 'لا يوجد';
    reportMd += `| \`${r.id}\` | ${r.title} | **${r.status}** | ${verifiedText} | \`${r.branch}\` | ${filesText} | ${r.summary || 'لا يوجد'} |\n`;
  });

  reportMd += `\n---\n\n`;
  reportMd += `### خطوات المراجعة والدمج اليدوية\n\n`;

  let hasPassed = false;
  results.forEach(r => {
    if (r.status === 'passed') {
      hasPassed = true;
      reportMd += `#### المهمة \`${r.id}\`:\n`;
      reportMd += `\`\`\`bash\n`;
      reportMd += `git diff main..evolve/${r.id}\n`;
      reportMd += `# evolve/${r.id} is an imported commit from an isolated standalone repo (no shared\n`;
      reportMd += `# history with main), so a plain merge will refuse it — cherry-pick instead:\n`;
      reportMd += `git cherry-pick evolve/${r.id}\n`;
      reportMd += `\`\`\`\n\n`;
    }
  });

  if (!hasPassed) {
    reportMd += `لا توجد فروع ناجحة للدمج.\n\n`;
  }

  reportMd += `> **تذكير هام**: راجع التعديلات يدوياً ثم ادمج؛ لا يوجد دمج تلقائي.\n`;

  fs.writeFileSync(path.join(root, 'evolve-report.md'), reportMd, 'utf8');

  // Print summary to stdout
  console.log(`===== EVOLVE-REPORT =====`);
  results.forEach(r => {
    const verifiedText = r.verified ? 'نعم' : 'لا';
    console.log(`Task ID: ${r.id}`);
    console.log(`- Status: ${r.status}`);
    console.log(`- Verified: ${verifiedText}`);
    console.log(`- Branch: ${r.branch}`);
    if (r.status !== 'passed' && r.failReason) console.log(`- Reason: ${r.failReason}`);
    console.log(`- Files: ${(r.files && r.files.length > 0) ? r.files.join(', ') : 'None'}`);
    console.log(`- Summary: ${r.summary || 'No summary'}`);
    if (r.status === 'passed') {
      console.log(`- Review commands:`);
      console.log(`  git diff main..evolve/${r.id}`);
      console.log(`  git cherry-pick evolve/${r.id}   (unrelated history — not a plain merge)`);
    }
    console.log('');
  });
  console.log(`تذكير: راجع ثم ادمج يدوياً؛ لا دمج تلقائي.`);
  console.log(`=========================`);
});
