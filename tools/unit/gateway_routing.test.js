// The gateway decides two things a person cannot check by eye: which model a
// request goes to, and who is allowed to ask. Both are easy to get subtly wrong
// in ways that still look like they work — an explicit model quietly swapped for
// another, a token check that passes on a prefix, a fallback chain that retries
// into the same rate limit until it gives up.
//
// Everything here runs offline. openrouter.chat and the score file are both
// replaced with fakes, so these assertions test the routing decision itself and
// never depend on OpenRouter being reachable, or on which free models exist
// today.

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

// Point the modules at throwaway files BEFORE loading them: the real token and
// the real scores must not be touched by a test run.
const SCORES = path.join(TMP, 'scores.json');
process.env.MAKTABA_MODEL_SCORES = SCORES;
process.env.MAKTABA_GATEWAY_TOKEN = path.join(TMP, 'token.json');
process.env.MAKTABA_GATEWAY_USAGE = path.join(TMP, 'usage.jsonl');
// The router now consults the availability sweep as well as the scores, so this
// file has to be redirected too. Without it the test read the REAL sweep, which
// naturally contains none of the fake models below, and every auto route
// resolved to nothing — a test failing because of the machine it ran on.
const AVAILABILITY = path.join(TMP, 'availability.json');
process.env.MAKTABA_MODEL_AVAILABILITY = AVAILABILITY;
// The router persists circuit state, so that file needs redirecting too or a
// test run leaves real models marked as failing.
process.env.MAKTABA_MODEL_HEALTH = path.join(TMP, 'health.json');

const openrouter = require('../../lib/openrouter');
const bench = require('../../lib/modelBench');
const gw = require('../../lib/gateway');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

function probes(spec) {
  return Object.keys(spec).map(id => ({ id, ok: spec[id] }));
}

function writeScores(models) {
  fs.writeFileSync(SCORES, JSON.stringify({ updatedAt: new Date().toISOString(), models }, null, 2), 'utf8');
  // Mirror them into the availability sweep as open, so these assertions test
  // the RANKING rules rather than accidentally testing the availability filter.
  // The filter has its own tests in model_availability.test.js.
  const open = {};
  Object.keys(models).forEach(id => {
    open[id] = { id, status: 'open', checkedAt: new Date().toISOString() };
  });
  fs.writeFileSync(AVAILABILITY, JSON.stringify({ checkedAt: new Date().toISOString(), models: open }, null, 2), 'utf8');
}

// alpha is the strongest overall; gamma would outrank it but is unreliable;
// each model passes a different mix of probes so capability filters are visible.
writeScores({
  alpha: { id: 'alpha', name: 'Alpha', rank: 0.90, reliability: 1, medianMs: 2000, contextLength: 128000,
    probes: probes({ arabic: true, code: true, json: false, reasoning: false }) },
  beta: { id: 'beta', name: 'Beta', rank: 0.80, reliability: 1, medianMs: 3000, contextLength: 32000,
    probes: probes({ arabic: false, code: true, json: true, reasoning: false }) },
  gamma: { id: 'gamma', name: 'Gamma', rank: 0.95, reliability: 0.2, medianMs: 900, contextLength: 1000000,
    probes: probes({ arabic: true, code: true, json: true, reasoning: true }) },
  delta: { id: 'delta', name: 'Delta', rank: 0.50, reliability: 1, medianMs: 8000, contextLength: 8000,
    probes: probes({ arabic: true, code: false, json: true, reasoning: false }) }
});

// --- ranking ---------------------------------------------------------------
const ranked = bench.rankModels();
check('scores are ranked best first', ranked[0].id === 'gamma' && ranked[1].id === 'alpha',
  ranked.map(m => m.id).join(','));

// --- auto picks the best model that can actually be relied on ---------------
let chain = gw.resolveChain('auto');
check('auto picks the top-ranked model', chain.chain[0] === 'alpha', chain.chain.join(','));
check('auto reports that it chose', chain.auto === true && chain.reason === 'ranked');
// gamma outranks alpha but answered only one probe in five. A model that is
// usually unavailable is a bad default however well it scores when it replies.
check('an unreliable model is never auto-selected', chain.chain.indexOf('gamma') === -1, chain.chain.join(','));

