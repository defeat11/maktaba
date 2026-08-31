// Keeps the gateway answering when the model behind it stops.
//
// The gateway already had a fallback chain: try the next model when one fails,
// and skip a failed model for a flat five minutes. That is enough to survive a
// single hiccup and not much else. It could not tell a model that is blocked
// forever from one whose provider is having a bad minute, it never went back to
// the better model once the worse one had taken over, and its five minutes were
// a guess.
//
// This replaces the guess with a circuit breaker per model:
//
//   closed     the model is in use
//   open       it failed enough to be taken out, for a window sized by WHY it
//              failed — a 403 is not a blip, a 502 usually is
//   half-open  the window has passed, so exactly ONE request is allowed
//              through as a trial. It closes on success and re-opens, longer,
//              on failure.
//
// The half-open state is what makes recovery automatic. The order is rebuilt
// from rank on every call, so the moment the preferred model's circuit closes
// it is preferred again — nothing has to remember to switch back.
//
// One honest limit, stated rather than engineered around: when the ACCOUNT's
// daily allowance is gone, no model can serve, because the limit is on the key
// and not on any model. Failing over would just spend the remainder of nothing.
// The router reports that as its own state instead of pretending to route.

const fs = require('fs');
const path = require('path');
const { logInfo, logError } = require('./logger');

const HEALTH_PATH = process.env.MAKTABA_MODEL_HEALTH
  || path.join(__dirname, '..', 'model-health.json');

// How long a model stays out, by why it failed. These are not guesses: each one
// is how long that particular refusal actually lasts.
const BACKOFF_MS = {
  // "only available on agentic harnesses" — a policy, not an outage.
  'access': 6 * 60 * 60 * 1000,
  // The account must pay for it. Nothing changes until the user acts.
  'needs-credits': 6 * 60 * 60 * 1000,
  // The key itself was refused; every model will say the same.
  'key': 30 * 60 * 1000,
  // The upstream provider is having a bad time. Usually short.
  'provider-failure': 5 * 60 * 1000,
  // Per-model throttling clears quickly.
  'rate-limit': 2 * 60 * 1000,
  'timeout': 3 * 60 * 1000,
  // A 200 with nothing in it. Usually the model, occasionally the moment, so
  // it rests briefly rather than being written off.
  'empty-reply': 3 * 60 * 1000,
  'other': 5 * 60 * 1000
};

const MAX_BACKOFF_MS = 12 * 60 * 60 * 1000;
// One failure is bad luck. Two in a row is a pattern worth acting on — except
// for refusals that are already definitive, which open the circuit at once.
const FAILURES_BEFORE_OPEN = 2;
const DEFINITIVE = ['access', 'needs-credits'];

let cache = null;
let cacheMtime = null;

/**
 * The health record, re-read whenever the file on disk has moved on.
 *
 * Caching it forever would have been wrong beyond making a test awkward: the
 * weekly benchmark job runs in its own process and writes to the same file, so
 * a server holding a cache from boot would route by a picture of the world that
 * stopped updating hours ago.
 *
 * @returns {Object} models keyed by id
 */
function load() {
  let mtime = null;
  try {
    mtime = fs.existsSync(HEALTH_PATH) ? fs.statSync(HEALTH_PATH).mtimeMs : null;
  } catch (err) { /* unreadable: fall through to whatever is cached */ }

  if (cache && mtime === cacheMtime) return cache;

  try {
    cache = mtime === null ? {} : (JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf8')).models || {});
    cacheMtime = mtime;
  } catch (err) {
    logError('model-router', err);
    cache = cache || {};
  }
  return cache;
}

function save() {
  try {
    const tmp = HEALTH_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), models: cache || {} }, null, 2), 'utf8');
    fs.renameSync(tmp, HEALTH_PATH);
    // Stamp the cache with what we just wrote, so our own save does not look
    // like somebody else's change on the next read.
    try { cacheMtime = fs.statSync(HEALTH_PATH).mtimeMs; } catch (e) { cacheMtime = null; }
  } catch (err) {
    logError('model-router', err);
  }
}

