// An OpenAI-compatible endpoint served by Maktaba.
//
// Point any tool that speaks the OpenAI protocol at
// http://127.0.0.1:4500/api/gateway/v1 and it reaches OpenRouter's free models
// through here. That is the whole idea: one address, one token, and the tool
// never learns the OpenRouter key.
//
// The gateway adds three things a direct OpenRouter call does not have:
//   * "auto" as a model name, resolved from measured scores (see modelBench)
//   * a fallback chain, so a rate-limited free model does not become an error
//   * a usage log, so the fleet's AI traffic is visible like everything else
//
// It is loopback-only, like the rest of this server, and still requires a
// token: anything running on this machine can reach 127.0.0.1, and the browser
// is one of those things.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const openrouter = require('./openrouter');
const bench = require('./modelBench');
const { logInfo, logError, appendBounded } = require('./logger');

// Overridable for the same reason: a test must never touch the real token.
const TOKEN_PATH = process.env.MAKTABA_GATEWAY_TOKEN || path.join(__dirname, '..', 'gateway-token.json');
const USAGE_LOG = process.env.MAKTABA_GATEWAY_USAGE || path.join(__dirname, '..', 'logs', 'gateway-usage.jsonl');

// The flat five-minute penalty that used to live here has been replaced by the
// circuit breaker in lib/modelRouter.js. It could not tell a model blocked by
// policy from one having a bad minute, it never returned to the better model on
// its own, and five minutes was a guess. Two mechanisms deciding the same thing
// is how they drift apart and one starts lying, so there is now one.

const AUTO_NAMES = new Set(['auto', 'maktaba/auto', 'best', 'maktaba/best']);
const SKILLS = ['arabic', 'json', 'code', 'reasoning'];

/**
 * The gateway token, or null when none has been created.
 *
 * @returns {string|null}
 */
function readToken() {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    return parsed && parsed.token ? parsed.token : null;
  } catch (err) {
    logError('gateway', err);
    return null;
  }
}

/**
 * Creates a fresh token, invalidating any previous one.
 *
 * @returns {{token: string, createdAt: string}}
 */
function createToken() {
  const token = 'mk-' + crypto.randomBytes(24).toString('hex');
  const record = { token, createdAt: new Date().toISOString() };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(record, null, 2), 'utf8');
  logInfo('gateway', 'New gateway token issued.');
  return record;
}

