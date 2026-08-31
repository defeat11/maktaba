// The one switch that means "do not launch this program".
//
// Maktaba starts the user's programs by itself. The doctor scan runs every six
// hours and is the only automated task that actually LAUNCHES things, and 53 of
// 145 projects have never been started by it — so the first time it reaches one
// is unattended, at whatever hour the timer fires. lib/profiler.js records what
// that cost once: a watchdog launched by a scan killed the server mid-cycle.
//
// Nothing could have stopped it. excludeFromAutoFix governs AI writes,
// scan-cursor's skip list arms only after two timeouts have already happened,
// and autoStart answers a different question. So this flag exists, and the
// assertions below are about the two ways it could fail to matter: a launch
// path that does not consult it, and a save that silently forgets it.

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quar-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

process.env.MAKTABA_LOGS_DIR = path.join(TMP, 'logs');
try { fs.mkdirSync(process.env.MAKTABA_LOGS_DIR, { recursive: true }); } catch (e) {}

const quarantine = require('../../lib/quarantine');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

// --- reading the flag from either store --------------------------------------
// sqlite hands back 0/1, the JSON mirror hands back a boolean. A launch path
// that only understood one of them would enforce the block half the time.
check('a boolean true is quarantined', quarantine.isQuarantined({ quarantine: true }) === true);
check('sqlite\'s 1 is quarantined', quarantine.isQuarantined({ quarantine: 1 }) === true);
check('a boolean false is not', quarantine.isQuarantined({ quarantine: false }) === false);
check('sqlite\'s 0 is not', quarantine.isQuarantined({ quarantine: 0 }) === false);
check('an absent field is not', quarantine.isQuarantined({ name: 'x' }) === false);
check('a null project is not', quarantine.isQuarantined(null) === false);
// A string is not a decision anyone made; treating it as one would block on junk.
check('a stray string does not count as held', quarantine.isQuarantined({ quarantine: 'maybe' }) === false);

// --- the refusal carries its reason -------------------------------------------
const held = {
  id: 'a', name: 'guardian', quarantine: true,
  quarantineReason: 'يقتل عمليات', quarantineAt: '2026-08-27T18:00:00.000Z'
};
let block = quarantine.launchBlock(held);
check('a held project is blocked', block.blocked === true);
// A block with no explanation reads as a bug six months later.
check('the block carries the written reason', block.reason === 'يقتل عمليات');
check('and when it was set', block.since === '2026-08-27T18:00:00.000Z');

block = quarantine.launchBlock({ id: 'b', name: 'ok' });
check('an unheld project is not blocked', block.blocked === false && block.reason === null);

block = quarantine.launchBlock({ id: 'c', name: 'bare', quarantine: 1 });
check('a held project with no reason still gets a sentence',
  block.blocked === true && typeof block.reason === 'string' && block.reason.length > 10, block.reason);

// --- filtering a launch list ----------------------------------------------------
const list = [
  { id: '1', name: 'api' },
  { id: '2', name: 'watchdog', quarantine: 1 },
  { id: '3', name: 'web', quarantine: false },
  { id: '4', name: 'killer', quarantine: true }
];
const filtered = quarantine.filterLaunchable(list);
check('only the unheld are launchable',
  filtered.allowed.map(p => p.name).join(',') === 'api,web', filtered.allowed.map(p => p.name).join(','));
check('the held are reported, not silently dropped',
  filtered.blocked.map(p => p.name).join(',') === 'watchdog,killer');
check('an empty list is handled', quarantine.filterLaunchable([]).allowed.length === 0);
check('undefined is handled', quarantine.filterLaunchable(undefined).allowed.length === 0);

// --- the suggestion is a suggestion --------------------------------------------
// The profiler measures "this file calls taskkill". That is not the same
// statement as "this program must never run", and only the person who wrote it
// can make the second one.
const projects = [
  { id: 'w', name: 'super-guardian', path: 'C:/x/w', profile: JSON.stringify({
    risk: { isWatchdog: true, killsProcesses: true, evidence: ['taskkill /F', 'restart loop'] } }) },
  { id: 'watch-only', name: 'restarter', path: 'C:/x/r', profile: JSON.stringify({
    risk: { isWatchdog: true, killsProcesses: false, evidence: ['restarts children'] } }) },
  { id: 'kill-only', name: 'cleanup', path: 'C:/x/c', profile: JSON.stringify({
    risk: { isWatchdog: false, killsProcesses: true, evidence: ['taskkill'] } }) },
  { id: 'plain', name: 'site', path: 'C:/x/s', profile: JSON.stringify({ risk: { isWatchdog: false, killsProcesses: false } }) },
  { id: 'held', name: 'already-held', path: 'C:/x/h', quarantine: true, profile: JSON.stringify({
    risk: { isWatchdog: true, killsProcesses: true, evidence: ['taskkill'] } }) },
  { id: 'gone', name: 'deleted', path: 'C:/x/g', missing: true, profile: JSON.stringify({
    risk: { isWatchdog: true, killsProcesses: true, evidence: ['taskkill'] } }) },
  { id: 'noprofile', name: 'unprofiled', path: 'C:/x/n' },
  { id: 'badprofile', name: 'broken', path: 'C:/x/b', profile: '{not json' }
];
const suggested = quarantine.suggestions(projects);
check('only a watchdog that ALSO kills processes is suggested',
  suggested.length === 1 && suggested[0].projectId === 'w', JSON.stringify(suggested.map(s => s.projectId)));
