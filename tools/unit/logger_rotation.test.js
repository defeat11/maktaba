// Logs had no ceiling of any kind. Across 65 days of ordinary use error.log
// reached 3.2 MB, error-reports.jsonl 3.0 MB and app.log 1.2 MB, and a 30-second
// supervisor loop produced a 4.5 MB file in under two days. Nothing trimmed any
// of them.
//
// These assertions lock two things that must both hold: the file stays bounded,
// AND the most recent entries survive the trim. A rotation that keeps the file
// small by throwing away the newest lines would be worse than no rotation.

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { appendBounded } = require('../../lib/logger');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'logrot-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

// --- a file kept under its ceiling is left alone ----------------------------
const small = path.join(TMP, 'small.log');
for (let i = 0; i < 50; i++) appendBounded(small, 'line ' + i + '\n', 1024 * 1024, 100);
check('a file under the ceiling is not trimmed',
  fs.readFileSync(small, 'utf8').split('\n').filter(Boolean).length === 50);

// --- a file past its ceiling is trimmed, newest kept ------------------------
const big = path.join(TMP, 'big.log');
const CAP = 64 * 1024;
const KEEP = 100;
const TOTAL = 4000;
for (let i = 0; i < TOTAL; i++) {
  appendBounded(big, 'entry ' + i + ' ' + 'x'.repeat(120) + '\n', CAP, KEEP);
}
const size = fs.statSync(big).size;
const kept = fs.readFileSync(big, 'utf8').split('\n').filter(Boolean);

check('the file is bounded', size <= CAP * 2, size + ' bytes (cap ' + CAP + ')');
// Tail-keeping rotation trims to KEEP lines when the cap is passed, then the
// file grows again until the next trim — so at any moment the count sits
// somewhere between KEEP and what the cap allows. The invariant that matters is
// that it is bounded and far below the total ever written, not an exact count.
const maxLinesCapAllows = Math.ceil((CAP * 2) / 120);
check('trimming actually happened and the count stays bounded',
  kept.length >= KEEP && kept.length <= maxLinesCapAllows && kept.length < TOTAL / 4,
  kept.length + ' lines of ' + TOTAL + ' written (bound ' + maxLinesCapAllows + ')');
check('the NEWEST entry survives',
  kept[kept.length - 1].startsWith('entry ' + (TOTAL - 1) + ' '), kept[kept.length - 1].slice(0, 30));
check('the oldest entries are the ones dropped',
  !kept.some(l => l.startsWith('entry 0 ')));

// entries must stay contiguous — a trim must not cut a line in half
const nums = kept.map(l => parseInt(l.split(' ')[1], 10));
let contiguous = true;
for (let i = 1; i < nums.length; i++) {
  if (nums[i] !== nums[i - 1] + 1) { contiguous = false; break; }
}
check('surviving entries are contiguous and unbroken', contiguous,
  nums.length ? nums[0] + '..' + nums[nums.length - 1] : 'empty');

// --- the error report reads the last 1000 records, so the keep-count matters -
const { KEEP_LINES } = require('../../lib/logger');
check('KEEP_LINES leaves room for the 1000-record error report',
  KEEP_LINES >= 1000, 'KEEP_LINES=' + KEEP_LINES);

// --- a trim must never lose the file entirely -------------------------------
check('the trimmed file is still valid and non-empty', fs.statSync(big).size > 0);

// --- writing to an unwritable path must not throw ---------------------------
let threw = false;
try {
  appendBounded(path.join(TMP, 'no-such-dir', 'x.log'), 'hello\n', 1024, 10);
} catch (e) { threw = true; }
check('a failed write does not throw at the caller', threw === false);

const failed = results.filter(r => !r.pass);
console.log('\nLOGGER_ROTATION_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
assert.ok(true);
