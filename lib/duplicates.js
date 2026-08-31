const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * Computes the SHA1 hash of a given string or buffer.
 */
function sha1(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

/**
 * Computes a content fingerprint for a project.
 * Fingerprint is the SHA1 of package.json/composer.json content if present,
 * else the SHA1 of a sorted, comma-separated list of top-level filenames.
 */
async function getFingerprint(project) {
  const projectPath = project.path;
  let entries = [];
  try {
    entries = await fs.readdir(projectPath, { withFileTypes: true });
  } catch (err) {
    // If the directory cannot be read, fall back to hashing the path itself
    return sha1(projectPath);
  }

  const filesLower = new Map(entries.filter(e => e.isFile()).map(e => [e.name.toLowerCase(), e.name]));

  // 1. package.json content
  if (filesLower.has('package.json')) {
    try {
      const content = await fs.readFile(path.join(projectPath, filesLower.get('package.json')), 'utf8');
      return sha1(content);
    } catch (err) {
      // Fall through if error reading
    }
  }

  // 2. composer.json content
  if (filesLower.has('composer.json')) {
    try {
      const content = await fs.readFile(path.join(projectPath, filesLower.get('composer.json')), 'utf8');
      return sha1(content);
    } catch (err) {
      // Fall through if error reading
    }
  }

  // 3. Sorted list of top-level filenames
  const fileNames = entries
    .filter(e => e.isFile())
    .map(e => e.name)
    .sort();

  return sha1(fileNames.join(','));
}

/**
 * Finds duplicates among all detected projects.
 * Groups by normalized name OR content fingerprint.
 * 
 * @param {Array<Object>} projects Array of project objects. Each project must have 'name' and 'path' fields.
 * @returns {Promise<Object>} Map of projectPath -> array of duplicate projectPaths (excluding itself).
 */
async function findDuplicates(projects) {
  // Precompute normalized name and fingerprint for all projects
  const projectInfos = [];
  for (const project of projects) {
    const name = project.name || '';
    const normalizedName = name.toLowerCase().replace(/[\s\-_]/g, '');
    const fingerprint = await getFingerprint(project);

    projectInfos.push({
      project,
      normalizedName,
      fingerprint
    });
  }

  const n = projects.length;
  // Initialize adjacency list for connected components graph
  const adj = Array.from({ length: n }, () => []);

  // Construct edges: connect projects if their normalized name or fingerprint matches
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const infoA = projectInfos[i];
      const infoB = projectInfos[j];

      const nameMatch = infoA.normalizedName && infoA.normalizedName === infoB.normalizedName;
      const fingerprintMatch = infoA.fingerprint && infoA.fingerprint === infoB.fingerprint;

      if (nameMatch || fingerprintMatch) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }

  // Find connected components using Breadth-First Search
  const visited = new Set();
  const components = [];

  for (let i = 0; i < n; i++) {
    if (!visited.has(i)) {
      const component = [];
      const queue = [i];
      visited.add(i);

      while (queue.length > 0) {
        const u = queue.shift();
        component.push(u);

        for (const v of adj[u]) {
          if (!visited.has(v)) {
            visited.add(v);
            queue.push(v);
          }
        }
      }
      components.push(component);
    }
  }

  // Map each project path to its list of duplicate peer paths
  const duplicateMap = {};
  for (const project of projects) {
    duplicateMap[project.path] = [];
  }

  for (const component of components) {
    if (component.length > 1) {
      const paths = component.map(idx => projectInfos[idx].project.path);
      for (const p of paths) {
        duplicateMap[p] = paths.filter(otherPath => otherPath !== p);
      }
    }
  }

  return duplicateMap;
}

module.exports = { findDuplicates };
