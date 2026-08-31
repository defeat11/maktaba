// Measures the free models against each other so "the best one" is a number
// rather than an opinion.
//
// Free models are not interchangeable: some take forty seconds to answer a
// one-line question, some return an empty body, some are rate-limited most of
// the day, and some quietly ignore the language they were asked in. None of
// that is visible from the catalogue listing, so it has to be measured.
//
// Every probe has a verifiable answer. Nothing here asks a model to judge
// another model, and nothing scores "quality" by vibe — a probe either produced
// the required answer or it did not.

const fs = require('fs');
const path = require('path');
const openrouter = require('./openrouter');
const { logInfo, logError, appendBounded } = require('./logger');

// Overridable so tests can score against a throwaway file instead of the real one.
const RESULTS_PATH = process.env.MAKTABA_MODEL_SCORES || path.join(__dirname, '..', 'model-scores.json');

// Probes are deliberately small: cheap to run, quick to fail, and each one
// checks something a router actually needs to know.
const PROBES = [
  {
    id: 'follows-instruction',
    weight: 3,
    prompt: 'Reply with exactly one word: OK',
    check: (text) => /\bok\b/i.test(text) && text.trim().split(/\s+/).length <= 6
  },
  {
    id: 'arabic',
    weight: 3,
    // Most of this user's work is Arabic, so a model that cannot answer in it
    // is not a candidate however fast it is.
    prompt: 'أجب بالعربية بجملة واحدة قصيرة: ما هي عاصمة مصر؟',
    check: (text) => /[؀-ۿ]/.test(text) && /القاهرة/.test(text)
  },
  {
    id: 'reasoning',
    weight: 2,
    prompt: 'A shelf holds 12 books. You remove 5, then add 3. How many books are on the shelf? Reply with the number only.',
    check: (text) => /\b10\b/.test(text)
  },
  {
    id: 'json',
    weight: 2,
    prompt: 'Return ONLY this JSON with no prose and no code fence: {"status":"ready","count":3}',
    check: (text) => {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return false;
      try {
        const o = JSON.parse(m[0]);
        return o.status === 'ready' && o.count === 3;
      } catch (e) { return false; }
    }
  },
  {
    id: 'code',
    weight: 2,
    prompt: 'Write a JavaScript one-liner that reverses a string named s. Code only, no explanation.',
    check: (text) => /split\s*\(\s*['"`]{2}\s*\)|\[\.\.\.s\]|reverse\s*\(/.test(text)
  }
];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * Whether a refusal was the account's daily free allowance running out.
 *
 * This matters more than it looks. A per-minute throttle is worth waiting out;
 * a daily quota is not, and every request after it returns the same refusal.
 * Treating the two the same is what turned a benchmark into a machine for
 * writing zeros against perfectly good models.
 *
 * @param {string} message Error text from OpenRouter
 * @returns {boolean}
 */
function isDailyQuota(message) {
  return /free-models-per-day|per-day|daily/i.test(String(message || ''));
}

// The first benchmark run answered 40 probes and was rate-limited on 42, in one
// unbroken block once the pace passed roughly twenty requests a minute. Those
// models scored zero for being throttled, not for being bad — which is the one
// thing a ranking must never get wrong. Holding the pace below the limit costs
// a few minutes and buys scores that mean what they say.
const MIN_GAP_MS = 3500;
let lastRequestAt = 0;

async function pace() {
  const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

const state = {
  running: false,
  total: 0,
  done: 0,
  current: null,
  startedAt: null,
  stopped: false,
  stoppedReason: null
};

/**
 * Runs every probe against one model and turns the outcome into a score.
 *
 * @param {Object} model Model record from openrouter.listFreeModels
 * @param {Object} [opts] perProbeTimeoutMs
 * @returns {Promise<Object>} The model's scorecard
 */
async function benchModel(model, opts = {}) {
  const result = {
    id: model.id,
    name: model.name,
    contextLength: model.contextLength,
    parameters: model.parameters,
    probes: [],
    passed: 0,
    weightedScore: 0,
    maxWeighted: PROBES.reduce((a, p) => a + p.weight, 0),
    latencies: [],
    errors: [],
    testedAt: new Date().toISOString()
  };

  for (const probe of PROBES) {
    if (state.stopped) break;
    let lastError = null;
    let lastKind = null;
    let lastProvider = null;
    // One retry, and only for a rate limit. A free model that is briefly
    // throttled is not the same as a model that cannot answer, and scoring the
    // two identically would rank a good model below a broken one purely by
    // when the benchmark happened to reach it.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!opts.noPacing) await pace();
        // A model that needs more than a minute and a half to answer "reply
        // with one word" is not a candidate for a gateway, so waiting the full
        // three minutes only makes the weekly run longer without changing the
        // outcome. The wait is recorded as a failure, which is what it is.
        const res = await openrouter.chat(model.id, [{ role: 'user', content: probe.prompt }],
          { maxTokens: 400, temperature: 0, timeoutMs: opts.timeoutMs || 90000 });
        const text = String(res.reply || '');
        const ok = text.trim().length > 0 && probe.check(text);
        result.probes.push({ id: probe.id, ok, ms: res.elapsedMs, sample: text.trim().slice(0, 90),
          retried: attempt > 0 || undefined });
        result.latencies.push(res.elapsedMs);
        if (ok) { result.passed++; result.weightedScore += probe.weight; }
        lastError = null;
        break;
      } catch (err) {
        lastError = String(err.message).slice(0, 160);
        // openrouter.chat now attaches a kind. Reading it beats matching
        // regexes against an Arabic sentence, which is how a provider outage
        // and a spent quota came to look identical.
        lastKind = err.kind || null;
        lastProvider = err.provider || null;

        if (err.kind === 'daily-quota' || (!err.kind && isDailyQuota(err.message))) {
          // Waiting twenty seconds for a limit that resets tomorrow just makes
          // the run longer and the result no truer.
          result.quotaExhausted = true;
          break;
        }

        // A provider failure is worth one more try: OpenRouter may route the
        // same model id to a different upstream next time, which is exactly why
        // one model answers and refuses minutes apart.
        const worthRetrying = err.kind
          ? (err.kind === 'rate-limit' || err.kind === 'provider-failure')
          : /حدّ الطلبات|rate limit|429/i.test(err.message);
        if (!worthRetrying || attempt === 1 || state.stopped) break;
        await sleep(20000);
      }
    }
    if (lastError) {
      // A refusal is information: a model that is rate-limited most of the time
      // is a bad default however well it scores when it does answer. Keeping the
      // KIND alongside the sentence is what lets the page answer "why did this
      // model fail" instead of showing the same red cross for four different
      // causes.
      result.probes.push({ id: probe.id, ok: false, error: lastError, kind: lastKind, provider: lastProvider });
      result.errors.push(lastError);
    }

    // Stop the whole model once the daily allowance is gone.
    //
    // The break in the quota branch above only leaves the retry loop, so every
    // remaining probe still fired against an allowance already known to be
    // spent. Measured: a model that answered three probes and then hit the
    // quota was charged two more failures it never earned — reliability 0.6
    // instead of 0.8, rank 0.678 instead of 0.738 — and that depressed card was
    // persisted and routed by. The comment above promised this; the code did
    // not do it.
    if (result.quotaExhausted) break;
  }

  const lat = result.latencies;
  result.medianMs = lat.length ? lat.slice().sort((a, b) => a - b)[Math.floor(lat.length / 2)] : null;
  result.reliability = PROBES.length ? (PROBES.length - result.errors.length) / PROBES.length : 0;
  result.accuracy = result.maxWeighted ? result.weightedScore / result.maxWeighted : 0;

  // The overall number a router sorts by. Accuracy dominates, reliability gates
  // it, and speed only separates models that are otherwise equal — a fast model
  // that answers wrongly is worthless.
  // Speed on a curve that never flattens, rather than a line that hits zero at
  // sixty seconds and stays there. The old form scored a model answering in 300
  // seconds exactly the same as one answering in 60 — and nemotron-3.5-lightning
  // was answering every probe in 300s while ranking fourth, because nothing in
  // the arithmetic could see the difference.
  //
  // 8s -> 0.71, 30s -> 0.40, 60s -> 0.25, 300s -> 0.06. Still small next to
  // accuracy, which is as it should be: a fast wrong answer is worthless.
  const speedFactor = result.medianMs === null ? 0 : 20000 / (20000 + result.medianMs);
  result.rank = Math.round((result.accuracy * 0.6 + result.reliability * 0.3 + speedFactor * 0.1) * 1000) / 1000;

  return result;
}

/**
 * Benchmarks the free models, newest scores replacing older ones.
 *
 * @param {Object} [opts] limit, onlyStaleHours
 * @returns {Promise<Object>} Summary of the run
 */
async function runBenchmark(opts = {}) {
  if (state.running) return { started: false, reason: 'already running' };
  if (!openrouter.hasKey()) return { started: false, reason: 'لا يوجد مفتاح OpenRouter.' };

  // The pace that keeps this under the rate limit is per-process, so two
  // benchmarks at once (the server and the weekly job, say) would double the
  // request rate and score every model as throttled. A wrong score is worse
  // than a skipped run: it misroutes real traffic until someone re-measures.
  const holder = readLock();
  if (holder) return { started: false, reason: 'قياس آخر يعمل الآن (pid ' + holder.pid + ').' };

  const { models } = await openrouter.listFreeModels(false);

  // Only models whose output is text and nothing else.
  //
  // "Includes text" is not enough: google/lyria-3 declares ["text","audio"] and
  // is a music generator. Asked to reply with one word it answered
  // "[13.7:17.1] OK" — a timestamped lyric line, which passed the probe and put
  // a music model into a ranking of chat models. A model that also emits audio
  // or images is a generator, not a chat endpoint, and the gateway never routes
  // to one.
  let targets = models.filter(isTextOnly);
  const skipped = models.length - targets.length;
  if (skipped > 0) logInfo('model-bench', `Skipping ${skipped} model(s) that do not answer in text alone.`);

  // Drop scores collected before this rule existed, so a model the gateway will
  // never route to cannot keep sitting in the ranking.
  dropIneligible(models);

  // Cards that recorded a refusal rather than a measurement. This was written
  // with a docstring saying an unpruned card "hides it from the gateway
  // forever" and then never called from anything but a test — the one place it
  // could not protect the real scores file.
  pruneUnmeasured();

  if (opts.onlyStaleHours) {
    const previous = readScores();
    const cutoff = Date.now() - opts.onlyStaleHours * 3600000;
    targets = targets.filter(m => {
      const old = previous.models && previous.models[m.id];
      return !old || new Date(old.testedAt).getTime() < cutoff;
    });
  }
  if (opts.onlyFailed) {
    // Re-test only what did not answer cleanly. After a throttled run this is
    // the difference between a five-minute correction and a full re-run.
    const previous = readScores();
    targets = targets.filter(m => {
      const old = previous.models && previous.models[m.id];
      return !old || old.reliability < 1;
    });
  }
  if (opts.limit) targets = targets.slice(0, opts.limit);
  if (!targets.length) return { started: false, reason: 'كل النماذج مُقيَّمة حديثاً.', total: 0 };

  writeLock();
  state.running = true;
  state.total = targets.length;
  state.done = 0;
  state.current = null;
  state.startedAt = new Date().toISOString();
  state.stopped = false;
  state.stoppedReason = null;

  logInfo('model-bench', `Benchmarking ${targets.length} free models.`);

  (async () => {
    const previous = readScores();
    const scores = previous.models || {};
    // Strictly one at a time. Free tiers are rate-limited per key, and running
    // these in parallel turns a benchmark into a self-inflicted 429 storm that
    // measures the limiter instead of the models.
    for (const model of targets) {
      if (state.stopped) break;
      state.current = model.id;
      try {
        const card = await benchModel(model);
        if (card.quotaExhausted) {
          // Everything after this point would score zero for the same reason,
          // so the run stops here and keeps whatever was measured before. A
          // ranking built out of refusals is worse than an incomplete one.
          state.stoppedReason = 'daily-quota';
          logInfo('model-bench', `Daily free quota reached at ${model.id}. Keeping earlier scores.`);
          if (card.passed > 0 && !scores[model.id]) scores[model.id] = card;
          break;
        }
        scores[model.id] = card;
      } catch (err) {
        logError('model-bench', err);
      }
      state.done++;
      writeScores({ updatedAt: new Date().toISOString(), models: scores });
    }
    state.running = false;
    state.current = null;
    clearLock();
    const ranked = rankModels();
    logInfo('model-bench', `Benchmark finished. Best: ${ranked[0] ? ranked[0].id + ' (' + ranked[0].rank + ')' : 'none'}`);
    try {
      appendBounded(path.join(__dirname, '..', 'logs', 'model-bench-history.jsonl'),
        JSON.stringify({ ts: new Date().toISOString(), tested: state.done, best: ranked[0] ? ranked[0].id : null,
          top3: ranked.slice(0, 3).map(m => ({ id: m.id, rank: m.rank })) }) + '\n',
        5 * 1024 * 1024, 2000);
    } catch (e) { /* history is a nicety, not a requirement */ }
  })();

  return { started: true, total: state.total };
}

const LOCK_PATH = RESULTS_PATH.replace(/\.json$/, '') + '.lock';
const LOCK_STALE_MS = 45 * 60 * 1000;

/**
 * The process currently benchmarking, if there is one.
 *
 * A lock left behind by a killed process must not block every future run, so a
 * lock is only honoured while its process is alive and the lock is recent.
 *
 * @returns {{pid: number, at: string}|null}
 */
function readLock() {
  try {
    if (!fs.existsSync(LOCK_PATH)) return null;
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (!lock || !lock.pid) return null;
    if (Date.now() - new Date(lock.at).getTime() > LOCK_STALE_MS) return null;
    if (lock.pid === process.pid) return null;
    try {
      process.kill(lock.pid, 0);
    } catch (e) {
      return null; // the holder is gone
    }
    return lock;
  } catch (err) {
    return null;
  }
}

function writeLock() {
  try {
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
  } catch (err) { /* a lock we cannot write must not stop the run */ }
}

function clearLock() {
  try { if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH); } catch (err) { /* nothing to do */ }
}