function revokeToken() {
  try {
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Checks a caller's credential against the stored token.
 *
 * @param {Object} req Express request
 * @returns {{ok: boolean, error?: string, status?: number}}
 */
function authorize(req) {
  const expected = readToken();
  // Refusing everything until a token exists is deliberate: an accidentally
  // open gateway spends someone else's quota and hides who did it.
  if (!expected) {
    return { ok: false, status: 503, error: 'Gateway token not created yet. Create one in Maktaba first.' };
  }

  const header = String(req.headers.authorization || '');
  const bearer = header.replace(/^Bearer\s+/i, '').trim();
  const given = bearer || String(req.headers['x-api-key'] || '').trim();
  if (!given) return { ok: false, status: 401, error: 'Missing Authorization: Bearer <token>.' };

  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // Compare in constant time, and only when the lengths already match —
  // timingSafeEqual throws on a length mismatch, which would leak the length.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: 'Invalid token.' };
  }
  return { ok: true };
}

/**
 * Works out which models to try, in order, for one request.
 *
 * An explicit model id is honoured first and always: asking for a specific
 * model and silently getting a different one would make the gateway a liar.
 * Fallbacks only ever come after the caller's own choice has failed.
 *
 * @param {string} requested Model name from the caller
 * @param {Object} [need] Capability filters for auto mode
 * @returns {{chain: Array<string>, auto: boolean, reason: string}}
 */
function resolveChain(requested, need = {}) {
  const name = String(requested || '').trim();

  // Availability is fresher than the benchmark and answers a different
  // question: the benchmark says how well a model answered when it was last
  // measured, the sweep says whether it will answer at all right now. A model
  // that scored 5/5 last week and whose provider is down today is still a
  // wrong choice, and until this filter existed "auto" avoided that only by
  // luck — every top-ranked model happened to be open.
  //
  // If nothing has been swept yet, the set is empty and nothing is excluded:
  // an absent measurement must never be read as a negative one.
  let openSet = null;
  try {
    const ids = require('./modelAvailability').openModelIds();
    if (ids.length) openSet = new Set(ids);
  } catch (err) { /* no sweep yet, or unreadable — rank alone then */ }

  const ranked = bench.rankModels()
    .filter(m => m.reliability > 0.5)
    .filter(m => !openSet || openSet.has(m.id));

  // "auto:arabic" / "auto:code" — a capability requirement, not a preference.
  const wants = Object.assign({}, need);
  let bare = name;
  const colon = name.indexOf(':');
  if (colon > -1 && AUTO_NAMES.has(name.slice(0, colon).toLowerCase())) {
    bare = name.slice(0, colon);
    for (const tag of name.slice(colon + 1).split(',')) {
      const t = tag.trim().toLowerCase();
      if (SKILLS.indexOf(t) !== -1) wants[t] = true;
    }
  }

  if (AUTO_NAMES.has(bare.toLowerCase())) {
    if (!ranked.length) return { chain: [], auto: true, reason: 'no-scores' };

    let pool = ranked;
    for (const key of SKILLS) {
      if (wants[key]) pool = pool.filter(m => (m.probes || []).some(p => p.id === key && p.ok));
    }
    // Nothing passed the required probe: fall back to the full ranking rather
    // than returning nothing, and say so in the reason so the caller can tell.
    const relaxed = pool.length === 0;
    if (relaxed) pool = ranked;

    // Every candidate, in preference order. The old code kept four and dropped
    // the rest, so a bad afternoon for four models became an error the caller
    // saw. The router decides how far down to walk, and keeps models that are
    // resting as a last resort rather than discarding them.
    return { chain: pool.map(m => m.id), auto: true, reason: relaxed ? 'ranked-relaxed' : 'ranked' };
  }

  if (!name) return { chain: [], auto: false, reason: 'no-model' };

  const chain = [name];
  for (const m of ranked) {
    if (m.id !== name) chain.push(m.id);
  }
  return { chain, auto: false, reason: 'explicit' };
}

/**
 * Runs one chat request through the chain until a model answers.
 *
 * @param {Object} body OpenAI-shaped request body
 * @returns {Promise<Object>} The OpenRouter result plus routing detail
 */
async function complete(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) throw Object.assign(new Error('messages is required.'), { status: 400 });

  const { chain, auto, reason } = resolveChain(body.model, {});
  if (!chain.length) {
    throw Object.assign(
      new Error('No model available. Name a model, or run the Maktaba benchmark so "auto" has scores to choose from.'),
      { status: 503 }
    );
  }

  const router = require('./modelRouter');
  const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 1200;

  const routed = await router.route(chain, async (modelId) => {
    const result = await openrouter.chat(modelId, messages, {
      temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
      maxTokens
    });

    // An empty body with a 200 is a failure wearing a success's clothes. The
    // caller asked a question and got nothing, and passing that through as an
    // answer is the silent kind of breakage this gateway exists to avoid — so
    // it counts as a failure and the next model is tried.
    //
    // Unless the caller asked for almost no tokens, or the model stopped
    // because it ran out of them: then an empty or clipped reply is the
    // arithmetic working, not the model failing.
    const empty = !String(result.reply || '').trim();
    if (empty && maxTokens > 5 && result.finishReason !== 'length') {
      const err = new Error('ردّ فارغ من ' + modelId + ' (HTTP 200 بلا محتوى).');
      err.kind = 'empty-reply';
      throw err;
    }
    return result;
  });

  return Object.assign({}, routed.result, {
    routedTo: routed.servedBy,
    auto,
    routeReason: reason,
    // True when the first choice did not answer. The caller still gets a reply;
    // it is simply told that this is not the reply it would have had.
    degraded: routed.degraded,
    preferred: routed.preferred,
    preferredState: routed.preferredState,
    attempts: routed.attempts
  });
}

/**
 * Shapes a result the way an OpenAI client expects to receive it.
 *
 * @param {Object} result Output of complete()
 * @param {string} requested The model name the caller asked for
 * @returns {Object} OpenAI-compatible completion object
 */
