// Maktaba's health check on ITSELF.
//
// This app checks whether other projects are healthy. Nothing checked whether
// the app's own foundations were sound — and the cost of that showed up
// repeatedly: a health signal that read crash dumps as success for months, an
// error dashboard reporting 35 errors while the log held 922, a recovery copy
// written in a way that a mid-write kill could destroy, watchdogs restarting
// each other, and uncommitted work sitting in the tree for days while the
// evolution loop seeded itself from HEAD and could not see it.
//
// Every check below exists because that specific thing actually went wrong.
// The rule this encodes is the one that found all of them: do not trust,
// measure.
//
// Read-only. It never fixes, deletes or writes anything.
//
//   node tools/truth-check.js            human-readable report
//   node tools/truth-check.js --json     machine-readable
//
// Exit 0 when everything passes or only warns, 1 when a FAIL is present.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Thresholds. Set from the real numbers on this machine so the report is
// actionable rather than noisy — each sits above today's value, close enough
// to fire before the thing becomes a problem.
const LIMITS = {
  logFileMb: 10,          // logger.js has no rotation at all; error.log is at 3.2 MB
  backupsDirMb: 500,      // snapshotGuard's zip cap; a full backups dir blocks repairs
  healthStaleDays: 14,    // a verdict older than this describes a project that has moved on
  neverScannedPct: 50,    // a catalogue mostly unscanned is a catalogue you cannot trust
  dirtyTreeDays: 2,       // evolve seeds from `git archive HEAD` and cannot see uncommitted work
  expectedWatchdogs: 1,   // more than one and they restart each other
  serverPort: 4500
};

const results = [];
function record(level, area, name, detail, fix) {
  results.push({ level, area, name, detail, fix: fix || null });
}
const ok = (area, name, detail) => record('OK', area, name, detail);
const warn = (area, name, detail, fix) => record('WARN', area, name, detail, fix);
const fail = (area, name, detail, fix) => record('FAIL', area, name, detail, fix);

function mb(bytes) { return Math.round(bytes / 1024 / 1024 * 10) / 10; }

function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else { try { total += fs.statSync(full).size; } catch (e2) {} }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// 1. Data durability — can the catalogue survive losing sqlite?
// ---------------------------------------------------------------------------
function checkDataDurability() {
  const AREA = 'البيانات';
  const sqlitePath = path.join(ROOT, 'db.sqlite');
  const jsonPath = path.join(ROOT, 'db.json');

  // The recovery copy must be readable. If sqlite is ever lost this file is the
  // catalogue, and a truncated one means the app silently starts empty.
  let mirror = null;
  if (!fs.existsSync(jsonPath)) {
    fail(AREA, 'نسخة الإنقاذ db.json', 'الملف غير موجود',
      'شغّل أي عملية حفظ لإعادة توليده، أو استعِد من backups/');
  } else {
    try {
      mirror = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const list = mirror.projects || mirror;
      if (!Array.isArray(list) || list.length === 0) {
        fail(AREA, 'نسخة الإنقاذ db.json', 'الملف صالح لكنه فارغ',
          'استعِد أحدث نسخة من backups/');
      } else {
        ok(AREA, 'نسخة الإنقاذ db.json', list.length + ' صفاً، وتُقرأ بنجاح');
        mirror = list;
      }
    } catch (err) {
      fail(AREA, 'نسخة الإنقاذ db.json', 'تالف — لا يُقرأ كـJSON: ' + err.message.slice(0, 70),
        'استعِد من backups/ فوراً؛ هذه آخر نسخة لو ضاع sqlite');
      mirror = null;
    }
  }

  // Drift between the two stores means one of them is lying about your data.
  if (mirror && fs.existsSync(sqlitePath)) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(sqlitePath, { readonly: true });
      const rows = db.prepare('SELECT * FROM projects').all();
      db.close();

      const byId = new Map(mirror.map(p => [p.id, p]));
      const missingFromMirror = rows.filter(r => !byId.has(r.id)).length;
      const sqliteIds = new Set(rows.map(r => r.id));
      const extraInMirror = mirror.filter(p => !sqliteIds.has(p.id)).length;

      const FIELDS = ['userClassification', 'runCommand', 'assignedPort', 'doctorHealth',
        'excludeFromAutoFix', 'overview', 'aiAnalyzedAt', 'missing'];
      let drifted = 0;
      for (const r of rows) {
        const m = byId.get(r.id);
        if (!m) continue;
        for (const f of FIELDS) {
          let a = r[f], b = m[f];
          if (typeof b === 'boolean') a = !!a;
          if (a === undefined || a === '') a = null;
          if (b === undefined || b === '') b = null;
          if (a !== b) { drifted++; break; }
        }
      }

      if (missingFromMirror || extraInMirror || drifted) {
        fail(AREA, 'تطابق المرآة مع sqlite',
          drifted + ' صفاً منحرفاً، ' + missingFromMirror + ' ناقصاً من المرآة، ' + extraInMirror + ' زائداً',
          'المرآة لم تعد تعكس الحقيقة — افحص أخطاء store-sync في logs/error.log');
      } else {
        ok(AREA, 'تطابق المرآة مع sqlite', rows.length + ' صفاً، صفر انحراف');
      }
    } catch (err) {
      warn(AREA, 'تطابق المرآة مع sqlite', 'تعذّرت المقارنة: ' + err.message.slice(0, 70));
    }
  }

  // A full backups directory means the snapshot guard will start refusing
  // repairs on projects that are not git repositories.
  const backupsDir = path.join(ROOT, 'backups');
  if (fs.existsSync(backupsDir)) {
    const size = mb(dirSizeBytes(backupsDir));
    const count = fs.readdirSync(backupsDir).length;
    if (size > LIMITS.backupsDirMb) {
      warn(AREA, 'مجلد النسخ الاحتياطية', size + ' ميجابايت في ' + count + ' ملف',
        'قلّم القديم — امتلاؤه يمنع لقطات الإصلاح للمشاريع غير المستودعية');
    } else {
      ok(AREA, 'مجلد النسخ الاحتياطية', size + ' ميجابايت في ' + count + ' ملف');
    }
  } else {
    warn(AREA, 'مجلد النسخ الاحتياطية', 'غير موجود',
      'يُنشأ عند أول نسخة؛ لا نسخ احتياطية بعد');
  }
}

