// The autostart registry filters out Windows's own tasks and services so that
// what remains describes THIS machine's setup. That filter was broken for
// months and nothing noticed, because a filter that stops filtering still
// returns a perfectly plausible list.
//
// It was written inline in a template literal with four backslashes, which
// JavaScript collapsed to two before PowerShell ever saw it. TaskPath contains
// single backslashes and a -like pattern does not treat backslash as an escape,
// so the pattern matched nothing and excluded nothing.
//
// Measured before the fix: 300 entries, 186 of them scheduled tasks — every
// task on the machine, 161 belonging to Windows — and 175 reported as
// "unknown to Maktaba". After: 78 entries, 25 tasks, 23 unknown.
//
// The output alone cannot tell you the filter is dead, so these assertions
// check the pattern itself and the matching behaviour it is supposed to have.

const assert = require('node:assert');
const registry = require('../../lib/systemRegistry');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail && !pass ? '   [' + detail + ']' : ''));
}

const BS = String.fromCharCode(92);

/**
 * Emulates PowerShell's -like operator closely enough to test these patterns.
 *
 * Only * and ? are wildcards. Backslash is an ordinary character — that is the
 * whole point of this file.
 *
 * @param {string} value The string being tested
 * @param {string} pattern A PowerShell -like pattern
 * @returns {boolean}
 */
function psLike(value, pattern) {
  let rx = '';
  for (const ch of pattern) {
    if (ch === '*') rx += '[\\s\\S]*';
    else if (ch === '?') rx += '[\\s\\S]';
    else rx += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + rx + '$', 'i').test(value);
}

// --- the patterns themselves ------------------------------------------------
const task = registry.VENDOR_TASK_PATTERN;
const service = registry.VENDOR_SERVICE_PATTERN;

check('the task pattern is exported', typeof task === 'string' && task.length > 0);
check('the service pattern is exported', typeof service === 'string' && service.length > 0);

// The exact defect: a doubled backslash. It cannot match a path that has single
// ones, and it is invisible in the output.
check('the task pattern has no doubled backslash', task.indexOf(BS + BS) === -1, JSON.stringify(task));
check('the service pattern has no doubled backslash', service.indexOf(BS + BS) === -1, JSON.stringify(service));
check('the task pattern has exactly two backslashes', task.split(BS).length - 1 === 2, JSON.stringify(task));
check('the service pattern has exactly two backslashes', service.split(BS).length - 1 === 2, JSON.stringify(service));

// --- what the filter must exclude -------------------------------------------
// These are real TaskPath values from this machine.
const WINDOWS_TASKS = [
  BS + 'Microsoft' + BS + 'Windows' + BS + 'UpdateOrchestrator' + BS,
  BS + 'Microsoft' + BS + 'Windows' + BS + 'Defrag' + BS,
  BS + 'Microsoft' + BS + 'Office' + BS
];
for (const p of WINDOWS_TASKS) {
  check('a Windows task is excluded: ' + p, psLike(p, task) === true, JSON.stringify(p));
}

// --- what it must keep ------------------------------------------------------
// Maktaba's own tasks live at the root, and so do the user's.
const MINE = [BS, BS + 'MyTools' + BS];
for (const p of MINE) {
  check('a non-Microsoft task path is kept: ' + JSON.stringify(p), psLike(p, task) === false);
}

// --- services ---------------------------------------------------------------
const WINDOWS_SERVICES = [
  'C:' + BS + 'Windows' + BS + 'system32' + BS + 'svchost.exe -k netsvcs',
  '"C:' + BS + 'Windows' + BS + 'System32' + BS + 'SearchIndexer.exe"'
];
for (const p of WINDOWS_SERVICES) {
  check('a Windows service is excluded', psLike(p, service) === true, p);
}

const MY_SERVICES = [
  '"C:' + BS + 'Program Files' + BS + 'Docker' + BS + 'Docker' + BS + 'com.docker.service"',
  'C:' + BS + 'projects' + BS + 'maktaba' + BS + 'node.exe'
];
for (const p of MY_SERVICES) {
  check('a non-Windows service is kept', psLike(p, service) === false, p);
}

// --- the regression this file exists to prevent -----------------------------
// If someone re-introduces the doubled form, every one of these must fail.
const BROKEN = BS + BS + 'Microsoft' + BS + BS + '*';
check('the doubled form would match nothing (proving the bug was real)',
  WINDOWS_TASKS.every(p => psLike(p, BROKEN) === false));

const failed = results.filter(r => !r.pass);
console.log('\nSYSTEM_REGISTRY_FILTER_TEST: ' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
assert.ok(true);
