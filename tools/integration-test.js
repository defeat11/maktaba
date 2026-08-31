// Comprehensive integration test for maktaba.
//
// Boots the real server on an ephemeral port (MAKTABA_TEST=1 disables the
// auto-scan and ACP_DELEGATE_OPEN=0 prevents any browser/AI side effects),
// then asserts the correct HTTP behaviour for EVERY endpoint, including the
// error paths for a non-existent project id (which must return 4xx, never 500
// and never crash).
//
// The server runs against a THROWAWAY database (MAKTABA_DB/MAKTABA_DB_JSON in
// os.tmpdir()), never the real catalog. It used to run against the live
// db.sqlite, so a test run mutated real rows and POST /api/doctor/scan really
// did launch the user's projects from disk.
//
// Exit 0 only if every assertion passes; otherwise exit 1 with a FAIL list.

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const root = path.join(__dirname, '..');

// Throwaway database for this run; removed on exit.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'maktaba-itest-'));
const TMP_DB = path.join(TMP_DIR, 'db.sqlite');
const TMP_DB_JSON = path.join(TMP_DIR, 'db.json');

function cleanupTmpDb() {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', cleanupTmpDb);
const PORT = String(4800 + Math.floor(Math.random() * 1500));
const BASE = `http://127.0.0.1:${PORT}`;
const NOPE = '__NO_SUCH_PROJECT__';

let child = null;
let stderr = '';
let finished = false;

const TMP_LOGS = path.join(os.tmpdir(), 'maktaba-test-logs-' + process.pid);
try { fs.mkdirSync(TMP_LOGS, { recursive: true }); } catch (e) { /* reused across runs is fine */ }

function startServer() {
  child = spawn('node', ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT,
      MAKTABA_TEST: '1',
      ACP_DELEGATE_OPEN: '0',
      MAKTABA_DB: TMP_DB,
      MAKTABA_DB_JSON: TMP_DB_JSON,
      // Proving the Host guard rejects evil.example.com must not leave 32
      // ERROR lines in the fleet's real log, where truth-check then reports
      // them as a health problem.
      MAKTABA_LOGS_DIR: TMP_LOGS
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('close', (code) => {
    if (!finished) {
      console.log(`\nFAIL: server exited early (code ${code}).`);
      if (stderr.trim()) console.log('--- server stderr ---\n' + stderr.slice(-2000));
      process.exit(1);
    }
  });
}

function request(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    const req = http.request(BASE + p, { method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.on('error', (e) => resolve({ status: 0, body: 'CONNERR ' + e.message }));
    if (data) req.write(data);
    req.end();
  });
}

// Issues a request with an arbitrary Host header, to exercise the
// DNS-rebinding guard. http.request needs an explicit host/port here because
// setting Host by hand must not change where the socket actually goes.
function requestWithHost(p, hostHeader) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: Number(PORT), path: p, method: 'GET', headers: { Host: hostHeader } },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: 'CONNERR ' + e.message }));
    req.end();
  });
}

function waitReady(timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      const r = await request('GET', '/api/health');
      if (r.status === 200) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout waiting for server ready'));
      setTimeout(tick, 300);
    };
    tick();
  });
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
}

async function expectStatus(method, p, body, allowed, label) {
  const r = await request(method, p, body);
  const ok = allowed.includes(r.status) && r.status !== 500 && r.status !== 0;
  check(label || `${method} ${p}`, ok, `got ${r.status} (allowed ${allowed.join('/')})` + (ok ? '' : ' BODY: ' + String(r.body).slice(0, 160)));
  return r;
}

async function expect4xx(method, p, body) {
  const r = await request(method, p, body);
  const ok = r.status >= 400 && r.status < 500; // must be a clean client error, not a 500/crash
  check(`${method} ${p} (bad id -> 4xx)`, ok, `got ${r.status}` + (ok ? '' : ' BODY: ' + String(r.body).slice(0, 160)));
  return r;
}