function readScores() {
  try {
    if (!fs.existsSync(RESULTS_PATH)) return { updatedAt: null, models: {} };
    return JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
  } catch (err) {
    logError('model-bench', err);
    return { updatedAt: null, models: {} };
  }
}

function writeScores(data) {
  try {
    const tmp = RESULTS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, RESULTS_PATH);
  } catch (err) {
    logError('model-bench', err);
  }
}

/**
 * Whether a model answers in text and nothing else.
 *
 * "Includes text" is not enough: google/lyria-3 declares ["text","audio"] and is
 * a music generator. Asked to reply with one word it answered "[13.7:17.1] OK" —
 * a timestamped lyric line, which passed the probe and put a music model into a
 * ranking of chat models.
 *
 * @param {Object} m Model record
 * @returns {boolean}
 */
function isTextOnly(m) {
  const out = m.outputModalities || [];
  return out.length === 0 || (out.length === 1 && out[0] === 'text');
}

/**
 * Forgets scores for models the gateway would never route to anyway.
 *
 * @param {Array<Object>} models The current free-model list
 * @returns {number} How many cards were dropped
 */
function dropIneligible(models) {
  const data = readScores();
  const stored = data.models || {};
  const ineligible = models.filter(m => !isTextOnly(m)).map(m => m.id);
  const removed = ineligible.filter(id => stored[id]);
  if (!removed.length) return 0;
  removed.forEach(id => { delete stored[id]; });
  writeScores({ updatedAt: new Date().toISOString(), models: stored });
  return removed.length;
}

