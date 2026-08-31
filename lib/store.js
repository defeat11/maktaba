const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// logger only depends on fs/path, so this cannot cycle back into the store.
const { logError } = require('./logger');

// Both paths must be overridable, and both must be overridden together: the
// JSON file is a mirror that syncJsonMirror() rewrites in full, so pointing
// only the sqlite path at a scratch file would still clobber the real db.json.
// The test harnesses set these to files under os.tmpdir().
const DB_SQLITE_PATH = process.env.MAKTABA_DB || path.join(__dirname, '../db.sqlite');
const DB_JSON_PATH = process.env.MAKTABA_DB_JSON || path.join(__dirname, '../db.json');

function sha1(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

let db = null;
let useSqlite = false;

function buildJsonList(projects) {
  if (!Array.isArray(projects)) return [];
  return projects.map(p => {
    const id = sha1(p.path);
    const lastModStr = p.lastModified instanceof Date ? p.lastModified.toISOString() : String(p.lastModified);
    return {
      id,
      path: p.path,
      name: p.name || '',
      type: p.type || '',
      description: p.description || '',
      entryFile: p.entryFile || null,
      port: p.port !== undefined && p.port !== null ? p.port : null,
      sizeBytes: p.sizeBytes || 0,
      lastModified: lastModStr,
      duplicates: p.duplicates || [],
      createdAt: p.createdAt || null,
      modifiedAt: p.modifiedAt || null,
      overview: p.overview || null,
      overviewGeneratedAt: p.overviewGeneratedAt || null,
      overviewStack: p.overviewStack || null,
      confidence: p.confidence !== undefined && p.confidence !== null ? p.confidence : null,
      classification: p.classification || null,
      signals: p.signals || [],
      userClassification: p.userClassification || null,
      groupId: p.groupId || id,
      isPrimary: p.isPrimary !== undefined ? !!p.isPrimary : true,
      backupOf: p.backupOf || null,
      backups: p.backups || [],
      assignedPort: p.assignedPort !== undefined && p.assignedPort !== null ? p.assignedPort : null,
      userPortSet: p.userPortSet !== undefined ? !!p.userPortSet : false,
      backupUncertain: p.backupUncertain !== undefined ? !!p.backupUncertain : false,
      userBackupDecision: p.userBackupDecision || null,
      autoStart: p.autoStart !== undefined ? !!p.autoStart : false,
      favorite: p.favorite !== undefined ? !!p.favorite : false,
      runCommand: p.runCommand || null,
      aiProfile: p.aiProfile || null,
      aiAnalyzedAt: p.aiAnalyzedAt || null,
      userRunCommandSet: p.userRunCommandSet !== undefined ? !!p.userRunCommandSet : false,
      doctorHealth: p.doctorHealth || null,
      doctorLastScanAt: p.doctorLastScanAt || null,
      doctorLastOutput: p.doctorLastOutput || null,
      excludeFromAutoFix: p.excludeFromAutoFix !== undefined ? !!p.excludeFromAutoFix : false,
      doctorFixAttempts: p.doctorFixAttempts !== undefined ? Number(p.doctorFixAttempts) : 0,
      doctorLastFixAt: p.doctorLastFixAt || null,
      doctorLastFixSummary: p.doctorLastFixSummary || null,
      doctorNeedsReview: p.doctorNeedsReview !== undefined ? !!p.doctorNeedsReview : false,
      // This is a whitelist projection with no spread: a field missing here is
      // written as absent to db.json on every mirror sync.
      lastSeenAt: p.lastSeenAt || null,
      missing: p.missing !== undefined ? !!p.missing : false,
      profile: p.profile || null,
      quarantine: p.quarantine !== undefined ? !!p.quarantine : false,
      quarantineReason: p.quarantineReason || null,
      quarantineAt: p.quarantineAt || null
    };
  });
}

/**
 * Writes the project list to db.json atomically.
 *
 * db.json is not a throwaway mirror: it is the recovery copy this module reads
 * back to repopulate an empty database, and the store it falls back to when
 * sqlite cannot load. A plain writeFileSync truncates the target first, so a
 * process killed mid-write leaves it unparseable — and this server is killed by
 * watchdogs routinely. Writing to a temp file and renaming means the file on
 * disk is always either the old complete copy or the new one, never a fragment.
 * Measured cost of the extra step: about 1.5 ms per write.
 *
 * @param {Array<Object>} list Rows to persist
 */
function writeJsonAtomic(list) {
  const tmpPath = DB_JSON_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmpPath, DB_JSON_PATH);
}

async function syncJsonMirror() {
  if (!useSqlite) return;
  try {
    const projects = await getProjects();
    const list = buildJsonList(projects);
    writeJsonAtomic(list);
  } catch (err) {
    // A silent console.warn was invisible here: the server runs hidden, so a
    // mirror that stopped updating would never be noticed until it was needed.
    logError('store-sync', err);
    console.warn('Failed to sync JSON mirror:', err.message);
  }
}