// --- a required skill is a filter, not a preference -------------------------
chain = gw.resolveChain('auto:arabic');
check('auto:arabic keeps only models that passed the Arabic probe',
  chain.chain.indexOf('beta') === -1 && chain.chain[0] === 'alpha', chain.chain.join(','));

chain = gw.resolveChain('auto:json');
check('auto:json excludes a model that failed the JSON probe',
  chain.chain.indexOf('alpha') === -1 && chain.chain[0] === 'beta', chain.chain.join(','));

chain = gw.resolveChain('auto:arabic,json');
check('two skills narrow to the model that passed both',
  chain.chain.length === 1 && chain.chain[0] === 'delta', chain.chain.join(','));

// --- an impossible requirement must not return nothing silently -------------
chain = gw.resolveChain('auto:reasoning');
check('an unmet requirement falls back rather than failing',
  chain.chain.length > 0 && chain.reason === 'ranked-relaxed', chain.reason);

// --- an explicit model is honoured, always ----------------------------------
chain = gw.resolveChain('vendor/some-model');
check('an explicit model is tried first', chain.chain[0] === 'vendor/some-model', chain.chain.join(','));
check('an explicit model is not reported as auto', chain.auto === false && chain.reason === 'explicit');
check('fallbacks come after the explicit choice, never before', chain.chain.length > 1 && chain.chain[1] === 'alpha');

check('a missing model name yields no chain', gw.resolveChain('').chain.length === 0);

// --- bestModel agrees with the router ---------------------------------------
check('bestModel honours a skill requirement', bench.bestModel({ arabic: true }).id === 'alpha');
check('bestModel honours a context requirement', bench.bestModel({ minContext: 100000 }).id === 'alpha');
check('bestModel returns null when nothing qualifies',
  bench.bestModel({ minContext: 99999999 }) === null);

// --- the token check --------------------------------------------------------
check('no token means the gateway refuses everyone',
  gw.authorize({ headers: { authorization: 'Bearer anything' } }).status === 503);

const issued = gw.createToken();
check('an issued token is stored and readable', gw.readToken() === issued.token);
check('the token is long and random', /^mk-[0-9a-f]{48}$/.test(issued.token), issued.token);

check('the right token is accepted',
  gw.authorize({ headers: { authorization: 'Bearer ' + issued.token } }).ok === true);
check('the token is also accepted as x-api-key',
  gw.authorize({ headers: { 'x-api-key': issued.token } }).ok === true);
check('a wrong token of the same length is rejected',
  gw.authorize({ headers: { authorization: 'Bearer mk-' + 'a'.repeat(48) } }).status === 401);
// A shorter credential must be rejected, not crash: timingSafeEqual throws on a
// length mismatch, which would turn a bad token into a 500 and leak the length.
let threw = false;
let short;
try { short = gw.authorize({ headers: { authorization: 'Bearer mk-short' } }); } catch (e) { threw = true; }
check('a short token is rejected without throwing', threw === false && short.status === 401);
check('a missing credential is rejected', gw.authorize({ headers: {} }).status === 401);

const rotated = gw.createToken();
check('a new token invalidates the previous one',
  gw.authorize({ headers: { authorization: 'Bearer ' + issued.token } }).status === 401
  && gw.authorize({ headers: { authorization: 'Bearer ' + rotated.token } }).ok === true);

// --- the fallback chain, with the network faked -----------------------------
// gateway calls openrouter.chat through the module object, so replacing the
// property is enough to run the whole routing path offline.
const realChat = openrouter.chat;
const calls = [];

