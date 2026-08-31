const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let cachedResult = null;

/**
 * Resolves the location of the ACP delegate script or command.
 * Caches the result in a module variable.
 * 
 * @returns {Object|null} Resolved details or null.
 */
function resolveDelegate() {
  if (cachedResult !== null) {
    return cachedResult;
  }

  // a. process.env.ACP_DELEGATE_PATH
  if (process.env.ACP_DELEGATE_PATH) {
    const p = process.env.ACP_DELEGATE_PATH;
    if (fs.existsSync(p)) {
      cachedResult = { mode: 'node', delegatePath: path.resolve(p) };
      return cachedResult;
    }
  }

  // b. config.json field "acpDelegatePath"
  try {
    const configPath = path.join(__dirname, '..', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.acpDelegatePath && fs.existsSync(config.acpDelegatePath)) {
        cachedResult = { mode: 'node', delegatePath: path.resolve(config.acpDelegatePath) };
        return cachedResult;
      }
    }
  } catch (err) {
    // Ignore config read/parse errors
  }

  // c. common relative locations (sibling / grandparent checkouts)
  const relativeLocations = [
    path.join(__dirname, '..', '..', 'antigravity-acp', 'dist', 'delegate.js'),
    path.join(__dirname, '..', '..', '..', 'antigravity-acp', 'dist', 'delegate.js')
  ];

  for (const loc of relativeLocations) {
    if (fs.existsSync(loc)) {
      cachedResult = { mode: 'node', delegatePath: path.resolve(loc) };
      return cachedResult;
    }
  }

  // d. acp command on PATH
  try {
    const cmd = process.platform === 'win32' ? 'where acp' : 'which acp';
    execSync(cmd, { stdio: 'ignore' });
    cachedResult = { mode: 'acp', cmd: process.platform === 'win32' ? 'acp.cmd' : 'acp' };
    return cachedResult;
  } catch (err) {
    // Ignore execution failures
  }

  // e. none
  cachedResult = null;
  return null;
}

module.exports = {
  resolveDelegate
};
