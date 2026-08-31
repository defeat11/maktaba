const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

const root = path.join(__dirname, '..');

// Throwaway database: the smoke check must never touch the real catalog.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'maktaba-smoke-'));
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) {}
});
// Unique port (overridable via SMOKE_PORT) so parallel smoke checks never collide.
const SMOKE_PORT = String(process.env.SMOKE_PORT || (4600 + Math.floor(Math.random() * 2000)));

let child = null;
let stderrData = '';
let cleanedUp = false;
let serverClosed = false;

// Spawn the server with PORT 4599 and MAKTABA_TEST=1
child = spawn('node', ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: SMOKE_PORT,
    MAKTABA_TEST: '1',
    ACP_DELEGATE_OPEN: '0',
    MAKTABA_DB: path.join(TMP_DIR, 'db.sqlite'),
    MAKTABA_DB_JSON: path.join(TMP_DIR, 'db.json')
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

// Capture stderr for failure diagnostics
child.stderr.on('data', (data) => {
  stderrData += data.toString();
});

child.on('close', (code) => {
  serverClosed = true;
});

function cleanup(callback) {
  if (cleanedUp) {
    if (callback) callback();
    return;
  }
  cleanedUp = true;
  if (child) {
    try {
      child.kill();
    } catch (e) {}

    // Kill process tree on Windows using taskkill
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    
    let killerDone = false;
    const finish = () => {
      if (killerDone) return;
      killerDone = true;
      if (callback) callback();
    };
    
    killer.on('close', finish);
    killer.on('error', finish);
  } else {
    if (callback) callback();
  }
}

function getLastErrorLines() {
  const lines = stderrData.split(/\r?\n/).filter(Boolean);
  return lines.slice(-15).join('\n');
}

function fail(reason) {
  console.log(`SMOKE FAIL: ${reason}`);
  const errLines = getLastErrorLines();
  if (errLines) {
    console.log('Last 15 lines of stderr:');
    console.log(errLines);
  }
  cleanup(() => {
    process.exit(1);
  });
}

// Timeout after 20 seconds
const timeoutTimer = setTimeout(() => {
  fail('Timeout reached after 20 seconds without a successful 200 response.');
}, 20000);

let pollInterval = null;

function poll() {
  if (serverClosed) {
    clearTimeout(timeoutTimer);
    clearInterval(pollInterval);
    fail('Server exited early.');
    return;
  }

  const req = http.get(`http://127.0.0.1:${SMOKE_PORT}/api/projects`, (res) => {
    let body = '';
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => {
      if (res.statusCode === 200) {
        clearTimeout(timeoutTimer);
        clearInterval(pollInterval);
        
        let projectCountMessage = '';
        try {
          const json = JSON.parse(body);
          if (Array.isArray(json)) {
            projectCountMessage = ` (projects count: ${json.length})`;
          }
        } catch (e) {
          // Not json or not array
        }

        console.log(`SMOKE OK${projectCountMessage}`);
        cleanup(() => {
          process.exit(0);
        });
      } else {
        // If statusCode is not 200, it's an error. Stop and fail.
        clearTimeout(timeoutTimer);
        clearInterval(pollInterval);
        fail(`Received non-200 status code: ${res.statusCode}`);
      }
    });
  });

  req.on('error', (err) => {
    // During startup, connection errors (like ECONNREFUSED) are ignored until server is ready.
    // However, if we get other errors, we can log them or wait for timeout.
  });

  req.end();
}

// Poll every 300ms
pollInterval = setInterval(poll, 300);
// Run initial poll immediately
poll();
