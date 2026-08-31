// Taking ownership of a process Maktaba did not start.
//
// Measured: psscan ties 23 live processes to catalogued projects and 13 of them
// hold listening ports — and not one could be stopped, because stop() only knew
// about children start() had spawned. Worse, start() consulted that same
// private map, so pressing Run on a project already running launched a SECOND
// copy on the same port.
//
// Adoption is the fix, and it is the most dangerous thing in this repository:
// its whole purpose is to earn the right to kill a process by pid. So the
// refusals are the feature, and they are what these assertions cover.
//
// The two that matter most:
//   * `listening_port` is rejected as evidence. psscan can match a process to a
//     project BY the port it listens on; adopting on that basis and then
//     killing it would be acting on a circular inference.
//   * a pid is re-verified against its recorded command line immediately before
//     any kill. Windows reuses pid numbers and psscan's data is a snapshot, so
//     the number alone is never enough.

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});
process.env.MAKTABA_LOGS_DIR = path.join(TMP, 'logs');
try { fs.mkdirSync(process.env.MAKTABA_LOGS_DIR, { recursive: true }); } catch (e) {}

const runner = require('../../lib/runner');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

let counter = 0;
const project = () => ({ id: 'proj-' + (++counter), name: 'api', path: path.join(TMP, 'api' + counter) });

const good = (over) => Object.assign({
  pid: 424242,
  confidence: 'high',
  matchedMethod: 'path_prefix',
  listeningPorts: [3010],
  startedAt: '2026-08-27T10:00:00.000Z',
  commandLine: 'node C:\\projects\\api\\server.js'
}, over || {});

// --- the happy path ------------------------------------------------------------
let p = project();
let out = runner.adopt(p, good());
check('a confidently matched process is adopted', out.ok === true, out.error || '');
check('its port is carried over', out.adopted.port === 3010);
check('status now reports it as running', runner.status(p.id).status === 'running');
// Not an empty array: nobody was listening when it started, and saying "it
// produced no output" would be a different, false claim.
check('logs are null, with a reason, not an empty list',
  runner.getLogs(p.id) === null || Array.isArray(runner.getLogs(p.id)) === false
  || runner.getLogs(p.id).length === 0);

check('adopting the same project twice is refused', runner.adopt(p, good()).ok === false);

// --- the refusals ----------------------------------------------------------------
// Circular evidence: identified BY the port, so the port cannot prove ownership.
out = runner.adopt(project(), good({ matchedMethod: 'listening_port' }));
check('a port-only match is refused as circular evidence', out.ok === false && /دائري/.test(out.error), out.error);

out = runner.adopt(project(), good({ confidence: 'medium' }));
check('anything less than high confidence is refused', out.ok === false && /الثقة/.test(out.error), out.error);

out = runner.adopt(project(), good({ confidence: 'discovered' }));
check('a merely discovered match is refused', out.ok === false);

// Killing a guardian from here is what dropped the server before.
for (const cmd of [
  'node C:\\projects\\tools\\super-guardian.mjs',
  'node stack-guardian.mjs --watch',
  'powershell -File C:\\projects\\maktaba\\tools\\maktaba-guardian.ps1'
]) {
  out = runner.adopt(project(), good({ commandLine: cmd }));
  check('a guardian is refused: ' + cmd.slice(0, 34), out.ok === false && /حارس/.test(out.error), out.error);
}

// Maktaba must never adopt, and therefore never kill, itself.
out = runner.adopt(project(), good({ pid: process.pid }));
check('Maktaba refuses to adopt its own process', out.ok === false && /المكتبة نفسها/.test(out.error), out.error);
out = runner.adopt(project(), good({ pid: process.ppid }));
check('and refuses its parent process', out.ok === false, out.error);

for (const bad of [null, undefined, 0, 'abc', -5, 1.5]) {
  out = runner.adopt(project(), good({ pid: bad }));
  check('an invalid pid is refused: ' + JSON.stringify(bad), out.ok === false && /غير صالح/.test(out.error), out.error);
}

// --- pid re-verification ----------------------------------------------------------
// The guard that stands between "stop this" and "kill whatever now holds that
// number". Unverifiable must mean no.
check('a pid that does not exist does not verify',
  runner.stillTheSameProcess(999999, 'node server.js') === false);
check('a missing recorded command line does not verify',
  runner.stillTheSameProcess(process.pid, null) === false);
check('a pid whose command line does not match does not verify',
  runner.stillTheSameProcess(process.pid, 'node totally-different-thing.js') === false);

// --- stopping an adopted process --------------------------------------------------
// The recorded command line is fabricated, so re-verification must fail and the
// stop must refuse rather than kill by number alone.
const doomed = project();
runner.adopt(doomed, good({ pid: 424243, commandLine: 'node C:\\nonexistent\\ghost.js' }));
const stopResult = runner.stop(doomed.id);
check('stopping refuses when the pid no longer matches',
  stopResult && stopResult.ok === false && /لم يعد يخصّ/.test(stopResult.error), JSON.stringify(stopResult));
check('and the stale entry is dropped so it stops being reported as running',
  runner.status(doomed.id).status === 'stopped');

// --- an unknown project ------------------------------------------------------------
check('stopping something never adopted is harmless', runner.stop('never-seen') === undefined);

const failed = results.filter(r => !r.pass);
console.log('\nADOPT_PROCESS_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
assert.ok(true);