// Either flag alone is ordinary: plenty of tools restart things, and plenty
// deliberately kill processes. The pair is what stopped a doctor scan.
check('a watchdog that kills nothing is not suggested', !suggested.some(s => s.projectId === 'watch-only'));
check('a killer that is not a watchdog is not suggested', !suggested.some(s => s.projectId === 'kill-only'));
check('an already-held project is not suggested again', !suggested.some(s => s.projectId === 'held'));
check('a project missing from disk is not suggested', !suggested.some(s => s.projectId === 'gone'));
check('an unprofiled project is skipped', !suggested.some(s => s.projectId === 'noprofile'));
check('an unparseable profile does not throw', !suggested.some(s => s.projectId === 'badprofile'));
// The evidence is what makes it a suggestion rather than a verdict.
check('the suggestion carries its evidence',
  Array.isArray(suggested[0].evidence) && suggested[0].evidence.length > 0, JSON.stringify(suggested[0]));
check('and says why in words', typeof suggested[0].why === 'string' && suggested[0].why.length > 10);
check('no projects yields no suggestions', quarantine.suggestions([]).length === 0);
check('undefined yields no suggestions', quarantine.suggestions(undefined).length === 0);

// --- the guardian list must match what is really in tools/ ----------------------
// A hand-written regex covered three guardians and missed master-supervisor.js
// and run-guardian-hidden.vbs, both real files. Adopting a guardian is being
// allowed to kill it, and killing one is what dropped the server before — so
// the list is checked against the directory rather than remembered.
const toolsDir = path.join(__dirname, '..');
const realGuardians = fs.readdirSync(toolsDir)
  .filter(f => /guardian|supervisor|watchdog/i.test(f));
for (const f of realGuardians) {
  check('a real file in tools/ is recognised as a guardian: ' + f,
    quarantine.isGuardianCommand('node ' + path.join(toolsDir, f)) === true, f);
}
check('tools/ actually contains guardians to check against', realGuardians.length >= 3,
  realGuardians.join(','));

check('an ordinary command is not a guardian',
  quarantine.isGuardianCommand('node C:/projects/api/server.js') === false);
check('an empty command line is not a guardian', quarantine.isGuardianCommand('') === false);
check('a null command line does not throw', quarantine.isGuardianCommand(null) === false);
// The catch-all: a guardian this repo has not seen yet still must not be killed
// by accident.
check('an unknown watchdog is still caught by name',
  quarantine.isGuardianCommand('python C:/x/my_watchdog_service.py') === true);

// --- the store must not forget it -----------------------------------------------
// This is the failure that would make the whole feature pointless: autoStart is
// false on 164 of 164 rows partly because flags get dropped by a save that
// passes the whole list back. The quarantine is carried forward like `profile`.
const TMP_DB = path.join(TMP, 'db.sqlite');
process.env.MAKTABA_DB = TMP_DB;
process.env.MAKTABA_DB_JSON = path.join(TMP, 'db.json');
const store = require('../../lib/store');

(async () => {
  const seed = [
    { path: path.join(TMP, 'p1'), name: 'one', type: 'Node', lastModified: new Date(), sizeBytes: 1 },
    { path: path.join(TMP, 'p2'), name: 'two', type: 'Node', lastModified: new Date(), sizeBytes: 1 }
  ];
  await store.saveProjects(seed);
  let rows = await store.getProjects();
  check('a fresh row is not quarantined', rows.every(r => r.quarantine === false), JSON.stringify(rows.map(r => r.quarantine)));

  const target = rows.find(r => r.name === 'one');
  const set = await quarantine.setQuarantine(target.id, true, 'يقتل عمليات');
  check('setting the quarantine succeeds', set.ok === true, set.error || '');
  check('the previous value is returned for the undo record', set.before.quarantine === false);

  rows = await store.getProjects();
  const after = rows.find(r => r.name === 'one');
  check('it is held after saving', after.quarantine === true);
  check('the reason survives the round trip', after.quarantineReason === 'يقتل عمليات');
  check('the timestamp is recorded', typeof after.quarantineAt === 'string' && after.quarantineAt.length > 10);
  check('the other project is untouched', rows.find(r => r.name === 'two').quarantine === false);

  // The real test: a save that is not about quarantine at all must not clear it.
  rows.forEach(r => { r.favorite = true; });
  await store.saveProjects(rows);
  const survived = (await store.getProjects()).find(r => r.name === 'one');
  check('an unrelated save does not clear the quarantine', survived.quarantine === true);
  check('nor its reason', survived.quarantineReason === 'يقتل عمليات');

  // And a scan passing rows that carry no quarantine field must not clear it —
  // this is exactly how a flag dies quietly.
  await store.saveProjects(seed.map(p => Object.assign({}, p)), { fromScan: true });
  const afterScan = (await store.getProjects()).find(r => r.name === 'one');
  check('a rescan does not clear the quarantine', afterScan.quarantine === true, JSON.stringify(afterScan.quarantine));

  // --- releasing ---------------------------------------------------------------
  const release = await quarantine.setQuarantine(target.id, false);
  check('releasing succeeds', release.ok === true);
  check('the reason is cleared on release', release.after.quarantineReason === null);
  const released = (await store.getProjects()).find(r => r.name === 'one');
  check('it is launchable again', released.quarantine === false);

  const missing = await quarantine.setQuarantine('no-such-id', true, 'x');
  check('quarantining an unknown project is refused', missing.ok === false);

  const failed = results.filter(r => !r.pass);
  console.log('\nQUARANTINE_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exit(1);
  assert.ok(true);
})();
