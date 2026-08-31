// Who owns each listening port, and how sure Maktaba is allowed to sound.
//
// The existing /api/ports/conflicts compares the catalogue against itself and
// never looks at the machine. Measured on this machine: 67 ports listening, 13
// attributable. One of the invisible ones is php.exe serving a CATALOGUED
// project on port 8000 — the catalogue row even says assignedPort 8000 — which
// psscan cannot see because php.exe is not one of the eight executable names it
// queries.
//
// Two things are asserted hardest here.
//
// First, the honesty of `basis`. psscan can match a process to a project BY the
// port it listens on; citing that process as proof of who owns the port is
// circular. It is still the best available guess, so it is kept and labelled
// 'inferred'. If that label ever silently becomes 'observed', the ledger starts
// asserting things it cannot see.
//
// Second, that `foreign` stays a count. Listing every unrelated port on the
// machine turns a library of your projects into a network monitor.
//
// buildLedger is pure, so none of this needs PowerShell, Docker or a network.

const assert = require('node:assert');
const { buildLedger } = require('../../lib/portLedger');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

const PROJECTS = [
  { id: 'a', name: 'api', assignedPort: 3001 },
  { id: 'b', name: 'web', assignedPort: 3002 },
  { id: 'c', name: 'backend', assignedPort: 8000 },
  { id: 'twin1', name: 'twin-one', assignedPort: 3080 },
  { id: 'twin2', name: 'twin-two', assignedPort: 3080 },
  { id: 'gone', name: 'deleted', assignedPort: 9999, missing: true }
];

function ledgerOf(ports, processRows, containers) {
  return buildLedger({ ports, processRows, projects: PROJECTS, containers: containers || [] });
}

// --- attributed, by seeing the process ---------------------------------------
let out = ledgerOf(
  [{ port: 3001, pid: 100, address: '0.0.0.0', ownerName: 'node' }],
  [{ pid: 100, listeningPorts: [3001], matchedProjectId: 'a', matchedProjectName: 'api', matchedMethod: 'path_prefix' }]
);
check('a port whose process is known is attributed', out.rows[0].verdict === 'attributed', JSON.stringify(out.rows[0]));
check('and that is an observation', out.rows[0].basis === 'observed' && out.rows[0].via === 'process');
check('it names the project', out.rows[0].projectId === 'a');

// --- the circular match must be labelled, not hidden -------------------------
out = ledgerOf(
  [{ port: 3001, pid: 100, address: '0.0.0.0', ownerName: 'node' }],
  [{ pid: 100, listeningPorts: [3001], matchedProjectId: 'a', matchedProjectName: 'api', matchedMethod: 'listening_port' }]
);
check('a process matched BY the port is still attributed', out.rows[0].verdict === 'attributed');
check('but is labelled inferred, not observed', out.rows[0].basis === 'inferred', out.rows[0].basis);

// --- claimed but dark ---------------------------------------------------------
// The php:8000 case. The catalogue claims the port, the port is alive, and the
// owner is invisible. Reporting this as "the project is running" would be a
// claim about something nobody looked at.
out = ledgerOf(
  [{ port: 8000, pid: 777, address: '127.0.0.1', ownerName: 'php' }],
  []
);
check('a claimed port with an unseen owner is dark', out.rows[0].verdict === 'claimed-but-dark', JSON.stringify(out.rows[0]));
check('it is an inference', out.rows[0].basis === 'inferred' && out.rows[0].via === 'declared');
check('it still names the project that claims it', out.rows[0].projectName === 'backend');
check('and keeps the owner name it did see', out.rows[0].ownerName === 'php');
check('the count reflects it', out.claimedButDark === 1);

// --- contested -----------------------------------------------------------------
out = ledgerOf([{ port: 3080, pid: 200, address: '::', ownerName: 'node' }], []);
check('a port two projects declare is contested', out.rows[0].verdict === 'contested', JSON.stringify(out.rows[0]));
check('it lists every project that declares it',
  out.rows[0].declaredBy.length === 2
  && out.rows[0].declaredBy.map(d => d.name).sort().join(',') === 'twin-one,twin-two',
  JSON.stringify(out.rows[0].declaredBy));

