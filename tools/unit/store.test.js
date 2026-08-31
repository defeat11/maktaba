// Unit test for the store's single most dangerous contract: user data that
// cost real time or real agent budget must survive a rescan.
//
// A rescan calls saveProjects() with freshly walked folders that carry NONE of
// the user-set fields (classification, run command, overview, AI profile,
// doctor state...). saveProjects is expected to merge them back from the rows
// already in the database. That merge is 18 hand-maintained Maps, one per
// field, and a 19th field added without touching all of them would silently
// wipe that column across the whole catalog on the next scan.
//
// This test runs against a throwaway database (MAKTABA_DB / MAKTABA_DB_JSON),
// never the real catalog.

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'maktaba-store-test-'));
// Written before the store is required. Proving the row-count guard refuses a
// bad save logs an ERROR each time, and 41 of those in the fleet's real log had
// truth-check reporting the test suite as a health problem.
process.env.MAKTABA_LOGS_DIR = path.join(TMP_DIR, 'logs');
try { fs.mkdirSync(process.env.MAKTABA_LOGS_DIR, { recursive: true }); } catch (e) {}
process.env.MAKTABA_DB = path.join(TMP_DIR, 'db.sqlite');
process.env.MAKTABA_DB_JSON = path.join(TMP_DIR, 'db.json');
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) {}
});

// Must be required AFTER the env vars above: the paths are read at module load.
const store = require('../../lib/store');

const PROJECT_PATH = path.join(TMP_DIR, 'my-project');
const OTHER_PATH = path.join(TMP_DIR, 'other-project');

// What the scanner produces: filesystem facts only, no user fields at all.
function scanResult() {
  return [
    {
      path: PROJECT_PATH,
      name: 'my-project',
      type: 'node',
      entryFile: 'index.js',
      port: null,
      sizeBytes: 1234,
      lastModified: new Date('2026-01-01T00:00:00.000Z'),
      description: 'scanned',
      classification: 'confirmed',
      confidence: 90,
      signals: []
    },
    {
      path: OTHER_PATH,
      name: 'other-project',
      type: 'python',
      entryFile: 'main.py',
      port: null,
      sizeBytes: 99,
      lastModified: new Date('2026-01-01T00:00:00.000Z'),
      description: 'scanned',
      classification: 'likely',
      confidence: 60,
      signals: []
    }
  ];
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined && !pass ? '   [' + detail + ']' : ''));
}

