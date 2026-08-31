// One switch that means "do not launch this program".
//
// Maktaba launches the user's programs by itself. The doctor scan runs every
// six hours and is the only automated task that actually STARTS things, and 53
// of 145 projects have never been started by it — so the first time it reaches
// one is unattended, at whatever hour the timer fires.
//
// That has gone wrong before. lib/profiler.js carries the note: a watchdog
// launched by a scan killed the server mid-cycle. And nothing could have
// stopped it, because no single switch existed:
//
//   excludeFromAutoFix  governs AI writes, not launching
//   scan-cursor skip     arms itself only after two timeouts have happened
//   autoStart            answers a different question (start at logon)
//
// So this is the one flag every launch path consults. It carries a reason
// because a block with no explanation reads as a bug six months later.
//
// It is set BY A PERSON. The automatic suggestion below returns evidence for
// someone to act on and never applies itself: quarantining a project the user
// wanted running is the same class of failure as running one they did not.

const { logInfo } = require('./logger');

/**
 * Whether this project must not be launched.
 *
 * Accepts a row from either store (sqlite gives 0/1, the JSON mirror gives a
 * boolean), so callers never have to know which one they are holding.
 *
 * @param {Object} project Catalogue row
 * @returns {boolean}
 */
function isQuarantined(project) {
  if (!project) return false;
  return project.quarantine === true || project.quarantine === 1;
}

/**
 * The refusal, in the form every launch path can return.
 *
 * @param {Object} project Catalogue row
 * @returns {{blocked: boolean, reason: string|null, since: string|null}}
 */
function launchBlock(project) {
  if (!isQuarantined(project)) return { blocked: false, reason: null, since: null };
  return {
    blocked: true,
    reason: project.quarantineReason || 'هذا المشروع محجور — التشغيل ممنوع حتى ترفع الحجر.',
    since: project.quarantineAt || null
  };
}

/**
 * Filters a launch list down to what is allowed to run, and says what it dropped.
 *
 * @param {Array<Object>} projects Candidates
 * @returns {{allowed: Array<Object>, blocked: Array<Object>}}
 */
function filterLaunchable(projects) {
  const allowed = [];
  const blocked = [];
  for (const p of (projects || [])) {
    if (isQuarantined(p)) blocked.push(p);
    else allowed.push(p);
  }
  if (blocked.length) {
    logInfo('quarantine', 'Skipped ' + blocked.length + ' quarantined project(s): ' +
      blocked.map(p => p.name).slice(0, 8).join(', '));
  }
  return { allowed, blocked };
}

// Every guardian and supervisor in this repository, by filename.
//
// A hand-written regex covered three of them and missed master-supervisor.js
// and run-guardian-hidden.vbs — both real, both in tools/. Adopting a guardian
// means being allowed to kill it, and killing one is what dropped the server
// before, so the list lives in one place and is checked against tools/ by a
// test rather than remembered.
const GUARDIAN_FILES = [
  'super-guardian.mjs',
  'stack-guardian.mjs',
  'maktaba-guardian.ps1',
  'master-supervisor.js',
  'run-guardian-hidden.vbs',
  'run-audit-hidden.vbs',
  'start-maktaba-hidden.vbs'
];

/**
 * Whether a command line belongs to something that watches or restarts others.
 *
 * @param {string} commandLine The process command line
 * @returns {boolean}
 */
function isGuardianCommand(commandLine) {
  const text = String(commandLine || '').toLowerCase();
  if (!text) return false;
  if (GUARDIAN_FILES.some(f => text.indexOf(f.toLowerCase()) !== -1)) return true;
  // A catch-all for names not yet on the list: anything calling itself a
  // guardian, watchdog or supervisor is not something to kill by accident.
  return /guardian|watchdog|supervisor/.test(text);
}

/**
 * Sets or lifts the quarantine on a project.
 *
 * @param {string} projectId Project id
 * @param {boolean} on Whether to quarantine
 * @param {string} [reason] Why, shown wherever the block is reported
 * @returns {Promise<Object>} The updated row, plus what it was before
 */
async function setQuarantine(projectId, on, reason) {
  const store = require('./store');
  const projects = await store.getProjects();
  const project = projects.find(p => p.id === projectId);
  if (!project) return { ok: false, error: 'المشروع غير موجود.' };

  const before = {
    quarantine: isQuarantined(project),
    quarantineReason: project.quarantineReason || null,
    quarantineAt: project.quarantineAt || null
  };

  project.quarantine = !!on;
  project.quarantineReason = on ? (reason || 'حُجر يدوياً.') : null;
  project.quarantineAt = on ? new Date().toISOString() : null;

  await store.saveProjects(projects);
  logInfo('quarantine', (on ? 'Quarantined ' : 'Released ') + project.name);

  return {
    ok: true,
    project,
    before,
    after: {
      quarantine: project.quarantine,
      quarantineReason: project.quarantineReason,
      quarantineAt: project.quarantineAt
    }
  };
}

/**
 * Programs whose measured profile says they can disturb the rest of the machine.
 *
 * Returned as a SUGGESTION with its evidence attached, never applied. The
 * profiler's risk flags are measured from the code on disk, but "this file
 * calls taskkill" is not the same statement as "this program should never run"
 * — only the person who wrote it can make that one.
 *
 * @param {Array<Object>} projects Catalogue rows
 * @returns {Array<Object>} Candidates with the evidence behind each
 */
function suggestions(projects) {
  const out = [];
  for (const project of (projects || [])) {
    if (!project || project.missing || isQuarantined(project)) continue;

    let profile = null;
    try {
      profile = typeof project.profile === 'string' ? JSON.parse(project.profile) : project.profile;
    } catch (err) { continue; }
    if (!profile || !profile.risk) continue;

    // Both flags, not either. A watchdog that restarts things is ordinary; a
    // program that kills processes may be a deliberate tool. The pair together
    // is what killed a doctor scan mid-cycle.
    if (!(profile.risk.isWatchdog && profile.risk.killsProcesses)) continue;

    out.push({
      projectId: project.id,
      projectName: project.name,
      path: project.path,
      evidence: (profile.risk.evidence || []).slice(0, 4),
      why: 'يعمل كحارس ويقتل عمليات — تشغيله دون مراقبة هو ما أوقف فحص الدكتور من قبل'
    });
  }
  return out;
}

module.exports = { isQuarantined, launchBlock, filterLaunchable, setQuarantine, suggestions,
  isGuardianCommand, GUARDIAN_FILES };