// A contested port whose owner IS visible stays contested — the conflict is the
// thing worth reporting — but the owner is not thrown away.
out = ledgerOf(
  [{ port: 3080, pid: 200, address: '::', ownerName: 'node' }],
  [{ pid: 200, listeningPorts: [3080], matchedProjectId: 'twin1', matchedProjectName: 'twin-one', matchedMethod: 'path_prefix' }]
);
check('a contested port with a known owner is still contested', out.rows[0].verdict === 'contested');
check('and the owner it saw is kept', out.rows[0].projectId === 'twin1' && out.rows[0].basis === 'observed');

// --- foreign is a count, never a list ------------------------------------------
out = ledgerOf(
  [
    { port: 445, pid: 4, address: '0.0.0.0', ownerName: 'System' },
    { port: 5040, pid: 900, address: '0.0.0.0', ownerName: 'svchost' },
    { port: 3001, pid: 100, address: '0.0.0.0', ownerName: 'node' }
  ],
  [{ pid: 100, listeningPorts: [3001], matchedProjectId: 'a', matchedProjectName: 'api', matchedMethod: 'path_prefix' }]
);
check('unrelated ports are counted', out.foreign === 2, String(out.foreign));
// The boundary that keeps this a project library rather than a network monitor.
check('unrelated ports are NOT listed', out.rows.length === 1 && out.rows[0].port === 3001,
  JSON.stringify(out.rows.map(r => r.port)));
check('the total counts every listening port', out.total === 3);

// --- containers ------------------------------------------------------------------
// Without this join, two ports serving a catalogued project from inside Docker
// would be counted foreign — a false statement about the user's own programs.
out = ledgerOf(
  [{ port: 9119, pid: 500, address: '0.0.0.0', ownerName: 'wslrelay' }],
  [],
  [{ name: 'agent-runner', ports: [9119], matchedProjectId: 'gem', matchedProjectName: 'sample-app' }]
);
check('a container port is attributed to its project', out.rows[0].verdict === 'attributed', JSON.stringify(out.rows[0]));
check('the container is named as the route to it', out.rows[0].via === 'container' && out.rows[0].basis === 'observed');
check('it is not counted foreign', out.foreign === 0);

// --- a process seen without its pid in the table ----------------------------------
// psscan can learn a port from a command line even when the OS table does not
// tie it to that PID, so the port index is a second way in.
out = ledgerOf(
  [{ port: 4620, pid: null, address: '0.0.0.0', ownerName: null }],
  [{ pid: 321, listeningPorts: [4620], matchedProjectId: 'a', matchedProjectName: 'api', matchedMethod: 'path_prefix' }]
);
check('a port with no pid can still be matched by the process index',
  out.rows[0].verdict === 'attributed' && out.rows[0].basis === 'observed', JSON.stringify(out.rows[0]));

// --- the same port on two addresses is one port -----------------------------------
out = ledgerOf(
  [
    { port: 3001, pid: null, address: '::', ownerName: null },
    { port: 3001, pid: 100, address: '0.0.0.0', ownerName: 'node' }
  ],
  [{ pid: 100, listeningPorts: [3001], matchedProjectId: 'a', matchedProjectName: 'api', matchedMethod: 'path_prefix' }]
);
check('one port listening on two addresses is one row', out.rows.length === 1 && out.total === 1);
// The entry that knows the owner must win, or the row loses the attribution.
check('the row keeps the entry that has an owner', out.rows[0].pid === 100 && out.rows[0].verdict === 'attributed',
  JSON.stringify(out.rows[0]));

// --- a project that is gone claims nothing ------------------------------------------
out = ledgerOf([{ port: 9999, pid: 1, address: '0.0.0.0', ownerName: 'x' }], []);
check('a project missing from disk does not claim a port', out.foreign === 1 && out.rows.length === 0,
  JSON.stringify(out.rows));

// --- degenerate input -----------------------------------------------------------------
out = buildLedger({});
check('empty input does not throw', out.total === 0 && out.rows.length === 0 && out.foreign === 0);
out = ledgerOf([], []);
check('no listening ports yields nothing', out.total === 0);

const failed = results.filter(r => !r.pass);
console.log('\nPORT_LEDGER_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
assert.ok(true);
