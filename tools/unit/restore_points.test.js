// Maktaba stashes a project's uncommitted work before letting an AI agent
// write to it. Putting that work back runs at exactly one place in the code, so
// any run that does not reach it leaves the stash behind — and until this
// ledger existed, nothing recorded that it had.
//
// Found on this machine: three maktaba-autofix stashes, none returned. Two held
// only .acp-sessions tool files. The third held nineteen files the user needed,
// including tools/acp_api_delegate.py, which their own instructions tell Claude
// to run. The folder looked finished. Nothing in the app could have said
// otherwise.
//
// These assertions cover the two things that make the feature trustworthy:
// that a stash's real contents are seen (untracked files included), and that
// returning work never destroys anything.

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

process.env.MAKTABA_RESTORE_LEDGER = path.join(TMP, 'ledger.jsonl');
const rp = require('../../lib/restorePoints');
const snapshotGuard = require('../../lib/snapshotGuard');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Builds a repository with one committed file, one edit to it, and untracked
 * files of both kinds — tool leftovers and real work.
 *
 * @param {string} name Directory name
 * @returns {string} Repository path
 */
function makeRepo(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'launch.bat'), 'echo original\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
  return dir;
}

// --- a stash's real contents --------------------------------------------------
const repo = makeRepo('mixed');
fs.writeFileSync(path.join(repo, 'launch.bat'), 'echo edited by the user\n');   // tracked edit
fs.mkdirSync(path.join(repo, '.acp-sessions'), { recursive: true });
fs.writeFileSync(path.join(repo, '.acp-sessions', 'session-1.html'), 'tool noise');
fs.writeFileSync(path.join(repo, 'my_script.py'), 'print("real work")\n');      // untracked real work

const taken = snapshotGuard.snapshot(repo);
check('a dirty repo is snapshotted as a stash', taken.ok === true && taken.kind === 'git-stash', JSON.stringify(taken));
check('the working tree really was emptied by the stash',
  git(['status', '--porcelain'], repo).length === 0);
check('the user file is gone from the folder while stashed',
  fs.existsSync(path.join(repo, 'my_script.py')) === false);

const contents = rp.inspectStash(repo, taken.handle);
check('the tracked edit is seen', contents.tracked.indexOf('launch.bat') !== -1, contents.tracked.join(','));
// The defect this exists to avoid: `git stash show` reports tracked changes
// only. Untracked files live in a third parent it never mentions, so reading
// the tracked side alone reports a stash of 24 files as holding nothing.
check('untracked files are seen too', contents.untracked.length === 2, JSON.stringify(contents.untracked));
check('a stash with real work is not called tooling', contents.toolingOnly === false);
check('a stash with real work says so', contents.holdsRealWork === true);

// --- the ledger ---------------------------------------------------------------
const ledger = rp.list();
check('taking a restore point is written down',
  ledger.some(e => e.event === 'taken' && e.handle === taken.handle), JSON.stringify(ledger));

// --- reconciliation finds what was never returned ----------------------------
const projects = [{ id: 'p1', name: 'mixed', path: repo }];
let state = rp.reconcile(projects);
check('an unreturned stash is found', state.pending.length === 1, JSON.stringify(state.pending));
check('it is not marked as already returned', state.pending[0].alreadyReturned === false);
check('it can be returned onto a clean tree', state.pending[0].canReturn === true);
check('it reports what is inside', state.pending[0].trackedCount === 1 && state.pending[0].untrackedCount === 2);

// --- returning the work -------------------------------------------------------
const returned = rp.returnWork(repo, taken.handle);
check('the work is returned', returned.ok === true, returned.error || '');
check('the user file is back on disk', fs.existsSync(path.join(repo, 'my_script.py')) === true);
check('the tracked edit is back in the tree',
  fs.readFileSync(path.join(repo, 'launch.bat'), 'utf8').indexOf('edited by the user') !== -1);
// apply, never pop: using a restore point must not consume it.
check('the stash still exists after returning',
  git(['stash', 'list'], repo).indexOf('maktaba-autofix') !== -1);
check('the return is written down',
  rp.list().some(e => e.event === 'returned' && e.handle === taken.handle));

state = rp.reconcile(projects);
check('a returned stash is no longer reported as pending work',
  state.pending.length === 1 && state.pending[0].alreadyReturned === true);

// --- refusing to make things worse -------------------------------------------
// The tree is now dirty (the work was just restored into it). Applying again
// would be a merge conflict laid on top of work the user may have continued.
const onDirty = rp.returnWork(repo, taken.handle);
check('returning onto a dirty tree is refused', onDirty.ok === false && /غير محفوظة/.test(onDirty.error), onDirty.error || '');
check('the refusal still hands over the manual command', /stash apply/.test(onDirty.hint));

// --- a stash id is never anything but a stash id -----------------------------
// The value reaches git as an argument, so anything that is not a sha is
// refused before it gets there.
const injected = rp.returnWork(repo, 'HEAD --hard; rm -rf /');
check('a non-sha handle is rejected', injected.ok === false && /غير صالح/.test(injected.error));
const missing = rp.returnWork(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
check('an unknown sha is rejected without acting', missing.ok === false);

// --- tooling-only stashes are reported, but not alarming ---------------------
const toolRepo = makeRepo('tool-only');
fs.mkdirSync(path.join(toolRepo, '.acp-sessions'), { recursive: true });
fs.writeFileSync(path.join(toolRepo, '.acp-sessions', 'sessions.json'), '{}');
fs.writeFileSync(path.join(toolRepo, 'debug.log'), 'noise');
const toolTaken = snapshotGuard.snapshot(toolRepo);
const toolContents = rp.inspectStash(toolRepo, toolTaken.handle);
check('a stash of only tool files is classified as tooling', toolContents.toolingOnly === true,
  JSON.stringify(toolContents.untracked));
check('a tooling-only stash does not claim to hold real work', toolContents.holdsRealWork === false);

// --- somebody else's stash is not Maktaba's to touch -------------------------
const userRepo = makeRepo('user-stash');
fs.writeFileSync(path.join(userRepo, 'launch.bat'), 'echo my own change\n');
git(['stash', 'push', '-m', 'my own work in progress'], userRepo);
const userState = rp.reconcile([{ id: 'u1', name: 'user-stash', path: userRepo }]);
check('a stash the user made themselves is ignored', userState.pending.length === 0,
  JSON.stringify(userState.pending));

// --- a project that is not a repo at all --------------------------------------
const plain = path.join(TMP, 'not-a-repo');
fs.mkdirSync(plain, { recursive: true });
const plainState = rp.reconcile([{ id: 'x', name: 'plain', path: plain }]);
check('a non-repository is skipped without error', plainState.pending.length === 0);
const goneState = rp.reconcile([{ id: 'y', name: 'gone', path: path.join(TMP, 'nope'), missing: true }]);
check('a missing project is skipped without error', goneState.pending.length === 0);

const failed = results.filter(r => !r.pass);
console.log('\nRESTORE_POINTS_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
assert.ok(true);
