// A playground for OpenRouter's free models, served from inside Maktaba.
//
// The key never reaches the browser. It is written once to a gitignored file
// and every request to OpenRouter is made from here, so the page only ever
// learns whether a key is configured — never what it is. That also means the
// key cannot leak through a screenshot, the devtools network tab, or a shared
// artifact of this page.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { logError, logInfo } = require('./logger');

const KEY_PATH = path.join(__dirname, '..', 'openrouter-key.json');
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const KEY_URL = 'https://openrouter.ai/api/v1/key';

// Free models change; a short cache keeps the list snappy without going stale.
let modelCache = { at: 0, models: [] };
const CACHE_MS = 10 * 60 * 1000;

/**
 * Reads the stored key. Never logged, never returned to a route.
 *
 * @returns {string|null}
 */
function readKey() {
  try {
    if (!fs.existsSync(KEY_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
    return parsed && typeof parsed.key === 'string' && parsed.key ? parsed.key : null;
  } catch (err) {
    logError('openrouter', err);
    return null;
  }
}

/**
 * Stores the key, replacing any previous one.
 *
 * @param {string} key The OpenRouter API key
 * @returns {{ok: boolean, error?: string}}
 */
function saveKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return { ok: false, error: 'المفتاح فارغ.' };
  if (!/^sk-or-/.test(trimmed)) {
    return { ok: false, error: 'مفتاح OpenRouter يبدأ بـ sk-or- — تأكّد أنك نسخت المفتاح الصحيح.' };
  }
  try {
    fs.writeFileSync(KEY_PATH, JSON.stringify({ key: trimmed, savedAt: new Date().toISOString() }, null, 2), 'utf8');
    logInfo('openrouter', 'API key stored.');
    return { ok: true };
  } catch (err) {
    logError('openrouter', err);
    return { ok: false, error: err.message };
  }
}

function clearKey() {
  try {
    if (fs.existsSync(KEY_PATH)) fs.unlinkSync(KEY_PATH);
    modelCache = { at: 0, models: [] };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function hasKey() { return readKey() !== null; }

/**
 * One HTTPS request returning parsed JSON.
 *
 * @param {string} url Target URL
 * @param {Object} options method, headers
 * @param {string} [body] Request body
 * @returns {Promise<{status: number, json: Object|null, raw: string}>}
 */
function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const limitMs = options.timeoutMs || 120000;
    let timedOut = false;
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeoutMs || 120000
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        clearTimeout(hardStop);
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* reported as raw */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    // Node's `timeout` option is an IDLE timeout on the socket, not a cap on how
    // long the request may take. A model that holds the connection open while it
    // thinks never trips it — measured: nvidia/nemotron-3.5-lightning answered
    // every probe in almost exactly 300 seconds while a 90-second "timeout" was
    // set, so five probes held the benchmark for twenty-five minutes on one
    // model. This timer is the actual cap.
    const hardStop = setTimeout(() => {
      timedOut = true;
      req.destroy();
      const err = new Error('تجاوز الطلب المهلة الكلية (' + Math.round(limitMs / 1000) + ' ثانية).');
      err.kind = 'timeout';
      reject(err);
    }, limitMs);
    const clearHardStop = () => clearTimeout(hardStop);

    req.on('timeout', () => {
      clearHardStop();
      req.destroy();
      const err = new Error('انتهت مهلة الاتصال بـ OpenRouter.');
      err.kind = 'timeout';
      reject(err);
    });
    req.on('error', (err) => { clearHardStop(); if (!timedOut) reject(err); });
    req.on('close', clearHardStop);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Pulls a parameter count out of a model's own description.
 *
 * OpenRouter has no parameter-count field, but most open-weight models state it
 * in their description ("16B active parameters out of 280B total"). Reading it
 * from there is honest — the value is quoted from the model card — and the
 * result is null rather than a guess when nothing is stated.
 *
 * @param {string} description Model description
 * @returns {{total: string|null, active: string|null}}
 */
function extractParameters(description) {
  const text = String(description || '');
  const out = { total: null, active: null };

  const active = text.match(/([\d.]+\s*[BMT])\s*(?:active|activated)\s*(?:parameters|params)/i);
  if (active) out.active = active[1].replace(/\s+/g, '').toUpperCase();

  const total = text.match(/(?:out of|of)\s*([\d.]+\s*[BMT])\s*(?:total)?/i)
    || text.match(/([\d.]+\s*[BMT])[- ]?(?:parameter|param)/i)
    || text.match(/([\d.]+\s*[BMT])\s*(?:total\s*)?(?:parameters|params)/i);
  if (total) out.total = total[1].replace(/\s+/g, '').toUpperCase();

  // A lone figure with no "active" counterpart is the total, not the active set.
  if (!out.total && out.active && !/out of|total/i.test(text)) {
    out.total = out.active;
    out.active = null;
  }
  return out;
}

/**
 * Every model OpenRouter currently serves at no cost, with the details worth
 * comparing them by.
 *
 * The catalogue endpoint is public, so this works before a key is configured —
 * you can browse what is available and only then decide to add one.
 *
 * @param {boolean} [force] Bypass the cache
 * @returns {Promise<{models: Array<Object>, fetchedAt: string, totalOnOpenRouter: number}>}
 */
async function listFreeModels(force) {
  if (!force && modelCache.models.length && Date.now() - modelCache.at < CACHE_MS) {
    return { models: modelCache.models, fetchedAt: new Date(modelCache.at).toISOString(), cached: true,
      totalOnOpenRouter: modelCache.total };
  }

  const res = await request(MODELS_URL, { headers: { 'Accept': 'application/json' } });
  if (res.status !== 200 || !res.json || !Array.isArray(res.json.data)) {
    throw new Error('تعذّر جلب قائمة النماذج (HTTP ' + res.status + ').');
  }

  const all = res.json.data;
  const free = all.filter(m => {
    const p = m.pricing || {};
    // Free means both directions cost nothing. Checking the ":free" suffix alone
    // would miss models that are free without the suffix, and trusting the
    // suffix alone would include ones that are not.
    return parseFloat(p.prompt || '1') === 0 && parseFloat(p.completion || '1') === 0;
  });

  const models = free.map(m => {
    const arch = m.architecture || {};
    const provider = m.top_provider || {};
    return {
      id: m.id,
      name: m.name,
      description: m.description || '',
      vendor: String(m.id).split('/')[0],
      parameters: extractParameters(m.description),
      contextLength: m.context_length || provider.context_length || null,
      maxOutput: provider.max_completion_tokens || null,
      modality: arch.modality || null,
      inputModalities: arch.input_modalities || [],
      outputModalities: arch.output_modalities || [],
      tokenizer: arch.tokenizer || null,
      supports: m.supported_parameters || [],
      moderated: provider.is_moderated === true,
      huggingFaceId: m.hugging_face_id || null,
      createdAt: m.created ? new Date(m.created * 1000).toISOString() : null,
      knowledgeCutoff: m.knowledge_cutoff || null,
      expiresAt: m.expiration_date || null
    };
  }).sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0));

  modelCache = { at: Date.now(), models, total: all.length };
  return { models, fetchedAt: new Date().toISOString(), cached: false, totalOnOpenRouter: all.length };
}

/**
 * Works out what a refusal actually means, and keeps the parts that say why.
 *
 * The first version of this read `error.message` and nothing else. That single
 * field is often the useless sentence "Provider returned error", while the
 * fields that explain it sit in `error.metadata` and were thrown away:
 *
 *   429 "Provider returned error"  metadata.provider_name -> which upstream
 *                                  metadata.raw           -> what it actually said
 *   402 "Insufficient credits"     metadata.limit_source  -> openrouter_credits
 *                                  metadata.remedy_hint   -> what to do about it
 *
 * The second mistake was labelling every 429 "تجاوزت حدّ الطلبات". OpenRouter
 * also returns 429 when the UPSTREAM provider throttles it — nothing to do with
 * this account's quota — so the message blamed the user for someone else's
 * capacity, and no amount of waiting would have fixed it.
 *
 * @param {number} status HTTP status
 * @param {Object|null} json Parsed body
 * @param {string} raw Raw body
 * @returns {{kind: string, text: string, provider: string|null, upstream: string|null, remedy: string|null}}
 */
function classifyFailure(status, json, raw) {
  const error = (json && json.error) || {};
  const meta = error.metadata || {};
  const message = error.message || String(raw || '').slice(0, 300);
  const provider = meta.provider_name || null;
  const upstream = meta.raw ? String(meta.raw).slice(0, 300) : null;
  const remedy = meta.remedy_hint || null;

  const withProvider = (base) => base + (provider ? ' [المزوّد: ' + provider + ']' : '');
  const withRemedy = (base) => base + (remedy ? ' — ' + remedy : '');

  // The account's daily free allowance. Waiting fixes this; nothing else does.
  if (/free-models-per-day/i.test(message)) {
    return { kind: 'daily-quota', provider, upstream, remedy,
      text: 'انتهت حصّتك اليومية من النماذج المجانية (free-models-per-day). تتجدّد تلقائياً.' };
  }

  // Paid model, or a model listed as free that the account cannot actually use.
  if (status === 402 || /insufficient credits|limit_source/i.test(message) || meta.limit_source === 'openrouter_credits') {
    return { kind: 'needs-credits', provider, upstream, remedy,
      text: withRemedy('هذا النموذج يحتاج رصيداً في حسابك، وليس مجانياً فعلياً: ' + message.slice(0, 160)) };
  }

  if (status === 401) {
    return { kind: 'key', provider, upstream, remedy,
      text: 'المفتاح مرفوض من OpenRouter (HTTP 401): ' + message.slice(0, 160) };
  }

  if (status === 403) {
    return { kind: 'access', provider, upstream, remedy,
      text: 'النموذج غير متاح لهذا الاستخدام (HTTP 403): ' + message.slice(0, 200) };
  }

  // The upstream provider failed or throttled OpenRouter itself. Trying the same
  // model again can genuinely work, because OpenRouter may route to a different
  // provider next time — which is why one model succeeds and fails minutes apart.
  if (/provider returned error/i.test(message) || upstream || status === 502 || status === 503) {
    return { kind: 'provider-failure', provider, upstream, remedy,
      text: withProvider('المزوّد خلف هذا النموذج رفض الطلب (HTTP ' + status + ')')
        + (upstream ? ' — ' + upstream.slice(0, 160) : '') };
  }

  if (status === 429) {
    return { kind: 'rate-limit', provider, upstream, remedy,
      text: withProvider('تجاوزت حدّ الطلبات (HTTP 429): ' + message.slice(0, 160)) };
  }

  return { kind: 'other', provider, upstream, remedy,
    text: withProvider('OpenRouter رفض الطلب (HTTP ' + status + '): ' + message.slice(0, 200)) };
}

/**
 * Sends a conversation to one model and returns its reply.
 *
 * @param {string} model Model id
 * @param {Array<{role: string, content: string}>} messages Conversation so far
 * @param {Object} [opts] temperature, maxTokens, timeoutMs
 * @returns {Promise<Object>} reply, usage and timing
 */
async function chat(model, messages, opts = {}) {
  const key = readKey();
  if (!key) throw new Error('لم يُضبَط مفتاح OpenRouter بعد.');
  if (!model) throw new Error('لم يُحدَّد نموذج.');
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('لا توجد رسالة لإرسالها.');

  const body = JSON.stringify({
    model,
    messages: messages.slice(-20).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user'),
      content: String(m.content || '').slice(0, 24000)
    })),
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7,
    max_tokens: typeof opts.maxTokens === 'number' ? opts.maxTokens : 1200
  });

  const started = Date.now();
  const res = await request(CHAT_URL, {
    method: 'POST',
    timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 180000,
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      // OpenRouter attributes traffic with these; harmless and honest.
      'HTTP-Referer': 'http://127.0.0.1:4500',
      'X-Title': 'Maktaba'
    }
  }, body);

  const elapsedMs = Date.now() - started;

  if (res.status !== 200) {
    const failure = classifyFailure(res.status, res.json, res.raw);
    const err = new Error(failure.text);
    // Attached so callers can act on the KIND rather than re-reading the
    // sentence. The benchmark needs to tell "this model is bad" from "the
    // upstream provider is down" from "your quota is gone", and three different
    // regexes over one Arabic string is how that goes wrong.
    err.kind = failure.kind;
    err.status = res.status;
    err.provider = failure.provider;
    err.upstream = failure.upstream;
    err.remedy = failure.remedy;
    throw err;
  }

  const choice = res.json && res.json.choices && res.json.choices[0];
  const message = choice && choice.message;
  return {
    reply: (message && message.content) || '',
    reasoning: (message && message.reasoning) || null,
    finishReason: choice ? choice.finish_reason : null,
    usage: res.json.usage || null,
    modelUsed: res.json.model || model,
    // Which upstream actually served this. OpenRouter routes one model id to
    // several providers, and two calls to the same model can land on different
    // ones — which is why the same model succeeds and fails minutes apart.
    provider: (res.json && res.json.provider) || null,
    elapsedMs
  };
}


/**
 * What OpenRouter says this key is allowed to do.
 *
 * Worth asking directly rather than inferring: two benchmark runs were refused
 * on roughly half their requests, and pacing them under twenty a minute did not
 * change that — which rules out a per-minute limit and points at a daily quota.
 * The endpoint answers the question outright.
 *
 * @returns {Promise<Object>} Usage, limit and rate-limit as OpenRouter reports them
 */
async function keyLimits() {
  const key = readKey();
  if (!key) throw new Error('لم يُضبَط مفتاح OpenRouter بعد.');
  const res = await request(KEY_URL, { headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } });
  if (res.status !== 200 || !res.json) {
    throw new Error('تعذّر قراءة حدود المفتاح (HTTP ' + res.status + ').');
  }
  const d = res.json.data || {};
  return {
    usage: d.usage,
    limit: d.limit,
    limitRemaining: d.limit_remaining,
    isFreeTier: d.is_free_tier,
    rateLimit: d.rate_limit || null,
    // The label can carry a name the user chose; the key itself never appears.
    label: d.label || null
  };
}

module.exports = { request, listFreeModels, chat, hasKey, saveKey, clearKey, extractParameters, keyLimits,
  classifyFailure };
