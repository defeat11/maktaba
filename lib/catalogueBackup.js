// A verified copy of the catalogue, taken on a timer that actually fires.
//
// A backup routine already existed — doctorGuard.backupDbBeforeCycle — with a
// single call site in doctorQueue.js. The queue only runs on projects whose
// doctorHealth is 'broken', and that is true for 0 of 164 rows, so the queue
// has never processed anything and the backup has essentially never run.
// What is on disk: two backup events, 2026-06-14 and 2026-08-26, seventy-three
// days apart, while db.json is rewritten every day.
//
// What is at stake is not code. It is 164 catalogued projects, 145 measured
// profiles and 109 health verdicts, living in two files on one disk. Maktaba's
// own repository has no remote, and db.json is gitignored, so git history would
// not bring the catalogue back either.
//
// Two rules make a copy worth having:
//   * it is verified after it is written, by opening it and counting rows —
//     an unverified backup is a belief, not a backup
//   * the check is the SAME 10% drop rule store.js already enforces on saves,
//     read from one place rather than invented a second time here

const fs = require('fs');
const path = require('path');
const { logInfo, logError } = require('./logger');

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = process.env.MAKTABA_CATALOGUE_BACKUPS
  || path.join(ROOT, 'backups', 'catalogue');
const MANIFEST = path.join(BACKUP_DIR, 'manifest.json');

// The same threshold store.js refuses a save at. A copy holding more than a
// tenth fewer rows than the live catalogue is a torn copy, not a smaller
// catalogue.
const MAX_DROP_RATIO = 0.1;

const KEEP_DAILY = 7;
const KEEP_WEEKLY = 4;

function sourcePaths(root) {
  const base = root || ROOT;
  return { sqlite: path.join(base, 'db.sqlite'), json: path.join(base, 'db.json') };
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch (err) { return null; }
}