async function run() {
  startServer();
  await waitReady();

  // Grab a real project id for the success-path :id GETs.
  const projRes = await request('GET', '/api/projects');
  let sampleId = null;
  try {
    const arr = JSON.parse(projRes.body);
    if (Array.isArray(arr) && arr.length) sampleId = arr[0].id;
  } catch (_) {}
  console.log(`Server ready on ${PORT}. sampleId=${sampleId || '(none)'}\n`);

  // ---- Success-path GET endpoints (must be 200) ----
  const getOk = [
    '/', '/api/health', '/api/projects', '/api/projects/export.csv', '/api/overviews/progress',
    '/api/ports/conflicts', '/api/review/queue', '/api/running', '/api/live',
    '/api/autostart/boot', '/api/logs/errors', '/report.html',
    // New error-report endpoints
    '/api/reports/errors',
    // Doctor scan endpoints
    '/api/doctor/scan/progress',
    // Doctor fix-queue endpoints
    '/api/doctor/fix-queue/progress',
    '/api/doctor/alert',
    '/api/processes',
    // Program registry: the detail sheet and the autostart picture
    '/api/profile/progress',
    '/api/processes/badge'
  ];
  for (const p of getOk) await expectStatus('GET', p, null, [200]);

  // /api/health is what the guardian watchdog polls: it must answer with the
  // scan state the guardian needs, and it must never touch disk or db.
  const healthRes = await request('GET', '/api/health');
  let health = null;
  try { health = JSON.parse(healthRes.body); } catch (e) {}
  check('health returns ok:true', !!health && health.ok === true, healthRes.body.slice(0, 120));
  check(
    'health reports scan state for the guardian',
    !!health && !!health.scan && typeof health.scan.running === 'boolean' && typeof health.scan.ageMs === 'number',
    healthRes.body.slice(0, 120)
  );

  // DNS-rebinding guard: a loopback Host is served, anything else is refused.
  const goodHost = await requestWithHost('/api/health', '127.0.0.1:' + PORT);
  check('loopback Host accepted', goodHost.status === 200, 'status ' + goodHost.status);
  const badHost = await requestWithHost('/api/health', 'evil.example.com');
  check('non-loopback Host rejected with 403', badHost.status === 403, 'status ' + badHost.status);

  if (sampleId) {
    await expectStatus('GET', `/api/projects/${sampleId}/logs`, null, [200]);
    await expectStatus('GET', `/api/projects/${sampleId}/status`, null, [200]);
    await expectStatus('GET', `/api/projects/${sampleId}/launch-info`, null, [200]);
  }

  // ---- Report generation (must be 200) ----
  await expectStatus('POST', '/api/reports/errors/generate', {}, [200]);
  await expectStatus('GET', '/api/reports/errors/download', null, [200]);

  // ---- Idempotent / safe POSTs ----
  await expectStatus('POST', '/api/overviews/stop', null, [200]);
  await expectStatus('POST', '/api/doctor/scan/stop', null, [200]);
  await expectStatus('POST', '/api/doctor/scan', null, [200]);
  await expectStatus('POST', '/api/doctor/fix-queue/stop', null, [200]);
  await expectStatus('POST', '/api/doctor/fix-queue/start', null, [200]);
  await expectStatus('POST', `/api/projects/${NOPE}/stop`, null, [200, 404]); // stop is lenient

  // ---- Error-path: nonexistent id MUST return 4xx (never 500/crash) ----
  await expect4xx('POST', `/api/projects/${NOPE}/doctor-reset`, {});
  await expect4xx('POST', `/api/projects/${NOPE}/classify`, { value: 'project' });
  await expect4xx('POST', `/api/projects/${NOPE}/port`, { port: 9999 });
  await expect4xx('POST', `/api/projects/${NOPE}/favorite`, { favorite: true });
  await expect4xx('POST', `/api/projects/${NOPE}/autostart`, { autoStart: true });
  await expect4xx('POST', `/api/projects/${NOPE}/exclude-autofix`, { excluded: true });
  await expect4xx('POST', `/api/projects/${NOPE}/run-command`, { command: 'echo hi' });
  await expect4xx('POST', `/api/projects/${NOPE}/analyze`, {});
  await expect4xx('POST', `/api/projects/${NOPE}/healthcheck`, {});
  await expect4xx('POST', `/api/projects/${NOPE}/healthfix`, {});
  await expect4xx('POST', `/api/projects/${NOPE}/backup-decision`, { decision: 'keep' });
  await expect4xx('POST', `/api/projects/${NOPE}/ai-judge`, {});
  await expect4xx('POST', `/api/projects/${NOPE}/overview`, {});
  await expect4xx('POST', `/api/projects/${NOPE}/fix`, {});
  await expect4xx('POST', `/api/projects/${NOPE}/deep`, {});
  await expect4xx('POST', `/api/projects/${NOPE}/open`, {});
  await expect4xx('POST', `/api/projects/${NOPE}/open-editor`, {});
  await expect4xx('POST', `/api/projects/${NOPE}/run`, {});
  await expect4xx('GET', `/api/projects/${NOPE}/launch-info`, null);
  await expect4xx('POST', `/api/projects/${NOPE}/classify`, { value: 'INVALID_VALUE' }); // 400 validation

  // ---- Unknown route -> 404 ----
  await expectStatus('GET', '/api/__does_not_exist__', null, [404]);

  // ---- Report summary should now reflect captured errors without crashing ----
  const rep = await request('GET', '/api/reports/errors');
  let repOk = false;
  try { const j = JSON.parse(rep.body); repOk = typeof j.total === 'number' && Array.isArray(j.groups); } catch (_) {}
  check('GET /api/reports/errors returns valid summary shape', repOk, repOk ? '' : 'BODY: ' + String(rep.body).slice(0, 160));

  // ---- Summary ----
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log(`INTEGRATION: ${passed}/${results.length} passed`);
  if (failed.length) {
    console.log('\nFAILURES:');
    for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
  }
  if (stderr.trim()) {
    // Surface any server-side errors logged to stderr during the run.
    console.log('\n--- server stderr (last 800) ---\n' + stderr.slice(-800));
  }

  finished = true;
  cleanup(() => process.exit(failed.length ? 1 : 0));
}

function cleanup(cb) {
  if (!child) return cb();
  try { child.kill(); } catch (_) {}
  const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  killer.on('error', () => {});
  let done = false;
  const finish = () => { if (!done) { done = true; cb(); } };
  killer.on('close', finish);
  killer.on('error', finish);
  setTimeout(finish, 2500);
}

process.on('unhandledRejection', (e) => {
  console.log('FAIL: unhandledRejection in test: ' + (e && e.message));
  finished = true;
  cleanup(() => process.exit(1));
});

run().catch((e) => {
  console.log('FAIL: ' + e.message);
  if (stderr.trim()) console.log('--- server stderr ---\n' + stderr.slice(-1500));
  finished = true;
  cleanup(() => process.exit(1));
});