// ---------------------------------------------------------------------------
// 2. Signal freshness — are the verdicts the app acts on still true?
// ---------------------------------------------------------------------------
function checkSignalFreshness(projects) {
  const AREA = 'الإشارة';
  if (!projects) return;

  const never = projects.filter(p => !p.doctorLastScanAt);
  const pct = Math.round(never.length / projects.length * 100);
  if (pct > LIMITS.neverScannedPct) {
    warn(AREA, 'تغطية الفحص', never.length + ' من ' + projects.length + ' لم تُفحص قط (' + pct + '%)',
      'شغّل فحصاً كاملاً: POST /api/doctor/scan');
  } else {
    ok(AREA, 'تغطية الفحص', (projects.length - never.length) + ' من ' + projects.length + ' مفحوصة (' + (100 - pct) + '%)');
  }

  const scanned = projects.filter(p => p.doctorLastScanAt);
  if (scanned.length) {
    const oldest = scanned.reduce((a, b) => a.doctorLastScanAt < b.doctorLastScanAt ? a : b);
    const ageDays = Math.floor((Date.now() - new Date(oldest.doctorLastScanAt).getTime()) / 86400000);
    if (ageDays > LIMITS.healthStaleDays) {
      warn(AREA, 'أقدم حكم صحة', ageDays + ' يوماً (' + oldest.name + ')',
        'أعد الفحص — حكم بهذا العمر لا يصف المشروع كما هو الآن');
    } else {
      ok(AREA, 'أقدم حكم صحة', ageDays + ' يوماً');
    }
  }

  // A project marked broken whose folder is gone is a false positive sitting in
  // the repair queue's candidate list — but only while the row has not been
  // retired. Once a scan flags it missing the system has handled it correctly
  // and the verdict is inert, so warning about it then would be crying wolf
  // about the fix working.
  const ghosts = projects.filter(p =>
    p.doctorHealth === 'broken' && p.path && !fs.existsSync(p.path) && p.missing !== true);
  const retired = projects.filter(p =>
    p.path && !fs.existsSync(p.path) && p.missing === true);
  if (ghosts.length) {
    warn(AREA, 'أحكام على مجلدات مفقودة', ghosts.length + ' موسوماً معطوباً، ومجلده غير موجود، ولم يُقاعَد بعد',
      'شغّل مسحاً كاملاً للكتالوج — سيسمها missing فتخرج من قائمة المرشّحين');
  } else {
    ok(AREA, 'أحكام على مجلدات مفقودة',
      retired.length ? 'لا شيء معلّق (' + retired.length + ' مجلداً مفقوداً مُقاعَداً بشكل صحيح)' : 'لا شيء');
  }

  // 'unknown' is the state that protects working code from an agent. Its
  // presence is healthy; its absence across a whole catalogue is suspicious.
  const counts = {};
  projects.forEach(p => { const h = p.doctorHealth || 'never'; counts[h] = (counts[h] || 0) + 1; });
  ok(AREA, 'توزيع الصحة',
    Object.entries(counts).map(([k, v]) => v + ' ' + k).join('، '));
}

