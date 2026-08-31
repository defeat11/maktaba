// The router that keeps the gateway answering when a model stops.
//
// What it replaced: a flat five-minute skip after any failure. That could not
// tell a model blocked by policy from one having a bad minute, it never went
// back to the better model once a worse one had taken over, and the five
// minutes was a guess.
//
// Three behaviours are what make this worth having, and each is asserted here:
//
//   * a single failure does not cost a good model its place — one blip is not
//     a verdict, and the request is served by falling through anyway
//   * how long a model rests depends on WHY it failed: a 403 is a policy that
//     will still be there in an hour, a 502 usually is not
//   * recovery needs nobody to notice. The order is rebuilt from preference on
//     every call, so the moment a circuit closes the preferred model is
//     preferred again
//
// And one thing it deliberately does NOT do: fail over when the ACCOUNT's daily
// allowance is gone. That limit is on the key, so every remaining model would
// refuse for the same reason. Trying them would spend nothing usefully and
// report a fleet-wide outage that is not happening.

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'router-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});
process.env.MAKTABA_LOGS_DIR = path.join(TMP, 'logs');
try { fs.mkdirSync(process.env.MAKTABA_LOGS_DIR, { recursive: true }); } catch (e) {}
process.env.MAKTABA_MODEL_HEALTH = path.join(TMP, 'health.json');

const router = require('../../lib/modelRouter');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

const fail = (kind, message) => {
  const e = new Error(message || kind);
  e.kind = kind;
  return e;
};

