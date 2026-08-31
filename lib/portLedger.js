// Who actually owns each listening port on this machine.
//
// Maktaba assigns ports to projects and reports "conflicts", but
// GET /api/ports/conflicts compares the catalogue against itself and never
// looks at the machine at all. Measured: 68 ports listening, 13 of them
// attributable (19%). One of the invisible ones is php.exe serving a
// CATALOGUED project on port 8000 — the row even says assignedPort 8000 — and
// psscan cannot see it because php.exe is not among the eight executable names
// it queries.
//
// The data was already being fetched and thrown away: psscan pulls the entire
// listening table with no filter, then consults it only for the PIDs that
// passed that eight-name filter.
//
// So this inverts the join — from the port to its owner, rather than from a
// project to the port it hopes to have — and gives every row a verdict that
// says how much is really known:
//
//   attributed       the owning process is tied to a catalogued project
//   contested        more than one project declares this port
//   claimed-but-dark a project declares it, the port is alive, the owner is
//                    invisible to Maktaba
//   foreign          neither: reported as a COUNT, never as a list
//
// That last line is a boundary, not an oversight. Listing every port on the
// machine that has nothing to do with the user's projects would make this a
// network monitor.
//
// Two things this must never do, both learned the hard way:
//   * feed portManager.assignPorts — deterministic assignment is a stated
//     guarantee, and 13 of 46 owning processes will not reveal their path
//     without admin rights, so a block based on this could be plain wrong
//   * write a permanent log of rows that are not the user's projects

const { spawn } = require('child_process');
const { logError } = require('./logger');

const PS_TIMEOUT_MS = 30000;

/**
 * Every listening TCP port, with whatever its owner is willing to say.
 *
 * Get-Process gives a name for every PID without admin rights; the executable
 * path often needs them, which is why the name is what gets used here.
 *
 * @returns {Promise<{ok: boolean, reason: string|null, ports: Array<Object>}>}
 */
function listeningTable() {
  const query = `
$ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess;
$procs = Get-Process -ErrorAction SilentlyContinue | Select-Object Id,ProcessName;
[PSCustomObject]@{ ports = $ports; procs = $procs } | ConvertTo-Json -Compress -Depth 4
`;

  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* already gone */ }
      resolve({ ok: false, reason: 'PowerShell لم يستجب.', ports: [] });
    }, PS_TIMEOUT_MS);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message, ports: [] });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (!trimmed) return resolve({ ok: false, reason: 'لا مخرجات من PowerShell.', ports: [] });

      let parsed;
      try {
        parsed = JSON.parse(trimmed.replace(/[\x00-\x1f]/g, ' '));
      } catch (err) {
        logError('port-ledger', err);
        return resolve({ ok: false, reason: 'تعذّرت قراءة مخرجات PowerShell.', ports: [] });
      }

      const asArray = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
      const names = new Map();
      for (const p of asArray(parsed.procs)) {
        if (p && p.Id !== undefined) names.set(Number(p.Id), p.ProcessName || null);
      }

      const ports = [];
      for (const row of asArray(parsed.ports)) {
        const port = row && row.LocalPort !== undefined ? Number(row.LocalPort) : null;
        const pid = row && row.OwningProcess !== undefined ? Number(row.OwningProcess) : null;
        if (!port) continue;
        ports.push({
          port,
          pid: pid || null,
          address: row.LocalAddress || null,
          ownerName: pid && names.has(pid) ? names.get(pid) : null
        });
      }
      resolve({ ok: true, reason: null, ports });
    });
  });
}

/**
 * Joins the machine's listening ports to the catalogue.
 *
 * Pure: everything it needs is passed in, so the verdicts can be pinned by a
 * test with no PowerShell, no Docker and no network.
 *
 * @param {Object} input ports, processRows, projects, containers
 * @returns {Object} Counts and the rows that concern the user's projects
 */