// ---------------------------------------------------------------------------
// 3. Silent failures — is anything failing without telling you?
// ---------------------------------------------------------------------------
function checkSilentFailures(projects) {
  const AREA = 'الصمت';

  if (projects) {
    const review = projects.filter(p => p.doctorNeedsReview);
    if (review.length) {
      warn(AREA, 'مشاريع تنتظر مراجعتك', review.length + ': ' + review.slice(0, 4).map(p => p.name).join('، '),
        'راجعها ثم صفّرها عبر POST /api/projects/:id/doctor-reset');
    } else {
      ok(AREA, 'مشاريع تنتظر مراجعتك', 'لا شيء');
    }
  }

  // The error report is what you read to decide priorities. It once showed 35
  // errors while error.log held 922, so the evidence itself was wrong.
  const reportPath = path.join(ROOT, 'logs', 'ERROR-REPORT.md');
  const errorLog = path.join(ROOT, 'logs', 'error.log');
  if (fs.existsSync(reportPath) && fs.existsSync(errorLog)) {
    const reportAgeH = Math.floor((Date.now() - fs.statSync(reportPath).mtimeMs) / 3600000);
    if (reportAgeH > 24 * 7) {
      warn(AREA, 'تقرير الأخطاء', 'عمره ' + Math.floor(reportAgeH / 24) + ' يوماً',
        'يُعاد توليده عند كل إقلاع — قِدَمه يعني أن الخادم لم يُعَد تشغيله منذ مدة');
    } else {
      ok(AREA, 'تقرير الأخطاء', 'محدَّث قبل ' + reportAgeH + ' ساعة');
    }
  }

  // Errors logged in the last 24h, by scope — a spike in one scope is the
  // signal that used to hide in a 3 MB file nobody opened.
  if (fs.existsSync(errorLog)) {
    try {
      const cutoff = new Date(Date.now() - 86400000).toISOString();
      const lines = fs.readFileSync(errorLog, 'utf8').split('\n');
      const recent = lines.filter(l => {
        const m = l.match(/^\[([0-9T:.\-Z]+)\]/);
        return m && m[1] > cutoff;
      });
      const byScope = {};
      const lastSeen = {};
      recent.forEach(l => {
        const m = l.match(/\[ERROR\]\s*\[([^\]]+)\]/);
        const scope = m ? m[1] : 'unknown';
        byScope[scope] = (byScope[scope] || 0) + 1;
        const t = l.match(/^\[([0-9T:.\-Z]+)\]/);
        if (t && (!lastSeen[scope] || t[1] > lastSeen[scope])) lastSeen[scope] = t[1];
      });
      const top = Object.entries(byScope).sort((a, b) => b[1] - a[1]).slice(0, 3);

      // How long ago the busiest source last spoke. This is the difference
      // between a loop still running and a burst that ended hours ago, and the
      // old hint guessed "usually a retry loop with no ceiling" without
      // checking — which was wrong every time it fired today, where the bulk
      // was a test suite proving its own guards worked.
      const busiest = top.length ? top[0][0] : null;
      const quietFor = busiest && lastSeen[busiest]
        ? Math.round((Date.now() - new Date(lastSeen[busiest]).getTime()) / 60000)
        : null;

      if (recent.length === 0) {
        ok(AREA, 'أخطاء آخر 24 ساعة', 'لا شيء');
      } else if (recent.length > 100) {
        const stillGoing = quietFor !== null && quietFor < 15;
        warn(AREA, 'أخطاء آخر 24 ساعة', recent.length + ' خطأ — الأكثر: ' + top.map(([s, n]) => s + ' (' + n + ')').join('، ')
          + (quietFor === null ? '' : ' · آخر ظهور لـ' + busiest + ' قبل ' + quietFor + ' دقيقة'),
          stillGoing
            ? 'المصدر الأكثر ما زال يكتب الآن — افحصه، قد تكون حلقة تعيد المحاولة بلا سقف'
            : 'لا شيء منها حديث — دفعة انتهت، وتخرج من نافذة الـ24 ساعة وحدها');
      } else {
        ok(AREA, 'أخطاء آخر 24 ساعة', recent.length + (top.length ? ' — الأكثر: ' + top.map(([s, n]) => s + ' (' + n + ')').join('، ') : ''));
      }
    } catch (err) {
      warn(AREA, 'أخطاء آخر 24 ساعة', 'تعذّرت القراءة: ' + err.message.slice(0, 60));
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Bounded writers — is anything growing without a ceiling?
// ---------------------------------------------------------------------------
function checkBoundedWriters() {
  const AREA = 'النمو';
  const logsDir = path.join(ROOT, 'logs');
  const watched = [];

  if (fs.existsSync(logsDir)) {
    for (const name of fs.readdirSync(logsDir)) {
      const full = path.join(logsDir, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) watched.push({ name: 'logs/' + name, size: st.size });
      } catch (e) {}
    }
  }
  for (const extra of ['maktaba_evolution.log', 'db.json', 'db.sqlite']) {
    const full = path.join(ROOT, extra);
    if (fs.existsSync(full)) {
      try { watched.push({ name: extra, size: fs.statSync(full).size }); } catch (e) {}
    }
  }

  const over = watched.filter(w => mb(w.size) > LIMITS.logFileMb);
  if (over.length) {
    warn(AREA, 'ملفات تجاوزت الحد',
      over.map(w => w.name + ' (' + mb(w.size) + ' ميجابايت)').join('، '),
      'لا يوجد تدوير في lib/logger.js — قلّمها يدوياً أو أضِف تدويراً');
  } else {
    const biggest = watched.sort((a, b) => b.size - a.size)[0];
    ok(AREA, 'ملفات تجاوزت الحد',
      'لا شيء' + (biggest ? ' (الأكبر: ' + biggest.name + ' ' + mb(biggest.size) + ' ميجابايت)' : ''));
  }

  // logger.js has no rotation at all, so this is a standing condition rather
  // than an incident: worth stating plainly every run.
  const loggerSrc = path.join(ROOT, 'lib', 'logger.js');
  if (fs.existsSync(loggerSrc)) {
    const src = fs.readFileSync(loggerSrc, 'utf8');
    if (!/rotat|maxSize|truncate/i.test(src)) {
      warn(AREA, 'تدوير السجلات', 'lib/logger.js بلا أي منطق تدوير',
        'السجلات تنمو إلى ما لا نهاية؛ أضِف سقفاً أو مهمة تقليم');
    } else {
      ok(AREA, 'تدوير السجلات', 'موجود');
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Repo hygiene — can the evolution loop see your work?
// ---------------------------------------------------------------------------
function checkRepoHygiene() {
  const AREA = 'المستودع';
  let status = '';
  try {
    status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (err) {
    warn(AREA, 'حالة الشجرة', 'تعذّر تشغيل git: ' + err.message.slice(0, 60));
    return;
  }

  if (!status) {
    ok(AREA, 'حالة الشجرة', 'نظيفة');
    return;
  }

  const files = status.split('\n').map(l => l.slice(3).replace(/^"|"$/g, ''));
  // How long has the oldest pending change been sitting there?
  let oldestDays = 0;
  for (const f of files) {
    const full = path.join(ROOT, f);
    try {
      const age = (Date.now() - fs.statSync(full).mtimeMs) / 86400000;
      if (age > oldestDays) oldestDays = age;
    } catch (e) {}
  }
  const days = Math.floor(oldestDays);

  if (days >= LIMITS.dirtyTreeDays) {
    warn(AREA, 'حالة الشجرة', files.length + ' ملفاً معلّقاً، أقدمها منذ ' + days + ' يوماً',
      'حلقة evolve تبذر من git archive HEAD ولا ترى العمل غير المُلتزَم — قد يدهسه الوكيل');
  } else {
    ok(AREA, 'حالة الشجرة', files.length + ' ملفاً معلّقاً (أقدمها اليوم)');
  }
}

// ---------------------------------------------------------------------------
// 6. Lifecycle — is exactly one thing in charge of keeping the server up?
// ---------------------------------------------------------------------------
function checkLifecycle() {
  const AREA = 'دورة الحياة';

  let running = [];
  if (process.platform === 'win32') {
    try {
      // Only the runtimes these watchdogs actually run under. Without this
      // filter the check finds itself: any shell or query whose command line
      // merely CONTAINS the watchdog names matches, and the first run of this
      // script reported two watchdogs when both hits were its own grep.
      const out = execSync(
        'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | ' +
        'Where-Object { $_.Name -in @(\'node.exe\',\'powershell.exe\',\'wscript.exe\') } | ' +
        'ForEach-Object { $_.ProcessId.ToString() + \'|\' + $_.CommandLine }"',
        { encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      running = out.split(/\r?\n/).filter(Boolean).map(l => {
        const [pid, ...rest] = l.split('|');
        return { pid: pid.trim(), cmd: rest.join('|') };
      }).filter(p => {
        // Drop anything that is inspecting processes rather than being one.
        if (/Get-CimInstance|Where-Object|Get-Process/i.test(p.cmd)) return false;
        return /master-supervisor\.js|super-guardian\.mjs|maktaba-guardian\.ps1/i.test(p.cmd);
      }).map(p => {
        let name = 'unknown';
        if (/master-supervisor\.js/i.test(p.cmd)) name = 'master-supervisor';
        else if (/super-guardian\.mjs/i.test(p.cmd)) name = 'super-guardian';
        else if (/maktaba-guardian\.ps1/i.test(p.cmd)) name = 'maktaba-guardian';
        return { pid: p.pid, name };
      });
    } catch (err) {
      warn(AREA, 'عدد الحرّاس', 'تعذّر الفحص: ' + err.message.slice(0, 60));
    }
  }

  // Two watchdogs restart each other's work. This is not hypothetical: a scan
  // was killed 57 seconds in because a second supervisor was in play.
  const names = [...new Set(running.map(r => r.name))];
  if (names.length > LIMITS.expectedWatchdogs) {
    warn(AREA, 'عدد الحرّاس', names.length + ' يعملون: ' + names.join('، '),
      'حارس واحد فقط — المتعددون يعيدون تشغيل بعضهم ويقتلون الفحوص');
  } else if (names.length === 0) {
    warn(AREA, 'عدد الحرّاس', 'لا حارس يعمل',
      'الخادم لن يعود تلقائياً لو سقط');
  } else {
    ok(AREA, 'عدد الحرّاس', names[0] + ' فقط');
  }

  return names;
}

function checkServer() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: LIMITS.serverPort, path: '/api/health', timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const h = JSON.parse(body);
            const hours = Math.floor((h.uptimeMs || 0) / 3600000);
            ok('دورة الحياة', 'الخادم', 'يستجيب (pid ' + h.pid + '، منذ ' + hours + ' ساعة)' +
              (h.scan && h.scan.running ? ' — فحص جارٍ' : ''));
          } catch (e) {
            warn('دورة الحياة', 'الخادم', 'يستجيب برد غير مفهوم');
          }
          resolve();
        });
      }
    );
    req.on('timeout', () => { req.destroy(); warn('دورة الحياة', 'الخادم', 'لا يستجيب خلال 5 ثوانٍ', 'قد يكون مشغولاً بفحص، أو ساقطاً'); resolve(); });
    req.on('error', () => { warn('دورة الحياة', 'الخادم', 'لا يعمل على المنفذ ' + LIMITS.serverPort, 'شغّله: npm start'); resolve(); });
  });
}

