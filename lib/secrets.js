// Whether a project is tracking a file that should never have been committed.
//
// Nothing in lib/ ever asked git what it follows: a search for `ls-files` or
// `check-ignore` across the whole codebase returned nothing. The profile has a
// `quality.env` marker, but it is true for 48 projects while only 25 hold a
// real .env — it counts .env.example too, so it says nothing about risk.
//
// Measured across all 69 catalogued repositories on this machine: one tracked
// .env, in a repository that has a GitHub remote.
//
// Hard limits, so this stays a library and does not drift into being a security
// scanner:
//   * file names and git flags only — never the contents of any file
//   * no entropy scoring, no pattern matching on values, no network
//   * nothing outside catalogued project directories
//   * never fixes anything: rewriting git history is exactly the destructive
//     act this project refuses to take on a user's behalf

const path = require('path');
const { execFileSync } = require('child_process');

// Files that hold credentials by convention, split by how certain that is.
//
// The split matters because this check reads names, never contents. A .env or
// a .pem is a credentials file by definition. A .npmrc usually just sets a
// registry and only sometimes carries a token — reporting the two identically
// would produce false alarms, and a report that cries wolf is one nobody reads
// when a real key shows up in it.
const CERTAIN_PATTERNS = [
  /(^|\/)\.env$/i,
  /(^|\/)\.env\.[a-z0-9_-]+$/i,
  /(^|\/)credentials\.json$/i,
  /(^|\/)service-account[a-z0-9_-]*\.json$/i,
  /(^|\/)id_rsa$/i,
  /(^|\/)id_ed25519$/i,
  /\.pem$/i,
  /\.pfx$/i,
  /\.p12$/i
];

const POSSIBLE_PATTERNS = [
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.netrc$/i
];

const SECRET_PATTERNS = CERTAIN_PATTERNS.concat(POSSIBLE_PATTERNS);

// A template is meant to be committed. Counting it as a leak is the false alarm
// that makes people stop reading the report — which is how a real one gets
// missed.
const EXAMPLE_PATTERNS = [
  /\.(example|sample|template|dist|default)$/i,
  /(^|\/)\.env\.(example|sample|template)$/i,
  /example|sample|template/i
];

const MAX_TRACKED_FILES = 200000;

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
    maxBuffer: 32 * 1024 * 1024
  });
}

function gitSafe(args, cwd) {
  try { return git(args, cwd); } catch (err) { return null; }
}

/**
 * Whether a path looks like a credentials file.
 *
 * @param {string} filePath Repo-relative path
 * @returns {boolean}
 */
function isSecretName(filePath) {
  const p = String(filePath || '').split('\\').join('/');
  return SECRET_PATTERNS.some(rx => rx.test(p));
}

/**
 * How sure the name alone allows us to be.
 *
 * This check never opens a file, so "possible" is the honest label for a name
 * that only sometimes carries a credential.
 *
 * @param {string} filePath Repo-relative path
 * @returns {string|null} 'certain', 'possible', or null
 */
function secretConfidence(filePath) {
  const p = String(filePath || '').split('\\').join('/');
  if (CERTAIN_PATTERNS.some(rx => rx.test(p))) return 'certain';
  if (POSSIBLE_PATTERNS.some(rx => rx.test(p))) return 'possible';
  return null;
}

/**
 * Whether a path is a template rather than a real secret.
 *
 * @param {string} filePath Repo-relative path
 * @returns {boolean}
 */
function isExample(filePath) {
  const base = path.basename(String(filePath || '').split('\\').join('/'));
  return EXAMPLE_PATTERNS.some(rx => rx.test(base));
}

/**
 * Asks git what this project is actually tracking.
 *
 * @param {string} projectPath Project directory
 * @returns {{isRepo: boolean, hasRemote: boolean, tracked: Array<string>, examples: Array<string>, checked: boolean}}
 */
function scanProject(projectPath) {
  const out = { isRepo: false, hasRemote: false, tracked: [], examples: [], checked: false };
  if (!projectPath) return out;

  const inside = gitSafe(['rev-parse', '--is-inside-work-tree'], projectPath);
  if (!inside || inside.trim() !== 'true') return out;
  out.isRepo = true;

  const listing = gitSafe(['ls-files'], projectPath);
  if (listing === null) return out;
  out.checked = true;

  const files = listing.split('\n').slice(0, MAX_TRACKED_FILES);
  for (const file of files) {
    const name = file.trim();
    if (!name || !isSecretName(name)) continue;
    if (isExample(name)) out.examples.push(name);
    else out.tracked.push(name);
  }

  // A tracked secret in a repository with no remote is a local mistake. The
  // same file in a repository that pushes somewhere is a different problem, so
  // the two are never reported as one number.
  const remotes = gitSafe(['remote'], projectPath);
  out.hasRemote = remotes !== null && remotes.trim().length > 0;
  if (out.hasRemote) {
    const url = gitSafe(['remote', 'get-url', 'origin'], projectPath);
    out.remote = url ? url.trim() : null;
  }
  return out;
}

/**
 * Runs the check across the catalogue.
 *
 * @param {Array<Object>} projects Catalogue rows
 * @returns {{checked: number, exposed: Array<Object>}}
 */
function scanAll(projects) {
  const exposed = [];
  let checked = 0;

  for (const project of (projects || [])) {
    if (!project || !project.path || project.missing) continue;
    const result = scanProject(project.path);
    if (!result.checked) continue;
    checked++;
    if (!result.tracked.length) continue;
    const certain = result.tracked.filter(f => secretConfidence(f) === 'certain');
    exposed.push({
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      files: result.tracked,
      certain,
      possible: result.tracked.filter(f => secretConfidence(f) === 'possible'),
      hasRemote: result.hasRemote,
      remote: result.remote || null,
      // Handed over as text to run, never run here. Removing a file from git's
      // index is reversible; rewriting history to erase it is not, and that
      // decision belongs to the person whose repository it is.
      fix: result.tracked.map(f =>
        'git -C "' + project.path + '" rm --cached "' + f + '" && echo "' + f + '" >> "' +
        path.join(project.path, '.gitignore') + '"')
    });
  }

  return { checked, exposed };
}

module.exports = { scanProject, scanAll, isSecretName, isExample, secretConfidence,
  SECRET_PATTERNS, CERTAIN_PATTERNS, POSSIBLE_PATTERNS };