function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readManifest() {
  try {
    if (!fs.existsSync(MANIFEST)) return { entries: [] };
    const parsed = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch (err) {
    logError('catalogue-backup', err);
    return { entries: [] };
  }
}

function writeManifest(manifest) {
  try {
    const tmp = MANIFEST + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
    fs.renameSync(tmp, MANIFEST);
  } catch (err) {
    logError('catalogue-backup', err);
  }
}

/**
 * Whether the catalogue has changed since the last copy was taken.
 *
 * Copying an unchanged file every hour would fill the disk with identical
 * archives and push the genuinely different ones out of the retention window.
 *
 * @param {string} [root] Directory holding db.sqlite and db.json
 * @returns {{needed: boolean, reason: string}}
 */
function needsBackup(root) {
  const src = sourcePaths(root);
  if (!fs.existsSync(src.sqlite) && !fs.existsSync(src.json)) {
    return { needed: false, reason: 'لا يوجد كتالوج لنسخه.' };
  }

  const entries = readManifest().entries;
  const last = entries.length ? entries[entries.length - 1] : null;
  if (!last) return { needed: true, reason: 'لا توجد نسخة بعد.' };

  const now = { sqlite: mtimeOf(src.sqlite), json: mtimeOf(src.json) };
  const before = last.sourceMtimes || {};
  if (now.sqlite !== before.sqlite || now.json !== before.json) {
    return { needed: true, reason: 'الكتالوج تغيّر منذ آخر نسخة.' };
  }
  return { needed: false, reason: 'لم يتغيّر الكتالوج منذ آخر نسخة.' };
}

/**
 * Counts the rows in a copied database, without touching the live one.
 *
 * @param {string} file Path to a copied .sqlite file
 * @returns {{ok: boolean, rows: number|null, error: string|null}}
 */
function countRows(file) {
  let db = null;
  try {
    const Database = require('better-sqlite3');
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT count(*) AS c FROM projects').get().c;
    return { ok: true, rows, error: null };
  } catch (err) {
    return { ok: false, rows: null, error: err.message };
  } finally {
    if (db) { try { db.close(); } catch (e) { /* closing a failed open */ } }
  }
}

/**
 * Judges a copy by its row count against the live catalogue.
 *
 * Deliberately the same 10% rule store.js applies when refusing a save, rather
 * than a second threshold invented here: two different definitions of "too few
 * rows" in one codebase is how they drift apart and one of them starts lying.
 *
 * A copy holding MORE rows than the live catalogue is fine — the catalogue can
 * legitimately shrink between the copy and the check.
 *
 * @param {number|null} liveRows Rows in the live catalogue
 * @param {number|null} copyRows Rows in the copy
 * @returns {{ok: boolean, reason: string|null}}
 */
function verifyRowCount(liveRows, copyRows) {
  if (copyRows === null || copyRows === undefined) {
    return { ok: false, reason: 'تعذّر عدّ صفوف النسخة.' };
  }
  // Nothing to compare against: the copy is readable, and that is all that can
  // honestly be claimed for it.
  if (liveRows === null || liveRows === undefined || liveRows <= 0) {
    return { ok: true, reason: null };
  }
  const dropRatio = (liveRows - copyRows) / liveRows;
  if (dropRatio > MAX_DROP_RATIO) {
    return {
      ok: false,
      reason: 'النسخة فيها ' + copyRows + ' صفاً بينما الكتالوج فيه ' + liveRows
        + ' — نقص أكثر من ' + Math.round(MAX_DROP_RATIO * 100) + '%.'
    };
  }
  return { ok: true, reason: null };
}

/**
 * Takes a copy of the catalogue and proves it is readable before keeping it.
 *
 * @param {Object} [opts] force, root
 * @returns {Promise<Object>} What happened
 */
async function backupNow(opts = {}) {
  const src = sourcePaths(opts.root);

  if (!opts.force) {
    const check = needsBackup(opts.root);
    if (!check.needed) return { ok: true, skipped: true, reason: check.reason };
  }

  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  } catch (err) {
    logError('catalogue-backup', err);
    return { ok: false, error: 'تعذّر إنشاء مجلد النسخ: ' + err.message };
  }

  const stamp = stampNow();
  const sqliteDest = path.join(BACKUP_DIR, 'db.sqlite.' + stamp + '.bak');
  const jsonDest = path.join(BACKUP_DIR, 'db.json.' + stamp + '.bak');
  const written = [];

  // Live row count first, so the copy has something to be compared against.
  let liveRows = null;
  if (fs.existsSync(src.sqlite)) {
    const live = countRows(src.sqlite);
    if (live.ok) liveRows = live.rows;
  }

  try {
    if (fs.existsSync(src.sqlite)) {
      // sqlite's own online backup, not a file copy. It coordinates with any
      // write in flight, so the copy cannot catch the database mid-transaction.
      const Database = require('better-sqlite3');
      const source = new Database(src.sqlite, { readonly: true, fileMustExist: true });
      try {
        await source.backup(sqliteDest);
      } finally {
        try { source.close(); } catch (e) { /* already closing */ }
      }
      written.push(sqliteDest);
    }
    if (fs.existsSync(src.json)) {
      fs.copyFileSync(src.json, jsonDest);
      written.push(jsonDest);
    }
  } catch (err) {
    logError('catalogue-backup', err);
    written.forEach(f => { try { fs.unlinkSync(f); } catch (e) { /* nothing to undo */ } });
    return { ok: false, error: 'فشل النسخ: ' + err.message };
  }

  // ── verification ────────────────────────────────────────────────────────
  // After the copy, never during: opening the live database to check it would
  // hold a lock exactly when the scanner may be writing to it.
  const verdict = { rows: null, jsonRows: null };

  if (fs.existsSync(sqliteDest)) {
    const counted = countRows(sqliteDest);
    if (!counted.ok) {
      written.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
      logError('catalogue-backup', new Error('Backup was unreadable and was deleted: ' + counted.error));
      return { ok: false, error: 'النسخة غير قابلة للقراءة فحُذفت: ' + counted.error };
    }
    verdict.rows = counted.rows;

    const verdictRows = verifyRowCount(liveRows, counted.rows);
    if (!verdictRows.ok) {
      written.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
      const msg = verdictRows.reason + ' فحُذفت.';
      logError('catalogue-backup', new Error(msg));
      return { ok: false, error: msg };
    }
  }

  if (fs.existsSync(jsonDest)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonDest, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('db.json ليس مصفوفة.');
      verdict.jsonRows = parsed.length;
    } catch (err) {
      // The JSON mirror failing does not invalidate a good sqlite copy, but it
      // must not be kept and counted as if it were sound.
      try { fs.unlinkSync(jsonDest); } catch (e) {}
      logError('catalogue-backup', new Error('JSON mirror unreadable, dropped from this backup: ' + err.message));
    }
  }

  const entry = {
    stamp,
    at: new Date().toISOString(),
    rows: verdict.rows,
    jsonRows: verdict.jsonRows,
    files: {
      sqlite: fs.existsSync(sqliteDest) ? path.basename(sqliteDest) : null,
      json: fs.existsSync(jsonDest) ? path.basename(jsonDest) : null
    },
    sourceMtimes: { sqlite: mtimeOf(src.sqlite), json: mtimeOf(src.json) },
    bytes: written.reduce((n, f) => {
      try { return n + fs.statSync(f).size; } catch (e) { return n; }
    }, 0),
    verified: true
  };

  const manifest = readManifest();
  manifest.entries.push(entry);
  writeManifest(manifest);

  const pruned = prune();
  logInfo('catalogue-backup', 'Catalogue backed up and verified: ' + entry.rows + ' rows'
    + (pruned ? ', pruned ' + pruned + ' old copy(ies)' : ''));

  return { ok: true, skipped: false, entry, pruned };
}

