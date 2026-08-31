// Containers, but only as a fact about a catalogued project.
//
// Maktaba's entire knowledge of Docker was one boolean in profiler.js: does a
// Dockerfile exist on disk. Meanwhile three containers were running on this
// machine serving ports 8091, 9119 and 9120, and the catalogue said
// `sample-app` was health "unknown" — while a container built from it was
// answering requests.
//
// The join is by evidence, never by name. A container counts as belonging to a
// project only when it literally references that project's directory:
//
//   * com.docker.compose.project.working_dir is inside a catalogued path
//   * a host bind mount's source is inside a catalogued path
//
// Both were measured here: compose-worker carries compose labels, agent-runner
// carries none at all (started with `docker run`) but mounts
// ...\sample-app\agent-data. One key alone would have missed one of them.
//
// A container that matches no catalogued project is NOT listed. Counting every
// container on the machine would make this a Docker dashboard, which is not
// what a library of your projects is for. And nothing here starts, stops,
// builds or removes anything — it reads.

const path = require('path');
const { execFile } = require('child_process');
const { logError } = require('./logger');

const DOCKER_TIMEOUT_MS = 15000;

function docker(args) {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: DOCKER_TIMEOUT_MS, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          // Three different situations that must not look alike: docker is not
          // installed, the daemon is not running, or the command failed. An
          // empty list would claim "no containers", which is a different and
          // possibly false statement.
          const text = String(stderr || err.message || '');
          let reason = text.slice(0, 200);
          if (err.code === 'ENOENT') reason = 'docker غير مثبّت على هذا الجهاز.';
          else if (/daemon|pipe|cannot connect/i.test(text)) reason = 'خدمة Docker غير مشغّلة.';
          else if (err.killed) reason = 'Docker لم يستجب خلال ' + (DOCKER_TIMEOUT_MS / 1000) + ' ثوانٍ.';
          return resolve({ ok: false, reason, stdout: '' });
        }
        resolve({ ok: true, reason: null, stdout });
      });
  });
}

function normalise(p) {
  return String(p || '').toLowerCase().split('\\').join('/').replace(/\/+$/, '');
}

/**
 * True when `child` is the same directory as `parent` or sits inside it.
 *
 * Compared segment-wise so that "…/photo-backup" is not read as being inside
 * "…/photo".
 *
 * @param {string} parent Candidate parent path
 * @param {string} child Candidate child path
 * @returns {boolean}
 */
function isInside(parent, child) {
  const a = normalise(parent);
  const b = normalise(child);
  if (!a || !b) return false;
  return b === a || b.startsWith(a + '/');
}

/**
 * Every running container, with the two facts that can tie one to a project.
 *
 * @returns {Promise<{available: boolean, reason: string|null, containers: Array<Object>}>}
 */
async function list() {
  const ps = await docker(['ps', '--format', '{{.ID}}']);
  if (!ps.ok) return { available: false, reason: ps.reason, containers: [] };

  const ids = ps.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return { available: true, reason: null, containers: [] };

  // One inspect for all of them: docker accepts many ids, and a call per
  // container turns a 200 ms read into seconds when a few are running.
  const inspected = await docker(['inspect'].concat(ids));
  if (!inspected.ok) return { available: false, reason: inspected.reason, containers: [] };

  let raw;
  try {
    raw = JSON.parse(inspected.stdout);
  } catch (err) {
    logError('containers', err);
    return { available: false, reason: 'تعذّرت قراءة مخرجات docker inspect.', containers: [] };
  }

  const containers = raw.map(c => {
    const config = c.Config || {};
    const labels = config.Labels || {};
    const state = c.State || {};

    const ports = [];
    const portMap = (c.NetworkSettings && c.NetworkSettings.Ports) || {};
    for (const key of Object.keys(portMap)) {
      for (const binding of (portMap[key] || [])) {
        const hostPort = parseInt(binding.HostPort, 10);
        if (hostPort && ports.indexOf(hostPort) === -1) ports.push(hostPort);
      }
    }

    // Every mount that names a host path, whatever its Type.
    //
    // Filtering to Type === 'bind' looked right and was wrong: agent-runner's
    // mount is declared as a named volume, yet its Source is
    // ...\sample-app\agent-data — a real directory inside a catalogued
    // project. The evidence that ties a container to a project is the path it
    // points at, not the label Docker files it under. A genuinely internal
    // volume has a Source under Docker's own storage, which can never sit
    // inside a project, so the path check below is what filters.
    const mounts = (c.Mounts || [])
      .filter(m => m && m.Source)
      .map(m => m.Source);

    return {
      id: String(c.Id || '').slice(0, 12),
      name: String(c.Name || '').replace(/^\//, ''),
      image: config.Image || null,
      running: state.Running === true,
      status: state.Status || null,
      startedAt: state.StartedAt || null,
      ports,
      composeProject: labels['com.docker.compose.project'] || null,
      composeWorkingDir: labels['com.docker.compose.project.working_dir'] || null,
      composeService: labels['com.docker.compose.service'] || null,
      mounts
    };
  });

  return { available: true, reason: null, containers };
}

/**
 * Ties each container to the catalogued project it references, if any.
 *
 * @param {Array<Object>} containers Output of list()
 * @param {Array<Object>} projects Catalogue rows
 * @returns {Array<Object>} Only the containers that matched, with the evidence
 */
function attachProjects(containers, projects) {
  const live = (projects || []).filter(p => p && p.path && !p.missing);
  const matched = [];

  for (const container of (containers || [])) {
    let hit = null;

    if (container.composeWorkingDir) {
      const p = live.find(project => isInside(project.path, container.composeWorkingDir));
      if (p) hit = { project: p, by: 'compose-working-dir', evidence: container.composeWorkingDir };
    }

    if (!hit) {
      for (const source of container.mounts) {
        // Deepest match wins: a mount inside "…/sample-app/agent-data"
        // belongs to sample-app, not to whatever parent also happens to be
        // catalogued.
        const candidates = live.filter(project => isInside(project.path, source));
        if (candidates.length) {
          const deepest = candidates.sort((a, b) => b.path.length - a.path.length)[0];
          hit = { project: deepest, by: 'bind-mount', evidence: source };
          break;
        }
      }
    }

    if (!hit) continue;
    matched.push(Object.assign({}, container, {
      matchedProjectId: hit.project.id,
      matchedProjectName: hit.project.name,
      matchedProjectPath: hit.project.path,
      matchedBy: hit.by,
      matchEvidence: hit.evidence
    }));
  }

  return matched;
}

/**
 * The containers belonging to catalogued projects, and nothing else.
 *
 * @param {Array<Object>} projects Catalogue rows
 * @returns {Promise<Object>} Availability, matched containers, and how many were skipped
 */
async function forProjects(projects) {
  const state = await list();
  if (!state.available) {
    return { available: false, reason: state.reason, containers: [], unmatched: 0, total: 0 };
  }
  const matched = attachProjects(state.containers, projects);
  return {
    available: true,
    reason: null,
    containers: matched,
    // A count, deliberately not a list: how many containers on this machine are
    // none of Maktaba's business is one honest number, whereas naming them
    // would be the Docker dashboard this is not.
    unmatched: state.containers.length - matched.length,
    total: state.containers.length
  };
}

module.exports = { list, attachProjects, forProjects, isInside };