// ---------------------------------------------------------------------------
// 7. The repair promise — has the pipeline ever actually closed?
// ---------------------------------------------------------------------------
/**
 * Whether the catalogue has a recent, verified copy.
 *
 * The old backup routine had one call site, inside the doctor fix queue, and
 * that queue only runs on projects whose health is 'broken' — true for 0 of 164
 * rows. Two backup events existed on disk seventy-three days apart. A stale
 * backup is not a smaller problem than no backup: both mean the catalogue that
 * would come back is not the one that was lost.
 */
/**
 * Whether every unit test that exists is actually in the gate.
 *
 * Two test files sat on disk for an hour without running: an edit to
 * package.json's test:unit line used a string replace whose anchor no longer
 * matched, and a replace that matches nothing fails silently. `npm test` stayed
 * green the whole time, because the tests it did not know about could not fail.
 *
 * A test outside the gate proves nothing, and worse, it looks like proof.
 */
function checkTestGate() {
  const AREA = 'الاختبارات';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const gate = (pkg.scripts && pkg.scripts['test:unit']) || '';
    const dir = path.join(ROOT, 'tools', 'unit');
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js'));
    const missing = files.filter(f => gate.indexOf('tools/unit/' + f) === -1);

    if (missing.length) {
      fail(AREA, 'اختبارات خارج البوابة',
        missing.length + ' من ' + files.length + ' ملف اختبار لا يُشغَّل: ' + missing.join('، '),
        'أضِفها إلى test:unit في package.json — اختبار لا يعمل يبدو دليلاً وليس دليلاً');
    } else {
      ok(AREA, 'اختبارات خارج البوابة', files.length + ' ملف اختبار، كلها في البوابة');
    }
  } catch (err) {
    warn(AREA, 'اختبارات خارج البوابة', 'تعذّر الفحص: ' + err.message.slice(0, 60));
  }
}

