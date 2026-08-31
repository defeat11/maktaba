// Re-measures the free models on a schedule, so "auto" keeps meaning what it
// says.
//
// Free models are not a stable set: they appear, disappear, and change limits
// week to week. A ranking measured once and never again slowly becomes a claim
// about a fleet that no longer exists — and the gateway would keep routing real
// traffic by it.
//
//   node tools/bench-models.js            re-measure up to 5 models older than 6 days
//   node tools/bench-models.js --all      re-measure everything
//   node tools/bench-models.js --failed   re-measure only what did not answer
//
// Exit codes: 0 ran or had nothing to do, 1 could not run.

const bench = require('../lib/modelBench');
const { logInfo } = require('../lib/logger');

const args = process.argv.slice(2);
const all = args.indexOf('--all') !== -1;
const failedOnly = args.indexOf('--failed') !== -1;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const opts = {};
  if (failedOnly) opts.onlyFailed = true;
  else if (!all) opts.onlyStaleHours = 24 * 6;

  // Five models is twenty-five requests: a deliberately small slice, because
  // the free tier's daily allowance is not a number anyone has given us.
  // OpenRouter reports limit: null and sends no x-ratelimit headers; the only
  // figure it states is 1000/day for accounts holding 10 credits. What was
  // measured here is that at least 62 free-model requests went through in one
  // day before the rest were refused with "free-models-per-day".
  //
  // So this cap is conservative by choice, not arithmetic. The rest of the
  // allowance belongs to whoever is actually using the gateway; a scheduled job
  // that eats the whole quota leaves nothing for the person it exists to serve.
  // Successive runs pick up where this one left off, because onlyStaleHours
  // skips whatever was measured recently.
  if (!all) opts.limit = 5;

  // Availability first, and cheaply: one request per model instead of five.
  // It answers "can I use this at all", which the benchmark then never has to
  // spend five requests rediscovering — and a model that is blocked or whose
  // provider is down is not worth benchmarking at any price.
  try {
    const availability = require('../lib/modelAvailability');
    const sweep = await availability.runSweep({ onlyStaleHours: 24 });
    if (sweep.started) {
      console.log('يفحص إتاحة ' + sweep.total + ' نموذجاً…');
      while (availability.getProgress().running) await sleep(4000);
      const s = availability.summarise();
      console.log('  مفتوح: ' + s.open + ' من ' + s.total);
    } else {
      console.log('الإتاحة: ' + sweep.reason);
    }
  } catch (err) {
    console.error('تعذّر فحص الإتاحة: ' + err.message);
  }

  let start;
  try {
    start = await bench.runBenchmark(opts);
  } catch (err) {
    console.error('تعذّر بدء القياس: ' + err.message);
    process.exit(1);
  }

  if (!start.started) {
    // Nothing to do is a success. A weekly job that reports failure because the
    // scores were already fresh would train everyone to ignore it.
    console.log(start.reason);
    process.exit(0);
  }

  console.log('يقيس ' + start.total + ' نموذجاً…');
  let last = -1;
  while (bench.getBenchProgress().running) {
    const p = bench.getBenchProgress();
    if (p.done !== last) {
      last = p.done;
      console.log('  ' + p.done + '/' + p.total + (p.current ? '  ' + p.current : ''));
    }
    await sleep(4000);
  }

  const ranked = bench.rankModels();
  console.log('\nالترتيب:');
  ranked.slice(0, 8).forEach((m, i) => {
    console.log('  ' + (i + 1) + '. ' + String(m.rank).padEnd(6) + ' ' + m.passed + '/5  ' +
      (m.medianMs ? Math.round(m.medianMs / 100) / 10 + 's' : '—').padEnd(7) + ' ' + m.id);
  });

  const usable = ranked.filter(m => m.reliability > 0.5).length;
  console.log('\n' + usable + ' من ' + ranked.length + ' نموذجاً صالح للاختيار التلقائي.');
  logInfo('bench-models', `Scheduled benchmark done: ${usable}/${ranked.length} usable, best=${ranked[0] ? ranked[0].id : 'none'}`);
  process.exit(0);
})();