function toOpenAiShape(result, requested) {
  const usage = result.usage || {};
  return {
    id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.routedTo,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: result.reply || '' },
      finish_reason: result.finishReason || 'stop'
    }],
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0
    },
    // Maktaba's own routing detail, namespaced so it cannot collide with a
    // field OpenAI may add later. A client that ignores it loses nothing.
    maktaba: {
      requested: requested,
      routed_to: result.routedTo,
      auto: result.auto,
      reason: result.routeReason,
      // Measured against the model the caller would have got on a good day, so
      // a request served from the second choice says so even when the first was
      // skipped before it was ever tried.
      degraded: result.degraded === true,
      preferred: result.preferred || null,
      preferred_state: result.preferredState || null,
      elapsed_ms: result.elapsedMs,
      attempts: result.attempts
    }
  };
}

/**
 * Records one gateway call. Local AI traffic is fleet activity like any other,
 * so it belongs in a log the audit can read.
 *
 * @param {Object} entry What happened
 */
function recordUsage(entry) {
  try {
    appendBounded(USAGE_LOG, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry)) + '\n',
      5 * 1024 * 1024, 5000);
  } catch (err) { /* a missing log line must never fail a request */ }
}

/**
 * Reads back what the gateway has served.
 *
 * @param {number} [limit] How many recent calls to return
 * @returns {Object} Totals and the most recent calls
 */
function getUsage(limit) {
  const take = limit || 50;
  try {
    if (!fs.existsSync(USAGE_LOG)) return { calls: 0, recent: [], byModel: {}, tokens: 0 };
    const lines = fs.readFileSync(USAGE_LOG, 'utf8').split('\n').filter(Boolean);
    const rows = [];
    for (const line of lines) {
      try { rows.push(JSON.parse(line)); } catch (e) { /* skip a torn line */ }
    }
    const byModel = {};
    let tokens = 0;
    for (const r of rows) {
      const key = r.routedTo || r.model || 'unknown';
      if (!byModel[key]) byModel[key] = { calls: 0, failures: 0, tokens: 0 };
      byModel[key].calls++;
      if (!r.ok) byModel[key].failures++;
      const t = (r.tokensIn || 0) + (r.tokensOut || 0);
      byModel[key].tokens += t;
      tokens += t;
    }
    return { calls: rows.length, recent: rows.slice(-take).reverse(), byModel, tokens };
  } catch (err) {
    logError('gateway', err);
    return { calls: 0, recent: [], byModel: {}, tokens: 0, error: err.message };
  }
}

/**
 * The models the gateway exposes, in OpenAI's list shape, with "auto" first.
 *
 * @returns {Promise<Object>} OpenAI-compatible model list
 */
async function listModels() {
  const data = [{
    id: 'auto',
    object: 'model',
    owned_by: 'maktaba',
    description: 'Maktaba picks the highest-scoring free model. Add a tag to require a skill: auto:arabic, auto:code, auto:json, auto:reasoning.'
  }];

  const scored = new Map(bench.rankModels().map(m => [m.id, m]));
  try {
    const { models } = await openrouter.listFreeModels(false);
    for (const m of models) {
      const s = scored.get(m.id);
      data.push({
        id: m.id,
        object: 'model',
        owned_by: m.vendor,
        context_length: m.contextLength,
        maktaba_rank: s ? s.rank : null,
        maktaba_tested_at: s ? s.testedAt : null
      });
    }
  } catch (err) {
    // OpenRouter being unreachable must not empty the list: the scored models
    // are still routable, and "auto" still works.
    for (const s of scored.values()) {
      data.push({ id: s.id, object: 'model', owned_by: String(s.id).split('/')[0], maktaba_rank: s.rank });
    }
  }
  return { object: 'list', data };
}

/**
 * What the gateway can do right now.
 *
 * @returns {Object} Readiness, the current best model, and the base URL
 */
function status() {
  const ranked = bench.rankModels();
  return {
    tokenCreated: readToken() !== null,
    keyConfigured: openrouter.hasKey(),
    scoredModels: ranked.length,
    best: ranked[0] ? { id: ranked[0].id, rank: ranked[0].rank, medianMs: ranked[0].medianMs } : null,
    // What the breaker is currently resting, and why.
    resting: require('./modelRouter').health().models
      .filter(m => m.state !== 'closed')
      .map(m => ({ id: m.id, state: m.state, reason: m.lastKind, minutesLeft: Math.round(m.restingForMs / 60000) })),
    baseUrl: 'http://127.0.0.1:' + (process.env.PORT || 4500) + '/api/gateway/v1'
  };
}

module.exports = {
  readToken, createToken, revokeToken, authorize,
  resolveChain, complete, toOpenAiShape, listModels,
  recordUsage, getUsage, status, AUTO_NAMES
};