/**
 * Whether a refusal was any kind of rate limit.
 *
 * @param {string} message Error text
 * @returns {boolean}
 */
function isRateLimit(message) {
  // The daily quota is a rate limit too. Leaving it out would let a card whose
  // every probe was refused for the daily cap survive the prune as a genuine
  // zero — the exact false verdict this pair of checks exists to prevent.
  return /حدّ الطلبات|rate limit|429/i.test(String(message || '')) || isDailyQuota(message);
}

/**
 * Removes scorecards that record a refusal rather than a measurement.
 *
 * A model whose every probe came back "daily quota exhausted" was never tested.
 * Leaving that card in place ranks it at zero and hides it from the gateway
 * forever, which is exactly the wrong conclusion.
 *
 * @returns {number} How many cards were dropped
 */
function pruneUnmeasured() {
  const data = readScores();
  const models = data.models || {};
  let removed = 0;
  for (const id of Object.keys(models)) {
    const probes = models[id].probes || [];
    // Any rate limit, not only the daily one. A card whose every probe was
    // refused holds no measurement of the model at all, and older cards predate
    // the fix that kept OpenRouter's reason, so their text cannot say which
    // limit it was. A permanent refusal — 403, 502 — is different: that IS a
    // measurement, and those cards stay.
    const everyProbeRefused = probes.length > 0 && probes.every(p => p.error && isRateLimit(p.error));
    if (everyProbeRefused) { delete models[id]; removed++; }
  }
  if (removed) writeScores({ updatedAt: new Date().toISOString(), models });
  return removed;
}