(async function run() {
  openrouter.chat = async (model) => {
    calls.push(model);
    if (model === 'alpha') throw new Error('rate limited');
    return { reply: 'hi', usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      finishReason: 'stop', elapsedMs: 120, modelUsed: model };
  };

  let out = await gw.complete({ model: 'auto', messages: [{ role: 'user', content: 'x' }] });
  check('a failed model falls through to the next one', out.routedTo === 'beta', out.routedTo);
  check('every attempt is recorded, failures included',
    out.attempts.length === 2 && out.attempts[0].ok === false && out.attempts[1].ok === true);

  // One failure is bad luck, not a verdict. The flat five-minute penalty this
  // replaced dropped a model after a single blip; the breaker gives it a second
  // chance and only then takes it out. The caller is protected either way,
  // because the router falls through within the same request.
  const router = require('../../lib/modelRouter');
  let after = gw.resolveChain('auto');
  check('one failure does not discard the preferred model',
    after.chain[0] === 'alpha', after.chain.join(','));
  check('but the request was still served', out.routedTo === 'beta');

  // A second failure is a pattern, and the circuit opens.
  await gw.complete({ model: 'auto', messages: [{ role: 'user', content: 'x' }] });
  after = gw.resolveChain('auto');
  const circuit = router.circuitState('alpha');
  check('two failures open the circuit', circuit.state === 'open', circuit.state);
  check('and an open model is no longer tried first',
    router.order(after.chain).usable[0] !== 'alpha', JSON.stringify(router.order(after.chain)));
  // It is kept as a last resort rather than dropped: a late answer from a
  // struggling model beats refusing the request.
  check('but it is kept as a last resort, not discarded',
    router.order(after.chain).resting.indexOf('alpha') !== -1);

  // Recovery is automatic and needs nobody to notice: the order is rebuilt from
  // rank every call, so the moment it answers again it is preferred again.
  router.recordSuccess('alpha', 100);
  check('a success closes the circuit', router.circuitState('alpha').state === 'closed');
  check('and the preferred model is preferred again',
    router.order(gw.resolveChain('auto').chain).usable[0] === 'alpha');

  // --- the reply is shaped the way an OpenAI client expects -----------------
  const shaped = gw.toOpenAiShape(out, 'auto');
  check('the response is an OpenAI chat completion',
    shaped.object === 'chat.completion' && shaped.choices[0].message.role === 'assistant'
    && shaped.choices[0].message.content === 'hi');
  check('usage is reported in OpenAI fields', shaped.usage.total_tokens === 12);
  check('the routing detail names the model actually used',
    shaped.maktaba.routed_to === 'beta' && shaped.maktaba.requested === 'auto' && shaped.maktaba.auto === true);
  check('the model field is the model that answered, not the one asked for',
    shaped.model === 'beta');

  // --- usage log ------------------------------------------------------------
  gw.recordUsage({ ok: true, requested: 'auto', routedTo: 'beta', tokensIn: 5, tokensOut: 7 });
  gw.recordUsage({ ok: false, requested: 'auto', routedTo: 'alpha', error: 'rate limited' });
  const usage = gw.getUsage(10);
  check('usage counts every call', usage.calls === 2);
  check('usage separates failures from successes',
    usage.byModel.alpha.failures === 1 && usage.byModel.beta.failures === 0);
  check('usage totals the tokens', usage.tokens === 12);

  // --- an empty body with a 200 is a failure in disguise -----------------------
  // The caller asked a question and got nothing back. Passing that through as
  // an answer is the silent breakage this gateway exists to prevent.
  writeScores({
    hollow: { id: 'hollow', name: 'Hollow', rank: 0.9, reliability: 1, medianMs: 100, probes: [] },
    solid: { id: 'solid', name: 'Solid', rank: 0.8, reliability: 1, medianMs: 200, probes: [] }
  });
  router.reset();
  openrouter.chat = async (model) => (model === 'hollow'
    ? { reply: '   ', finishReason: 'stop', usage: {}, elapsedMs: 10 }
    : { reply: 'a real answer', finishReason: 'stop', usage: {}, elapsedMs: 20 });

  out = await gw.complete({ model: 'auto', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 });
  check('an empty reply is failed over, not returned', out.routedTo === 'solid', out.routedTo);
  check('and the caller is told the answer is not the preferred one',
    out.degraded === true && out.preferred === 'hollow');
  check('the empty response is recorded as an attempt',
    out.attempts.length === 2 && out.attempts[0].kind === 'empty-reply', JSON.stringify(out.attempts));

  // But an empty reply the CALLER asked for is arithmetic, not failure.
  router.reset();
  out = await gw.complete({ model: 'auto', messages: [{ role: 'user', content: 'x' }], max_tokens: 1 });
  check('a one-token request may legitimately come back empty',
    out.routedTo === 'hollow' && out.degraded === false, out.routedTo);

  // So is a reply that stopped because it ran out of room.
  router.reset();
  openrouter.chat = async () => ({ reply: '', finishReason: 'length', usage: {}, elapsedMs: 10 });
  out = await gw.complete({ model: 'auto', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 });
  check('a reply clipped by the token limit is not treated as a failure',
    out.routedTo === 'hollow', out.routedTo);

  // --- a request with nothing to send ---------------------------------------
  let status400 = null;
  try { await gw.complete({ model: 'auto', messages: [] }); } catch (e) { status400 = e.status; }
  check('an empty conversation is a 400, not a 502', status400 === 400);

  // --- every model refusing --------------------------------------------------
  openrouter.chat = async () => { throw new Error('rate limited'); };
  let allFailed = null;
  try {
    await gw.complete({ model: 'vendor/x', messages: [{ role: 'user', content: 'x' }] });
  } catch (e) { allFailed = e; }
  check('a chain where everything fails is a 502', allFailed && allFailed.status === 502);
  check('the error names what was tried', allFailed && allFailed.attempts.length >= 1);

  // --- no scores at all -------------------------------------------------------
  writeScores({});
  const bare = gw.resolveChain('auto');
  check('auto with no scores yields no chain', bare.chain.length === 0 && bare.reason === 'no-scores');
  let noModel = null;
  try { await gw.complete({ model: 'auto', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { noModel = e.status; }
  check('auto before any benchmark is a clear 503', noModel === 503);

  openrouter.chat = realChat;

  // --- the probes themselves --------------------------------------------------
  // A scoring probe that accepts a wrong answer makes every rank meaningless,
  // so each check is tested against a right answer and a wrong one.
  const P = {};
  bench.PROBES.forEach(p => { P[p.id] = p; });

  check('the Arabic probe accepts a correct Arabic answer', P.arabic.check('عاصمة مصر هي القاهرة.') === true);
  check('the Arabic probe rejects a correct English answer', P.arabic.check('The capital is Cairo.') === false);
  check('the Arabic probe rejects Arabic with the wrong answer', P.arabic.check('عاصمة مصر هي الإسكندرية.') === false);

  check('the instruction probe accepts a one-word reply', P['follows-instruction'].check('OK') === true);
  check('the instruction probe rejects a rambling reply',
    P['follows-instruction'].check('Sure thing, here is my answer for you: OK, hope that helps!') === false);

  check('the arithmetic probe accepts the right number', P.reasoning.check('10') === true);
  check('the arithmetic probe rejects the wrong number', P.reasoning.check('9') === false);

  check('the JSON probe accepts the exact object', P.json.check('{"status":"ready","count":3}') === true);
  check('the JSON probe accepts it inside a code fence',
    P.json.check('```json\n{"status":"ready","count":3}\n```') === true);
  check('the JSON probe rejects wrong values', P.json.check('{"status":"ready","count":4}') === false);
  check('the JSON probe rejects prose', P.json.check('The status is ready and the count is 3.') === false);

  check('the code probe accepts a working one-liner',
    P.code.check("s.split('').reverse().join('')") === true);
  check('the code probe rejects an explanation with no code',
    P.code.check('You can reverse a string by iterating backwards.') === false);

  // --- the score a model ends up with ------------------------------------------
  openrouter.chat = async (model, messages) => {
    const text = messages[0].content;
    let reply = '';
    if (/one word/i.test(text)) reply = 'OK';
    else if (/عاصمة مصر/.test(text)) reply = 'القاهرة';
    else if (/shelf/i.test(text)) reply = '10';
    else if (/JSON/i.test(text)) reply = '{"status":"ready","count":3}';
    else reply = "[...s].reverse().join('')";
    return { reply, usage: {}, finishReason: 'stop', elapsedMs: 1000, modelUsed: model };
  };
  const perfect = await bench.benchModel({ id: 'perfect', name: 'Perfect' }, { noPacing: true });
  check('a model that answers everything scores full marks',
    perfect.passed === 5 && perfect.accuracy === 1 && perfect.reliability === 1);
  check('a perfect fast model ranks near the top', perfect.rank > 0.95, String(perfect.rank));

  openrouter.chat = async () => { throw new Error('429 rate limited'); };
  const dead = await bench.benchModel({ id: 'dead', name: 'Dead' }, { noPacing: true });
  check('a model that never answers scores zero',
    dead.passed === 0 && dead.reliability === 0 && dead.rank === 0);
  check('a model that never answers has no median latency', dead.medianMs === null);

  openrouter.chat = realChat;

  // --- telling a quota apart from a bad model ---------------------------------
  // The distinction the whole ranking rests on. OpenRouter refuses with
  // "free-models-per-day" once the account's daily allowance is gone, and every
  // model after that point returns the same thing. Scoring those as zero writes
  // false verdicts against good models.
  check('a daily quota refusal is recognised',
    bench.isDailyQuota('Rate limit exceeded: free-models-per-day. Add 10 credits') === true);
  check('a plain rate limit is not mistaken for the daily quota',
    bench.isDailyQuota('Rate limit exceeded: 20 requests per minute') === false);
  check('both kinds still count as rate limits',
    bench.isRateLimit('Rate limit exceeded: 20 requests per minute') === true
    && bench.isRateLimit('free-models-per-day') === true);
  check('a permanent refusal is not a rate limit',
    bench.isRateLimit('HTTP 403: only available on agentic harnesses') === false);

  check('a text-only model is eligible', bench.isTextOnly({ outputModalities: ['text'] }) === true);
  check('a model that also emits audio is not', bench.isTextOnly({ outputModalities: ['text', 'audio'] }) === false);
  check('a model that declares nothing is given the benefit of the doubt',
    bench.isTextOnly({}) === true);

  // --- a refusal is not a measurement -----------------------------------------
  writeScores({
    refused: { id: 'refused', rank: 0, reliability: 0, probes: [
      { id: 'a', ok: false, error: 'تجاوزت حدّ الطلبات لهذا النموذج المجاني.' },
      { id: 'b', ok: false, error: 'تجاوزت حدّ الطلبات لهذا النموذج المجاني.' }] },
    blocked: { id: 'blocked', rank: 0, reliability: 0, probes: [
      { id: 'a', ok: false, error: 'HTTP 403: only available on agentic harnesses' },
      { id: 'b', ok: false, error: 'HTTP 403: only available on agentic harnesses' }] },
    good: { id: 'good', rank: 0.9, reliability: 1, probes: [{ id: 'a', ok: true, ms: 100 }] },
    partial: { id: 'partial', rank: 0.4, reliability: 0.5, probes: [
      { id: 'a', ok: true, ms: 100 },
      { id: 'b', ok: false, error: 'تجاوزت حدّ الطلبات' }] }
  });

  const dropped = bench.pruneUnmeasured();
  const left = bench.rankModels().map(m => m.id).sort().join(',');
  check('a model refused on every probe is forgotten, not ranked zero',
    dropped === 1 && left.indexOf('refused') === -1, left);
  // 403 is an answer: that model genuinely cannot be used, and the zero is true.
  check('a permanently blocked model keeps its zero', left.indexOf('blocked') !== -1, left);
  check('a measured model is untouched', left.indexOf('good') !== -1, left);
  check('a partly measured model is kept', left.indexOf('partial') !== -1, left);

  const gone = bench.dropIneligible([
    { id: 'good', outputModalities: ['text', 'audio'] },
    { id: 'blocked', outputModalities: ['text'] }
  ]);
  check('a non-text model is dropped from the ranking',
    gone === 1 && bench.rankModels().every(m => m.id !== 'good'));

  // --- the run stops at the quota instead of writing zeros --------------------
  let probeCalls = 0;
  openrouter.chat = async () => {
    probeCalls++;
    throw new Error('تجاوزت حدّ الطلبات: Rate limit exceeded: free-models-per-day.');
  };
  const quotaCard = await bench.benchModel({ id: 'q', name: 'Q' }, { noPacing: true });
  check('a quota refusal is flagged on the scorecard', quotaCard.quotaExhausted === true);

  // Exactly one call: no retry, and no further probes.
  //
  // This assertion used to expect PROBES.length calls — one per probe, proving
  // only that the retry was skipped. That passed while the real defect sat
  // underneath it: the quota `break` left only the retry loop, so every
  // remaining probe still fired against an allowance already known to be spent,
  // and each one added a failure the model never earned. A model that answered
  // three probes and then hit the quota was scored reliability 0.6 instead of
  // 0.8, and that depressed card was persisted and routed by.
  check('a quota stops the whole model, not just the retry', probeCalls === 1, String(probeCalls));
  check('and the probes after it are not recorded as failures',
    quotaCard.errors.length === 1, String(quotaCard.errors.length));
  check('reliability reflects only what was actually attempted',
    quotaCard.probes.length === 1, String(quotaCard.probes.length));

  openrouter.chat = realChat;

  const failed = results.filter(r => !r.pass);
  console.log('\nGATEWAY_ROUTING_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exit(1);
  assert.ok(true);
})();
