// Establishes, by measurement, everything Maktaba can know about a project
// without asking an AI: what it is written in, how it starts, what it depends
// on, whether it is under version control, whether it is running right now, and
// whether it is the kind of program that can disturb the rest of the machine.
//
// Deliberately deterministic. The AI overview path costs agent budget and
// produces prose that can be wrong; everything here is read off the disk and is
// either true or absent. That makes it safe to run across the whole catalogue
// as often as wanted.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { logError } = require('./logger');

// Directories that are never the project's own code.
const HEAVY_DIRS = new Set(['node_modules', '.git', 'venv', '.venv', 'env',
  '__pycache__', 'dist', 'build', '.next', 'target', 'vendor', '.gradle']);

const MANIFESTS = [
  { file: 'package.json', runtime: 'Node.js', manager: 'npm' },
  { file: 'requirements.txt', runtime: 'Python', manager: 'pip' },
  { file: 'pyproject.toml', runtime: 'Python', manager: 'pip' },
  { file: 'Pipfile', runtime: 'Python', manager: 'pipenv' },
  { file: 'composer.json', runtime: 'PHP', manager: 'composer' },
  { file: 'pom.xml', runtime: 'Java', manager: 'maven' },
  { file: 'build.gradle', runtime: 'Java', manager: 'gradle' },
  { file: 'build.gradle.kts', runtime: 'Java', manager: 'gradle' },
  { file: 'Cargo.toml', runtime: 'Rust', manager: 'cargo' },
  { file: 'go.mod', runtime: 'Go', manager: 'go' }
];

function readSafe(file, limit) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > (limit || 512 * 1024)) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
}

function listSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return []; }
}

/**
 * Walks a project counting its own files and bytes, skipping dependency and
 * build directories so the number describes the work rather than the toolchain.
 *
 * @param {string} root Project directory
 * @param {number} cap Stop counting past this many bytes
 * @returns {{bytes: number, files: number, truncated: boolean}}
 */
function measureSize(root, cap) {
  let bytes = 0, files = 0, truncated = false;
  const stack = [root];
  while (stack.length) {
    if (bytes >= cap) { truncated = true; break; }
    const dir = stack.pop();
    for (const entry of listSafe(dir)) {
      if (entry.isDirectory()) {
        if (!HEAVY_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        files++;
        try { bytes += fs.statSync(path.join(dir, entry.name)).size; } catch (err) { /* skip */ }
      }
    }
  }
  return { bytes, files, truncated };
}

function gitFacts(root) {
  const out = { isRepo: false, commits: 0, branch: null, remote: null, dirty: null, lastCommit: null };
  const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    if (run(['rev-parse', '--is-inside-work-tree']) !== 'true') return out;
    out.isRepo = true;
  } catch (err) {
    return out;
  }
  // A repository with no commits has no HEAD, which is a real and common state.
  try { out.commits = parseInt(run(['rev-list', '--count', 'HEAD']), 10) || 0; } catch (err) { out.commits = 0; }
  try { out.branch = run(['rev-parse', '--abbrev-ref', 'HEAD']); } catch (err) { /* no HEAD yet */ }
  try { out.remote = run(['remote', 'get-url', 'origin']) || null; } catch (err) { /* no remote */ }
  try { out.dirty = run(['status', '--porcelain']).split('\n').filter(Boolean).length; } catch (err) { /* ignore */ }
  try { out.lastCommit = run(['log', '-1', '--format=%cI %s']).slice(0, 160) || null; } catch (err) { /* none */ }
  return out;
}

