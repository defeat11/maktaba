// Which executables the process scan asks Windows about.
//
// The list used to be eight names frozen in a query string. Measured cost: 69
// processes visible out of 592, and php.exe serving a CATALOGUED project on
// port 8000 — that project's own row says assignedPort 8000 — invisible not by
// accident but by construction. The port ledger could only call it
// "claimed-but-dark": the catalogue swears a project owns the port, the port is
// alive, and nothing can see what holds it.
//
// The filter is now derived from the languages in the catalogue. That is the
// entire safeguard, and it is what these assertions protect: it can only ever
// grow by a language the user actually writes in, so it can never widen into
// installed software. A catalogue with no PHP in it must not ask about php.exe.
//
// The eight originals are a floor. Anything that removes one narrows what
// Maktaba can see about its own fleet, silently.

const assert = require('node:assert');
const psscan = require('../../lib/psscan');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

const BASE = psscan.BASE_EXECUTABLES;
const build = (projects) => psscan.executablesForCatalogue(projects);

function hasAllBase(list) {
  return BASE.every(exe => list.indexOf(exe) !== -1);
}

// --- the floor ----------------------------------------------------------------
let out = build([]);
check('an empty catalogue still asks about the original eight',
  hasAllBase(out.executables) && out.executables.length === BASE.length, out.executables.join(','));
check('and adds nothing', out.runtimesQueried.length === 0, out.runtimesQueried.join(','));

out = build(undefined);
check('no catalogue at all does not throw', hasAllBase(out.executables));

// --- growth, only by a language the user writes in ------------------------------
out = build([{ id: 'a', name: 'shop', type: 'PHP' }]);
check('a PHP project makes php.exe worth asking about', out.executables.indexOf('php.exe') !== -1);
check('it is reported as the reason', out.runtimesQueried.indexOf('php') !== -1, out.runtimesQueried.join(','));
check('the original eight are untouched', hasAllBase(out.executables));

out = build([{ id: 'b', name: 'svc', type: 'Java' }]);
check('a Java project adds both java hosts',
  out.executables.indexOf('java.exe') !== -1 && out.executables.indexOf('javaw.exe') !== -1);

// --- the guarantee: no project in a language means no query for it ---------------
// This is what stops the filter becoming "every process on the machine".
out = build([
  { id: 'c', name: 'api', type: 'Node' },
  { id: 'd', name: 'tool', type: 'Python' },
  { id: 'e', name: 'site', type: 'Static' }
]);
check('a catalogue with no PHP never asks about php.exe', out.executables.indexOf('php.exe') === -1,
  out.executables.join(','));
check('nor java, ruby, or dotnet',
  ['java.exe', 'javaw.exe', 'ruby.exe', 'dotnet.exe'].every(e => out.executables.indexOf(e) === -1));
check('Node and Python need nothing added — they are already in the floor',
  out.executables.length === BASE.length && out.runtimesQueried.length === 0);

// --- the same language written different ways ------------------------------------
for (const spelling of ['.NET', 'dotnet', 'C#', 'csharp']) {
  out = build([{ id: 'x', name: 'app', type: spelling }]);
  check('"' + spelling + '" resolves to dotnet.exe', out.executables.indexOf('dotnet.exe') !== -1,
    out.executables.join(','));
}

// --- the runtime can come from the measured profile, not just the type ------------
out = build([{ id: 'f', name: 'legacy', type: 'Unknown', profile: JSON.stringify({ runtime: 'PHP' }) }]);
check('a profile stored as a JSON string is read', out.executables.indexOf('php.exe') !== -1);

out = build([{ id: 'g', name: 'legacy2', type: 'Unknown', profile: { runtime: 'Ruby' } }]);
check('a profile stored as an object is read', out.executables.indexOf('ruby.exe') !== -1);

out = build([{ id: 'h', name: 'broken', type: 'Unknown', profile: '{not json' }]);
check('an unparseable profile does not throw', hasAllBase(out.executables));
check('and adds nothing on the strength of garbage', out.executables.length === BASE.length);

// --- projects that are not there ---------------------------------------------------
out = build([{ id: 'i', name: 'deleted', type: 'PHP', missing: true }]);
check('a project missing from disk does not widen the filter',
  out.executables.indexOf('php.exe') === -1, out.executables.join(','));

out = build([null, undefined, { id: 'j' }]);
check('empty rows are skipped without throwing', hasAllBase(out.executables));

// --- hygiene --------------------------------------------------------------------------
out = build([
  { id: 'k', name: 'one', type: 'PHP' },
  { id: 'l', name: 'two', type: 'PHP' },
  { id: 'm', name: 'three', profile: { runtime: 'PHP' } }
]);
const phpCount = out.executables.filter(e => e === 'php.exe').length;
check('a language shared by several projects is asked about once', phpCount === 1, String(phpCount));
check('no duplicates anywhere', new Set(out.executables).size === out.executables.length);

// --- the floor can never shrink ----------------------------------------------------------
// Removing one of these narrows what Maktaba can see about its own fleet, and
// it would do so silently — the scan would simply return fewer rows.
const everyCase = [build([]), build([{ type: 'PHP' }]), build([{ type: 'Java' }]), build([{ type: 'Static' }])];
check('every derivation keeps all eight originals', everyCase.every(r => hasAllBase(r.executables)));
check('the floor still holds the script hosts',
  BASE.indexOf('wscript.exe') !== -1 && BASE.indexOf('powershell.exe') !== -1);

// --- coverage reporting ------------------------------------------------------------------
const coverage = psscan.getCoverage();
check('coverage is exposed', coverage !== null && typeof coverage === 'object');
check('coverage has the four fields the audit reads',
  ['totalProcesses', 'inFilter', 'outOfFilter', 'runtimesQueried'].every(k => k in coverage),
  Object.keys(coverage).join(','));
// The boundary: coverage says how many are outside the filter, never which.
check('coverage reports the remainder as a number, never a list',
  coverage.outOfFilter === null || typeof coverage.outOfFilter === 'number',
  typeof coverage.outOfFilter);

const failed = results.filter(r => !r.pass);
console.log('\nRUNTIME_FILTER_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
assert.ok(true);
