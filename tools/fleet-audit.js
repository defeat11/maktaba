// A standing audit of every program on this machine, from what Maktaba has
// measured — not from anything it guessed or asked an AI.
//
// tools/truth-check.js asks "is Maktaba itself sound?". This asks the other
// question: "across everything it manages, what needs attention?" It reads the
// profile written by lib/profiler.js and the autostart picture from
// lib/systemRegistry.js, and reports only findings that are actionable.
//
//   node tools/fleet-audit.js           human-readable
//   node tools/fleet-audit.js --json    machine-readable
//
// Read-only. Exits 0 unless something needs a decision.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const store = require(path.join(ROOT, 'lib', 'store'));
const systemRegistry = require(path.join(ROOT, 'lib', 'systemRegistry'));

const findings = [];
function add(severity, area, title, detail, items) {
  findings.push({ severity, area, title, detail, items: items || [] });
}

function parseProfile(row) {
  if (!row.profile) return null;
  try {
    return typeof row.profile === 'string' ? JSON.parse(row.profile) : row.profile;
  } catch (err) {
    return null;
  }
}

(async () => {
  const asJson = process.argv.includes('--json');
  const rows = await store.getProjects();
  const live = rows.filter(p => !p.missing);
  const profiled = live.map(p => ({ row: p, prof: parseProfile(p) })).filter(x => x.prof);

  // ── 1. Programs an agent could damage with no way back ────────────────────
  // A repair takes a git restore point when it can. A repository with no commits
  // has no HEAD to reset to, and a large folder cannot be archived either, so
  // those two together mean a repair must be refused — which is safe, but it is
  // also a program Maktaba cannot help.
  const noRestore = profiled.filter(({ prof }) =>
    (prof.git.isRepo && prof.git.commits === 0) || (!prof.git.isRepo && prof.size.megabytes > 500));
  if (noRestore.length) {
    add('warn', 'الاسترجاع', 'برامج بلا نقطة استرجاع ممكنة',
      noRestore.length + ' برنامجاً لا يمكن إصلاحه تلقائياً: مستودع بلا التزامات، أو مجلد أكبر من 500 ميجابايت بلا git',
      noRestore.slice(0, 12).map(({ row, prof }) => row.name +
        (prof.git.isRepo ? '  (git بلا commits)' : '  (' + prof.size.megabytes + 'MB بلا git)')));
  }

  // ── 2. Work that exists only on this disk ─────────────────────────────────
  const unpushed = profiled.filter(({ prof }) => prof.git.isRepo && prof.git.commits > 0 && !prof.git.remote);
  const dirty = profiled.filter(({ prof }) => prof.git.isRepo && prof.git.dirty > 20);
  if (unpushed.length) {
    add('info', 'النسخ', 'مستودعات بلا نسخة بعيدة',
      unpushed.length + ' مستودعاً له تاريخ محلي فقط — لا يوجد remote، فعطل القرص يفقدها',
      unpushed.slice(0, 10).map(({ row, prof }) => row.name + '  (' + prof.git.commits + ' commit)'));
  }
  if (dirty.length) {
    add('info', 'النسخ', 'عمل غير مُلتزَم متراكم',
      dirty.length + ' مستودعاً فيه أكثر من 20 ملفاً معلّقاً',
      dirty.slice(0, 10).map(({ row, prof }) => row.name + '  (' + prof.git.dirty + ' ملفاً)'));
  }

  // ── 3. Programs that can disturb the rest of the machine ──────────────────
  const dangerous = profiled.filter(({ prof }) => prof.risk.isWatchdog || prof.risk.killsProcesses);
  if (dangerous.length) {
    add('warn', 'الخطر', 'برامج تقتل عمليات أو تعمل كحرّاس',
      dangerous.length + ' برنامجاً يمكنه إيقاف عمليات أخرى. تشغيلها آلياً هو ما قتل فحص الدكتور من قبل',
      dangerous.slice(0, 12).map(({ row, prof }) => row.name + '  — ' +
        (prof.risk.evidence[0] || (prof.risk.isWatchdog ? 'watchdog' : 'kills processes'))));
  }

  // ── 4. Ports two programs both claim ──────────────────────────────────────
  const byPort = new Map();
  profiled.forEach(({ row, prof }) => {
    prof.declaredPorts.forEach(port => {
      if (!byPort.has(port)) byPort.set(port, []);
      byPort.get(port).push(row.name);
    });
  });
  const contested = [...byPort.entries()]
    .filter(([, names]) => names.length > 1)
    .sort((a, b) => b[1].length - a[1].length);
  if (contested.length) {
    add('info', 'المنافذ', 'منافذ يطلبها أكثر من برنامج',
      contested.length + ' منفذاً مشتركاً — تشغيل اثنين معاً يفشل أحدهما',
      contested.slice(0, 8).map(([port, names]) =>
        'المنفذ ' + port + ': ' + names.slice(0, 4).join('، ') + (names.length > 4 ? ' +' + (names.length - 4) : '')));
  }

  // ── 5. Programs whose recorded entry point is not there ───────────────────
  const badEntry = profiled.filter(({ prof }) => prof.entry.recorded && prof.entry.recordedExists === false);
  if (badEntry.length) {
    add('warn', 'التشغيل', 'ملف تشغيل مسجَّل غير موجود',
      badEntry.length + ' برنامجاً يشير سجلّه إلى ملف ليس على القرص — وهذا ما أنتج أحكام «معطوب» الكاذبة',
      badEntry.slice(0, 10).map(({ row, prof }) => row.name + '  -> ' + prof.entry.recorded));
  }

  // ── 6. Autostart entries Maktaba does not recognise ───────────────────────
  let registry = null;
  try {
    registry = await systemRegistry.scanSystem(rows);
    if (registry.unknownToMaktaba > 0) {
      const unknown = registry.entries.filter(e => e.unknownToMaktaba);
      add('info', 'الإقلاع', 'يبدأ نفسه ومكتبة لا تعرف برنامجه',
        registry.unknownToMaktaba + ' مدخلاً من ' + registry.total +
        ' (' + registry.vendor + ' منها برامج موردين مستبعَدة، و' + registry.knownToMaktaba + ' مربوطة بمشاريعك)',
        unknown.slice(0, 10).map(e => '[' + e.kind + '] ' + e.name));
    }
    const owned = registry.entries.filter(e => e.matchedProject);
    if (owned.length) {
      add('ok', 'الإقلاع', 'إقلاع تلقائي مربوط بمشاريعك',
        owned.length + ' مدخلاً تعرف مكتبة برنامجه بالضبط',
        owned.map(e => '[' + e.kind + '] ' + e.name + '  -> ' + e.matchedProject));
    }
  } catch (err) {
    add('warn', 'الإقلاع', 'تعذّر فحص الإقلاع التلقائي', err.message, []);
  }

  // ── 7. Coverage ───────────────────────────────────────────────────────────
  const unprofiled = live.filter(p => !p.profile).length;
  const unscanned = live.filter(p => !p.doctorLastScanAt).length;
  add(unprofiled > 0 ? 'warn' : 'ok', 'التغطية', 'اكتمال المعرفة',
    profiled.length + ' من ' + live.length + ' برنامجاً موصوف بالتفصيل، و' +
    (live.length - unscanned) + ' مفحوص صحّياً' +
    (unprofiled ? '  —  ' + unprofiled + ' بلا وصف بعد' : ''), []);

  // ── 7b. Who actually owns each listening port ─────────────────────────────
  // Finding 4 above compares the catalogue against itself. This one looks at
  // the machine, which is a different question with a different answer.
  try {
    const ledger = await require('../lib/portLedger').portLedger(rows);
    if (!ledger.ok) {
      add('info', 'المنافذ', 'تعذّرت قراءة المنافذ الحيّة', ledger.reason, []);
    } else {
      const dark = ledger.rows.filter(r => r.verdict === 'claimed-but-dark');
      const live = ledger.rows.filter(r => r.verdict === 'contested');

      // How much of the machine the process scan can see at all. One ratio,
      // never a list of the rest — that boundary is what keeps this a library
      // of your programs rather than a task manager.
      try {
        const coverage = require('../lib/psscan').getCoverage();
        if (coverage.totalProcesses) {
          add('ok', 'العمليات', 'مدى رؤية المكتبة للعمليات',
            coverage.inFilter + ' عملية مرئية من ' + coverage.totalProcesses +
            ' على الجهاز — المرشّح مشتقّ من لغات مشاريعك' +
            (coverage.runtimesQueried && coverage.runtimesQueried.length
              ? ' (' + coverage.runtimesQueried.join('، ') + ')' : ''), []);
        }
      } catch (err) { /* coverage is a nicety, not a finding */ }

      add('ok', 'المنافذ', 'نسبة المنافذ المعروفة',
        ledger.attributed + ' منفذاً منسوباً لمشروع من ' + ledger.total + ' يستمع على الجهاز، و'
        + ledger.foreign + ' لا علاقة لها بمشاريعك', []);

      if (dark.length) {
        // The catalogue says a project owns this port, the port is alive, and
        // Maktaba cannot see what is holding it. That is not "it is running".
        add('warn', 'المنافذ', 'منفذ يعلنه مشروع ومالكه غير مرئي',
          dark.length + ' منفذاً حيّاً يدّعيه الكتالوج ولا تعرف المكتبة من يحمله',
          dark.map(r => 'المنفذ ' + r.port + ' -> ' + r.projectName
            + (r.ownerName ? '  (يحمله ' + r.ownerName + ')' : '')));
      }
      if (live.length) {
        add('info', 'المنافذ', 'منافذ حيّة يعلنها أكثر من مشروع',
          live.length + ' منفذاً مستمعاً الآن ويدّعيه أكثر من مشروع',
          live.map(r => 'المنفذ ' + r.port + ': ' + r.declaredBy.map(d => d.name).slice(0, 4).join('، ')));
      }
    }
  } catch (err) {
    add('info', 'المنافذ', 'تعذّر فحص سجل المنافذ', err.message, []);
  }

  // ── 8. Work Maktaba took and never gave back ──────────────────────────────
  // The highest-consequence thing this audit can find. A stash is invisible
  // from the folder: the files are simply not there, and nothing else reports
  // it. Three sat unreturned on this machine, one holding nineteen files the
  // user needed.
  try {
    const rp = require('../lib/restorePoints');
    const state = rp.reconcile(rows);
    const open = state.pending.filter(p => !p.alreadyReturned);
    const withWork = open.filter(p => p.holdsRealWork);

    if (!open.length) {
      add('ok', 'الاسترجاع', 'لا شغل محتجز',
        state.checked + ' مستودعاً مفحوصاً — كل ما حفظته المكتبة أُعيد', []);
    } else {
      add(withWork.length ? 'warn' : 'info', 'الاسترجاع', 'شغل حفظته المكتبة ولم تُعِده',
        open.length + ' مشروعاً' + (withWork.length ? '، ' + withWork.length + ' منها فيه شغل حقيقي' : ' (ملفات أدوات فقط)'),
        open.map(p => p.projectName + '  ->  ' + p.trackedCount + ' معدّل و' + p.untrackedCount + ' جديد'
          + (p.canReturn ? '' : '  (الشجرة متسخة — لا يمكن الإرجاع الآن)')));
    }
  } catch (err) {
    add('warn', 'الاسترجاع', 'تعذّر فحص نقاط الاسترجاع', err.message, []);
  }

  // ── 9. Credentials committed into a repository ────────────────────────────
  // Nothing in lib/ ever asked git what it tracks. The profile's quality.env
  // marker is true for 48 projects while only 25 hold a real .env, because it
  // counts .env.example — so it says nothing about risk.
  try {
    const secrets = require('../lib/secrets');
    const scan = secrets.scanAll(rows);
    const certain = scan.exposed.filter(e => e.certain.length);
    const possible = scan.exposed.filter(e => !e.certain.length);

    if (certain.length) {
      const pushed = certain.filter(e => e.hasRemote);
      add('warn', 'الأسرار', 'ملفات اعتماد ملتزَمة في git',
        certain.length + ' مستودعاً يتتبّع ملف أسرار'
        + (pushed.length ? '، ' + pushed.length + ' منها له remote — أي أنها غادرت الجهاز' : ''),
        certain.map(e => e.projectName + '  ->  ' + e.certain.join('، ')
          + (e.hasRemote ? '  [' + e.remote + ']' : '  (محلي فقط)')));
    }
    if (possible.length) {
      // Named separately on purpose: this check reads names, never contents,
      // and a .npmrc usually holds only a registry setting. Reporting it like a
      // private key is the false alarm that makes the real one get skipped.
      add('info', 'الأسرار', 'ملفات قد تحمل رمز دخول',
        possible.length + ' مستودعاً يتتبّع ملفاً من النوع الذي يحمل رمزاً أحياناً — افحصها بنفسك',
        possible.map(e => e.projectName + '  ->  ' + e.possible.join('، ')));
    }
    if (!scan.exposed.length) {
      add('ok', 'الأسرار', 'لا ملفات اعتماد ملتزَمة',
        scan.checked + ' مستودعاً مفحوصاً', []);
    }
  } catch (err) {
    add('warn', 'الأسرار', 'تعذّر فحص الأسرار', err.message, []);
  }

  // ── 10. Programs of yours running inside containers ───────────────────────
  // Maktaba's whole knowledge of Docker used to be one boolean in the profile:
  // does a Dockerfile exist. Two containers were serving ports 9119 and 9120
  // from a project the catalogue called health "unknown".
  try {
    const containers = require('../lib/containers');
    const state = await containers.forProjects(rows);
    if (!state.available) {
      add('info', 'الحاويات', 'تعذّر سؤال Docker', state.reason, []);
    } else if (!state.containers.length) {
      add('ok', 'الحاويات', 'لا حاويات تخصّ مشاريعك',
        state.total + ' حاوية تعمل، لا واحدة منها تشير إلى مشروع مفهرس', []);
    } else {
      // A running container is evidence the program works — but it is not the
      // same evidence the health scan collects, so it is reported beside the
      // verdict, never as the verdict.
      const contradicted = state.containers.filter(c => {
        const row = rows.find(r => r.id === c.matchedProjectId);
        return row && row.doctorHealth !== 'ok';
      });
      add(contradicted.length ? 'info' : 'ok', 'الحاويات', 'مشاريعك تعمل داخل حاويات',
        state.containers.length + ' حاوية مربوطة بمشاريعك من ' + state.total + ' تعمل على الجهاز'
        + (contradicted.length ? '، و' + contradicted.length + ' منها لمشروع حكمُه ليس «سليم»' : ''),
        state.containers.map(c => c.name + '  ->  ' + c.matchedProjectName
          + (c.ports.length ? '  (منفذ ' + c.ports.join('، ') + ')' : '')));
    }
  } catch (err) {
    add('info', 'الحاويات', 'تعذّر فحص الحاويات', err.message, []);
  }

  // ── 11. The AI gateway ────────────────────────────────────────────────────
  // The gateway spends a real quota and answers other programs on this machine,
  // which makes it fleet activity — it belongs in the daily audit like anything
  // else that runs here.
  try {
    const gw = require('../lib/gateway');
    const state = gw.status();
    const usage = gw.getUsage(1);

    if (!state.tokenCreated) {
      add('ok', 'البوابة', 'البوابة مغلقة', 'لا يوجد مفتاح — لا برنامج يقدر يستخدمها', []);
    } else if (!state.keyConfigured) {
      add('warn', 'البوابة', 'مفتاح بوابة بلا مفتاح OpenRouter',
        'البوابة تقبل الطلبات لكنها لا تقدر تحوّلها — كل طلب سيفشل', []);
    } else {
      const failing = Object.keys(usage.byModel || {})
        .filter(k => usage.byModel[k].failures > 0)
        .map(k => k + ': ' + usage.byModel[k].failures + ' فشل من ' + usage.byModel[k].calls);
      add('ok', 'البوابة', 'البوابة تعمل',
        usage.calls + ' طلباً · ' + usage.tokens.toLocaleString('en-US') + ' توكن' +
        (state.best ? '  —  auto → ' + state.best.id : ''), failing.slice(0, 5));
    }

    // Scores that are months old make "auto" a claim about a fleet that has
    // changed. Free models come and go weekly.
    const bench = require('../lib/modelBench');
    const progress = bench.getBenchProgress();
    if (state.tokenCreated || progress.scoredModels) {
      const ageDays = progress.updatedAt
        ? Math.round((Date.now() - new Date(progress.updatedAt).getTime()) / 86400000)
        : null;
      if (ageDays === null) {
        add('warn', 'البوابة', 'لم تُقَس النماذج بعد', 'auto لا يقدر يختار بلا قياس', []);
      } else if (ageDays > 14) {
        add('warn', 'البوابة', 'قياس النماذج قديم',
          'آخر قياس قبل ' + ageDays + ' يوماً لـ ' + progress.scoredModels + ' نموذجاً — أعِد القياس', []);
      } else {
        add('ok', 'البوابة', 'قياس النماذج حديث',
          progress.scoredModels + ' نموذجاً مُقيَّماً، آخر قياس قبل ' + ageDays + ' يوماً', []);
      }
    }
  } catch (err) {
    add('warn', 'البوابة', 'تعذّر فحص البوابة', err.message, []);
  }

  // ── report ────────────────────────────────────────────────────────────────
  const counts = { ok: 0, info: 0, warn: 0 };
  findings.forEach(f => counts[f.severity]++);

  const report = { generatedAt: new Date().toISOString(), counts, findings };

  // Always leave the result on disk, so a scheduled run is not a report nobody
  // ever sees. logger.appendBounded keeps the history from growing forever.
  try {
    const logsDir = path.join(ROOT, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'fleet-audit.json'), JSON.stringify(report, null, 2), 'utf8');
    const { appendBounded } = require(path.join(ROOT, 'lib', 'logger'));
    appendBounded(path.join(logsDir, 'fleet-audit-history.jsonl'),
      JSON.stringify({ ts: report.generatedAt, counts, titles: findings.filter(f => f.severity !== 'ok').map(f => f.title) }) + '\n',
      10 * 1024 * 1024, 5000);
  } catch (err) {
    console.error('could not write the audit report: ' + err.message);
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(counts.warn ? 1 : 0);
  }

  const mark = { ok: '  ok  ', info: ' info ', warn: ' warn ' };
  console.log('');
  console.log('تدقيق أسطول البرامج — ' + new Date().toISOString().replace('T', ' ').slice(0, 16));
  console.log('='.repeat(74));
  console.log('البرامج الحيّة: ' + live.length + '   الموصوفة: ' + profiled.length +
    (registry ? '   مداخل الإقلاع: ' + registry.total : ''));

  // Group by area before printing. The heading is emitted only when the area
  // changes, which silently assumed findings were pushed grouped — and they are
  // not: sections were appended over time in the order they were written, so
  // "المنافذ" and "الاسترجاع" each headed two separate blocks. Sorting by
  // first-appearance keeps the intended section order within each area.
  const areaOrder = [];
  findings.forEach(f => { if (areaOrder.indexOf(f.area) === -1) areaOrder.push(f.area); });
  findings.sort((a, b) => areaOrder.indexOf(a.area) - areaOrder.indexOf(b.area));

  let area = null;
  for (const f of findings) {
    if (f.area !== area) { area = f.area; console.log('\n' + area); }
    console.log('  [' + mark[f.severity] + '] ' + f.title);
    console.log('           ' + f.detail);
    f.items.forEach(i => console.log('             · ' + i));
  }

  console.log('\n' + '='.repeat(74));
  console.log('النتيجة: ' + counts.ok + ' سليم · ' + counts.info + ' للعلم · ' + counts.warn + ' يحتاج نظرة');
  console.log('');
  process.exit(counts.warn ? 1 : 0);
})().catch(err => { console.error('audit failed: ' + err.stack); process.exit(2); });
