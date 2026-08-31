/**
 * Helper to validate if a value is a valid port number (1024 - 65535).
 * 
 * @param {*} port Value to check.
 * @returns {boolean} True if port is valid.
 */
function isValidPort(port) {
  const p = parseInt(port, 10);
  return Number.isInteger(p) && p >= 1024 && p <= 65535;
}

/**
 * Assigns unique ports to all primary projects, and aligns backups with their primary project's port.
 * 
 * @param {Array<Object>} projects Array of project objects.
 * @returns {Array<Object>} Annotated projects array.
 */
function assignPorts(projects) {
  if (!projects || !Array.isArray(projects)) return [];

  try {
    const RESERVED_PORTS = new Set([4500]);
    const BASE_PORT = 3001;
    const usedPorts = new Set();
    const primaryMap = new Map(); // id -> primary project

    // First, identify all real primary projects and backups
    const primaries = [];
    const backups = [];

    for (const p of projects) {
      try {
        if (p.isPrimary !== false && p.classification !== 'not-project') {
          primaries.push(p);
          primaryMap.set(p.id, p);
        } else if (p.isPrimary === false) {
          backups.push(p);
        } else {
          // not-project items get null port
          p.assignedPort = null;
        }
      } catch (err) {
        console.error('Error classifying project in assignPorts:', err);
      }
    }

    // Sort primaries by path to guarantee stable, deterministic assignment order
    primaries.sort((a, b) => String(a.path).localeCompare(String(b.path)));

    // Allocate ports for primaries
    let nextAvailablePort = BASE_PORT;

    function getNextFreePort() {
      while (usedPorts.has(nextAvailablePort) || RESERVED_PORTS.has(nextAvailablePort)) {
        nextAvailablePort++;
      }
      return nextAvailablePort;
    }

    for (const p of primaries) {
      try {
        let desired = null;
        if (p.assignedPort !== undefined && isValidPort(p.assignedPort)) {
          desired = parseInt(p.assignedPort, 10);
        } else if (p.port !== undefined && isValidPort(p.port)) {
          desired = parseInt(p.port, 10);
        }

        if (desired && !usedPorts.has(desired) && !RESERVED_PORTS.has(desired)) {
          p.assignedPort = desired;
          usedPorts.add(desired);
        } else {
          const freePort = getNextFreePort();
          p.assignedPort = freePort;
          usedPorts.add(freePort);
        }
      } catch (err) {
        console.error(`Error assigning port to primary project ${p.path}:`, err);
        p.assignedPort = p.port || null;
      }
    }

    // Allocate ports for backups based on their primary project's assigned port
    for (const b of backups) {
      try {
        if (b.backupOf && primaryMap.has(b.backupOf)) {
          const primary = primaryMap.get(b.backupOf);
          b.assignedPort = primary.assignedPort;
        } else {
          b.assignedPort = b.port !== undefined && isValidPort(b.port) ? parseInt(b.port, 10) : null;
        }
      } catch (err) {
        console.error(`Error assigning port to backup project ${b.path}:`, err);
        b.assignedPort = b.port || null;
      }
    }
  } catch (err) {
    console.error('Overall error in assignPorts:', err);
  }

  return projects;
}

module.exports = {
  assignPorts,
  isValidPort
};
