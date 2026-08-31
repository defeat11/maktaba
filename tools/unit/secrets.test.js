// Whether a project committed a credentials file.
//
// The rule this check lives or dies by: it reads file NAMES and git flags, and
// never the contents of anything. That keeps it a library check rather than a
// security scanner — and it means the report has to be honest about what a name
// can and cannot prove.
//
// Measured across 69 catalogued repositories: two with a certain leak (two .pem
// private keys in a repo pushed to the user's own GitHub, and a .env pair), and
// four tracking a .npmrc, which usually holds only a registry setting.
//
// Both halves matter. Missing the .pem files is the obvious failure. Reporting
// four .npmrc files at the same volume is the quieter one: a report that cries
// wolf is the report nobody reads on the day a real key appears in it.

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const secrets = require('../../lib/secrets');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// --- what counts as a credentials file --------------------------------------
const CERTAIN = ['.env', '.env.local', 'frontend/.env.production', 'credentials.json',
  'service-account-key.json', 'certs/asa.pem', 'keys/id_rsa', 'client.p12', 'cert.pfx'];
for (const f of CERTAIN) {
  check('certain: ' + f, secrets.secretConfidence(f) === 'certain', String(secrets.secretConfidence(f)));
}

const POSSIBLE = ['.npmrc', '.pypirc', '.netrc'];
for (const f of POSSIBLE) {
  check('possible: ' + f, secrets.secretConfidence(f) === 'possible', String(secrets.secretConfidence(f)));
}

const NOT_SECRETS = ['README.md', 'src/index.js', 'environment.ts', 'package.json',
  'docs/environment-setup.md', 'env.d.ts'];
for (const f of NOT_SECRETS) {
  check('not a secret: ' + f, secrets.secretConfidence(f) === null, String(secrets.secretConfidence(f)));
}

// --- templates are meant to be committed ------------------------------------
// This is the difference between a report worth reading and noise: the profile's
// existing quality.env marker is true for 48 projects while only 25 hold a real
// .env, precisely because it counts these.
const TEMPLATES = ['.env.example', '.env.sample', '.env.template', 'credentials.json.example'];
for (const f of TEMPLATES) {
  check('template is not a leak: ' + f, secrets.isExample(f) === true);
}
check('a real .env is not treated as a template', secrets.isExample('.env') === false);
check('a real .env.local is not treated as a template', secrets.isExample('.env.local') === false);
// A path can contain the word "example" without the file being one.
check('a folder named examples does not excuse the file inside it',
  secrets.isExample('examples/.env') === false, 'examples/.env');

// --- against a real repository ----------------------------------------------
function makeRepo(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  return dir;
}

const leaky = makeRepo('leaky');
fs.writeFileSync(path.join(leaky, '.env'), 'API_KEY=whatever\n');
fs.writeFileSync(path.join(leaky, '.env.example'), 'API_KEY=\n');
fs.writeFileSync(path.join(leaky, '.npmrc'), 'registry=https://registry.npmjs.org\n');
fs.writeFileSync(path.join(leaky, 'README.md'), '# hi\n');
git(['add', '-A'], leaky);
git(['commit', '-q', '-m', 'oops'], leaky);

let scan = secrets.scanProject(leaky);
check('a tracked .env is found', scan.tracked.indexOf('.env') !== -1, JSON.stringify(scan.tracked));
check('the template is not reported as tracked work',
  scan.tracked.indexOf('.env.example') === -1 && scan.examples.indexOf('.env.example') !== -1);
check('ordinary files are ignored', scan.tracked.indexOf('README.md') === -1);
check('a repo with no remote says so', scan.hasRemote === false);

// --- a file present but correctly ignored is not a leak ---------------------
const safe = makeRepo('safe');
fs.writeFileSync(path.join(safe, '.gitignore'), '.env\n');
fs.writeFileSync(path.join(safe, '.env'), 'API_KEY=whatever\n');
fs.writeFileSync(path.join(safe, 'app.js'), 'console.log(1)\n');
git(['add', '-A'], safe);
git(['commit', '-q', '-m', 'clean'], safe);

scan = secrets.scanProject(safe);
// The whole point of asking git rather than the filesystem: the file is right
// there on disk, and it is not a leak because git was told to skip it.
check('an ignored .env on disk is not reported', scan.tracked.length === 0, JSON.stringify(scan.tracked));

// --- a remote raises the stakes ---------------------------------------------
git(['remote', 'add', 'origin', 'https://github.com/example/repo.git'], leaky);
scan = secrets.scanProject(leaky);
check('a remote is detected', scan.hasRemote === true);
check('the remote url is reported', /github\.com\/example\/repo/.test(scan.remote || ''), scan.remote || '');

// --- across the catalogue ----------------------------------------------------
const projects = [
  { id: 'a', name: 'leaky', path: leaky },
  { id: 'b', name: 'safe', path: safe },
  { id: 'c', name: 'gone', path: path.join(TMP, 'nope'), missing: true },
  { id: 'd', name: 'plain', path: TMP }
];
const all = secrets.scanAll(projects);
check('only the leaking repo is reported', all.exposed.length === 1 && all.exposed[0].projectName === 'leaky',
  JSON.stringify(all.exposed.map(e => e.projectName)));
check('certain and possible are separated',
  all.exposed[0].certain.indexOf('.env') !== -1 && all.exposed[0].possible.indexOf('.npmrc') !== -1,
  JSON.stringify(all.exposed[0]));

// The remedy is text to read, never an action taken. Rewriting git history is
// irreversible, and it is not Maktaba's call to make on someone's repository.
check('a fix is offered as a command, not performed', Array.isArray(all.exposed[0].fix)
  && /rm --cached/.test(all.exposed[0].fix[0]));
check('the file is still tracked after scanning — nothing was changed',
  git(['ls-files'], leaky).indexOf('.env') !== -1);

// --- degenerate input --------------------------------------------------------
check('a non-repository is skipped', secrets.scanProject(path.join(TMP, 'nothing-here')).checked === false);
check('no path does not throw', secrets.scanProject('').isRepo === false);
check('no projects yields nothing', secrets.scanAll([]).exposed.length === 0);
check('undefined does not throw', secrets.scanAll(undefined).exposed.length === 0);

const failed = results.filter(r => !r.pass);
console.log('\nSECRETS_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
assert.ok(true);