function buildLedger(input) {
  const ports = input.ports || [];
  const processRows = input.processRows || [];
  const projects = (input.projects || []).filter(p => p && !p.missing);
  const containers = input.containers || [];

  // A project "declares" a port when the catalogue says it should have it.
  const declaredBy = new Map();
  for (const project of projects) {
    for (const value of [project.assignedPort, project.port]) {
      const n = Number(value);
      if (!n) continue;
      if (!declaredBy.has(n)) declaredBy.set(n, []);
      const list = declaredBy.get(n);
      if (!list.some(p => p.id === project.id)) list.push({ id: project.id, name: project.name });
    }
  }

  // The owner Maktaba can actually see, by PID.
  const ownerByPid = new Map();
  const ownerByPort = new Map();
  for (const row of processRows) {
    if (!row) continue;
    if (row.pid) ownerByPid.set(Number(row.pid), row);
    for (const p of (row.listeningPorts || [])) {
      if (!ownerByPort.has(Number(p))) ownerByPort.set(Number(p), row);
    }
  }

  // A published container port is an observation too. Without this, two ports
  // serving a catalogued project from inside Docker would be counted foreign —
  // a false statement about the user's own programs.
  const containerByPort = new Map();
  for (const c of containers) {
    for (const p of (c.ports || [])) {
      if (!containerByPort.has(Number(p))) containerByPort.set(Number(p), c);
    }
  }

  // One row per port number: the same port listening on both 0.0.0.0 and :: is
  // one port from the user's point of view.
  const seen = new Map();
  for (const entry of ports) {
    const existing = seen.get(entry.port);
    if (!existing || (!existing.pid && entry.pid)) seen.set(entry.port, entry);
  }

  const rows = [];
  let foreign = 0;

  for (const entry of Array.from(seen.values()).sort((a, b) => a.port - b.port)) {
    const declarers = declaredBy.get(entry.port) || [];
    const processOwner = (entry.pid && ownerByPid.get(entry.pid)) || ownerByPort.get(entry.port) || null;
    const container = containerByPort.get(entry.port) || null;

    let verdict = null;
    let basis = null;
    let via = null;
    let projectId = null;
    let projectName = null;

    if (processOwner && processOwner.matchedProjectId) {
      projectId = processOwner.matchedProjectId;
      projectName = processOwner.matchedProjectName || null;
      via = 'process';
      // Matching a process to a project BY its listening port and then citing
      // the process as proof of who owns the port is circular. It is still the
      // best guess available, so it is kept — and labelled an inference.
      basis = processOwner.matchedMethod === 'listening_port' ? 'inferred' : 'observed';
    } else if (container) {
      projectId = container.matchedProjectId;
      projectName = container.matchedProjectName || null;
      via = 'container';
      basis = 'observed';
    }

    if (declarers.length > 1) {
      verdict = 'contested';
      if (!basis) basis = 'inferred';
      if (!via) via = 'declared';
    } else if (projectId) {
      verdict = 'attributed';
    } else if (declarers.length === 1) {
      // The catalogue says this port belongs to a project, the port is alive,
      // and Maktaba cannot see what is holding it. That is not the same as
      // "the project is running", and must not be reported as if it were.
      verdict = 'claimed-but-dark';
      basis = 'inferred';
      via = 'declared';
      projectId = declarers[0].id;
      projectName = declarers[0].name;
    } else {
      // Nothing to do with the user's projects: counted, never listed.
      foreign++;
      continue;
    }

    rows.push({
      port: entry.port,
      address: entry.address,
      pid: entry.pid,
      ownerName: entry.ownerName,
      verdict,
      basis,
      via,
      projectId,
      projectName,
      declaredBy: declarers
    });
  }

  return {
    total: seen.size,
    attributed: rows.filter(r => r.verdict === 'attributed').length,
    contested: rows.filter(r => r.verdict === 'contested').length,
    claimedButDark: rows.filter(r => r.verdict === 'claimed-but-dark').length,
    foreign,
    rows
  };
}

/**
 * Builds the ledger against the live machine.
 *
 * @param {Array<Object>} projects Catalogue rows
 * @returns {Promise<Object>} The ledger, or a reason it could not be built
 */
async function portLedger(projects) {
  const table = await listeningTable();
  if (!table.ok) {
    return { ok: false, reason: table.reason, total: 0, attributed: 0, contested: 0, claimedButDark: 0, foreign: 0, rows: [] };
  }

  let processRows = [];
  try {
    processRows = await require('./psscan').scanProcesses();
  } catch (err) {
    logError('port-ledger', err);
  }

  let containers = [];
  try {
    const state = await require('./containers').forProjects(projects);
    if (state.available) containers = state.containers;
  } catch (err) {
    // Docker being absent is ordinary, not an error worth failing the ledger for.
  }

  const ledger = buildLedger({ ports: table.ports, processRows, projects, containers });
  return Object.assign({ ok: true, reason: null }, ledger);
}

module.exports = { portLedger, buildLedger, listeningTable };