(async () => {
  // --- a blip is not a verdict --------------------------------------------------
  router.reset();
  router.recordFailure('a', fail('provider-failure'));
  check('one failure leaves the circuit closed', router.circuitState('a').state === 'closed');
  check('and the model is still tried', router.canTry('a') === true);

  router.recordFailure('a', fail('provider-failure'));
  check('a second failure opens it', router.circuitState('a').state === 'open');
  check('and it is no longer tried', router.canTry('a') === false);

  // --- a definitive refusal is acted on at once ---------------------------------
  // Spending a second request to confirm a 403 teaches nothing.
  router.reset();
  router.recordFailure('b', fail('access', '403 only available on agentic harnesses'));
  check('a 403 opens the circuit on the first failure', router.circuitState('b').state === 'open');

  router.reset();
  router.recordFailure('c', fail('needs-credits'));
  check('so does a model that turns out to need credits', router.circuitState('c').state === 'open');

  // --- the wait is sized by the reason ------------------------------------------
  router.reset();
  const restFor = (kind, times) => {
    const id = 'm-' + kind;
    for (let i = 0; i < times; i++) router.recordFailure(id, fail(kind));
    const e = router.health().models.find(m => m.id === id);
    return e.openUntil - Date.now();
  };
  const policyWait = restFor('access', 1);
  const outageWait = restFor('provider-failure', 2);
  const throttleWait = restFor('rate-limit', 2);
  check('a policy refusal rests far longer than an outage', policyWait > outageWait * 10,
    Math.round(policyWait / 60000) + 'min vs ' + Math.round(outageWait / 60000) + 'min');
  check('a throttle rests the shortest', throttleWait < outageWait,
    Math.round(throttleWait / 60000) + 'min vs ' + Math.round(outageWait / 60000) + 'min');

  // --- repeated failure is asked about less and less ------------------------------
  router.reset();
  router.recordFailure('d', fail('provider-failure'));
  router.recordFailure('d', fail('provider-failure'));
  const firstWindow = router.health().models.find(m => m.id === 'd').openUntil - Date.now();
  const e = router.health().models.find(m => m.id === 'd');
  // Force the window open so the next failure counts as a second opening.
  const store = JSON.parse(fs.readFileSync(process.env.MAKTABA_MODEL_HEALTH, 'utf8'));
  store.models.d.openUntil = Date.now() - 1;
  fs.writeFileSync(process.env.MAKTABA_MODEL_HEALTH, JSON.stringify(store), 'utf8');
  // No reset needed: the router re-reads when the file's mtime moves, which is
  // what makes a second process's updates visible at all.
  check('an expired window becomes half-open on the next look',
    router.circuitState('d').state === 'half-open', router.circuitState('d').state);
  check('half-open allows exactly one trial through', router.canTry('d') === true);

  router.recordFailure('d', fail('provider-failure'));
  router.recordFailure('d', fail('provider-failure'));
  const secondWindow = router.health().models.find(m => m.id === 'd').openUntil - Date.now();
  check('a model that keeps failing waits longer each time', secondWindow > firstWindow,
    Math.round(secondWindow / 60000) + 'min vs ' + Math.round(firstWindow / 60000) + 'min');

  // --- recovery, with nobody watching ---------------------------------------------
  router.recordSuccess('d', 120);
  check('one success closes the circuit', router.circuitState('d').state === 'closed');
  check('and resets the failure streak',
    router.health().models.find(m => m.id === 'd').consecutiveFailures === 0);
  check('so it is usable again immediately', router.canTry('d') === true);

  // --- ordering ---------------------------------------------------------------------
  router.reset();
  router.recordFailure('down', fail('access'));
  const ordered = router.order(['good', 'down', 'other']);
  check('a resting model drops out of the usable list',
    ordered.usable.join(',') === 'good,other', ordered.usable.join(','));
  // Kept, not discarded: a late answer beats refusing the request.
  check('but is kept as a last resort', ordered.resting.join(',') === 'down');
  check('preference order is otherwise untouched', ordered.usable[0] === 'good');

  // --- routing --------------------------------------------------------------------
  router.reset();
  let calls = [];
  let out = await router.route(['x', 'y', 'z'], async (id) => {
    calls.push(id);
    if (id === 'x') throw fail('provider-failure', 'upstream down');
    return { reply: 'served by ' + id };
  });
  check('the request is served despite the first model failing', out.result.reply === 'served by y');
  check('it says which model actually answered', out.servedBy === 'y');
  // The caller gets an answer either way, and is told it is not the answer it
  // would have had.
  check('and admits the answer is degraded', out.degraded === true && out.preferred === 'x');
  check('every attempt is recorded', out.attempts.length === 2 && out.attempts[0].ok === false);
  check('it stopped as soon as one answered', calls.join(',') === 'x,y');

  out = await router.route(['x', 'y'], async (id) => ({ reply: 'ok ' + id }));
  check('when the first works, nothing is called degraded', out.degraded === false && out.servedBy === 'x');

  // --- the case that cannot be routed around ----------------------------------------
  // The daily allowance is on the key. Failing over would spend the remainder of
  // nothing and report a fleet-wide outage that is not happening.
  router.reset();
  calls = [];
  let quotaErr = null;
  try {
    await router.route(['x', 'y', 'z'], async (id) => {
      calls.push(id);
      throw fail('daily-quota', 'free-models-per-day');
    });
  } catch (err) { quotaErr = err; }
  check('a spent daily quota stops the sweep at the first model', calls.length === 1, calls.join(','));
  check('and is reported as a quota, not as three broken models',
    quotaErr && quotaErr.quota === true && quotaErr.status === 429);
  check('the message says the limit is on the account, not the model',
    /حسابك/.test(quotaErr.message), quotaErr.message);
  // Crucially, no model is blamed for it.
  check('no model is marked unhealthy by a quota refusal',
    router.health().models.every(m => m.state === 'closed'),
    JSON.stringify(router.health().byState));

  // --- everything failing -----------------------------------------------------------
  router.reset();
  let allErr = null;
  try {
    await router.route(['x', 'y'], async () => { throw fail('provider-failure', 'down'); });
  } catch (err) { allErr = err; }
  check('when nothing answers it is a 502', allErr && allErr.status === 502);
  check('and it names how many were tried', /2/.test(allErr.message), allErr.message);

  try {
    await router.route([], async () => ({}));
    check('an empty candidate list throws', false);
  } catch (err) {
    check('an empty candidate list throws', err.status === 503);
  }

  // --- health report -------------------------------------------------------------------
  router.reset();
  router.recordSuccess('h1', 100);
  router.recordFailure('h2', fail('access'));
  const h = router.health();
  check('health counts each state', h.byState.closed === 1 && h.byState.open === 1, JSON.stringify(h.byState));
  check('it reports a success rate', h.models.find(m => m.id === 'h1').successRate === 100);
  check('and how long a resting model has left',
    h.models.find(m => m.id === 'h2').restingForMs > 0);

  // --- it survives a restart --------------------------------------------------------------
  // A model blocked by policy must still be blocked after the server restarts,
  // or every restart costs another wasted request to rediscover it.
  const persisted = JSON.parse(fs.readFileSync(process.env.MAKTABA_MODEL_HEALTH, 'utf8'));
  check('circuit state is written to disk', persisted.models.h2 && persisted.models.h2.state === 'open',
    JSON.stringify(Object.keys(persisted.models)));

  const failed = results.filter(r => !r.pass);
  console.log('\nMODEL_ROUTER_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exit(1);
  assert.ok(true);
})();
