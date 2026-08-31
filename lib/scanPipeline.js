const { scanProjects } = require('./scanner');
const { extractMetadata } = require('./metadata');
const { findDuplicates } = require('./duplicates');
const { classifyProject } = require('./classifier');
const { groupBackups } = require('./backups');
const { saveProjects } = require('./store');

/**
 * Runs the full project scan pipeline:
 * scan -> extract metadata -> find duplicates -> classify -> group backups -> save.
 * 
 * @param {Object} config The scan configuration.
 * @returns {Promise<Object>} Object with count of projects processed.
 */
async function runFullScan(config, options = {}) {
  const rawProjects = await scanProjects(config);
  const projects = [];
  for (const rawProj of rawProjects) {
    try {
      const metadata = await extractMetadata(rawProj.path, rawProj.markers);
      projects.push({
        path: rawProj.path,
        ...metadata
      });
    } catch (err) {
      console.error(`Failed to extract metadata for ${rawProj.path}:`, err.message);
    }
  }

  const duplicateMap = await findDuplicates(projects);
  for (const proj of projects) {
    proj.duplicates = duplicateMap[proj.path] || [];
  }

  // Run classification scoring on each project
  for (const proj of projects) {
    try {
      const classificationResult = await classifyProject(proj);
      proj.confidence = classificationResult.confidence;
      proj.classification = classificationResult.classification;
      proj.signals = classificationResult.signals;
    } catch (classifyErr) {
      console.error(`Failed to classify project ${proj.path}:`, classifyErr.message);
      proj.confidence = 0;
      proj.classification = 'weak';
      proj.signals = [{ label: `خطأ أثناء التحليل: ${classifyErr.message}`, points: 0 }];
    }
  }

  // Group backup-like duplicates under primary projects
  groupBackups(projects);

  // Pre-merge user-set classifications and ports so that assignPorts/classifier behaves correctly
  try {
    const { getProjects } = require('./store');
    const existing = await getProjects();
    const existingMap = new Map();
    for (const ex of existing) {
      existingMap.set(ex.id, ex);
    }

    const crypto = require('crypto');
    function sha1(str) {
      return crypto.createHash('sha1').update(str).digest('hex');
    }

    for (const p of projects) {
      const id = p.id || sha1(p.path);
      if (existingMap.has(id)) {
        const ex = existingMap.get(id);
        if (ex.userClassification !== undefined && ex.userClassification !== null) {
          p.userClassification = ex.userClassification;
        }
        if (ex.userPortSet) {
          p.assignedPort = ex.assignedPort;
          p.userPortSet = ex.userPortSet;
        }
      }
    }
  } catch (err) {
    console.error('Error pre-merging user-set classifications and ports in scanPipeline:', err);
  }

  // Assign ports to projects
  const { assignPorts } = require('./portManager');
  assignPorts(projects);

  // options carries the deliberate escape hatch documented in store.js: a scan
  // that legitimately drops more than 10% of rows (folders genuinely emptied or
  // deleted) is refused by default and must be re-run with { force: true } after
  // the drops have been checked one by one.
  await saveProjects(projects, { fromScan: true, ...options });
  return { count: projects.length };
}

module.exports = {
  runFullScan
};
