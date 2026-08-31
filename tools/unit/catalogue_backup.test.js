// The catalogue's copy, and the checks that make it worth having.
//
// A backup routine already existed. Its only call site was inside the doctor
// fix queue, which runs on projects whose health is 'broken' — true for 0 of
// 164 rows. So it never ran: two backup events on disk, 2026-06-14 and
// 2026-08-26, seventy-three days apart, while db.json is rewritten daily.
//
// What is at stake is 164 catalogued projects, 145 measured profiles and 109
// health verdicts in two files on one disk, in a repository with no remote and
// a gitignored db.json.
//
// The two things asserted hardest here: a copy is never kept unless it can be
// opened and counted, and pruning never removes the newest one. A backup that
// is not verified is a belief, and a retention rule that can delete the latest
// copy is worse than no retention rule at all.

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'catbak-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

const BACKUPS = path.join(TMP, 'backups');
// Set before the module under test is required. Proving a guard works calls
// logError, and without this those records land in the fleet's real
// logs/error.log, where truth-check counts them as production failures — the
// suite making the project look ill by being run.
process.env.MAKTABA_LOGS_DIR = path.join(TMP, 'logs');
try { fs.mkdirSync(process.env.MAKTABA_LOGS_DIR, { recursive: true }); } catch (e) {}
process.env.MAKTABA_CATALOGUE_BACKUPS = BACKUPS;

const cb = require('../../lib/catalogueBackup');
const Database = require('better-sqlite3');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

/**
 * Builds a catalogue directory holding a sqlite database and its json mirror.
 *
 * @param {string} name Directory name
 * @param {number} rows How many projects to put in it
 * @returns {string} The directory path
 */
function makeCatalogue(name, rows) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT)');
  const insert = db.prepare('INSERT OR REPLACE INTO projects (id, name) VALUES (?, ?)');
  for (let i = 0; i < rows; i++) insert.run('id' + i, 'project ' + i);
  db.close();
  fs.writeFileSync(path.join(dir, 'db.json'),
    JSON.stringify(Array.from({ length: rows }, (_, i) => ({ id: 'id' + i, name: 'project ' + i }))), 'utf8');
  return dir;
}

// --- the verification rule, on its own ---------------------------------------
// Same 10% threshold store.js refuses a save at. Two definitions of "too few
// rows" in one codebase is how they drift and one starts lying.
check('an identical copy passes', cb.verifyRowCount(164, 164).ok === true);
check('a copy short by 5% passes', cb.verifyRowCount(100, 95).ok === true);
check('a copy short by exactly 10% passes', cb.verifyRowCount(100, 90).ok === true);
check('a copy short by 11% is rejected', cb.verifyRowCount(100, 89).ok === false);
check('an empty copy of a full catalogue is rejected', cb.verifyRowCount(164, 0).ok === false);
check('the rejection says both numbers',
  /89/.test(cb.verifyRowCount(100, 89).reason) && /100/.test(cb.verifyRowCount(100, 89).reason),
  cb.verifyRowCount(100, 89).reason);
// The catalogue can legitimately shrink between the copy and the check, so
// more rows in the copy is not a fault.
check('a copy with MORE rows passes', cb.verifyRowCount(100, 120).ok === true);
check('an uncountable copy is rejected', cb.verifyRowCount(100, null).ok === false);
check('with no live count to compare, a readable copy passes', cb.verifyRowCount(null, 50).ok === true);
check('the threshold is the one store.js uses', cb.MAX_DROP_RATIO === 0.1);

// --- taking a copy ------------------------------------------------------------
const catalogue = makeCatalogue('live', 164);