function checkCatalogueBackup() {
  const AREA = 'البيانات';
  let state;
  try {
    state = require(path.join(ROOT, 'lib', 'catalogueBackup')).status();
  } catch (err) {
    warn(AREA, 'نسخة الكتالوج', 'تعذّر فحصها: ' + err.message.slice(0, 60));
    return;
  }

  if (!state.count) {
    fail(AREA, 'نسخة الكتالوج', 'لا توجد أي نسخة',
      'شغّل المكتبة دقيقة واحدة — تأخذ نسخة تلقائياً بعد الإقلاع بستين ثانية');
    return;
  }

  const mb = Math.round(state.bytes / 104857 ) / 10;
  if (state.ageHours > 48) {
    fail(AREA, 'نسخة الكتالوج', 'آخر نسخة قبل ' + state.ageHours + ' ساعة — أقدم من يومين',
      'المؤقّت الساعي إمّا متوقّف أو الخادم لم يعمل. شغّل المكتبة، أو خذ نسخة يدوياً.');
  } else {
    ok(AREA, 'نسخة الكتالوج', state.count + ' نسخة، آخرها قبل ' + state.ageHours +
      ' ساعة بـ' + state.rows + ' صفاً (' + mb + ' ميجابايت)');
  }
}

function checkRepairPromise() {
  const AREA = 'الإصلاح';
  const historyPath = path.join(ROOT, 'logs', 'fix-history.jsonl');

  // Deliberately not an early return. The budget check below must run even
  // when there is no repair history — a stuck or corrupt budget file is
  // precisely what would produce an empty history, so skipping it here would
  // hide the cause of the very thing being reported.
  let entries = null;
  if (!fs.existsSync(historyPath)) {
    warn(AREA, 'سجل الإصلاحات', 'لا يوجد — لم تُسجَّل أي محاولة إصلاح بعد',
      'الوعد الأساسي للتطبيق ما زال غير مُثبَت');
  } else {
    try {
      entries = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    } catch (err) {
      warn(AREA, 'سجل الإصلاحات', 'تعذّرت قراءته: ' + err.message.slice(0, 60));
    }
  }

  if (entries) {
    const verified = entries.filter(e => e.verified === true);
    const withRestore = entries.filter(e => e.restoreKind);
    if (entries.length === 0) {
      warn(AREA, 'سجل الإصلاحات', 'فارغ');
    } else {
      ok(AREA, 'سجل الإصلاحات', entries.length + ' محاولة، ' + verified.length + ' منها مُتحقَّق منها');
      // Every agent run must have had a way back. One without is a run that
      // could not have been undone.
      const succeeded = entries.filter(e => e.ok).length;
      if (withRestore.length < succeeded) {
        warn(AREA, 'نقاط الاسترجاع', (succeeded - withRestore.length) + ' محاولة نجحت بلا نقطة استرجاع مسجّلة',
          'راجع lib/snapshotGuard.js — كل كتابة وكيل يجب أن يسبقها طريق رجوع');
      } else {
        ok(AREA, 'نقاط الاسترجاع', withRestore.length + ' محاولة تحمل نقطة استرجاع');
      }
    }
  }

  // The daily AI budget file: a stuck counter silently stops all repair work.
  const budgetPath = path.join(ROOT, 'doctor-budget.json');
  if (fs.existsSync(budgetPath)) {
    try {
      const b = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
      const today = new Date().toISOString().slice(0, 10);
      ok(AREA, 'ميزانية الذكاء', b.date === today
        ? 'صُرف ' + b.count + ' اليوم'
        : 'آخر صرف بتاريخ ' + b.date + ' (تُصفَّر تلقائياً عند أول استخدام اليوم)');
    } catch (err) {
      warn(AREA, 'ميزانية الذكاء', 'ملف doctor-budget.json تالف',
        'احذفه — سيُعاد إنشاؤه بعداد صفر');
    }
  } else {
    ok(AREA, 'ميزانية الذكاء', 'لم يُصرف شيء بعد');
  }
}

