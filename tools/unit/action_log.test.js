// The decision log, and the one rule it exists to enforce.
//
// Measured in app.log before this existed: 219 lines for starting a project,
// 10 for stopping one, and ZERO for changing a port or setting a
// classification. Those two changed the catalogue silently — no record of the
// old value, no way back.
//
// The rule: `undo` carries a payload written down WHEN THE ACTION HAPPENED, and
// undoing replays exactly that payload. It must never work out an inverse at
// undo time. An inverse derived later is a guess about a state that has since
// moved, and applying it creates a second problem instead of removing the
// first. The assertions below are what stop that from creeping back in.

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alog-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

const LOG = path.join(TMP, 'actions.jsonl');
// Set before the module under test is required. Proving a guard works calls
// logError, and without this those records land in the fleet's real
// logs/error.log, where truth-check counts them as production failures — the
// suite making the project look ill by being run.
process.env.MAKTABA_LOGS_DIR = path.join(TMP, 'logs');
try { fs.mkdirSync(process.env.MAKTABA_LOGS_DIR, { recursive: true }); } catch (e) {}
process.env.MAKTABA_ACTION_LOG = LOG;

const actionLog = require('../../lib/actionLog');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

// --- recording ---------------------------------------------------------------
const first = actionLog.record({
  action: 'set-port',
  projectId: 'p1',
  projectName: 'photo',
  before: 3010,
  after: 3099,
  undo: { type: 'set-port', port: 3010, userPortSet: false }
});

check('an action is recorded', first !== null && first.seq === 1, JSON.stringify(first));
check('it keeps the old value', first.before === 3010 && first.after === 3099);
check('it carries the payload that reverses it',
  first.undo.type === 'set-port' && first.undo.port === 3010);
check('it is stamped with a time', typeof first.ts === 'string' && first.ts.length > 10);

const second = actionLog.record({
  action: 'classify', projectId: 'p2', projectName: 'ui', before: null, after: 'not-project',
  undo: { type: 'set-classification', value: null }
});
check('sequence numbers climb', second.seq === 2);

// --- what has no honest reverse ----------------------------------------------
// Restarting a program is a new launch, not the undoing of a stop: the process
// and its state are gone. Offering "undo" there would promise something the
// button cannot deliver.
const stopped = actionLog.record({
  action: 'stop', projectId: 'p3', projectName: 'api', before: 'running', after: 'stopped',
  undo: null, undoReason: 'إعادة التشغيل ليست تراجعاً'
});
check('an action with no reverse records why', stopped.undo === null && /تراجع/.test(stopped.undoReason));

let listed = actionLog.list();
check('newest action comes first', listed[0].seq === 3, listed.map(a => a.seq).join(','));
check('an action with a payload is offered as undoable', listed.find(a => a.seq === 1).canUndo === true);
check('an action without one is not', listed.find(a => a.seq === 3).canUndo === false);

// --- undo replays the recorded payload, and only that ------------------------
let replayed = null;
const realExecutor = actionLog.EXECUTORS['set-port'];
actionLog.EXECUTORS['set-port'] = async (payload, entry) => {
  replayed = { payload, entrySeq: entry.seq };
  return { ok: true, detail: 'replayed' };
};

