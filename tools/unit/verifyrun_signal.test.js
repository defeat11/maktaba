// The health check decides which projects an AI agent is sent to rewrite, so
// the difference between "this server came up" and "this project crashed" has
// to be exact.
//
// The regression this guards against: the success test used to be
// /:\d{4,5}\b/ over the raw output, and a Node crash dump opens with
// `node:internal/modules/cjs/loader:1459`. That four-digit LINE NUMBER was read
// as a PORT, so a project that could not start at all reported itself healthy —
// which is a large part of why the repair queue never found any work to do.

const assert = require('node:assert');
const { hasServerBanner, isStackNoise } = require('../verifyRun');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

// --- crash output must never read as success -------------------------------

const nodeCrash = [
  'node:internal/modules/cjs/loader:1459',
  '  throw err;',
  '  ^',
  '',
  "Error: Cannot find module './config'",
  'Require stack:',
  '- C:\\proj\\index.js',
  '    at Module._resolveFilename (node:internal/modules/cjs/loader:1456:15)',
  '    at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)'
].join('\n');
check('a Node crash dump is not a success signal', hasServerBanner(nodeCrash) === false);

const syntaxErr = [
  'C:\\proj\\server.js:2048',
  'const x = ;',
  '          ^',
  'SyntaxError: Unexpected token',
  '    at wrapSafe (node:internal/modules/cjs/loader:1234:18)'
].join('\n');
check('a syntax error with a 4-digit line is not a success signal', hasServerBanner(syntaxErr) === false);

const pyTrace = [
  'Traceback (most recent call last):',
  '  File "app.py", line 1421, in <module>',
  '    main()',
  'ModuleNotFoundError: No module named requests'
].join('\n');
check('a Python traceback is not a success signal', hasServerBanner(pyTrace) === false);

check('empty output is not a success signal', hasServerBanner('') === false);
check('null output is handled', hasServerBanner(null) === false);

// --- real server banners must still be recognised --------------------------

const banners = [
  ['express', 'Server listening on port 4500'],
  ['vite', '  ➜  Local:   http://localhost:5173/'],
  ['next', '- ready started server on 0.0.0.0:3000, url: http://localhost:3000'],
  ['generic url', 'App running at http://127.0.0.1:8080'],
  ['bare listening', 'listening'],
  ['port word', 'Started. port: 9090'],
  ['port equals', 'boot ok port=5173'],
  ['running on', 'Server running on 4000'],
  ['flask', ' * Running on http://127.0.0.1:5000']
];
for (const [name, line] of banners) {
  check('recognises a real ' + name + ' banner', hasServerBanner(line) === true, line);
}

// --- a banner buried in otherwise noisy output still counts ----------------

check('finds a banner among stack noise',
  hasServerBanner(nodeCrash + '\nlistening on port 3000\n') === true);

// --- the noise classifier itself -------------------------------------------

check('stack frame is noise', isStackNoise('    at Module._load (node:internal/modules/cjs/loader:1242:25)') === true);
check('file:line is noise', isStackNoise('C:\\proj\\server.js:2048') === true);
check('a plain banner is not noise', isStackNoise('Server listening on port 4500') === false);

// --- launcher-side failure vs a genuine project fault -----------------------
//
// This is what decides which projects an AI agent gets aimed at. In a real scan
// 6 of 8 "broken" verdicts turned out to be Maktaba mis-running the project
// rather than the project being broken — Python projects carrying a small
// package.json were typed as Node and run with npm. The samples below are the
// actual output captured from those runs.

const { isLauncherSideFailure } = require('../verifyRun');

// npm was handed a script the project does not define (agent-source).
check('npm missing-script is a launcher-side failure',
  isLauncherSideFailure('npm error Missing script: "start"\nnpm error') === true);

// python was handed a file that is not there (photo, Project_For_CV).
check('python missing entry file is a launcher-side failure',
  isLauncherSideFailure("python: can't open file 'C:\\proj\\app.py': [Errno 2] No such file or directory") === true);

// The entry module itself could not be resolved — EMPTY require stack.
check('an unresolvable entry module is a launcher-side failure',
  isLauncherSideFailure("Error: Cannot find module './main'\n  code: 'MODULE_NOT_FOUND',\n  requireStack: []\n") === true);

// The project's OWN code required something missing — NON-EMPTY require stack.
// That is a real fault and must stay 'broken'.
check('a dependency missing from project code is NOT launcher-side',
  isLauncherSideFailure("Error: Cannot find module 'express'\nRequire stack:\n- C:\\proj\\index.js\n  code: 'MODULE_NOT_FOUND',\n  requireStack: [ 'C:\\proj\\index.js' ]\n") === false);

// A Python import error raised from inside the project is a real fault too.
check('a python ModuleNotFoundError from project code is NOT launcher-side',
  isLauncherSideFailure("Traceback (most recent call last):\n  File \"modem_analyzer.py\", line 38\n    from playwright.sync_api import sync_playwright\nModuleNotFoundError: No module named 'playwright'") === false);

// Browser code handed to node — our mistake about how to start it, not a fault
// in the project. This is the real output from kitchen-app.
check('browser code run under node is a launcher-side failure',
  isLauncherSideFailure("ReferenceError: document is not defined\n    at Object.<anonymous> (C:\\proj\\app.js:9:23)") === true);
check('a window reference under node is launcher-side',
  isLauncherSideFailure("ReferenceError: window is not defined") === true);

// A toolchain the machine does not have. Real output from label-tool.
check('a missing toolchain is a launcher-side failure',
  isLauncherSideFailure("ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.") === true);
check('an unrecognised command is launcher-side',
  isLauncherSideFailure("'gradle' is not recognized as an internal or external command,") === true);
check('a POSIX command-not-found is launcher-side',
  isLauncherSideFailure("bash: poetry: command not found") === true);

check('an ordinary crash is NOT launcher-side',
  isLauncherSideFailure("TypeError: x is not a function\n    at run (index.js:12:3)") === false);
// A dependency the project declares but has not installed is still ITS problem.
check('a missing project dependency is NOT launcher-side',
  isLauncherSideFailure("ModuleNotFoundError: No module named 'playwright'") === false);
check('an unrelated ReferenceError is NOT launcher-side',
  isLauncherSideFailure("ReferenceError: myHelper is not defined\n    at run (index.js:5:1)") === false);

check('empty output is not treated as launcher-side', isLauncherSideFailure('') === false);
check('null output is handled by the launcher check', isLauncherSideFailure(null) === false);

const failed = results.filter(r => !r.pass);
console.log('\nVERIFYRUN_SIGNAL_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
assert.ok(true);