/**
 * Every scored model, best first.
 *
 * @returns {Array<Object>}
 */
function rankModels() {
  const data = readScores();
  return Object.values(data.models || {}).sort((a, b) => b.rank - a.rank);
}

/**
 * The model to use right now, by measurement.
 *
 * @param {Object} [need] Requirements: { arabic, json, code, minContext }
 * @returns {Object|null} The winning scorecard, or null when nothing qualifies
 */
function bestModel(need = {}) {
  let ranked = rankModels().filter(m => m.reliability > 0.5);

  if (need.minContext) ranked = ranked.filter(m => (m.contextLength || 0) >= need.minContext);
  // A requirement is a filter, not a preference: asking for Arabic and getting a
  // model that failed the Arabic probe would be worse than getting nothing.
  for (const key of ['arabic', 'json', 'code', 'reasoning']) {
    if (need[key]) ranked = ranked.filter(m => (m.probes || []).some(p => p.id === key && p.ok));
  }
  return ranked[0] || null;
}

function getBenchProgress() {
  const data = readScores();
  return {
    running: state.running,
    total: state.total,
    done: state.done,
    current: state.current,
    startedAt: state.startedAt,
    stoppedReason: state.stoppedReason,
    scoredModels: Object.keys(data.models || {}).length,
    updatedAt: data.updatedAt
  };
}

function stopBenchmark() { state.stopped = true; state.running = false; clearLock(); return { stopped: true }; }

module.exports = { runBenchmark, getBenchProgress, stopBenchmark, rankModels, bestModel, benchModel,
  pruneUnmeasured, dropIneligible, isTextOnly, isDailyQuota, isRateLimit, PROBES };