(async () => {
  let out = await cb.backupNow({ root: catalogue });
  check('a copy is taken', out.ok === true && out.skipped === false, JSON.stringify(out));
  check('it counted the rows', out.entry.rows === 164, String(out.entry && out.entry.rows));
  check('it counted the json mirror', out.entry.jsonRows === 164);
  check('it recorded a size', out.entry.bytes > 0);
  check('both files are on disk',
    fs.existsSync(path.join(BACKUPS, out.entry.files.sqlite))
    && fs.existsSync(path.join(BACKUPS, out.entry.files.json)));

  // The copy must be a real database, not just bytes of the right length.
  const counted = cb.countRows(path.join(BACKUPS, out.entry.files.sqlite));
  check('the copy opens as a database and counts', counted.ok === true && counted.rows === 164,
    JSON.stringify(counted));

  // --- an unchanged catalogue is not copied again ------------------------------
  const again = await cb.backupNow({ root: catalogue });
  check('an unchanged catalogue is skipped', again.ok === true && again.skipped === true, JSON.stringify(again));
  check('the skip says why', /لم يتغيّر/.test(again.reason), again.reason);

  // --- a changed catalogue is copied -------------------------------------------
  const db = new Database(path.join(catalogue, 'db.sqlite'));
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('extra', 'one more');
  db.close();
  fs.writeFileSync(path.join(catalogue, 'db.json'),
    JSON.stringify(Array.from({ length: 165 }, (_, i) => ({ id: 'id' + i }))), 'utf8');

  check('a changed catalogue needs a copy', cb.needsBackup(catalogue).needed === true);
  out = await cb.backupNow({ root: catalogue });
  check('the change is copied', out.ok === true && out.skipped === false && out.entry.rows === 165,
    JSON.stringify(out.entry && out.entry.rows));

  // --- an unreadable copy is never kept ----------------------------------------
  // Simulated by pointing the backup at a "database" that is not one: the copy
  // gets written, fails to open, and must be deleted rather than counted.
  const broken = path.join(TMP, 'broken');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'db.sqlite'), 'this is not a database at all', 'utf8');
  fs.writeFileSync(path.join(broken, 'db.json'), '[]', 'utf8');
  const beforeFiles = fs.readdirSync(BACKUPS).length;
  const bad = await cb.backupNow({ root: broken, force: true });
  check('a copy that cannot be opened is refused', bad.ok === false, JSON.stringify(bad));
  check('and it is not left behind on disk', fs.readdirSync(BACKUPS).length === beforeFiles,
    fs.readdirSync(BACKUPS).length + ' vs ' + beforeFiles);

  // --- a broken json mirror does not sink a good database copy -----------------
  const halfBad = makeCatalogue('half-bad', 40);
  fs.writeFileSync(path.join(halfBad, 'db.json'), '{ not json', 'utf8');
  const half = await cb.backupNow({ root: halfBad, force: true });
  check('a good database copy survives a corrupt mirror', half.ok === true && half.entry.rows === 40,
    JSON.stringify(half));
  check('the corrupt mirror is dropped, not kept', half.entry.files.json === null,
    String(half.entry.files.json));

  // --- retention -----------------------------------------------------------------
  // Fabricate a long history: one copy a day for 40 days.
  const entries = [];
  for (let i = 40; i >= 0; i--) {
    const at = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString();
    const stamp = 'fake-' + i;
    const sqliteName = 'db.sqlite.' + stamp + '.bak';
    fs.writeFileSync(path.join(BACKUPS, sqliteName), 'x', 'utf8');
    entries.push({
      stamp, at, rows: 100, jsonRows: 100,
      files: { sqlite: sqliteName, json: null },
      sourceMtimes: {}, bytes: 1, verified: true
    });
  }
  fs.writeFileSync(path.join(BACKUPS, 'manifest.json'), JSON.stringify({ entries }, null, 2), 'utf8');

  const removed = cb.prune();
  const kept = cb.readManifest().entries;
  check('pruning removes old copies', removed > 0, String(removed));
  // 7 days plus 4 weeks is at most 11 distinct copies out of 41.
  check('what remains is within the retention window', kept.length <= 11 && kept.length >= 7,
    kept.length + ' kept');
  // The single most important guarantee: whatever the arithmetic decides, the
  // newest copy is never the one deleted.
  const newest = entries[entries.length - 1].stamp;
  check('the newest copy is never pruned', kept.some(e => e.stamp === newest), newest);
  check('pruned files are gone from disk',
    kept.every(e => fs.existsSync(path.join(BACKUPS, e.files.sqlite)))
    && fs.readdirSync(BACKUPS).filter(f => f.indexOf('fake-') !== -1).length === kept.filter(e => e.stamp.indexOf('fake-') === 0).length);
  // Weekly copies must reach further back than the daily ones, or "7 daily + 4
  // weekly" is just "7 daily" with extra words.
  const ages = kept.map(e => Math.round((Date.now() - new Date(e.at).getTime()) / 86400000));
  check('retention reaches beyond the last week', Math.max.apply(null, ages) > 7, ages.join(','));

  // --- status ---------------------------------------------------------------------
  const state = cb.status();
  check('status counts what is kept', state.count === kept.length, state.count + ' vs ' + kept.length);
  check('status reports an age in hours', typeof state.ageHours === 'number' && state.ageHours >= 0);

  // --- nothing to copy ---------------------------------------------------------------
  const empty = path.join(TMP, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  const none = cb.needsBackup(empty);
  check('an absent catalogue is not an error', none.needed === false && /لا يوجد/.test(none.reason), none.reason);

  const failed = results.filter(r => !r.pass);
  console.log('\nCATALOGUE_BACKUP_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exit(1);
  assert.ok(true);
})();
