// Telling apart the four different things a refused OpenRouter call can mean.
//
// The user saw "⚠ تجاوزت حدّ الطلبات: Provider returned error" and asked the
// obvious question: why? Two separate faults made that unanswerable.
//
// First, the reader took `error.message` and nothing else. That field is often
// the useless sentence "Provider returned error", while the fields that explain
// it sit in `error.metadata` and were discarded — measured against the live API:
//
//   402  metadata.limit_source = openrouter_credits, metadata.remedy_hint
//   429  metadata.provider_name = which upstream, metadata.raw = what it said
//
// Second, every 429 was labelled "تجاوزت حدّ الطلبات". OpenRouter also returns
// 429 when the UPSTREAM provider throttles IT — nothing to do with this
// account — so the message blamed the user for someone else's capacity, and no
// amount of waiting would have helped.
//
// These four kinds need four different responses, which is why the kind is a
// field and not a sentence to be re-parsed:
//   daily-quota      wait; nothing else works
//   provider-failure retry; OpenRouter may route elsewhere next time
//   needs-credits    this model is not actually free for this account
//   access           this model will never work here, whatever you do

const assert = require('node:assert');
const { classifyFailure } = require('../../lib/openrouter');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

// --- the account's daily allowance ------------------------------------------
// Captured from the live API.
let f = classifyFailure(429, { error: { code: 429,
  message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day' } }, '');
check('a spent daily quota is named as such', f.kind === 'daily-quota', f.kind);
check('and the message says it renews itself', /تتجدّد/.test(f.text), f.text);

// --- an upstream provider failing -------------------------------------------
// The user's actual case. The old code called this a rate limit.
f = classifyFailure(429, { error: { code: 429, message: 'Provider returned error',
  metadata: { provider_name: 'Chutes', raw: 'upstream returned 503: no capacity' } } }, '');
check('a provider failure is NOT called a quota problem', f.kind === 'provider-failure', f.kind);
check('the provider that failed is named', f.provider === 'Chutes' && /Chutes/.test(f.text), f.text);
// metadata.raw is the field that actually answers "why", and it was thrown away.
check('the upstream reason is kept', /no capacity/.test(f.text), f.text);

f = classifyFailure(502, { error: { code: 502, message: 'Provider returned error' } }, '');
check('a 502 is a provider failure too', f.kind === 'provider-failure', f.kind);
check('it survives without metadata', f.provider === null && /502/.test(f.text), f.text);

// --- a model that is not really free -----------------------------------------
// google/lyria-3 is listed with zero pricing yet answers 402. Calling that a
// rate limit would send someone waiting for a limit that never resets.
f = classifyFailure(402, { error: { code: 402,
  message: 'Insufficient credits. This account never purchased credits',
  metadata: { limit_source: 'openrouter_credits', remedy_hint: 'Add credits at https://openrouter.ai/settings/credits' } } }, '');
check('a credits problem is named', f.kind === 'needs-credits', f.kind);
check('the message says the model is not actually free', /ليس مجانياً/.test(f.text), f.text);
check('the remedy hint is carried through', /Add credits/.test(f.text), f.text);

// --- access and key ------------------------------------------------------------
f = classifyFailure(403, { error: { code: 403,
  message: 'thinkingmachines/inkling:free is only available on agentic harnesses' } }, '');
check('a 403 is an access problem, not a rate limit', f.kind === 'access', f.kind);
check('the reason survives intact', /agentic harnesses/.test(f.text), f.text);

f = classifyFailure(401, { error: { code: 401, message: 'No auth credentials found' } }, '');
check('a 401 points at the key', f.kind === 'key' && /المفتاح/.test(f.text), f.text);

// --- a genuine rate limit that is not the daily cap -------------------------------
f = classifyFailure(429, { error: { code: 429, message: 'Rate limit exceeded: 20 requests per minute' } }, '');
check('a per-minute limit is a rate-limit', f.kind === 'rate-limit', f.kind);
check('and is not confused with the daily quota', f.kind !== 'daily-quota');

// --- nothing useful in the body ---------------------------------------------------
f = classifyFailure(500, null, 'Internal Server Error');
check('an unparseable body still yields a kind', f.kind === 'other', f.kind);
check('and shows the raw text rather than nothing', /Internal Server Error/.test(f.text), f.text);
check('a missing body does not throw', classifyFailure(500, null, '').kind === 'other');

// --- the four kinds are distinct ---------------------------------------------------
// If any two of these collapse, the benchmark cannot tell "this model is bad"
// from "the provider is down" from "your quota is gone" — and it starts writing
// zeros against good models again.
const kinds = [
  classifyFailure(429, { error: { message: 'Rate limit exceeded: free-models-per-day' } }, '').kind,
  classifyFailure(429, { error: { message: 'Provider returned error', metadata: { provider_name: 'X' } } }, '').kind,
  classifyFailure(402, { error: { message: 'Insufficient credits' } }, '').kind,
  classifyFailure(403, { error: { message: 'not available' } }, '').kind
];
check('the four causes stay four distinct kinds',
  new Set(kinds).size === 4, kinds.join(','));

const failed = results.filter(r => !r.pass);
console.log('\nOPENROUTER_FAILURES_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
assert.ok(true);