async function main() {
  // 1. first scan seeds the catalog
  await store.saveProjects(scanResult());
  let projects = await store.getProjects();
  const target = projects.find(p => p.path === PROJECT_PATH);
  assert.ok(target, 'seed project must exist after first save');
  const id = target.id;

  // 2. the user (and the AI pipeline) accumulate data against that row
  await store.setUserClassification(id, 'confirmed');
  await store.saveOverview(id, {
    overview: 'مشروع اختبار',
    generatedAt: '2026-02-01T00:00:00.000Z',
    stack: 'node,express'
  });
  await store.saveAiProfile(id, {
    aiProfile: { runMode: 'multi', services: ['api', 'web'] },
    aiAnalyzedAt: '2026-02-02T00:00:00.000Z',
    runCommand: 'npm run dev',
    assignedPort: 4321,
    userPortSet: true,
    userRunCommandSet: true
  });
  await store.saveDoctorHealth(id, {
    doctorHealth: 'broken',
    doctorLastScanAt: '2026-02-03T00:00:00.000Z',
    doctorLastOutput: 'boom'
  });
  await store.setExcludeFromAutoFix(id, true);
  await store.saveDoctorFixStatus(id, {
    doctorFixAttempts: 2,
    doctorLastFixAt: '2026-02-04T00:00:00.000Z',
    doctorLastFixSummary: 'tried twice',
    doctorNeedsReview: true
  });

  // favorite and autoStart have no dedicated setter — they are written through
  // a full save, the same way the UI routes do it.
  projects = await store.getProjects();
  const withFlags = projects.map(p => (p.id === id ? { ...p, favorite: true, autoStart: true } : p));
  await store.saveProjects(withFlags);

  const before = (await store.getProjects()).find(p => p.id === id);
  check('setup: user data is actually stored', before.userClassification === 'confirmed' && before.favorite === true, JSON.stringify(before && {
    cls: before.userClassification, fav: before.favorite
  }));

  // 3. THE RESCAN — same folders, none of the user fields
  await store.saveProjects(scanResult());

  const after = (await store.getProjects()).find(p => p.id === id);
  assert.ok(after, 'project must still exist after rescan');

  // 4. every user-set field must have survived
  const expectations = [
    ['userClassification', 'confirmed'],
    ['favorite', true],
    ['autoStart', true],
    ['runCommand', 'npm run dev'],
    ['userRunCommandSet', true],
    ['assignedPort', 4321],
    ['userPortSet', true],
    ['aiAnalyzedAt', '2026-02-02T00:00:00.000Z'],
    ['overview', 'مشروع اختبار'],
    ['overviewGeneratedAt', '2026-02-01T00:00:00.000Z'],
    ['overviewStack', 'node,express'],
    ['doctorHealth', 'broken'],
    ['doctorLastScanAt', '2026-02-03T00:00:00.000Z'],
    ['doctorLastOutput', 'boom'],
    ['excludeFromAutoFix', true],
    ['doctorFixAttempts', 2],
    ['doctorLastFixAt', '2026-02-04T00:00:00.000Z'],
    ['doctorLastFixSummary', 'tried twice'],
    ['doctorNeedsReview', true]
  ];

  for (const [field, expected] of expectations) {
    check('rescan preserves ' + field, after[field] === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(after[field]));
  }

  // aiProfile is stored as JSON; compare parsed
  let parsedProfile = null;
  try {
    parsedProfile = typeof after.aiProfile === 'string' ? JSON.parse(after.aiProfile) : after.aiProfile;
  } catch (e) {}
  check(
    'rescan preserves aiProfile',
    !!parsedProfile && parsedProfile.runMode === 'multi',
    JSON.stringify(after.aiProfile)
  );

  // 5. filesystem facts must still be refreshed by the scan (not frozen)
  check('rescan still updates scanned fields', after.type === 'node' && after.sizeBytes === 1234, 'type=' + after.type);

  // 6. A scan that no longer sees a folder must MARK it, not delete it.
  //    This is what protects data when a drive is unplugged or a folder is
  //    briefly unreadable. Dropping 1 of 2 rows is 50%, over the guard's
  //    threshold, so seed a wider catalog first to isolate this behaviour.
  const wide = scanResult();
  for (let i = 0; i < 18; i++) {
    wide.push({
      path: path.join(TMP_DIR, 'filler-' + i),
      name: 'filler-' + i,
      type: 'node',
      entryFile: 'index.js',
      port: null,
      sizeBytes: 1,
      lastModified: new Date('2026-01-01T00:00:00.000Z'),
      description: 'filler',
      classification: 'likely',
      confidence: 50,
      signals: []
    });
  }
  await store.saveProjects(wide, { fromScan: true });
  // now drop exactly one folder (1 of 20 = 5%, under the 10% guard)
  const withoutOne = wide.filter(p => p.path !== OTHER_PATH);
  await store.saveProjects(withoutOne, { fromScan: true });

  const all = await store.getProjects();
  const vanished = all.find(p => p.path === OTHER_PATH);
  check('unseen project is kept, not deleted', !!vanished, 'row count ' + all.length);
  check('unseen project is flagged missing', !!vanished && vanished.missing === true, 'missing=' + (vanished && vanished.missing));
  const stillHere = all.find(p => p.id === id);
  check('seen project is not flagged missing', !!stillHere && stillHere.missing === false, 'missing=' + (stillHere && stillHere.missing));
  check('seen project records lastSeenAt', !!stillHere && typeof stillHere.lastSeenAt === 'string', 'lastSeenAt=' + (stillHere && stillHere.lastSeenAt));

  // 6b. Only a real scan may claim a project was "seen on disk".
  //
  // saveProjects is called from nine places and only one of them is a
  // filesystem scan; the rest are UI toggles that pass the whole project list.
  // While they all stamped lastSeenAt/missing unconditionally, one favourite
  // toggle re-dated every row and cleared every genuine missing flag — so a
  // folder that had actually vanished silently looked present again, and the
  // whole missing mechanism did nothing.
  const beforeToggle = (await store.getProjects()).find(p => p.path === OTHER_PATH);
  const seenStampBefore = beforeToggle.lastSeenAt;
  check('setup: the vanished project is still flagged missing', beforeToggle.missing === true,
    'missing=' + beforeToggle.missing);

  // A UI-style save: the full list, but nothing looked at the disk.
  const currentRows = await store.getProjects();
  await store.saveProjects(currentRows.map(p => (p.id === id ? { ...p, favorite: false } : p)));

  const afterToggle = (await store.getProjects()).find(p => p.path === OTHER_PATH);
  check('a non-scan save does not clear the missing flag', afterToggle.missing === true,
    'missing=' + afterToggle.missing);
  check('a non-scan save does not re-date lastSeenAt', afterToggle.lastSeenAt === seenStampBefore,
    JSON.stringify(seenStampBefore) + ' -> ' + JSON.stringify(afterToggle.lastSeenAt));

  // And a real scan still does both.
  await store.saveProjects(wide, { fromScan: true });
  const afterScan = (await store.getProjects()).find(p => p.path === OTHER_PATH);
  check('a real scan clears missing when the folder is seen again', afterScan.missing === false,
    'missing=' + afterScan.missing);
  check('a real scan re-dates lastSeenAt', afterScan.lastSeenAt !== seenStampBefore,
    JSON.stringify(afterScan.lastSeenAt));

  // 7. A partial scan must be refused outright, not silently applied.
  let refused = false;
  try {
    await store.saveProjects([wide[0]]);   // 1 of 20 rows: a 95% drop
  } catch (err) {
    refused = /Refusing to save/.test(err.message);
  }
  check('partial scan is refused by the row guard', refused, 'no error thrown');
  const afterRefusal = await store.getProjects();
  check('catalog intact after refused save', afterRefusal.length === all.length, afterRefusal.length + ' vs ' + all.length);

  const failed = results.filter(r => !r.pass);
  console.log('\nUNIT(store): ' + (results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('UNIT(store) crashed: ' + err.stack);
  process.exit(1);
});
