// Which free models are actually open to this account.
//
// "Free" in OpenRouter's catalogue is a statement about price. It is not a
// statement about access. Measured on this machine, from twenty-one models all
// listed as free:
//
//   13  open
//    4  the provider behind them refused (502)
//    2  blocked — "only available on agentic harnesses" (403)
//    2  not chat models at all — music generators
//
// A page that lists 21 free models and stops there has told the truth about the
// price and omitted the part that decides whether you can type into it.
//
// Two things are asserted hardest here. First, that a spent daily quota is
// never recorded as a fact about a model: it is a fact about the account, and
// writing "unavailable" against a model that was never asked is the false
// verdict this project guards against everywhere else. Second, that a model
// which cannot produce text is identified without spending a request — the
// allowance is around fifty a day and shared with everything else.

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avail-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});
process.env.MAKTABA_LOGS_DIR = path.join(TMP, 'logs');
try { fs.mkdirSync(process.env.MAKTABA_LOGS_DIR, { recursive: true }); } catch (e) {}
process.env.MAKTABA_MODEL_AVAILABILITY = path.join(TMP, 'availability.json');

const openrouter = require('../../lib/openrouter');
const ma = require('../../lib/modelAvailability');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

// --- what needs no request at all ----------------------------------------------
check('a text-only model is a chat candidate', ma.isTextOnly({ outputModalities: ['text'] }) === true);
check('a music generator is not', ma.isTextOnly({ outputModalities: ['text', 'audio'] }) === false);
check('an image generator is not', ma.isTextOnly({ outputModalities: ['image'] }) === false);
check('a model declaring nothing is given the benefit of the doubt', ma.isTextOnly({}) === true);

// --- one failure kind, one thing the user can do about it ------------------------
const cases = [
  ['needs-credits', ma.STATUS.NEEDS_CREDITS],
  ['access', ma.STATUS.BLOCKED],
  ['provider-failure', ma.STATUS.PROVIDER_DOWN],
  ['rate-limit', ma.STATUS.RATE_LIMITED],
  ['key', ma.STATUS.KEY_REJECTED],
  ['other', ma.STATUS.UNKNOWN]
];
for (const [kind, expected] of cases) {
  const err = new Error('x'); err.kind = kind;
  check('a ' + kind + ' failure reads as ' + expected, ma.statusFromError(err) === expected,
    ma.statusFromError(err));
}
check('no error at all means open', ma.statusFromError(null) === ma.STATUS.OPEN);
// An unclassified error must not be dressed up as a verdict about the model.
check('an error with no kind is unknown, not blocked',
  ma.statusFromError(new Error('something')) === ma.STATUS.UNKNOWN);
check('every status has an Arabic label',
  Object.values(ma.STATUS).every(v => typeof ma.LABELS[v] === 'string' && ma.LABELS[v].length > 0),
  JSON.stringify(Object.keys(ma.LABELS)));

// --- probing, with the network faked ---------------------------------------------
const realChat = openrouter.chat;

(async () => {
  // A generator is settled from its own declaration, without asking.
  let out = await ma.probe({ id: 'g/music', name: 'Music', outputModalities: ['text', 'audio'] }, { noPacing: true });
  check('a non-text model is judged without a request',
    out.status === ma.STATUS.NOT_TEXT && out.costRequest === false, JSON.stringify(out));

  openrouter.chat = async () => ({ reply: 'hi', usage: {}, finishReason: 'stop', elapsedMs: 420 });
  out = await ma.probe({ id: 'a/open', name: 'Open', outputModalities: ['text'] }, { noPacing: true });
  check('a model that answers is open', out.status === ma.STATUS.OPEN, JSON.stringify(out));
  check('and its response time is recorded', out.elapsedMs === 420);

  openrouter.chat = async () => { const e = new Error('403 only available on agentic harnesses'); e.kind = 'access'; e.status = 403; throw e; };
  out = await ma.probe({ id: 'a/blocked', name: 'Blocked', outputModalities: ['text'] }, { noPacing: true });
  check('a 403 is reported as blocked', out.status === ma.STATUS.BLOCKED);
  check('the refusal text is kept so the reason is readable', /agentic harnesses/.test(out.detail), out.detail);
  check('the http status is kept', out.httpStatus === 403);

  openrouter.chat = async () => { const e = new Error('provider failed'); e.kind = 'provider-failure'; e.provider = 'Chutes'; throw e; };
  out = await ma.probe({ id: 'a/down', name: 'Down', outputModalities: ['text'] }, { noPacing: true });
  check('an upstream failure is not blamed on the model', out.status === ma.STATUS.PROVIDER_DOWN);
  check('and names the provider that failed', out.provider === 'Chutes');

  openrouter.chat = async () => { const e = new Error('needs credits'); e.kind = 'needs-credits'; e.remedy = 'add 10 credits'; throw e; };
  out = await ma.probe({ id: 'a/paid', name: 'Paid', outputModalities: ['text'] }, { noPacing: true });
  check('a model listed free that wants money says so', out.status === ma.STATUS.NEEDS_CREDITS);
  check('and carries the remedy', out.remedy === 'add 10 credits');

  // --- the one outcome that says nothing about the model -----------------------
  // The daily allowance belongs to the account. Recording it against a model
  // would be writing a verdict about something that was never asked.
  openrouter.chat = async () => { const e = new Error('free-models-per-day'); e.kind = 'daily-quota'; throw e; };
  out = await ma.probe({ id: 'a/unasked', name: 'Unasked', outputModalities: ['text'] }, { noPacing: true });
  check('a spent quota is flagged, not turned into a status',
    out.quotaExhausted === true && (out.status === null || out.status === undefined), JSON.stringify(out));

  openrouter.chat = realChat;

  // --- the summary ---------------------------------------------------------------
  fs.writeFileSync(process.env.MAKTABA_MODEL_AVAILABILITY, JSON.stringify({
    checkedAt: new Date().toISOString(),
    models: {
      'a': { id: 'a', status: 'blocked', checkedAt: new Date().toISOString() },
      'b': { id: 'b', status: 'open', checkedAt: new Date().toISOString() },
      'c': { id: 'c', status: 'open', checkedAt: new Date().toISOString() },
      'd': { id: 'd', status: 'not-text', checkedAt: new Date().toISOString() },
      'e': { id: 'e', status: 'provider-down', checkedAt: new Date().toISOString() }
    }
  }, null, 2), 'utf8');

  const summary = ma.summarise();
  check('the summary counts what is open', summary.open === 2 && summary.total === 5,
    summary.open + '/' + summary.total);
  check('it breaks the rest down by reason',
    summary.byStatus.blocked === 1 && summary.byStatus['provider-down'] === 1);
  // Open first: the list exists to answer "what can I use right now".
  check('open models are listed first', summary.models[0].status === 'open' && summary.models[1].status === 'open',
    summary.models.map(m => m.status).join(','));
  check('the unusable sink to the bottom',
    summary.models[summary.models.length - 1].status === 'not-text',
    summary.models.map(m => m.status).join(','));

  // Only the open ones are worth a five-probe benchmark: five requests against
  // a model that answers 403 to the first proves what one already established.
  check('only open models are offered to the benchmark',
    ma.openModelIds().sort().join(',') === 'b,c', ma.openModelIds().join(','));

  const progress = ma.getProgress();
  check('progress reports how many are known', progress.known === 5, String(progress.known));
  check('and is not running', progress.running === false);

  const failed = results.filter(r => !r.pass);
  console.log('\nMODEL_AVAILABILITY_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exit(1);
  assert.ok(true);
})();