function dayKey(iso) { return String(iso).slice(0, 10); }

function weekKey(iso) {
  const d = new Date(iso);
  // Year plus the week number, so copies from different years cannot collide.
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.floor((d - start) / (7 * 24 * 3600 * 1000));
  return d.getUTCFullYear() + '-w' + week;
}

/**
 * Keeps the newest copy of each of the last 7 days, then the newest of each of
 * the 4 weeks before that, and removes the rest.
 *
 * @returns {number} How many copies were removed
 */
function prune() {
  const manifest = readManifest();
  const entries = manifest.entries.slice().sort((a, b) => new Date(a.at) - new Date(b.at));
  if (!entries.length) return 0;

  const keep = new Set();

  const byDay = new Map();
  entries.forEach(e => byDay.set(dayKey(e.at), e));
  const days = Array.from(byDay.keys()).sort().slice(-KEEP_DAILY);
  days.forEach(d => keep.add(byDay.get(d).stamp));

  const byWeek = new Map();
  entries.forEach(e => byWeek.set(weekKey(e.at), e));
  const weeks = Array.from(byWeek.keys()).sort().slice(-KEEP_WEEKLY);
  weeks.forEach(w => keep.add(byWeek.get(w).stamp));

  // The newest copy is never pruned, whatever the arithmetic above decides.
  keep.add(entries[entries.length - 1].stamp);

  let removed = 0;
  const survivors = [];
  for (const entry of entries) {
    if (keep.has(entry.stamp)) { survivors.push(entry); continue; }
    for (const name of [entry.files.sqlite, entry.files.json]) {
      if (!name) continue;
      try { fs.unlinkSync(path.join(BACKUP_DIR, name)); } catch (e) { /* already gone */ }
    }
    removed++;
  }

  if (removed) writeManifest({ entries: survivors });
  return removed;
}

/**
 * What the backups look like right now.
 *
 * @returns {Object} Age, count and the newest copy
 */
function status() {
  const entries = readManifest().entries;
  if (!entries.length) {
    return { count: 0, lastAt: null, ageHours: null, rows: null, bytes: 0, dir: BACKUP_DIR };
  }
  const last = entries[entries.length - 1];
  return {
    count: entries.length,
    lastAt: last.at,
    ageHours: Math.round((Date.now() - new Date(last.at).getTime()) / 3600000),
    rows: last.rows,
    bytes: entries.reduce((n, e) => n + (e.bytes || 0), 0),
    dir: BACKUP_DIR
  };
}

module.exports = { backupNow, needsBackup, prune, status, countRows, verifyRowCount, readManifest,
  BACKUP_DIR, MAX_DROP_RATIO };
