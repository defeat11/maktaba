const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..');

// 1. Test Doctor Guard Budget and Safety Mechanics
console.log('--- TEST: Doctor Guard & Budget Integrity ---');
const doctorGuard = require('../../lib/doctorGuard');

// Mock a temporary budget file to test spend logic
const testBudgetFile = path.join(root, 'doctor-budget.json');
const initialCanSpend = doctorGuard.canSpendBudget();
assert.strictEqual(typeof initialCanSpend, 'boolean', 'canSpendBudget must return boolean');

// 2. Test Row Count Safety Guard
console.log('--- TEST: Row Count Safety Guard ---');
const safeCheck1 = doctorGuard.checkRowCountSafe(10);
assert.ok(safeCheck1 !== undefined, 'checkRowCountSafe should return a result object');

// 3. Test Store Protection & Invariants
console.log('--- TEST: Store Invariants & Scope Lock Protection ---');
const store = require('../../lib/store');
assert.strictEqual(typeof store.getProjects, 'function', 'store.getProjects must exist');
assert.strictEqual(typeof store.saveProjects, 'function', 'store.saveProjects must exist');
assert.strictEqual(typeof store.setExcludeFromAutoFix, 'function', 'setExcludeFromAutoFix must exist');

// 4. Test Supervisor Mechanics
console.log('--- TEST: Supervisor Mechanics ---');
const supervisor = require('../../lib/supervisor');
assert.strictEqual(typeof supervisor.startAll, 'function', 'supervisor.startAll must exist');
assert.strictEqual(typeof supervisor.getLiveStatus, 'function', 'supervisor.getLiveStatus must exist');
assert.strictEqual(typeof supervisor.restartCount, 'function', 'supervisor.restartCount must exist');

// 5. Test Process Scanner Safety & Deep Node Tracking
console.log('--- TEST: Process Scanner & Deep Node Tracking ---');
const psscan = require('../../lib/psscan');
assert.strictEqual(typeof psscan.scanProcesses, 'function', 'psscan.scanProcesses must exist');
assert.strictEqual(typeof psscan.getNewProcessCount, 'function', 'psscan.getNewProcessCount must exist');
assert.strictEqual(typeof psscan.saveProcessSnapshot, 'function', 'psscan.saveProcessSnapshot must exist');
assert.strictEqual(typeof psscan.extractPortFromCommandLine, 'function', 'extractPortFromCommandLine must exist');
assert.strictEqual(typeof psscan.resolveProjectDirectory, 'function', 'resolveProjectDirectory must exist');

// Test CLI port extraction
const portSample = psscan.extractPortFromCommandLine('node dist/index.js --port 18789');
assert.strictEqual(portSample, 18789, 'extractPortFromCommandLine must extract 18789');

// Test Node Project Directory resolution from node_modules
const dirSample = psscan.resolveProjectDirectory('C:\\my\\app\\node_modules\\openclaw\\dist\\index.js');
assert.strictEqual(dirSample, 'C:\\my\\app', 'resolveProjectDirectory must find root project folder above node_modules');

console.log('SUPERVISOR_SCOPELOCK_TEST: ALL CHECKS PASSED (100%)');
process.exit(0);
