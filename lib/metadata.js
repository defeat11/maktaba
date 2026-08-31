const fs = require('fs').promises;
const path = require('path');

// Try loading skipDirs from config.json, otherwise fall back to standard defaults
let skipDirs = [
  'node_modules', '.git', 'Windows', 'Program Files', 'Program Files (x86)',
  'ProgramData', 'AppData', '$Recycle.Bin', 'System Volume Information',
  '.cache', 'dist', 'build', 'vendor', 'venv', '.venv', 'env', '__pycache__'
];
try {
  const config = require('../config.json');
  if (config && Array.isArray(config.skipDirs)) {
    skipDirs = config.skipDirs;
  }
} catch (err) {
  // Ignored, defaults will be used
}
const skipSet = new Set(skipDirs.map(d => d.toLowerCase()));

/**
 * Checks if a paragraph is markdown heading or underlined heading.
 */
function isHeading(paragraph) {
  const lines = paragraph.trim().split(/\r?\n/);
  if (lines.length === 0) return true;
  const firstLine = lines[0].trim();
  if (firstLine.startsWith('#')) return true;
  if (lines.length > 1) {
    const secondLine = lines[1].trim();
    if (/^=+$/.test(secondLine) || /^---+$/.test(secondLine)) return true;
  }
  return false;
}

/**
 * Strips basic markdown markers from a paragraph of text.
 */
function stripMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '') // strip images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // strip link syntax but keep text
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // strip bold/italics
    .replace(/`([^`]+)`/g, '$1') // strip inline code
    .replace(/^\s*>\s*/gm, '') // strip blockquotes
    .replace(/^\s*[*+-]\s+/gm, '') // strip unordered lists
    .replace(/^\s*\d+\.\s+/gm, '') // strip ordered lists
    .replace(/\r?\n/g, ' ') // join newlines with space
    .replace(/\s+/g, ' ') // collapse multiple spaces
    .trim();
}

/**
 * Extracts comprehensive metadata for a project.
 * 
 * @param {string} projectPath Absolute path to the project directory.
 * @param {Array<string>} markers Array of project markers detected in the directory.
 * @returns {Promise<Object>} Metadata object.
 */
async function extractMetadata(projectPath, markers) {
  let entries = [];
  try {
    entries = await fs.readdir(projectPath, { withFileTypes: true });
  } catch (err) {
    // If the directory cannot be read, return minimal defaults
    return {
      name: path.basename(projectPath),
      type: 'Static',
      description: '',
      entryFile: null,
      port: null,
      sizeBytes: 0,
      lastModified: new Date()
    };
  }

  const topLevelFiles = entries.filter(e => e.isFile()).map(e => e.name);
  const filesLower = new Map(topLevelFiles.map(f => [f.toLowerCase(), f]));

  // Parse package.json or composer.json if present
  let packageJson = null;
  let composerJson = null;

  if (filesLower.has('package.json')) {
    try {
      const content = await fs.readFile(path.join(projectPath, filesLower.get('package.json')), 'utf8');
      packageJson = JSON.parse(content);
    } catch (err) {
      // Ignore parsing errors
    }
  }

  if (filesLower.has('composer.json')) {
    try {
      const content = await fs.readFile(path.join(projectPath, filesLower.get('composer.json')), 'utf8');
      composerJson = JSON.parse(content);
    } catch (err) {
      // Ignore parsing errors
    }
  }

  // 1. Name: the FOLDER name identifies a project in a library; a manifest name
  //    does not. Preferring package.json produced 21 cards all called
  //    "web-client", 12 called "react-example" and 9 called "web-site" —
  //    every one of which is a distinct folder on disk. The manifest name is
  //    kept as a subtitle instead.
  const name = path.basename(projectPath);
  let packageName = '';
  if (packageJson && typeof packageJson.name === 'string' && packageJson.name.trim()) {
    packageName = packageJson.name.trim();
  } else if (composerJson && typeof composerJson.name === 'string' && composerJson.name.trim()) {
    packageName = composerJson.name.trim();
  }
  // Only worth showing when it says something the folder name does not.
  if (packageName === name) packageName = '';

  // 2. Type/Language: Infer based on matched markers
  const lowerMarkers = markers.map(m => m.toLowerCase());
  let type = 'Static';
  if (lowerMarkers.some(m => m === 'package.json' || m === 'server.js')) {
    type = 'Node';
  } else if (lowerMarkers.some(m => m === 'requirements.txt' || m === 'pyproject.toml' || m === 'pipfile' || m === 'app.py' || m === 'main.py')) {
    type = 'Python';
  } else if (lowerMarkers.some(m => m === 'composer.json' || m === 'index.php')) {
    type = 'PHP';
  } else if (lowerMarkers.some(m => m === 'pom.xml' || m === 'build.gradle')) {
    type = 'Java';
  } else if (lowerMarkers.some(m => m.endsWith('.csproj'))) {
    type = '.NET';
  } else if (lowerMarkers.some(m => m === 'index.html')) {
    type = 'Static';
  }

  // 3. Description: package.json desc -> composer.json desc -> README first paragraph
  let description = '';
  if (packageJson && typeof packageJson.description === 'string' && packageJson.description.trim()) {
    description = packageJson.description.trim();
  } else if (composerJson && typeof composerJson.description === 'string' && composerJson.description.trim()) {
    description = composerJson.description.trim();
  } else {
    let readmeFile = null;
    if (filesLower.has('readme.md')) {
      readmeFile = filesLower.get('readme.md');
    } else if (filesLower.has('readme.txt')) {
      readmeFile = filesLower.get('readme.txt');
    }

    if (readmeFile) {
      try {
        const readmeContent = await fs.readFile(path.join(projectPath, readmeFile), 'utf8');
        const paragraphs = readmeContent.split(/\r?\n\s*\r?\n/);
        for (const p of paragraphs) {
          if (p.trim() && !isHeading(p)) {
            description = stripMarkdown(p);
            if (description.length > 500) {
              description = description.slice(0, 497) + '...';
            }
            break;
          }
        }
      } catch (err) {
        // Ignore errors reading README
      }
    }
  }

  // 4. Entry File Detection
  let entryFile = null;
  if (type === 'Node') {
    if (packageJson && typeof packageJson.main === 'string' && packageJson.main.trim()) {
      const mainFile = packageJson.main.trim();
      const candidates = [
        mainFile,
        mainFile + '.js',
        mainFile + '/index.js'
      ];
      for (const candidate of candidates) {
        const fullPath = path.join(projectPath, candidate);
        try {
          await fs.access(fullPath);
          entryFile = path.relative(projectPath, fullPath).replace(/\\/g, '/');
          break;
        } catch (err) {}
      }
    }
    if (!entryFile && packageJson && packageJson.scripts && typeof packageJson.scripts.start === 'string') {
      const startScript = packageJson.scripts.start;
      const match = startScript.match(/([\w\-.\/]+\.js)/);
      if (match) {
        const candidate = match[1];
        const fullPath = path.join(projectPath, candidate);
        try {
          await fs.access(fullPath);
          entryFile = path.relative(projectPath, fullPath).replace(/\\/g, '/');
        } catch (err) {}
      }
    }
    if (!entryFile) {
      for (const filename of ['server.js', 'app.js', 'index.js']) {
        if (filesLower.has(filename)) {
          entryFile = filesLower.get(filename);
          break;
        }
      }
    }
    if (!entryFile && filesLower.has('index.html')) {
      entryFile = filesLower.get('index.html');
    }
  } else if (type === 'Python') {
    for (const filename of ['app.py', 'main.py', 'manage.py']) {
      if (filesLower.has(filename)) {
        entryFile = filesLower.get(filename);
        break;
      }
    }
  } else if (type === 'PHP') {
    if (filesLower.has('index.php')) {
      entryFile = filesLower.get('index.php');
    }
  } else if (type === 'Static') {
    if (filesLower.has('index.html')) {
      entryFile = filesLower.get('index.html');
    }
  }

  // 5. Port Scan: entry file and .env
  let port = null;
  const filesToScanForPort = [];
  if (entryFile) {
    filesToScanForPort.push(path.join(projectPath, entryFile));
  }
  if (filesLower.has('.env')) {
    filesToScanForPort.push(path.join(projectPath, filesLower.get('.env')));
  }
  if (filesLower.has('.env.example')) {
    filesToScanForPort.push(path.join(projectPath, filesLower.get('.env.example')));
  }

  const portRegexes = [
    /\bPORT\s*=\s*(\d+)\b/i,
    /listen\(\s*(\d+)\b/,
    /\bport\s*=\s*(\d+)\b/i,
    /run\(\s*port\s*=\s*(\d+)\b/i,
    /localhost:(\d+)\b/i,
    /127\.0\.0\.1:(\d+)\b/i,
    /\bPORT\s*\|\|\s*(\d+)\b/i
  ];

  for (const filePath of filesToScanForPort) {
    try {
      const fileContent = await fs.readFile(filePath, 'utf8');
      for (const regex of portRegexes) {
        const match = fileContent.match(regex);
        if (match) {
          const p = parseInt(match[1], 10);
          if (p > 0 && p < 65536) {
            port = p;
            break;
          }
        }
      }
    } catch (err) {
      // Ignore errors reading individual files
    }
    if (port !== null) break;
  }

  // A) Detect port from package.json scripts
  if (port === null && packageJson && packageJson.scripts && typeof packageJson.scripts === 'object') {
    const scriptKeys = ['dev', 'start', 'serve', 'preview'];
    for (const key of scriptKeys) {
      const scriptVal = packageJson.scripts[key];
      if (typeof scriptVal === 'string') {
        const scriptRegexes = [
          /--port=(\d+)\b/,
          /--port\s+(\d+)\b/,
          /-p=(\d+)\b/,
          /-p\s+(\d+)\b/,
          /\bPORT=(\d+)\b/
        ];
        let foundPort = null;
        for (const rx of scriptRegexes) {
          const match = scriptVal.match(rx);
          if (match) {
            const p = parseInt(match[1], 10);
            if (p > 0 && p < 65536) {
              foundPort = p;
              break;
            }
          }
        }
        if (foundPort !== null) {
          port = foundPort;
          break;
        }
      }
    }
  }

  // B) Detect port from config files (vite, next, vue configs)
  if (port === null) {
    const configFiles = [
      'vite.config.ts',
      'vite.config.js',
      'vite.config.mjs',
      'vite.config.cjs',
      'next.config.js',
      'next.config.mjs',
      'vue.config.js'
    ];
    for (const file of configFiles) {
      if (filesLower.has(file.toLowerCase())) {
        const actualFilename = filesLower.get(file.toLowerCase());
        const filePath = path.join(projectPath, actualFilename);
        try {
          const fileContent = await fs.readFile(filePath, 'utf8');
          const match = fileContent.match(/\bport\s*:\s*(\d+)\b/i);
          if (match) {
            const p = parseInt(match[1], 10);
            if (p > 0 && p < 65536) {
              port = p;
              break;
            }
          }
        } catch (err) {
          // Ignore read errors
        }
      }
    }
  }

  // 6. Size Bytes (approx: sum top-level files + direct subdirectory files, skipping heavy dirs)
  let sizeBytes = 0;
  for (const entry of entries) {
    const fullPath = path.join(projectPath, entry.name);
    if (entry.isFile()) {
      try {
        const stat = await fs.stat(fullPath);
        sizeBytes += stat.size;
      } catch (err) {}
    } else if (entry.isDirectory()) {
      if (!skipSet.has(entry.name.toLowerCase())) {
        try {
          const subEntries = await fs.readdir(fullPath, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (subEntry.isFile()) {
              try {
                const subStat = await fs.stat(path.join(fullPath, subEntry.name));
                sizeBytes += subStat.size;
              } catch (err) {}
            }
          }
        } catch (err) {}
      }
    }
  }

  // 7. Last Modified (mtime of entry file or directory itself)
  let lastModified = null;
  if (entryFile) {
    try {
      const stat = await fs.stat(path.join(projectPath, entryFile));
      lastModified = stat.mtime;
    } catch (err) {}
  }
  if (!lastModified) {
    try {
      const stat = await fs.stat(projectPath);
      lastModified = stat.mtime;
    } catch (err) {
      lastModified = new Date();
    }
  }

  // Retrieve project directory stats for createdAt and modifiedAt
  let createdAt = null;
  let modifiedAt = null;
  try {
    const dirStat = await fs.stat(projectPath);
    const hasBirthtime = dirStat.birthtime && dirStat.birthtime.getTime() > 0;
    createdAt = (hasBirthtime ? dirStat.birthtime : dirStat.mtime).toISOString();
    modifiedAt = dirStat.mtime.toISOString();
  } catch (err) {
    const now = new Date().toISOString();
    createdAt = now;
    modifiedAt = now;
  }

  return {
    name,
    packageName,
    type,
    description,
    entryFile,
    port,
    sizeBytes,
    lastModified,
    createdAt,
    modifiedAt
  };
}

module.exports = { extractMetadata };