function entry(modelId) {
  const all = load();
  if (!all[modelId]) {
    all[modelId] = {
      id: modelId,
      state: 'closed',
      consecutiveFailures: 0,
      openUntil: null,
      lastKind: null,
      lastError: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      calls: 0,
      failures: 0,
      opens: 0
    };
  }
  return all[modelId];
}

/**
 * The circuit's state right now, resolving any window that has expired.
 *
 * Reading is what moves a model from open to half-open: there is no timer, so
 * the transition happens the moment someone asks, which is the only moment it
 * matters.
 *
 * @param {string} modelId Model id
 * @returns {{state: string, openUntil: number|null, reason: string|null}}
 */
function circuitState(modelId) {
  const e = entry(modelId);
  if (e.state === 'open') {
    if (!e.openUntil || Date.now() >= e.openUntil) {
      e.state = 'half-open';
      save();
    }
  }
  return { state: e.state, openUntil: e.openUntil, reason: e.lastKind, lastError: e.lastError };
}

/**
 * Whether a request may be sent to this model.
 *
 * half-open allows exactly one trial. That is the whole recovery mechanism:
 * something has to go first, and it should be one request rather than all of
 * them.
 *
 * @param {string} modelId Model id
 * @returns {boolean}
 */
function canTry(modelId) {
  return circuitState(modelId).state !== 'open';
}

/**
 * Records that a model answered.
 *
 * @param {string} modelId Model id
 * @param {number} [ms] How long it took
 */
function recordSuccess(modelId, ms) {
  const e = entry(modelId);
  const wasDown = e.state !== 'closed';
  e.state = 'closed';
  e.consecutiveFailures = 0;
  e.openUntil = null;
  e.lastKind = null;
  e.lastError = null;
  e.lastSuccessAt = new Date().toISOString();
  e.lastMs = ms || null;
  e.calls++;
  save();
  if (wasDown) logInfo('model-router', modelId + ' recovered; it is preferred again.');
}

/**
 * Records that a model refused, and decides whether to take it out of rotation.
 *
 * @param {string} modelId Model id
 * @param {Error} err The failure, ideally carrying a kind
 * @returns {{opened: boolean, until: number|null}}
 */
function recordFailure(modelId, err) {
  const e = entry(modelId);
  const kind = (err && err.kind) || 'other';
  e.calls++;
  e.failures++;
  e.consecutiveFailures++;
  e.lastKind = kind;
  e.lastError = String((err && err.message) || '').slice(0, 200);
  e.lastFailureAt = new Date().toISOString();

  // A 403 or a 402 is a decision someone made about this account. Waiting for a
  // second one to confirm it just spends another request to learn nothing.
  const definitive = DEFINITIVE.indexOf(kind) !== -1;
  const enough = definitive || e.consecutiveFailures >= FAILURES_BEFORE_OPEN;

  if (!enough) {
    save();
    return { opened: false, until: null };
  }

  const base = BACKOFF_MS[kind] || BACKOFF_MS.other;
  // Each reopening doubles the wait. A model that keeps failing is asked less
  // and less often, instead of being retried at the same rate forever.
  const factor = Math.min(Math.pow(2, Math.max(0, e.opens)), 64);
  const window = Math.min(base * factor, MAX_BACKOFF_MS);

  e.state = 'open';
  e.opens++;
  e.openUntil = Date.now() + window;
  save();

  logInfo('model-router', modelId + ' taken out for ' + Math.round(window / 60000)
    + ' min (' + kind + '), attempt ' + e.opens + '.');
  return { opened: true, until: e.openUntil };
}

/**
 * Orders candidate models best-first, with anything currently out at the back.
 *
 * The order is rebuilt on every call rather than remembered. That is what makes
 * the return automatic: the moment the preferred model's circuit closes, it is
 * first again, and nothing had to notice.
 *
 * @param {Array<string>} candidates Model ids, already in preference order
 * @returns {{usable: Array<string>, resting: Array<string>}}
 */