try {
  const Database = require('better-sqlite3');
  db = new Database(DB_SQLITE_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      name TEXT,
      type TEXT,
      description TEXT,
      entryFile TEXT,
      port INTEGER,
      sizeBytes INTEGER,
      lastModified TEXT,
      duplicates TEXT,
      createdAt TEXT,
      modifiedAt TEXT,
      overview TEXT,
      overviewGeneratedAt TEXT,
      overviewStack TEXT,
      confidence INTEGER,
      classification TEXT,
      signals TEXT,
      userClassification TEXT,
      groupId TEXT,
      isPrimary INTEGER DEFAULT 1,
      backupOf TEXT,
      backups TEXT,
      assignedPort INTEGER,
      userPortSet INTEGER DEFAULT 0,
      backupUncertain INTEGER DEFAULT 0,
      userBackupDecision TEXT,
      autoStart INTEGER DEFAULT 0,
      favorite INTEGER DEFAULT 0,
      runCommand TEXT,
      aiProfile TEXT,
      aiAnalyzedAt TEXT,
      userRunCommandSet INTEGER DEFAULT 0,
      doctorHealth TEXT,
      doctorLastScanAt TEXT,
      doctorLastOutput TEXT,
      excludeFromAutoFix INTEGER DEFAULT 0,
      doctorFixAttempts INTEGER DEFAULT 0,
      doctorLastFixAt TEXT,
      doctorLastFixSummary TEXT,
      doctorNeedsReview INTEGER DEFAULT 0
    )
  `);

  // Ensure new columns exist in SQLite database if it was already created previously
  for (const col of [
    { name: 'confidence', type: 'INTEGER' },
    { name: 'classification', type: 'TEXT' },
    { name: 'signals', type: 'TEXT' },
    { name: 'userClassification', type: 'TEXT' },
    { name: 'overviewStack', type: 'TEXT' },
    { name: 'groupId', type: 'TEXT' },
    { name: 'isPrimary', type: 'INTEGER DEFAULT 1' },
    { name: 'backupOf', type: 'TEXT' },
    { name: 'backups', type: 'TEXT' },
    { name: 'assignedPort', type: 'INTEGER' },
    { name: 'userPortSet', type: 'INTEGER DEFAULT 0' },
    { name: 'backupUncertain', type: 'INTEGER DEFAULT 0' },
    { name: 'userBackupDecision', type: 'TEXT' },
    { name: 'autoStart', type: 'INTEGER DEFAULT 0' },
    { name: 'favorite', type: 'INTEGER DEFAULT 0' },
    { name: 'runCommand', type: 'TEXT' },
    { name: 'aiProfile', type: 'TEXT' },
    { name: 'aiAnalyzedAt', type: 'TEXT' },
    { name: 'userRunCommandSet', type: 'INTEGER DEFAULT 0' },
    { name: 'doctorHealth', type: 'TEXT' },
    { name: 'doctorLastScanAt', type: 'TEXT' },
    { name: 'doctorLastOutput', type: 'TEXT' },
    { name: 'excludeFromAutoFix', type: 'INTEGER DEFAULT 0' },
    { name: 'doctorFixAttempts', type: 'INTEGER DEFAULT 0' },
    { name: 'doctorLastFixAt', type: 'TEXT' },
    { name: 'doctorLastFixSummary', type: 'TEXT' },
    { name: 'doctorNeedsReview', type: 'INTEGER DEFAULT 0' },
    // A scan no longer deletes rows it did not see; it marks them. A folder
    // that is temporarily unreadable (permissions, an editor lock, a
    // disconnected drive) must not cost the user their overviews and
    // classifications.
    { name: 'lastSeenAt', type: 'TEXT' },
    { name: 'missing', type: 'INTEGER DEFAULT 0' },
    // Deterministic deep profile written by lib/profiler.js: runtime,
    // entry point, dependencies, git state, activity, risk flags. Measured
    // from the folder rather than guessed, and costs no agent budget.
    { name: 'profile', type: 'TEXT' },
    // One switch that means "do not launch this". It did not exist: the doctor
    // scan is the only automated task that actually RUNS the user's programs,
    // and nothing could stop it reaching a given one. excludeFromAutoFix only
    // governs AI writes, the scan-cursor skip list arms itself only after two
    // timeouts, and autoStart is a different question entirely. A watchdog
    // launched by a scan once killed the server mid-cycle.
    { name: 'quarantine', type: 'INTEGER DEFAULT 0' },
    { name: 'quarantineReason', type: 'TEXT' },
    { name: 'quarantineAt', type: 'TEXT' }
  ]) {
    try {
      db.exec(`ALTER TABLE projects ADD COLUMN ${col.name} ${col.type}`);
    } catch (e) {
      // Ignored if column already exists
    }
  }

  useSqlite = true;
  console.log('Database initialized: Using better-sqlite3 store.');

  try {
    const rowCount = db.prepare('SELECT COUNT(*) as count FROM projects').get().count;
    if (rowCount === 0) {
      if (fs.existsSync(DB_JSON_PATH)) {
        const fileContent = fs.readFileSync(DB_JSON_PATH, 'utf8');
        const list = JSON.parse(fileContent);
        if (Array.isArray(list) && list.length > 0) {
          console.log(`SQLite is empty. Importing ${list.length} projects from db.json...`);
          const importedProjects = list.map(item => ({
            ...item,
            lastModified: item.lastModified ? new Date(item.lastModified) : new Date()
          }));
          saveProjectsSqlite(importedProjects);
          console.log('Import successful.');
        }
      }
    } else {
      syncJsonMirror();
    }
  } catch (initErr) {
    console.warn('Error during store initialization/import:', initErr.message);
  }
} catch (err) {
  console.warn('better-sqlite3 is unavailable, falling back to JSON file store. Reason:', err.message);
  useSqlite = false;
}

/**
 * Saves projects to SQLite
 */
function saveProjectsSqlite(projects, fromScan) {
  // No DELETE. This used to be `DELETE FROM projects` followed by re-inserting
  // whatever the caller passed, which meant any caller working from a partial
  // or stale list silently destroyed every row it did not know about — and the
  // rows carry data no rescan can regenerate (AI overviews, run commands,
  // manual classifications). Rows the scan did not see are marked missing
  // instead, so they can be shown as "not found in the last scan" and
  // recovered if the folder comes back.
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO projects (
      id, path, name, type, description, entryFile, port, sizeBytes,
      lastModified, duplicates, createdAt, modifiedAt, overview, overviewGeneratedAt,
      overviewStack, confidence, classification, signals, userClassification,
      groupId, isPrimary, backupOf, backups, assignedPort, userPortSet,
      backupUncertain, userBackupDecision, autoStart, favorite, runCommand,
      aiProfile, aiAnalyzedAt, userRunCommandSet,
      doctorHealth, doctorLastScanAt, doctorLastOutput, excludeFromAutoFix,
      doctorFixAttempts, doctorLastFixAt, doctorLastFixSummary, doctorNeedsReview,
      lastSeenAt, missing, profile,
      quarantine, quarantineReason, quarantineAt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const markMissingStmt = db.prepare('UPDATE projects SET missing = 1 WHERE id = ?');

  // Preserve every row's existing lastSeenAt/missing, so a save that is not a
  // scan cannot overwrite them.
  const priorSeen = new Map();
  for (const row of db.prepare('SELECT id, lastSeenAt, missing, profile, quarantine, quarantineReason, quarantineAt FROM projects').all()) {
    priorSeen.set(row.id, { lastSeenAt: row.lastSeenAt, missing: row.missing, profile: row.profile,
      quarantine: row.quarantine, quarantineReason: row.quarantineReason, quarantineAt: row.quarantineAt });
  }

  const transaction = db.transaction((arr) => {
    const seen = new Set(arr.map(p => sha1(p.path)));
    const nowIso = new Date().toISOString();

    for (const p of arr) {
      const id = sha1(p.path);
      const prior = priorSeen.get(id);
      const lastModStr = p.lastModified instanceof Date ? p.lastModified.toISOString() : String(p.lastModified);
      
      const groupIdVal = p.groupId || id;
      const isPrimaryVal = p.isPrimary !== undefined ? (p.isPrimary ? 1 : 0) : 1;
      const backupOfVal = p.backupOf || null;
      const backupsVal = JSON.stringify(p.backups || []);
      const assignedPortVal = p.assignedPort !== undefined && p.assignedPort !== null ? p.assignedPort : null;
      const userPortSetVal = p.userPortSet !== undefined ? (p.userPortSet ? 1 : 0) : 0;
      const backupUncertainVal = p.backupUncertain !== undefined ? (p.backupUncertain ? 1 : 0) : 0;
      const userBackupDecisionVal = p.userBackupDecision || null;
      const autoStartVal = p.autoStart !== undefined ? (p.autoStart ? 1 : 0) : 0;
      const favoriteVal = p.favorite !== undefined ? (p.favorite ? 1 : 0) : 0;
      const aiProfileVal = p.aiProfile ? JSON.stringify(p.aiProfile) : null;
      const userRunCommandSetVal = p.userRunCommandSet !== undefined ? (p.userRunCommandSet ? 1 : 0) : 0;
      const excludeFromAutoFixVal = p.excludeFromAutoFix !== undefined ? (p.excludeFromAutoFix ? 1 : 0) : 0;
      const doctorFixAttemptsVal = p.doctorFixAttempts !== undefined ? Number(p.doctorFixAttempts) : 0;
      const doctorLastFixAtVal = p.doctorLastFixAt || null;
      const doctorLastFixSummaryVal = p.doctorLastFixSummary || null;
      const doctorNeedsReviewVal = p.doctorNeedsReview !== undefined ? (p.doctorNeedsReview ? 1 : 0) : 0;

      insertStmt.run(
        id,
        p.path,
        p.name || '',
        p.type || '',
        p.description || '',
        p.entryFile || null,
        p.port !== undefined && p.port !== null ? p.port : null,
        p.sizeBytes || 0,
        lastModStr,
        JSON.stringify(p.duplicates || []),
        p.createdAt || null,
        p.modifiedAt || null,
        p.overview || null,
        p.overviewGeneratedAt || null,
        p.overviewStack || null,
        p.confidence !== undefined && p.confidence !== null ? p.confidence : null,
        p.classification || null,
        JSON.stringify(p.signals || []),
        p.userClassification || null,
        groupIdVal,
        isPrimaryVal,
        backupOfVal,
        backupsVal,
        assignedPortVal,
        userPortSetVal,
        backupUncertainVal,
        userBackupDecisionVal,
        autoStartVal,
        favoriteVal,
        p.runCommand || null,
        aiProfileVal,
        p.aiAnalyzedAt || null,
        userRunCommandSetVal,
        p.doctorHealth || null,
        p.doctorLastScanAt || null,
        p.doctorLastOutput || null,
        excludeFromAutoFixVal,
        doctorFixAttemptsVal,
        doctorLastFixAtVal,
        doctorLastFixSummaryVal,
        doctorNeedsReviewVal,
        // "Seen on disk" is a claim only a filesystem scan may make. saveProjects
        // is called from nine places and only one is a scan; the other eight are
        // UI toggles passing the whole project list. Stamping unconditionally
        // meant a single favourite toggle re-dated all 123 rows and cleared every
        // genuine missing flag, disabling the mechanism entirely.
        fromScan ? nowIso : (prior ? prior.lastSeenAt : null),
        fromScan ? 0 : (prior && prior.missing ? 1 : 0),
        // The profile is written by the profiler, never by a scan, so a
        // save must carry the stored one forward or every rescan erases it.
        p.profile !== undefined && p.profile !== null
          ? (typeof p.profile === 'string' ? p.profile : JSON.stringify(p.profile))
          : (prior ? prior.profile : null),
        // Carried forward like the profile. A quarantine the user set is a
        // decision, and a rescan passing the whole list back must not silently
        // undo it — which is exactly how autoStart-style flags get lost.
        p.quarantine !== undefined ? (p.quarantine ? 1 : 0) : (prior && prior.quarantine ? 1 : 0),
        p.quarantineReason !== undefined ? (p.quarantineReason || null) : (prior ? prior.quarantineReason : null),
        p.quarantineAt !== undefined ? (p.quarantineAt || null) : (prior ? prior.quarantineAt : null)
      );
    }

    // Anything a SCAN did not see is marked, not removed. A non-scan save says
    // nothing about what is on disk, so it must not mark anything.
    if (fromScan) {
      for (const row of db.prepare('SELECT id FROM projects').all()) {
        if (!seen.has(row.id)) markMissingStmt.run(row.id);
      }
    }
  });
  transaction(projects);
}

/**
 * Saves projects to JSON file
 */
function saveProjectsJson(projects) {
  const list = buildJsonList(projects);
  writeJsonAtomic(list);
}

/**
 * Saves the scanned project list to the database store.
 * Merges and preserves previously generated AI overviews.
 * 
 * @param {Array<Object>} projects Array of projects with metadata.
 * @returns {Promise<void>}
 */
async function saveProjects(projects, options = {}) {
  // Read existing projects first to merge and preserve AI overviews, userClassification, and user-set ports
  const existing = await getProjects();
  const overviewMap = new Map();
  const userClassMap = new Map();
  const userPortMap = new Map();
  const userBackupDecisionMap = new Map();
  const autoStartMap = new Map();
  const favoriteMap = new Map();
  const runCommandMap = new Map();
  const aiProfileMap = new Map();
  const aiAnalyzedAtMap = new Map();
  const userRunCommandSetMap = new Map();
  const doctorHealthMap = new Map();
  const doctorLastScanAtMap = new Map();
  const doctorLastOutputMap = new Map();
  const excludeFromAutoFixMap = new Map();
  const doctorFixAttemptsMap = new Map();
  const doctorLastFixAtMap = new Map();
  const doctorLastFixSummaryMap = new Map();
  const doctorNeedsReviewMap = new Map();
 
  for (const p of existing) {
    if (p.overview) {
      overviewMap.set(p.id, {
        overview: p.overview,
        overviewGeneratedAt: p.overviewGeneratedAt,
        overviewStack: p.overviewStack
      });
    }
    if (p.userClassification !== undefined && p.userClassification !== null) {
      userClassMap.set(p.id, p.userClassification);
    }
    if (p.userPortSet) {
      userPortMap.set(p.id, {
        assignedPort: p.assignedPort,
        userPortSet: p.userPortSet
      });
    }
    if (p.userBackupDecision !== undefined && p.userBackupDecision !== null) {
      userBackupDecisionMap.set(p.id, p.userBackupDecision);
    }
    if (p.autoStart !== undefined && p.autoStart !== null) {
      autoStartMap.set(p.id, p.autoStart);
    }
    if (p.favorite !== undefined && p.favorite !== null) {
      favoriteMap.set(p.id, p.favorite);
    }
    if (p.runCommand !== undefined && p.runCommand !== null) {
      runCommandMap.set(p.id, p.runCommand);
    }
    if (p.aiProfile !== undefined && p.aiProfile !== null) {
      aiProfileMap.set(p.id, p.aiProfile);
    }
    if (p.aiAnalyzedAt !== undefined && p.aiAnalyzedAt !== null) {
      aiAnalyzedAtMap.set(p.id, p.aiAnalyzedAt);
    }
    if (p.userRunCommandSet) {
      userRunCommandSetMap.set(p.id, p.userRunCommandSet);
    }
    if (p.doctorHealth !== undefined && p.doctorHealth !== null) {
      doctorHealthMap.set(p.id, p.doctorHealth);
    }
    if (p.doctorLastScanAt !== undefined && p.doctorLastScanAt !== null) {
      doctorLastScanAtMap.set(p.id, p.doctorLastScanAt);
    }
    if (p.doctorLastOutput !== undefined && p.doctorLastOutput !== null) {
      doctorLastOutputMap.set(p.id, p.doctorLastOutput);
    }
    if (p.excludeFromAutoFix !== undefined && p.excludeFromAutoFix !== null) {
      excludeFromAutoFixMap.set(p.id, p.excludeFromAutoFix);
    }
    if (p.doctorFixAttempts !== undefined && p.doctorFixAttempts !== null) {
      doctorFixAttemptsMap.set(p.id, p.doctorFixAttempts);
    }
    if (p.doctorLastFixAt !== undefined && p.doctorLastFixAt !== null) {
      doctorLastFixAtMap.set(p.id, p.doctorLastFixAt);
    }
    if (p.doctorLastFixSummary !== undefined && p.doctorLastFixSummary !== null) {
      doctorLastFixSummaryMap.set(p.id, p.doctorLastFixSummary);
    }
    if (p.doctorNeedsReview !== undefined && p.doctorNeedsReview !== null) {
      doctorNeedsReviewMap.set(p.id, p.doctorNeedsReview);
    }
  }

  // Merge preserved data into the incoming project list
  for (const p of projects) {
    const id = sha1(p.path);
    if (overviewMap.has(id)) {
      const saved = overviewMap.get(id);
      p.overview = saved.overview;
      p.overviewGeneratedAt = saved.overviewGeneratedAt;
      p.overviewStack = saved.overviewStack;
    } else {
      p.overview = p.overview || null;
      p.overviewGeneratedAt = p.overviewGeneratedAt || null;
      p.overviewStack = p.overviewStack || null;
    }
    
    if (userClassMap.has(id) && p.userClassification === undefined) {
      p.userClassification = userClassMap.get(id);
    } else {
      p.userClassification = p.userClassification || null;
    }

    if (userPortMap.has(id) && p.userPortSet === undefined) {
      const savedPort = userPortMap.get(id);
      p.assignedPort = savedPort.assignedPort;
      p.userPortSet = savedPort.userPortSet;
    } else {
      p.assignedPort = p.assignedPort !== undefined && p.assignedPort !== null ? p.assignedPort : null;
      p.userPortSet = p.userPortSet !== undefined ? p.userPortSet : false;
    }

    if (userBackupDecisionMap.has(id) && p.userBackupDecision === undefined) {
      p.userBackupDecision = userBackupDecisionMap.get(id);
    } else {
      p.userBackupDecision = p.userBackupDecision || null;
    }

    if (autoStartMap.has(id) && p.autoStart === undefined) {
      p.autoStart = autoStartMap.get(id);
    } else {
      p.autoStart = p.autoStart || false;
    }

    if (favoriteMap.has(id) && p.favorite === undefined) {
      p.favorite = favoriteMap.get(id);
    } else {
      p.favorite = p.favorite || false;
    }

    if (runCommandMap.has(id) && p.runCommand === undefined) {
      p.runCommand = runCommandMap.get(id);
    } else {
      p.runCommand = p.runCommand || null;
    }

    if (aiProfileMap.has(id) && p.aiProfile === undefined) {
      p.aiProfile = aiProfileMap.get(id);
    } else {
      p.aiProfile = p.aiProfile || null;
    }

    if (aiAnalyzedAtMap.has(id) && p.aiAnalyzedAt === undefined) {
      p.aiAnalyzedAt = aiAnalyzedAtMap.get(id);
    } else {
      p.aiAnalyzedAt = p.aiAnalyzedAt || null;
    }

    if (userRunCommandSetMap.has(id) && p.userRunCommandSet === undefined) {
      p.userRunCommandSet = userRunCommandSetMap.get(id);
    } else {
      p.userRunCommandSet = p.userRunCommandSet !== undefined ? p.userRunCommandSet : false;
    }

    if (doctorHealthMap.has(id) && p.doctorHealth === undefined) {
      p.doctorHealth = doctorHealthMap.get(id);
    } else {
      p.doctorHealth = p.doctorHealth || null;
    }

    if (doctorLastScanAtMap.has(id) && p.doctorLastScanAt === undefined) {
      p.doctorLastScanAt = doctorLastScanAtMap.get(id);
    } else {
      p.doctorLastScanAt = p.doctorLastScanAt || null;
    }

    if (doctorLastOutputMap.has(id) && p.doctorLastOutput === undefined) {
      p.doctorLastOutput = doctorLastOutputMap.get(id);
    } else {
      p.doctorLastOutput = p.doctorLastOutput || null;
    }

    if (excludeFromAutoFixMap.has(id) && p.excludeFromAutoFix === undefined) {
      p.excludeFromAutoFix = excludeFromAutoFixMap.get(id);
    } else {
      p.excludeFromAutoFix = p.excludeFromAutoFix || false;
    }

    if (doctorFixAttemptsMap.has(id) && p.doctorFixAttempts === undefined) {
      p.doctorFixAttempts = doctorFixAttemptsMap.get(id);
    } else {
      p.doctorFixAttempts = p.doctorFixAttempts !== undefined ? p.doctorFixAttempts : 0;
    }

    if (doctorLastFixAtMap.has(id) && p.doctorLastFixAt === undefined) {
      p.doctorLastFixAt = doctorLastFixAtMap.get(id);
    } else {
      p.doctorLastFixAt = p.doctorLastFixAt || null;
    }

    if (doctorLastFixSummaryMap.has(id) && p.doctorLastFixSummary === undefined) {
      p.doctorLastFixSummary = doctorLastFixSummaryMap.get(id);
    } else {
      p.doctorLastFixSummary = p.doctorLastFixSummary || null;
    }

    if (doctorNeedsReviewMap.has(id) && p.doctorNeedsReview === undefined) {
      p.doctorNeedsReview = doctorNeedsReviewMap.get(id);
    } else {
      p.doctorNeedsReview = p.doctorNeedsReview !== undefined ? p.doctorNeedsReview : false;
    }
  }

  // Row-count safety net. doctorGuard.checkRowCountSafe already existed but was
  // only wired into the doctor fix queue — never into the function that
  // actually rewrites the catalog. A save that would drop more than 10% of the
  // rows is refused: legitimate scans grow or hold steady, so a large drop
  // means a partial scan (unreadable folder, disconnected drive, a config.json
  // that failed to parse and fell back to a narrower root).
  if (existing.length > 0 && !options.force) {
    const incomingIds = new Set(projects.map(p => sha1(p.path)));
    const survivors = existing.filter(p => incomingIds.has(p.id)).length;
    const dropRatio = (existing.length - survivors) / existing.length;
    if (dropRatio > 0.1) {
      const msg =
        `Refusing to save: this scan would drop ${existing.length - survivors} of ` +
        `${existing.length} catalogued projects (${Math.round(dropRatio * 100)}%). ` +
        `Likely a partial scan, not a real deletion. If those folders really are ` +
        `gone, re-run with saveProjects(projects, { force: true }).`;
      logError('store-rowguard', new Error(msg));
      throw new Error(msg);
    }
  }

  if (useSqlite && db) {
    try {
      saveProjectsSqlite(projects, options.fromScan === true);
      await syncJsonMirror();
      return;
    } catch (err) {
      console.error('Failed to write to SQLite database. Falling back to JSON file.', err.message);
    }
  }
  saveProjectsJson(projects);
}

/**
 * Retrieves the saved projects from the database store.
 * 
 * @returns {Promise<Array<Object>>} Saved projects.
 */
async function getProjects() {
  if (useSqlite && db) {
    try {
      const stmt = db.prepare('SELECT * FROM projects');
      const rows = stmt.all();
      return rows.map(row => {
        let aiProfile = null;
        if (row.aiProfile) {
          try {
            aiProfile = JSON.parse(row.aiProfile);
          } catch (e) {
            aiProfile = null;
          }
        }
        return {
          id: row.id,
          path: row.path,
          name: row.name,
          type: row.type,
          description: row.description,
          entryFile: row.entryFile,
          port: row.port,
          sizeBytes: row.sizeBytes,
          lastModified: new Date(row.lastModified),
          duplicates: JSON.parse(row.duplicates || '[]'),
          createdAt: row.createdAt,
          modifiedAt: row.modifiedAt,
          overview: row.overview,
          overviewGeneratedAt: row.overviewGeneratedAt,
          overviewStack: row.overviewStack,
          confidence: row.confidence !== undefined && row.confidence !== null ? row.confidence : null,
          classification: row.classification || null,
          signals: JSON.parse(row.signals || '[]'),
          userClassification: row.userClassification || null,
          groupId: row.groupId || row.id,
          isPrimary: row.isPrimary !== undefined ? (row.isPrimary === 1) : true,
          backupOf: row.backupOf || null,
          backups: JSON.parse(row.backups || '[]'),
          assignedPort: row.assignedPort !== undefined && row.assignedPort !== null ? row.assignedPort : null,
          userPortSet: row.userPortSet !== undefined ? (row.userPortSet === 1) : false,
          backupUncertain: row.backupUncertain !== undefined ? (row.backupUncertain === 1) : false,
          userBackupDecision: row.userBackupDecision || null,
          autoStart: row.autoStart !== undefined ? !!row.autoStart : false,
          favorite: row.favorite !== undefined ? !!row.favorite : false,
          runCommand: row.runCommand || null,
          aiProfile,
          aiAnalyzedAt: row.aiAnalyzedAt || null,
          userRunCommandSet: row.userRunCommandSet !== undefined ? (row.userRunCommandSet === 1) : false,
          doctorHealth: row.doctorHealth || null,
          doctorLastScanAt: row.doctorLastScanAt || null,
          doctorLastOutput: row.doctorLastOutput || null,
          excludeFromAutoFix: row.excludeFromAutoFix !== undefined ? (row.excludeFromAutoFix === 1) : false,
          doctorFixAttempts: row.doctorFixAttempts !== undefined && row.doctorFixAttempts !== null ? row.doctorFixAttempts : 0,
          doctorLastFixAt: row.doctorLastFixAt || null,
          doctorLastFixSummary: row.doctorLastFixSummary || null,
          doctorNeedsReview: row.doctorNeedsReview !== undefined ? (row.doctorNeedsReview === 1) : false,
          lastSeenAt: row.lastSeenAt || null,
          missing: row.missing !== undefined ? (row.missing === 1) : false,
          profile: row.profile || null,
          quarantine: row.quarantine !== undefined ? (row.quarantine === 1) : false,
          quarantineReason: row.quarantineReason || null,
          quarantineAt: row.quarantineAt || null
        };
      });
    } catch (err) {
      console.error('Failed to read from SQLite database. Trying JSON file.', err.message);
    }
  }

  if (!fs.existsSync(DB_JSON_PATH)) {
    return [];
  }

  try {
    const content = fs.readFileSync(DB_JSON_PATH, 'utf8');
    const list = JSON.parse(content);
    return list.map(item => ({
      ...item,
      lastModified: new Date(item.lastModified),
      confidence: item.confidence !== undefined && item.confidence !== null ? item.confidence : null,
      classification: item.classification || null,
      signals: item.signals || [],
      userClassification: item.userClassification || null,
      groupId: item.groupId || item.id,
      isPrimary: item.isPrimary !== undefined ? !!item.isPrimary : true,
      backupOf: item.backupOf || null,
      backups: item.backups || [],
      assignedPort: item.assignedPort !== undefined && item.assignedPort !== null ? item.assignedPort : null,
      userPortSet: item.userPortSet !== undefined ? !!item.userPortSet : false,
      backupUncertain: item.backupUncertain !== undefined ? !!item.backupUncertain : false,
      userBackupDecision: item.userBackupDecision || null,
      autoStart: item.autoStart !== undefined ? !!item.autoStart : false,
      favorite: item.favorite !== undefined ? !!item.favorite : false,
      runCommand: item.runCommand || null,
      aiProfile: item.aiProfile || null,
      aiAnalyzedAt: item.aiAnalyzedAt || null,
      userRunCommandSet: item.userRunCommandSet !== undefined ? !!item.userRunCommandSet : false,
      doctorHealth: item.doctorHealth || null,
      doctorLastScanAt: item.doctorLastScanAt || null,
      doctorLastOutput: item.doctorLastOutput || null,
      excludeFromAutoFix: item.excludeFromAutoFix !== undefined ? !!item.excludeFromAutoFix : false,
      doctorFixAttempts: item.doctorFixAttempts !== undefined ? Number(item.doctorFixAttempts) : 0,
      doctorLastFixAt: item.doctorLastFixAt || null,
      doctorLastFixSummary: item.doctorLastFixSummary || null,
      doctorNeedsReview: item.doctorNeedsReview !== undefined ? !!item.doctorNeedsReview : false,
      quarantine: item.quarantine !== undefined ? !!item.quarantine : false,
      quarantineReason: item.quarantineReason || null,
      quarantineAt: item.quarantineAt || null
    }));
  } catch (err) {
    console.error('Error reading JSON file store:', err.message);
    return [];
  }
}

/**
 * Saves/updates the AI overview for a specific project.
 * 
 * @param {string} projectId SHA1 stable project id.
 * @param {Object} overviewObj Overview results including stack tags.
 * @returns {Promise<void>}
 */
async function saveOverview(projectId, overviewObj) {
  const { overview, generatedAt, stack } = overviewObj;

  if (useSqlite && db) {
    try {
      const stmt = db.prepare('UPDATE projects SET overview = ?, overviewGeneratedAt = ?, overviewStack = ? WHERE id = ?');
      stmt.run(overview || null, generatedAt || null, stack || null, projectId);
      await syncJsonMirror();
      return;
    } catch (err) {
      console.error('Failed to update overview in SQLite, trying JSON file store fallback:', err.message);
    }
  }

  if (!fs.existsSync(DB_JSON_PATH)) return;

  try {
    const content = fs.readFileSync(DB_JSON_PATH, 'utf8');
    const list = JSON.parse(content);
    let updated = false;
    for (const item of list) {
      if (item.id === projectId) {
        item.overview = overview || null;
        item.overviewGeneratedAt = generatedAt || null;
        item.overviewStack = stack || null;
        updated = true;
        break;
      }
    }
    if (updated) {
      writeJsonAtomic(list);
    }
  } catch (err) {
    console.error('Error updating overview in JSON file store:', err.message);
  }
}

/**
 * Sets user classification override on a project and recalculates confidence / signals.
 * 
 * @param {string} id Project ID
 * @param {string|null} value 'project' | 'not-project' | null
 * @returns {Promise<Object>} Updated project object
 */
async function setUserClassification(id, value) {
  const projects = await getProjects();
  const project = projects.find(p => p.id === id);
  if (!project) throw new Error('Project not found');

  project.userClassification = value;

  // Recalculate classification using the classifier module
  const { classifyProject } = require('./classifier');
  const result = await classifyProject(project);
  
  project.confidence = result.confidence;
  project.classification = result.classification;
  project.signals = result.signals;

  await saveProjects(projects);
  return project;
}

/**
 * Saves/updates AI footprint profile for a specific project.
 * 
 * @param {string} projectId SHA1 stable project id.
 * @param {Object} updates Fields to update.
 * @returns {Promise<void>}
 */
async function saveAiProfile(projectId, updates) {
  const { aiProfile, aiAnalyzedAt, runCommand, assignedPort, userPortSet, userRunCommandSet } = updates;
  const aiProfileStr = aiProfile ? JSON.stringify(aiProfile) : null;

  if (useSqlite && db) {
    try {
      let query = 'UPDATE projects SET aiProfile = ?, aiAnalyzedAt = ?';
      const params = [aiProfileStr, aiAnalyzedAt || null];

      if (runCommand !== undefined) {
        query += ', runCommand = ?';
        params.push(runCommand);
      }
      if (assignedPort !== undefined) {
        query += ', assignedPort = ?';
        params.push(assignedPort);
      }
      if (userPortSet !== undefined) {
        query += ', userPortSet = ?';
        params.push(userPortSet ? 1 : 0);
      }
      if (userRunCommandSet !== undefined) {
        query += ', userRunCommandSet = ?';
        params.push(userRunCommandSet ? 1 : 0);
      }
      query += ' WHERE id = ?';
      params.push(projectId);

      const stmt = db.prepare(query);
      stmt.run(...params);
      await syncJsonMirror();
      return;
    } catch (err) {
      console.error('Failed to update AI profile in SQLite, trying JSON file store fallback:', err.message);
    }
  }

  if (!fs.existsSync(DB_JSON_PATH)) return;

  try {
    const content = fs.readFileSync(DB_JSON_PATH, 'utf8');
    const list = JSON.parse(content);
    let updated = false;
    for (const item of list) {
      if (item.id === projectId) {
        item.aiProfile = aiProfile || null;
        item.aiAnalyzedAt = aiAnalyzedAt || null;
        if (runCommand !== undefined) {
          item.runCommand = runCommand;
        }
        if (assignedPort !== undefined) {
          item.assignedPort = assignedPort;
        }
        if (userPortSet !== undefined) {
          item.userPortSet = !!userPortSet;
        }
        if (userRunCommandSet !== undefined) {
          item.userRunCommandSet = !!userRunCommandSet;
        }
        updated = true;
        break;
      }
    }
    if (updated) {
      writeJsonAtomic(list);
    }
  } catch (err) {
    console.error('Error updating AI profile in JSON file store:', err.message);
  }
}

/**
 * Saves/updates the doctor scan health results for a specific project.
 * 
 * @param {string} projectId SHA1 stable project id.
 * @param {Object} healthObj Health results.
 * @returns {Promise<void>}
 */
/**
 * Stores a project's deterministic profile — everything lib/profiler.js could
 * establish about it by measurement.
 *
 * @param {string} projectId Project id
 * @param {Object} profile Profile object, stored as JSON
 */
async function saveProfile(projectId, profile) {
  const json = profile ? JSON.stringify(profile) : null;

  if (useSqlite && db) {
    try {
      db.prepare('UPDATE projects SET profile = ? WHERE id = ?').run(json, projectId);
      await syncJsonMirror();
      return;
    } catch (err) {
      logError('store-profile', err);
      console.error('Failed to write profile to SQLite, falling back to JSON:', err.message);
    }
  }

  if (!fs.existsSync(DB_JSON_PATH)) return;
  try {
    const list = JSON.parse(fs.readFileSync(DB_JSON_PATH, 'utf8'));
    let updated = false;
    for (const item of list) {
      if (item.id === projectId) { item.profile = json; updated = true; break; }
    }
    if (updated) writeJsonAtomic(list);
  } catch (err) {
    logError('store-profile', err);
  }
}

async function saveDoctorHealth(projectId, healthObj) {
  const { doctorHealth, doctorLastScanAt, doctorLastOutput } = healthObj;

  if (useSqlite && db) {
    try {
      const stmt = db.prepare('UPDATE projects SET doctorHealth = ?, doctorLastScanAt = ?, doctorLastOutput = ? WHERE id = ?');
      stmt.run(doctorHealth || null, doctorLastScanAt || null, doctorLastOutput || null, projectId);
      await syncJsonMirror();
      return;
    } catch (err) {
      console.error('Failed to update doctor health in SQLite, trying JSON file store fallback:', err.message);
    }
  }

  if (!fs.existsSync(DB_JSON_PATH)) return;

  try {
    const content = fs.readFileSync(DB_JSON_PATH, 'utf8');
    const list = JSON.parse(content);
    let updated = false;
    for (const item of list) {
      if (item.id === projectId) {
        item.doctorHealth = doctorHealth || null;
        item.doctorLastScanAt = doctorLastScanAt || null;
        item.doctorLastOutput = doctorLastOutput || null;
        updated = true;
        break;
      }
    }
    if (updated) {
      writeJsonAtomic(list);
    }
  } catch (err) {
    console.error('Error updating doctor health in JSON file store:', err.message);
  }
}

async function setExcludeFromAutoFix(id, value) {
  const projects = await getProjects();
  const project = projects.find(p => p.id === id);
  if (!project) throw new Error('Project not found');

  project.excludeFromAutoFix = !!value;

  await saveProjects(projects);
  return project;
}

/**
 * Saves/updates specific doctor fix status results for a project.
 * 
 * @param {string} projectId Project ID
 * @param {Object} updates Doctor fix fields to update
 * @returns {Promise<void>}
 */
async function saveDoctorFixStatus(projectId, updates) {
  if (useSqlite && db) {
    try {
      const fields = [];
      const params = [];
      for (const [key, val] of Object.entries(updates)) {
        if (['doctorHealth', 'doctorFixAttempts', 'doctorLastFixAt', 'doctorLastFixSummary', 'doctorNeedsReview'].includes(key)) {
          fields.push(`${key} = ?`);
          if (key === 'doctorNeedsReview') {
            params.push(val ? 1 : 0);
          } else {
            params.push(val);
          }
        }
      }
      if (fields.length > 0) {
        params.push(projectId);
        const stmt = db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`);
        stmt.run(...params);
        await syncJsonMirror();
      }
      return;
    } catch (err) {
      console.error('Failed to update doctor fix status in SQLite:', err.message);
    }
  }

  // JSON fallback
  if (!fs.existsSync(DB_JSON_PATH)) return;
  try {
    const content = fs.readFileSync(DB_JSON_PATH, 'utf8');
    const list = JSON.parse(content);
    let updated = false;
    for (const item of list) {
      if (item.id === projectId) {
        for (const [key, val] of Object.entries(updates)) {
          if (['doctorHealth', 'doctorFixAttempts', 'doctorLastFixAt', 'doctorLastFixSummary', 'doctorNeedsReview'].includes(key)) {
            if (key === 'doctorNeedsReview') {
              item[key] = !!val;
            } else if (key === 'doctorFixAttempts') {
              item[key] = Number(val);
            } else {
              item[key] = val;
            }
          }
        }
        updated = true;
        break;
      }
    }
    if (updated) {
      writeJsonAtomic(list);
    }
  } catch (err) {
    console.error('Error updating doctor fix status in JSON file store:', err.message);
  }
}

module.exports = {
  saveProjects,
  getProjects,
  saveOverview,
  setUserClassification,
  saveAiProfile,
  saveDoctorHealth,
  saveProfile,
  setExcludeFromAutoFix,
  saveDoctorFixStatus
};