(async () => {
  let out = await actionLog.undo(1);
  check('undo succeeds', out.ok === true, out.error || '');
  // The heart of it: what reached the executor is the object stored at record
  // time, byte for byte — not something reconstructed from current state.
  check('the executor receives the RECORDED payload, not a computed one',
    replayed && replayed.payload.port === 3010 && replayed.payload.userPortSet === false,
    JSON.stringify(replayed));
  check('the payload is tied to the right action', replayed.entrySeq === 1);

  // --- undoing is itself recorded, and cannot be repeated ---------------------
  listed = actionLog.list();
  const undoneEntry = listed.find(a => a.seq === 1);
  check('the action is marked undone', undoneEntry.undone === true);
  check('it is no longer offered for undo', undoneEntry.canUndo === false);
  check('the reversal has its own timestamp', typeof undoneEntry.undoneAt === 'string');
  // Append-only: the reversal is a new line, never an edit to the old one.
  const raw = actionLog.readAll();
  check('undoing appends rather than rewrites',
    raw.filter(r => r.action === 'undo' && r.targetSeq === 1).length === 1
    && raw.filter(r => r.seq === 1 && r.action === 'set-port').length === 1);
  check('the original line is untouched',
    raw.find(r => r.seq === 1).undo.port === 3010);

  const twice = await actionLog.undo(1);
  check('the same action cannot be undone twice', twice.ok === false && /بالفعل/.test(twice.error), twice.error);

  // --- refusals ----------------------------------------------------------------
  const missing = await actionLog.undo(999);
  check('an unknown sequence number is refused', missing.ok === false && /لا يوجد/.test(missing.error));

  const notANumber = await actionLog.undo('drop table');
  check('a non-numeric id is refused', notANumber.ok === false && /غير صالح/.test(notANumber.error));

  const noReverse = await actionLog.undo(3);
  check('an action with no payload is refused with its stated reason',
    noReverse.ok === false && /تراجع/.test(noReverse.error), noReverse.error);

  // An undo payload this build cannot replay must be refused, never improvised.
  // Improvising is precisely the computed inverse this module forbids.
  const alien = actionLog.record({
    action: 'something-new', projectId: 'p9', projectName: 'x',
    before: 1, after: 2, undo: { type: 'type-from-a-future-version', value: 1 }
  });
  const refused = await actionLog.undo(alien.seq);
  check('an unknown payload type is refused, not guessed',
    refused.ok === false && /غير معروف/.test(refused.error), refused.error);

  // --- a failing executor must not mark the action undone ---------------------
  actionLog.EXECUTORS['set-port'] = async () => ({ ok: false, error: 'المشروع لم يعد موجوداً في الكتالوج.' });
  const failing = actionLog.record({
    action: 'set-port', projectId: 'gone', projectName: 'gone', before: 1, after: 2,
    undo: { type: 'set-port', port: 1, userPortSet: false }
  });
  const failed = await actionLog.undo(failing.seq);
  check('a failed undo reports the failure', failed.ok === false);
  check('a failed undo leaves the action still undoable',
    actionLog.list().find(a => a.seq === failing.seq).canUndo === true);

  actionLog.EXECUTORS['set-port'] = async () => { throw new Error('boom'); };
  const threw = await actionLog.undo(failing.seq);
  check('an executor that throws is caught, not propagated', threw.ok === false && /فشل التراجع/.test(threw.error));
  check('and the action survives for another attempt',
    actionLog.list().find(a => a.seq === failing.seq).canUndo === true);

  actionLog.EXECUTORS['set-port'] = realExecutor;

  // --- the log stays bounded ---------------------------------------------------
  for (let i = 0; i < 3000; i++) {
    actionLog.record({ action: 'noise', projectId: 'n' + i, projectName: 'n', before: i, after: i + 1, undo: null });
  }
  const size = fs.statSync(LOG).size;
  check('the log is bounded', size < 5 * 1024 * 1024, size + ' bytes');
  const after = actionLog.readAll();
  check('trimming keeps the newest entries',
    after[after.length - 1].projectId === 'n2999', after[after.length - 1].projectId);
  // Rotation drops old lines, so a fresh number must still be higher than
  // anything already in the file — otherwise a new action could collide with a
  // live one and undo the wrong thing.
  const beforeSeq = Math.max.apply(null, after.map(r => r.seq));
  const nextOne = actionLog.record({ action: 'after-trim', projectId: 'z', projectName: 'z', undo: null });
  check('sequence numbers keep climbing after a trim', nextOne.seq > beforeSeq,
    nextOne.seq + ' vs ' + beforeSeq);

  // --- reading a damaged log ---------------------------------------------------
  fs.appendFileSync(LOG, '{ this is not json\n');
  check('a torn line does not break reading', actionLog.list().length > 0);

  const failedChecks = results.filter(r => !r.pass);
  console.log('\nACTION_LOG_TEST: ' + (results.length - failedChecks.length) + '/' + results.length + ' passed');
  if (failedChecks.length) process.exit(1);
  assert.ok(true);
})();