function order(candidates) {
  const usable = [];
  const resting = [];
  for (const id of (candidates || [])) {
    if (canTry(id)) usable.push(id);
    else resting.push(id);
  }
  // Resting models are kept as a last resort rather than dropped: serving a
  // request late from a model that was struggling beats refusing it outright.
  return { usable, resting };
}

/**
 * Sends one request, moving down the list until something answers.
 *
 * @param {Array<string>} candidates Model ids in preference order
 * @param {Function} send async (modelId) => result; should throw on failure
 * @returns {Promise<Object>} The result plus how it was reached
 */
async function route(candidates, send) {
  const { usable, resting } = order(candidates);
  const chain = usable.concat(resting);
  // The caller's first choice, before any reordering. Reporting the reordered
  // first entry instead would have called an answer "not degraded" whenever the
  // preferred model was skipped for being open — true about the chain that was
  // walked, and misleading about the answer that came back.
  const preferred = candidates[0] || null;

  if (!chain.length) {
    const err = new Error('لا يوجد نموذج صالح للتوجيه إليه.');
    err.status = 503;
    err.attempts = [];
    throw err;
  }

  const attempts = [];
  let quotaHit = false;

  for (let i = 0; i < chain.length; i++) {
    const modelId = chain[i];
    const startedAt = Date.now();
    const wasResting = usable.indexOf(modelId) === -1;
    try {
      const result = await send(modelId);
      const ms = Date.now() - startedAt;
      recordSuccess(modelId, ms);
      attempts.push({ model: modelId, ok: true, ms, wasResting });
      return {
        result,
        servedBy: modelId,
        // Measured against what the caller would have got on a good day, not
        // against the shortened list this particular call happened to walk.
        degraded: preferred !== null && modelId !== preferred,
        preferred,
        // Why the preferred one was passed over, when it was.
        preferredState: preferred && preferred !== modelId ? circuitState(preferred).state : null,
        attempts
      };
    } catch (err) {
      const ms = Date.now() - startedAt;
      attempts.push({ model: modelId, ok: false, ms, kind: err.kind || null,
        error: String(err.message || '').slice(0, 160) });

      // The account's allowance, not the model's. Every remaining model would
      // refuse for the same reason, so trying them spends nothing usefully and
      // teaches the router nothing about them.
      if (err.kind === 'daily-quota') { quotaHit = true; break; }

      recordFailure(modelId, err);
    }
  }

  const err = new Error(quotaHit
    ? 'انتهت حصّة اليوم المجانية على OpenRouter — الحدّ على حسابك لا على النموذج، فلا ينفع التحويل. تتجدّد تلقائياً.'
    : 'جُرّبت ' + attempts.length + ' نماذج ولم يستجب أي منها.');
  err.status = quotaHit ? 429 : 502;
  err.quota = quotaHit;
  err.attempts = attempts;
  throw err;
}

/**
 * The health of every model the router knows about.
 *
 * @returns {Object} Counts and per-model detail
 */
function health() {
  const all = load();
  const models = Object.values(all).map(e => {
    const live = circuitState(e.id);
    return Object.assign({}, e, {
      state: live.state,
      restingForMs: live.state === 'open' && e.openUntil ? Math.max(0, e.openUntil - Date.now()) : 0,
      successRate: e.calls ? Math.round((e.calls - e.failures) / e.calls * 100) : null
    });
  });
  const byState = {};
  models.forEach(m => { byState[m.state] = (byState[m.state] || 0) + 1; });
  return { total: models.length, byState, models };
}

/**
 * Clears the record for one model, or all of them.
 *
 * @param {string} [modelId] Model to reset; omit for all
 */
function reset(modelId) {
  const all = load();
  if (modelId) delete all[modelId];
  else { cache = {}; cacheMtime = null; }
  save();
  return { ok: true };
}

module.exports = { route, canTry, circuitState, recordSuccess, recordFailure,
  order, health, reset, BACKOFF_MS, FAILURES_BEFORE_OPEN };