function detectRuntime(root) {
  const manifests = [];
  let runtime = null, manager = null;
  for (const m of MANIFESTS) {
    if (fs.existsSync(path.join(root, m.file))) {
      manifests.push(m.file);
      if (!runtime) { runtime = m.runtime; manager = m.manager; }
    }
  }
  if (!runtime) {
    // Fall back to what the top level is actually made of.
    const exts = {};
    for (const e of listSafe(root)) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ext) exts[ext] = (exts[ext] || 0) + 1;
    }
    if (exts['.py']) runtime = 'Python';
    else if (exts['.js'] || exts['.mjs']) runtime = 'Node.js';
    else if (exts['.ps1']) runtime = 'PowerShell';
    else if (exts['.bat'] || exts['.cmd']) runtime = 'Batch';
    else if (exts['.html']) runtime = 'Static';
  }
  return { runtime: runtime || 'Unknown', manager, manifests };
}

function readDependencies(root, manager) {
  try {
    if (manager === 'npm') {
      const pkg = JSON.parse(readSafe(path.join(root, 'package.json')) || '{}');
      const deps = Object.keys(pkg.dependencies || {});
      const dev = Object.keys(pkg.devDependencies || {});
      return { count: deps.length + dev.length, names: deps.slice(0, 30), scripts: Object.keys(pkg.scripts || {}), declaredMain: pkg.main || null };
    }
    if (manager === 'pip' || manager === 'pipenv') {
      const req = readSafe(path.join(root, 'requirements.txt'));
      if (req) {
        const names = req.split(/\r?\n/).map(l => l.trim())
          .filter(l => l && !l.startsWith('#'))
          .map(l => l.split(/[<>=!\[; ]/)[0]).filter(Boolean);
        return { count: names.length, names: names.slice(0, 30), scripts: [], declaredMain: null };
      }
    }
  } catch (err) { /* fall through */ }
  return { count: 0, names: [], scripts: [], declaredMain: null };
}

/**
 * A one-line statement of what the project is, taken from its own README —
 * the first real sentence, not a heading or a badge.
 *
 * @param {string} root Project directory
 * @returns {string|null}
 */
function readPurpose(root) {
  for (const name of ['README.md', 'readme.md', 'README.txt', 'SPEC.md']) {
    const text = readSafe(path.join(root, name), 200 * 1024);
    if (!text) continue;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#') || line.startsWith('![') || line.startsWith('[!') ||
          line.startsWith('---') || line.startsWith('```') || line.startsWith('|') ||
          line.startsWith('<') || line.startsWith('>')) continue;
      // A line that is only a link, badge or tag says nothing about the project.
      const plain = line.replace(/<[^>]*>/g, '').replace(/[*_`]/g, '').trim();
      if (plain.length < 12) continue;
      return plain.slice(0, 240);
    }
  }
  return null;
}

/**
 * Flags that matter for whether this program is safe to launch automatically.
 * The doctor scan learned this the hard way: launching a project that was
 * itself a watchdog killed the server mid-scan.
 *
 * @param {string} root Project directory
 * @returns {{isWatchdog: boolean, killsProcesses: boolean, autoStarts: boolean, evidence: Array<string>}}
 */
function riskFlags(root) {
  const evidence = [];
  let isWatchdog = false, killsProcesses = false, autoStarts = false;

  const WATCH_NAME = /guardian|watchdog|supervisor|daemon|keeper|autostart/i;
  const KILL_CODE = /taskkill|Stop-Process|Get-NetTCPConnection|process\.kill\(|killall|pkill/;
  const AUTOSTART = /schtasks|Register-ScheduledTask|CurrentVersion\\\\Run|shell:startup/i;

  const entries = listSafe(root).filter(e => e.isFile()).slice(0, 120);
  for (const e of entries) {
    if (WATCH_NAME.test(e.name)) { isWatchdog = true; evidence.push('file: ' + e.name); }
    if (!/\.(js|mjs|cjs|py|ps1|bat|cmd|sh|vbs)$/i.test(e.name)) continue;
    const src = readSafe(path.join(root, e.name), 300 * 1024);
    if (!src) continue;
    if (!killsProcesses && KILL_CODE.test(src)) { killsProcesses = true; evidence.push('kills processes in ' + e.name); }
    if (!autoStarts && AUTOSTART.test(src)) { autoStarts = true; evidence.push('registers autostart in ' + e.name); }
  }
  return { isWatchdog, killsProcesses, autoStarts, evidence: evidence.slice(0, 6) };
}

/**
 * Ports the project's own files mention, so Maktaba knows what it will occupy
 * before it is started.
 *
 * @param {string} root Project directory
 * @returns {Array<number>}
 */
function declaredPorts(root) {
  const found = new Set();
  const entries = listSafe(root).filter(e => e.isFile()).slice(0, 60);
  for (const e of entries) {
    if (!/\.(js|mjs|cjs|py|json|env|ini|yml|yaml|bat|ps1)$/i.test(e.name)) continue;
    const src = readSafe(path.join(root, e.name), 200 * 1024);
    if (!src) continue;
    // Require the number to stand alone. Without the trailing boundary this
    // matched the first octet of 127.0.0.1 and reported port 127.
    const re = /(?:port|PORT)\s*[:=]\s*['"]?(\d{2,5})(?![\d.])/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const n = parseInt(m[1], 10);
      if (n >= 80 && n <= 65535) found.add(n);
      if (found.size > 8) break;
    }
  }
  return [...found].sort((a, b) => a - b);
}

function qualityMarkers(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  const hasDir = (d) => { try { return fs.statSync(path.join(root, d)).isDirectory(); } catch (e) { return false; } };
  return {
    readme: has('README.md') || has('readme.md') || has('README.txt'),
    tests: hasDir('tests') || hasDir('test') || hasDir('__tests__') ||
           listSafe(root).some(e => e.isFile() && /(^|[._-])(test|spec)[._-]|\.test\.|\.spec\./i.test(e.name)),
    dockerfile: has('Dockerfile') || has('docker-compose.yml'),
    ci: hasDir('.github') || has('.gitlab-ci.yml'),
    gitignore: has('.gitignore'),
    license: has('LICENSE') || has('LICENSE.md'),
    env: has('.env') || has('.env.example'),
    venv: hasDir('venv') || hasDir('.venv'),
    installedDeps: hasDir('node_modules') || hasDir('venv') || hasDir('.venv')
  };
}

/**
 * Builds the full profile for one project.
 *
 * @param {Object} project Catalogue row (needs path, and optionally entryFile)
 * @returns {Object|null} Profile, or null when the folder is unreadable
 */
function profileProject(project) {
  const root = project && project.path;
  if (!root || !fs.existsSync(root)) return null;

  try {
    const rt = detectRuntime(root);
    const deps = readDependencies(root, rt.manager);
    const size = measureSize(root, 2 * 1024 * 1024 * 1024);
    const git = gitFacts(root);
    const risk = riskFlags(root);

    let lastModified = null;
    try { lastModified = fs.statSync(root).mtime.toISOString(); } catch (err) { /* ignore */ }

    return {
      profiledAt: new Date().toISOString(),
      runtime: rt.runtime,
      packageManager: rt.manager,
      manifests: rt.manifests,
      purpose: readPurpose(root),
      entry: {
        recorded: project.entryFile || null,
        declaredMain: deps.declaredMain,
        // A recorded entry that is not on disk is why several projects were
        // wrongly reported broken.
        recordedExists: project.entryFile ? fs.existsSync(path.join(root, project.entryFile)) : null
      },
      scripts: deps.scripts,
      dependencies: { count: deps.count, names: deps.names },
      declaredPorts: declaredPorts(root),
      git,
      size: { bytes: size.bytes, megabytes: Math.round(size.bytes / 1024 / 1024 * 10) / 10, files: size.files, truncated: size.truncated },
      quality: qualityMarkers(root),
      risk,
      lastModified
    };
  } catch (err) {
    logError('profiler', err);
    return null;
  }
}

module.exports = { profileProject, measureSize, gitFacts, riskFlags, declaredPorts, readPurpose };
