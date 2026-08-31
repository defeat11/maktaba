const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');

/**
 * Recursively walks directories up to maxDepth to find project roots.
 * A directory is a project if it contains any marker from the configuration list.
 * 
 * @param {Object} config The scanner configuration containing roots, maxDepth, and skipDirs.
 * @returns {Promise<Array<Object>>} List of projects found with path and matched markers.
 */
async function scanProjects(config) {
  const { roots, maxDepth = 6, skipDirs = [], excludePathPatterns = [] } = config;
  const skipSet = new Set(skipDirs.map(d => d.toLowerCase()));
  const projects = [];

  let finalRoots = [];
  let wantsAuto = false;
  if (!roots || !Array.isArray(roots) || roots.length === 0) {
    wantsAuto = true;
  } else {
    for (const r of roots) {
      if (r === 'auto') {
        wantsAuto = true;
      } else {
        finalRoots.push(r);
      }
    }
  }

  if (wantsAuto) {
    const autoRoots = [];
    if (process.platform === 'win32') {
      for (let i = 65; i <= 90; i++) {
        const letter = String.fromCharCode(i);
        const drive = letter + ':\\';
        try {
          if (fsSync.existsSync(drive)) {
            autoRoots.push(drive);
          }
        } catch (e) {}
      }
    } else {
      autoRoots.push('/');
      try {
        const home = os.homedir();
        if (home) {
          autoRoots.push(home);
        }
      } catch (e) {}
    }
    finalRoots = [...new Set([...finalRoots, ...autoRoots])];
  }

  // Define marker files and matching helpers
  const isCsproj = (name) => name.toLowerCase().endsWith('.csproj');
  const standardMarkers = new Set([
    'package.json', 'requirements.txt', 'pyproject.toml', 'pipfile', 'composer.json',
    'index.php', 'pom.xml', 'build.gradle', 'index.html', 'server.js', 'app.py', 'main.py'
  ]);

  // Folders that hold projects but are never projects themselves.
  //
  // The walk registers a directory as a project the moment it sees a marker and
  // then stops descending — which is right for a project folder and ruinous for
  // a container. A single stray index.html downloaded into a user's Downloads folder
  // made the whole Downloads tree invisible: a rescan would have stopped there
  // and dropped 37 catalogued projects beneath it.
  const CONTAINER_DIRS = new Set([
    'downloads', 'documents', 'desktop', 'pictures', 'videos', 'music',
    'onedrive', 'public', 'users'
  ]);

  function isContainerDir(dir) {
    const base = path.basename(dir).toLowerCase();
    // A drive root (C:\) is a container too, and basename() gives '' for it.
    if (!base || /^[a-z]:$/i.test(base)) return true;
    return CONTAINER_DIRS.has(base);
  }

  /**
   * True when a .git directory represents a repository that has never been
   * committed to.
   *
   * `git init` with nothing committed leaves refs/heads empty and no
   * packed-refs. Such a directory carries no history and no identity, so
   * treating it as proof of a project is wrong — and expensive: an empty .git
   * sitting in a projects root made the scanner claim that folder as one project
   * hid the ~40 real projects underneath it. Checked on the filesystem rather
   * than by spawning git, since this runs inside the walk.
   *
   * @param {string} gitDir Path to the .git directory
   * @returns {boolean} True when the repository has no commits
   */
  function isEmptyGitDir(gitDir) {
    try {
      if (fsSync.existsSync(path.join(gitDir, 'packed-refs'))) return false;
      const headsDir = path.join(gitDir, 'refs', 'heads');
      if (!fsSync.existsSync(headsDir)) return true;
      return fsSync.readdirSync(headsDir).length === 0;
    } catch (err) {
      // Unreadable: fall back to trusting it, the old behaviour.
      return false;
    }
  }

  async function walk(currentDir, depth) {
    if (depth > maxDepth) return;

    // Check exclude patterns (case-insensitive substring matched against full path)
    const normPath = currentDir.toLowerCase().replace(/\//g, '\\');
    if (excludePathPatterns.some(pat => normPath.includes(pat.toLowerCase()))) {
      return;
    }

    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      // Gracefully handle permission errors, unreadable directories, etc.
      return;
    }

    let hasGit = false;
    const matchedMarkers = [];
    const subDirs = [];

    for (const entry of entries) {
      const name = entry.name;
      const lowerName = name.toLowerCase();

      if (lowerName === '.git' && entry.isDirectory()) {
        // A repository with no commits proves nothing about this folder.
        hasGit = !isEmptyGitDir(path.join(currentDir, name));
      }

      if (entry.isDirectory()) {
        if (!skipSet.has(lowerName)) {
          subDirs.push(path.join(currentDir, name));
        }
      } else if (entry.isFile()) {
        if (standardMarkers.has(lowerName) || isCsproj(name)) {
          matchedMarkers.push(name);
        }
      }
    }

    // A container never counts as a project no matter what has landed in it,
    // and crucially the walk keeps going down instead of stopping here.
    if (!isContainerDir(currentDir)) {
      if (hasGit) {
        // Put '.git' in markers with any other matchedMarkers
        const markers = ['.git', ...matchedMarkers];
        projects.push({
          path: currentDir,
          markers: markers
        });
        return;
      }

      if (matchedMarkers.length > 0) {
        // Project found! Add it and stop descending into its subfolders
        projects.push({
          path: currentDir,
          markers: matchedMarkers
        });
        return;
      }
    }

    // No project found at this level, recurse into subdirectories
    for (const subDir of subDirs) {
      await walk(subDir, depth + 1);
    }
  }

  for (const root of finalRoots) {
    try {
      await walk(path.resolve(root), 0);
    } catch (err) {
      // Catch errors for a root folder to avoid crashing the entire scan
      console.error(`Error scanning root ${root}:`, err.message);
    }
  }

  return projects;
}

module.exports = { scanProjects };