// ---------------------------------------------------------------------------

function loadProjects() {
  const jsonPath = path.join(ROOT, 'db.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return parsed.projects || parsed;
  } catch (err) {
    return null;
  }
}

function report(asJson) {
  const counts = { OK: 0, WARN: 0, FAIL: 0 };
  results.forEach(r => counts[r.level]++);

  if (asJson) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      summary: counts,
      verdict: counts.FAIL ? 'FAIL' : counts.WARN ? 'WARN' : 'OK',
      checks: results
    }, null, 2));
    return counts;
  }

  const mark = { OK: '  ok  ', WARN: ' warn ', FAIL: ' FAIL ' };
  console.log('');
  console.log('فحص حقيقة مكتبة — ' + new Date().toISOString().replace('T', ' ').slice(0, 16));
  console.log('='.repeat(72));

  // Same grouping fix as fleet-audit: checks are called in the order they were
  // added, not grouped by area, so "البيانات" was printed twice once the
  // catalogue-backup check landed after checks from other areas.
  const areaOrder = [];
  results.forEach(r => { if (areaOrder.indexOf(r.area) === -1) areaOrder.push(r.area); });
  results.sort((a, b) => areaOrder.indexOf(a.area) - areaOrder.indexOf(b.area));

  let currentArea = null;
  for (const r of results) {
    if (r.area !== currentArea) {
      currentArea = r.area;
      console.log('\n' + currentArea);
    }
    console.log('  [' + mark[r.level] + '] ' + r.name + ': ' + r.detail);
    if (r.fix && r.level !== 'OK') console.log('           ← ' + r.fix);
  }

  console.log('\n' + '='.repeat(72));
  console.log('النتيجة: ' + counts.OK + ' سليم · ' + counts.WARN + ' تحذير · ' + counts.FAIL + ' فشل');
  if (counts.FAIL) console.log('يوجد فشل يحتاج تدخلاً.');
  else if (counts.WARN) console.log('لا فشل. التحذيرات تستحق نظرة، ولا تمنع العمل.');
  else console.log('كل الثوابت سليمة.');
  console.log('');
  return counts;
}

(async () => {
  const asJson = process.argv.includes('--json');
  const projects = loadProjects();

  checkDataDurability();
  checkSignalFreshness(projects);
  checkSilentFailures(projects);
  checkBoundedWriters();
  checkRepoHygiene();
  checkLifecycle();
  await checkServer();
  checkTestGate();
  checkCatalogueBackup();
  checkRepairPromise();

  const counts = report(asJson);
  process.exit(counts.FAIL > 0 ? 1 : 0);
})();
