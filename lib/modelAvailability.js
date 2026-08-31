// Which free models are actually open to this account, and which only look it.
//
// "Free" on OpenRouter's catalogue means the price is zero. It does not mean
// you can use it. Measured on this machine, from models all listed as free:
//
//   thinkingmachines/inkling:free   403 — "only available on agentic harnesses"
//   google/lyria-3-pro-preview      502 — the provider behind it refused
//   several others                  429 — the account's daily allowance was gone
//
// A page that lists 21 free models and says nothing more is telling the truth
// about the price and leaving out the part that decides whether you can type a
// message into it.
//
// So this asks each one directly, with the smallest question that can be asked:
// one message, max_tokens 1. That is a single request per model rather than the
// five a full benchmark spends, which matters when the daily allowance is
// around fifty and shared with everything else.
//
// It answers "is this open", not "is this any good". The benchmark answers the
// second question, costs five times as much, and is worth running only on
// models this one has already found to be open.

const fs = require('fs');
const path = require('path');
const openrouter = require('./openrouter');
const { logInfo, logError, appendBounded } = require('./logger');

const RESULTS_PATH = process.env.MAKTABA_MODEL_AVAILABILITY
  || path.join(__dirname, '..', 'model-availability.json');

// Same pace the benchmark uses. Free tiers throttle per key, and a burst turns
// an availability check into a measurement of the rate limiter.
const MIN_GAP_MS = 3500;
let lastRequestAt = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pace() {
  const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

// What a single probe can conclude. Each maps to one thing the user can do
// about it, which is the only reason to have separate names at all.
const STATUS = {
  OPEN: 'open',                    // answered — you can use it now
  NEEDS_CREDITS: 'needs-credits',  // listed free, but this account must pay
  BLOCKED: 'blocked',              // the model refuses this kind of access
  PROVIDER_DOWN: 'provider-down',  // the upstream behind it failed, not you
  RATE_LIMITED: 'rate-limited',    // busy right now; try later
  NOT_TEXT: 'not-text',            // an image or music generator, never a chat
  KEY_REJECTED: 'key-rejected',    // your key, not the model
  UNKNOWN: 'unknown'
};

const LABELS = {
  'open': 'مفتوح',
  'needs-credits': 'يحتاج رصيداً',
  'blocked': 'محجوب عنك',
  'provider-down': 'المزوّد معطّل',
  'rate-limited': 'محدود الآن',
  'not-text': 'ليس نموذج محادثة',
  'key-rejected': 'المفتاح مرفوض',
  'unknown': 'غير معروف'
};

const state = {
  running: false, total: 0, done: 0, current: null,
  startedAt: null, stopped: false, stoppedReason: null
};

/**
 * Whether a model can produce text and nothing else.
 *
 * Knowable without spending a request: a music or image generator is never a
 * chat model, whatever its price says.
 *
 * @param {Object} model Model record
 * @returns {boolean}
 */
function isTextOnly(model) {
  const out = (model && model.outputModalities) || [];
  return out.length === 0 || (out.length === 1 && out[0] === 'text');
}

/**
 * Turns one probe outcome into a status the user can act on.
 *
 * @param {Error|null} err The failure, or null when it answered
 * @returns {string} One of STATUS
 */
function statusFromError(err) {
  if (!err) return STATUS.OPEN;
  switch (err.kind) {
    case 'needs-credits': return STATUS.NEEDS_CREDITS;
    case 'access': return STATUS.BLOCKED;
    case 'provider-failure': return STATUS.PROVIDER_DOWN;
    case 'rate-limit': return STATUS.RATE_LIMITED;
    case 'key': return STATUS.KEY_REJECTED;
    default: return STATUS.UNKNOWN;
  }
}

function readResults() {
  try {
    if (!fs.existsSync(RESULTS_PATH)) return { checkedAt: null, models: {} };
    const parsed = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    return { checkedAt: parsed.checkedAt || null, models: parsed.models || {} };
  } catch (err) {
    logError('model-availability', err);
    return { checkedAt: null, models: {} };
  }
}

function writeResults(data) {
  try {
    const tmp = RESULTS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, RESULTS_PATH);
  } catch (err) {
    logError('model-availability', err);
  }
}

/**
 * Asks one model the smallest possible question.
 *
 * @param {Object} model Model record
 * @param {Object} [opts] noPacing
 * @returns {Promise<Object>} What was learned about it
 */
