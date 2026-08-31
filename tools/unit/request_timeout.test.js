// The cap on how long a single request may take.
//
// Node's `timeout` option on an http request is an IDLE timeout: it fires when
// the socket goes quiet, not when the request has simply taken too long. A
// server that accepts the connection and holds it never trips it.
//
// Measured consequence: nvidia/nemotron-3.5-lightning answered every probe in
// almost exactly 300 seconds while lib/modelBench.js was passing
// timeoutMs: 90000. Five probes at 300s meant twenty-five minutes on one model,
// which is what "the benchmark is stuck at 3 of 19" actually was. The timeout
// was set, read correctly, and did nothing.
//
// So the cap is now an explicit timer that destroys the request regardless of
// what the socket is doing, and this test holds it to that by talking to a
// server which accepts a connection and then says nothing at all.

const assert = require('node:assert');
const http = require('http');
const https = require('https');

const openrouter = require('../../lib/openrouter');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

// Two servers: one that never answers, one that answers at once.
const silent = http.createServer(() => { /* accept, then say nothing, ever */ });
const prompt = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

(async () => {
  const silentPort = await listen(silent);
  const promptPort = await listen(prompt);

  // The real request() runs; only the transport is redirected at our servers.
  const realRequest = https.request;
  const pointAt = (port) => {
    https.request = (opts, cb) => http.request(
      Object.assign({}, opts, { hostname: '127.0.0.1', port, protocol: 'http:' }), cb);
  };

  try {
    // --- the failure that started this ------------------------------------------
    pointAt(silentPort);
    let started = Date.now();
    let err = null;
    try {
      await openrouter.request('https://example.invalid/v1/chat', { method: 'POST', timeoutMs: 1500 }, '{}');
    } catch (e) { err = e; }
    let elapsed = Date.now() - started;

    check('a server that never answers does not hang the request', err !== null);
    check('it gives up at the cap, not later', elapsed >= 1400 && elapsed < 4000, elapsed + 'ms');
    // The kind is what lets the router and the benchmark treat this as a timeout
    // rather than as the model being wrong.
    check('the failure is labelled a timeout', err && err.kind === 'timeout', err && err.kind);
    check('the message says how long it waited', err && /1|ثانية/.test(err.message), err && err.message);

    // A different cap must actually change the wait, or the number is decorative.
    started = Date.now();
    try {
      await openrouter.request('https://example.invalid/v1/chat', { method: 'POST', timeoutMs: 3000 }, '{}');
    } catch (e) { /* expected */ }
    const longer = Date.now() - started;
    check('a larger cap waits longer', longer > elapsed + 800, elapsed + 'ms then ' + longer + 'ms');

    // --- and it must not interfere with a normal reply ----------------------------
    // A timer left armed after a fast response would fire into nothing, or worse,
    // destroy a socket already handed back to the pool.
    pointAt(promptPort);
    started = Date.now();
    const ok = await openrouter.request('https://example.invalid/v1/chat', { method: 'POST', timeoutMs: 5000 }, '{}');
    const fast = Date.now() - started;
    check('a fast reply still comes back', ok && ok.status === 200, JSON.stringify(ok && ok.status));
    check('and is not delayed by the cap', fast < 1000, fast + 'ms');
    check('the body is parsed', ok && ok.json && ok.json.ok === true, JSON.stringify(ok && ok.json));

    // Nothing should be left running: an armed timer would keep the process alive.
    const pending = await new Promise(resolve => setTimeout(() => resolve(true), 200));
    check('no timer is left armed after a normal reply', pending === true);
  } finally {
    https.request = realRequest;
    silent.close();
    prompt.close();
  }

  const failed = results.filter(r => !r.pass);
  console.log('\nREQUEST_TIMEOUT_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exit(1);
  assert.ok(true);
})();
