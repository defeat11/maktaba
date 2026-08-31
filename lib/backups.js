const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

function sha1(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

const WORD_CHAR_CLASS = '[a-z0-9\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]';
const NON_WORD_CHAR_CLASS = `[^a-z0-9\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]`;

function buildKeywordRegex(keyword) {
  const firstChar = keyword[0];
  const lastChar = keyword[keyword.length - 1];

  let prefix = '';
  let suffix = '';

  if (new RegExp(WORD_CHAR_CLASS, 'i').test(firstChar)) {
    prefix = `(?:^|${NON_WORD_CHAR_CLASS})`;
  }
  if (new RegExp(WORD_CHAR_CLASS, 'i').test(lastChar)) {
    suffix = `(?:$|${NON_WORD_CHAR_CLASS})`;
  }

  const escapedKeyword = keyword.replace(/[-\s]/g, '\\$&');
  return new RegExp(prefix + escapedKeyword + suffix, 'i');
}

const backupKeywords = [
  'backup', 'back up', 'back-up', 'bak', 'old', 'copy', 
  '- copy', '_old', '_bak', 'archive', 'نسخة', 'نسخه', 'احتياطي', 'أرشيف'
];

const keywordRegexes = backupKeywords.map(buildKeywordRegex);

/**
 * Checks if a project directory is named or structured like a backup folder.
 * Matches keywords like 'backup', 'bak', 'copy', Arabic translations, or paren numbers like '(1)'.
 * 
 * @param {string} projectPath Absolute path to the project directory.
 * @returns {boolean} True if the path implies a backup-like folder.
 */
function isBackupLike(projectPath) {
  const name = path.basename(projectPath).toLowerCase();
  const pathLower = projectPath.toLowerCase();

  // Check if any path segment contains a backup keyword
  const segments = pathLower.split(/[\\/]/);
  const hasBackupWord = segments.some(segment => 
    keywordRegexes.some(regex => regex.test(segment))
  );

  // Check if basename ends with parenthesized numbers, e.g. "(1)", "(2)"
  const hasParenNumber = /\(\d+\)$/.test(name.trim());

  return hasBackupWord || hasParenNumber;
}

/**
 * Normalizes folder name by stripping common copy/backup/version suffixes.
 * 
 * @param {string} projectPath Absolute path to the project.
 * @returns {string} The normalized base name.
 */
function normName(projectPath) {
  const base = path.basename(projectPath);
  let cleaned = base.toLowerCase();
  
  // Strip ' - copy' optionally followed by ' (N)'
  cleaned = cleaned.replace(/ - copy(?: \(\d+\))?$/g, '');
  
  // Strip trailing ' (N)'
  cleaned = cleaned.replace(/ \(\d+\)$/g, '');
  
  // Strip trailing ' - old', ' old', etc.
  cleaned = cleaned.replace(/(?: - old| old| - old one| last one| - master|-master)$/g, '');
  
  // Strip Arabic copy markers: 'نسخة', 'نسخه', 'احتياطي'
  cleaned = cleaned.replace(/(?:نسخة|نسخه|احتياطي)/g, '');
  
  // Collapse repeated spaces/dashes and trim
  cleaned = cleaned.replace(/[-\s]+/g, ' ').trim();
  
  return cleaned;
}

/**
 * Generates a structural signature key by sorting non-excluded top-level directory entries.
 * 
 * @param {string} projectPath Absolute path to the project.
 * @returns {string} The entry signature.
 */
function contentKey(projectPath) {
  try {
    const entries = fs.readdirSync(projectPath);
    const excluded = new Set([
      'node_modules', '.git', 'dist', 'build', '.next', 'out', 
      'venv', '.venv', '__pycache__', '.cache'
    ]);
    const filtered = entries.filter(e => !excluded.has(e));
    filtered.sort();
    return filtered.join('|');
  } catch (err) {
    return '';
  }
}

/**
 * Comparer function to sort projects by latest modifiedAt, then latest createdAt, then shortest path.
 */
function compareProjects(a, b) {
  const aTime = a.modifiedAt ? Date.parse(a.modifiedAt) : 0;
  const bTime = b.modifiedAt ? Date.parse(b.modifiedAt) : 0;
  if (aTime !== bTime) {
    return bTime - aTime; // descending (latest first)
  }
  const aCreate = a.createdAt ? Date.parse(a.createdAt) : 0;
  const bCreate = b.createdAt ? Date.parse(b.createdAt) : 0;
  if (aCreate !== bCreate) {
    return bCreate - aCreate; // descending (latest first)
  }
  return a.path.length - b.path.length; // ascending (shortest path first)
}

/**
 * Groups duplicate projects into backup sets, designating a single primary project.
 * 
 * @param {Array<Object>} projects Array of projects.
 * @returns {Array<Object>} The same projects array, annotated in place.
 */
function groupBackups(projects) {
  if (!projects || !Array.isArray(projects)) return [];

  try {
    const projectMap = new Map();
    for (const p of projects) {
      if (!p.id) {
        p.id = sha1(p.path);
      }
      projectMap.set(p.path, p);
    }

    const n = projects.length;
    
    // Precompute names and signatures
    const normNames = new Map();
    const contentKeys = new Map();
    const basenames = new Map();

    for (const p of projects) {
      normNames.set(p.path, normName(p.path));
      contentKeys.set(p.path, contentKey(p.path));
      basenames.set(p.path, path.basename(p.path).toLowerCase());
    }

    // Helper to check for explicit copy/backup/version markers in the original folder name
    function hasExplicitMarker(basename) {
      const lower = basename.toLowerCase();
      const markers = [
        ' - copy',
        'copy (',
        ' - old',
        ' old',
        'old one',
        'last one',
        ' - master',
        '-master',
        'backup',
        'bak',
        'نسخة',
        'نسخه',
        'احتياطي'
      ];
      const hasSubstring = markers.some(m => lower.includes(m));
      const hasParenNumber = /\(\d+\)/.test(lower);
      return hasSubstring || hasParenNumber;
    }

    // Helper to evaluate if two projects should reside in the same backup group
    function shouldGroup(p1, p2) {
      if (p1.userBackupDecision === 'independent' || p2.userBackupDecision === 'independent') {
        return false;
      }
      const path1 = p1.path;
      const path2 = p2.path;

      const norm1 = normNames.get(path1);
      const norm2 = normNames.get(path2);

      const base1 = basenames.get(path1);
      const base2 = basenames.get(path2);

      const key1 = contentKeys.get(path1);
      const key2 = contentKeys.get(path2);

      // CONDITION 1: normName matches, at least one has an explicit marker, and they share the same parent directory (drifted copies)
      if (norm1 === norm2) {
        if (hasExplicitMarker(base1) || hasExplicitMarker(base2)) {
          const parent1 = path.dirname(path1).replace(/\\/g, '/').toLowerCase();
          const parent2 = path.dirname(path2).replace(/\\/g, '/').toLowerCase();
          if (parent1 === parent2) {
            return true;
          }
        }
      }

      // CONDITION 2: normName matches, neither has explicit marker, but content is identical (structural duplicates)
      if (norm1 === norm2) {
        if (!hasExplicitMarker(base1) && !hasExplicitMarker(base2)) {
          if (key1 === key2) {
            return true;
          }
        }
      }

      // CONDITION 3: one basename is a prefix of the other with length >= 4, and content is identical
      if (key1 === key2) {
        if (base1.startsWith(base2) && base2.length >= 4) return true;
        if (base2.startsWith(base1) && base1.length >= 4) return true;
      }

      return false;
    }

    // Disjoint-set / Union-Find initialization
    const parent = {};
    function find(x) {
      if (!parent[x]) parent[x] = x;
      if (parent[x] === x) return x;
      return parent[x] = find(parent[x]); // Path compression
    }
    function union(x, y) {
      const rootX = find(x);
      const rootY = find(y);
      if (rootX !== rootY) {
        parent[rootX] = rootY;
      }
    }

    // Initialize Union-Find sets
    for (const p of projects) {
      find(p.path);
    }

    // Evaluate pairings pairwise
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        try {
          if (shouldGroup(projects[i], projects[j])) {
            union(projects[i].path, projects[j].path);
          }
        } catch (e) {
          // Robust comparison fallback
        }
      }
    }

    // Group projects by their root parent path
    const groups = new Map();
    for (const p of projects) {
      const root = find(p.path);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root).push(p);
    }

    // Process each group to identify primaries and backups
    for (const [root, members] of groups.entries()) {
      try {
        if (members.length === 1) {
          // Singleton group
          const single = members[0];
          single.isPrimary = true;
          single.backupOf = null;
          single.groupId = single.id;
          single.backups = [];
          single.backupUncertain = false;
          continue;
        }

        // Split members into backup-like and non-backup-like
        const backupMembers = [];
        const nonBackupMembers = [];

        for (const m of members) {
          if (isBackupLike(m.path)) {
            backupMembers.push(m);
          } else {
            nonBackupMembers.push(m);
          }
        }

        // Select primary project
        let primary;
        if (nonBackupMembers.length > 0) {
          nonBackupMembers.sort(compareProjects);
          primary = nonBackupMembers[0];
        } else {
          backupMembers.sort(compareProjects);
          primary = backupMembers[0];
        }

        const primaryId = primary.id;

        // Annotate members
        for (const m of members) {
          if (m === primary) {
            m.isPrimary = true;
            m.backupOf = null;
            m.groupId = primaryId;
            m.backupUncertain = false;
            
            // Build backups metadata list (sorted by latest)
            const otherMembers = members.filter(x => x !== primary);
            otherMembers.sort(compareProjects);
            m.backups = otherMembers.map(o => ({
              id: o.id,
              name: o.name,
              path: o.path,
              modifiedAt: o.modifiedAt,
              createdAt: o.createdAt,
              isBackupLike: isBackupLike(o.path)
            }));
          } else {
            m.isPrimary = false;
            m.backupOf = primaryId;
            m.groupId = primaryId;
            m.backups = [];
            if (m.userBackupDecision === 'backup') {
              m.backupUncertain = false;
            } else {
              m.backupUncertain = !isBackupLike(m.path);
            }
          }
        }
      } catch (err) {
        // Fallback for an individual group error
        for (const m of members) {
          m.isPrimary = true;
          m.backupOf = null;
          m.groupId = m.id;
          m.backups = [];
        }
      }
    }

  } catch (err) {
    // Fallback for overall grouping error: default all to singletons
    for (const p of projects) {
      p.isPrimary = true;
      p.backupOf = null;
      p.groupId = p.id;
      p.backups = [];
    }
  }

  return projects;
}

module.exports = {
  groupBackups,
  isBackupLike,
  normName,
  contentKey
};
