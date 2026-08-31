// A container is tied to a project only by evidence: the container literally
// references that project's directory. Everything else — image name, container
// name, port number — is a guess dressed as a fact, and this project does not
// ship those.
//
// Measured on this machine: three containers running. compose-worker carries
// compose labels pointing at a folder that is NOT catalogued, so it must not be
// listed at all. agent-runner and agent-runner-2 carry no labels whatsoever
// (started with `docker run`) but mount ...\sample-app\agent-data, which is
// inside a catalogued project the health scan calls "unknown" while those
// containers serve ports 9119 and 9120.
//
// The mount that matters is declared Type "volume", not "bind". Filtering on
// the type looked correct and matched nothing; the Source path is the evidence.
//
// No Docker required: attachProjects is pure, so these run anywhere.

const assert = require('node:assert');
const containers = require('../../lib/containers');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

const BS = String.fromCharCode(92);
const win = (...parts) => parts.join(BS);

const PROJECTS = [
  { id: 'gem', name: 'sample-app', path: win('C:', 'projects', 'sample-app') },
  { id: 'gem2', name: 'sample-app - Copy', path: win('C:', 'projects', 'sample-app - Copy') },
  { id: 'photo', name: 'photo', path: win('C:', 'projects', 'photo') },
  { id: 'nested', name: 'nested-child', path: win('C:', 'projects', 'photo', 'sub-app') },
  { id: 'gone', name: 'gone', path: win('C:', 'projects', 'deleted'), missing: true }
];

// --- path containment -------------------------------------------------------
check('a path is inside itself', containers.isInside('C:/a/b', 'C:/a/b') === true);
check('a child path is inside', containers.isInside('C:/a/b', 'C:/a/b/c/d') === true);
check('separators do not matter', containers.isInside(win('C:', 'a', 'b'), 'C:/a/b/c') === true);
check('case does not matter on Windows', containers.isInside('C:/Users/A/Proj', 'c:/users/a/proj/x') === true);
// The classic off-by-one: "photo-backup" must not be read as inside "photo".
check('a sibling sharing a prefix is not inside',
  containers.isInside('C:/a/photo', 'C:/a/photo-backup/file') === false);
check('a parent is not inside its child', containers.isInside('C:/a/b/c', 'C:/a/b') === false);
check('empty paths match nothing', containers.isInside('', 'C:/a') === false && containers.isInside('C:/a', '') === false);

// --- the mount that started this -------------------------------------------
// Declared as a named volume, but its Source is a real directory inside a
// catalogued project. Filtering by Type === 'bind' matched nothing.
const agentRunner = {
  id: 'aaa', name: 'agent-runner', image: 'agent-runner:premig', running: true, ports: [9119],
  composeProject: null, composeWorkingDir: null, composeService: null,
  mounts: [win('C:', 'projects', 'sample-app', 'agent-data')]
};
let matched = containers.attachProjects([agentRunner], PROJECTS);
check('a container with no labels is matched by its mount path',
  matched.length === 1 && matched[0].matchedProjectId === 'gem', JSON.stringify(matched));
check('the match names its evidence',
  matched[0].matchedBy === 'bind-mount' && /agent-data/.test(matched[0].matchEvidence));

// --- compose labels ---------------------------------------------------------
const composed = {
  id: 'bbb', name: 'app-1', image: 'app', running: true, ports: [8080],
  composeProject: 'app', composeWorkingDir: win('C:', 'projects', 'photo'),
  composeService: 'web', mounts: []
};
matched = containers.attachProjects([composed], PROJECTS);
check('a compose container is matched by its working dir',
  matched.length === 1 && matched[0].matchedProjectId === 'photo');
check('the compose match says how it matched', matched[0].matchedBy === 'compose-working-dir');

// --- what must NOT be listed ------------------------------------------------
// compose-worker's real case: compose labels pointing outside the catalogue.
const foreign = {
  id: 'ccc', name: 'compose-worker', image: 'replica', running: true, ports: [8091],
  composeProject: 'agyfailover', composeWorkingDir: win('C:', 'projects', 'agy-backup'),
  composeService: 'replica', mounts: [win('C:', 'projects', 'agy-backup', 'state')]
};
check('a container referencing no catalogued project is not listed',
  containers.attachProjects([foreign], PROJECTS).length === 0);

// Docker's own storage is never inside a project, so an internal volume drops
// out on the path check without needing a Type filter.
const internal = {
  id: 'ddd', name: 'db', image: 'postgres', running: true, ports: [5432],
  composeProject: null, composeWorkingDir: null, composeService: null,
  mounts: ['/var/lib/docker/volumes/pgdata/_data']
};
check('a docker-internal volume matches nothing',
  containers.attachProjects([internal], PROJECTS).length === 0);

// A name that looks like a project is not evidence of anything.
const namesake = {
  id: 'eee', name: 'photo', image: 'photo:latest', running: true, ports: [3000],
  composeProject: null, composeWorkingDir: null, composeService: null, mounts: []
};
check('a container is never matched by its name alone',
  containers.attachProjects([namesake], PROJECTS).length === 0);

// --- nesting ----------------------------------------------------------------
// Two catalogued projects both contain the mount; the deeper one owns it.
const nested = {
  id: 'fff', name: 'sub', image: 'sub', running: true, ports: [4000],
  composeProject: null, composeWorkingDir: null, composeService: null,
  mounts: [win('C:', 'projects', 'photo', 'sub-app', 'data')]
};
matched = containers.attachProjects([nested], PROJECTS);
check('the deepest matching project wins',
  matched.length === 1 && matched[0].matchedProjectId === 'nested', JSON.stringify(matched.map(m => m.matchedProjectId)));

// A copy of a project must not absorb the original's container.
const copyProbe = {
  id: 'ggg', name: 'copy-probe', image: 'x', running: true, ports: [],
  composeProject: null, composeWorkingDir: null, composeService: null,
  mounts: [win('C:', 'projects', 'sample-app - Copy', 'data')]
};
matched = containers.attachProjects([copyProbe], PROJECTS);
check('a copy of a project keeps its own container',
  matched.length === 1 && matched[0].matchedProjectId === 'gem2', JSON.stringify(matched.map(m => m.matchedProjectId)));

// --- projects that are not on disk any more ---------------------------------
const ghost = {
  id: 'hhh', name: 'ghost', image: 'x', running: true, ports: [],
  composeProject: null, composeWorkingDir: null, composeService: null,
  mounts: [win('C:', 'projects', 'deleted', 'data')]
};
check('a project missing from disk claims nothing',
  containers.attachProjects([ghost], PROJECTS).length === 0);

// --- degenerate input -------------------------------------------------------
check('no containers yields no matches', containers.attachProjects([], PROJECTS).length === 0);
check('no projects yields no matches', containers.attachProjects([agentRunner], []).length === 0);
check('undefined input does not throw',
  containers.attachProjects(undefined, undefined).length === 0);

// --- the original container fields survive the join -------------------------
matched = containers.attachProjects([agentRunner], PROJECTS);
check('ports and image are preserved through the join',
  matched[0].ports[0] === 9119 && matched[0].image === 'agent-runner:premig');

const failed = results.filter(r => !r.pass);
console.log('\nCONTAINERS_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
assert.ok(true);