async function probe(model, opts = {}) {
  const base = {
    id: model.id,
    name: model.name,
    vendor: model.vendor || String(model.id).split('/')[0],
    contextLength: model.contextLength || null,
    parameters: model.parameters || null,
    checkedAt: new Date().toISOString()
  };

  // Free information: a generator is not a chat model, and no request is needed
  // to know that.
  if (!isTextOnly(model)) {
    return Object.assign(base, {
      status: STATUS.NOT_TEXT,
      detail: 'يُخرِج ' + ((model.outputModalities || []).join('، ') || 'غير نصّ') + ' — ليس نموذج محادثة.',
      costRequest: false
    });
  }

  try {
    if (!opts.noPacing) await pace();
    const res = await openrouter.chat(model.id, [{ role: 'user', content: 'hi' }],
      { maxTokens: 1, temperature: 0, timeoutMs: opts.timeoutMs || 45000 });
    return Object.assign(base, {
      status: STATUS.OPEN,
      detail: 'ردّ خلال ' + Math.round(res.elapsedMs / 100) / 10 + ' ثانية.',
      elapsedMs: res.elapsedMs,
      costRequest: true
    });
  } catch (err) {
    // The daily allowance is the one outcome that says nothing about the model.
    // It is reported separately so the sweep can stop rather than label every
    // remaining model with a fact about the account.
    if (err.kind === 'daily-quota') {
      return Object.assign(base, { status: null, quotaExhausted: true, detail: err.message, costRequest: true });
    }
    return Object.assign(base, {
      status: statusFromError(err),
      detail: String(err.message).slice(0, 200),
      provider: err.provider || null,
      remedy: err.remedy || null,
      httpStatus: err.status || null,
      costRequest: true
    });
  }
}

/**
 * Checks every free model, cheapest question first.
 *
 * @param {Object} [opts] onlyStaleHours, limit
 * @returns {Promise<Object>} Whether it started, and how many it will check
 */
async function runSweep(opts = {}) {
  if (state.running) return { started: false, reason: 'الفحص يعمل بالفعل.' };
  if (!openrouter.hasKey()) return { started: false, reason: 'لا يوجد مفتاح OpenRouter.' };

  const { models } = await openrouter.listFreeModels(true);
  let targets = models;

  if (opts.onlyStaleHours) {
    const previous = readResults();
    const cutoff = Date.now() - opts.onlyStaleHours * 3600000;
    targets = targets.filter(m => {
      const old = previous.models[m.id];
      return !old || new Date(old.checkedAt).getTime() < cutoff;
    });
  }
  if (opts.limit) targets = targets.slice(0, opts.limit);
  if (!targets.length) return { started: false, reason: 'كل النماذج مفحوصة حديثاً.', total: 0 };

  state.running = true;
  state.total = targets.length;
  state.done = 0;
  state.current = null;
  state.startedAt = new Date().toISOString();
  state.stopped = false;
  state.stoppedReason = null;

  logInfo('model-availability', 'Checking availability of ' + targets.length + ' free model(s).');

  (async () => {
    const results = readResults().models;
    for (const model of targets) {
      if (state.stopped) break;
      state.current = model.id;
      try {
        const outcome = await probe(model);
        if (outcome.quotaExhausted) {
          // Everything after this would report the same thing about the
          // account rather than about the model, so the sweep stops and keeps
          // what it actually learned.
          state.stoppedReason = 'daily-quota';
          logInfo('model-availability', 'Daily quota reached; keeping ' + state.done + ' result(s).');
          break;
        }
        results[model.id] = outcome;
      } catch (err) {
        logError('model-availability', err);
      }
      state.done++;
      writeResults({ checkedAt: new Date().toISOString(), models: results });
    }
    state.running = false;
    state.current = null;

    const summary = summarise();
    logInfo('model-availability', 'Availability sweep done: ' + summary.open + ' open of ' + summary.total + '.');
    try {
      appendBounded(path.join(__dirname, '..', 'logs', 'model-availability.jsonl'),
        JSON.stringify({ ts: new Date().toISOString(), checked: state.done, counts: summary.byStatus }) + '\n',
        2 * 1024 * 1024, 1000);
    } catch (e) { /* history is a nicety */ }
  })();

  return { started: true, total: state.total };
}

/**
 * Everything known, grouped so the open ones come first.
 *
 * @returns {Object} Models and counts
 */
function summarise() {
  const data = readResults();
  const rows = Object.values(data.models);
  const byStatus = {};
  rows.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });

  const rank = { open: 0, 'rate-limited': 1, 'provider-down': 2, unknown: 3,
    'needs-credits': 4, blocked: 5, 'not-text': 6, 'key-rejected': 7 };
  rows.sort((a, b) => (rank[a.status] === undefined ? 9 : rank[a.status])
    - (rank[b.status] === undefined ? 9 : rank[b.status]));

  return {
    checkedAt: data.checkedAt,
    total: rows.length,
    open: byStatus.open || 0,
    byStatus,
    models: rows
  };
}

function getProgress() {
  const data = readResults();
  return {
    running: state.running,
    total: state.total,
    done: state.done,
    current: state.current,
    startedAt: state.startedAt,
    stoppedReason: state.stoppedReason,
    known: Object.keys(data.models).length,
    checkedAt: data.checkedAt
  };
}

function stopSweep() { state.stopped = true; state.running = false; return { stopped: true }; }

/**
 * The models worth spending a full benchmark on.
 *
 * Only the open ones: five probes against a model that answers 403 to the first
 * is five requests spent proving what one already established.
 *
 * @returns {Array<string>} Model ids
 */
function openModelIds() {
  return Object.values(readResults().models)
    .filter(m => m.status === STATUS.OPEN)
    .map(m => m.id);
}

module.exports = { runSweep, probe, getProgress, stopSweep, summarise, openModelIds,
  isTextOnly, statusFromError, STATUS, LABELS };
