// A record of every decision Maktaba made about a project, and a way back.
//
// Before this, the only durable record of anything Maktaba did was
// logs/fix-history.jsonl, which covers AI repairs alone. Measured on this
// machine's app.log: 219 lines for starting a project, 10 for stopping one,
// and ZERO for changing a port or setting a classification. Those two simply
// left no trace at all — the value changed, and nothing anywhere said who
// changed it, when, or what it had been.
//
// The rule this file exists to enforce: `undo` carries a payload RECORDED at
// the time of the action, and undoing replays that payload. It never computes
// an inverse at undo time. An inverse worked out later is a guess about a state
// that has since moved on, and applying it can create damage rather than
// remove it — "set it back to whatever it probably was" is how a recovery
// becomes a second incident.
//
// Scope, deliberately: this logs what Maktaba DID to the user's projects. Not
// what it observed on the machine. Windows processes, autostart entries and
// container states are observations, and putting them here would turn a record
// of decisions into a surveillance log of a computer.

const fs = require('fs');
const path = require('path');
const { appendBounded, logInfo, logError } = require('./logger');

const LOG_PATH = process.env.MAKTABA_ACTION_LOG
  || path.join(__dirname, '..', 'logs', 'actions.jsonl');

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_LINES = 5000;

/**
 * Reads every line in the log, newest last.
 *
 * @returns {Array<Object>}
 */
function readAll() {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const rows = [];
    for (const line of fs.readFileSync(LOG_PATH, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch (e) { /* skip a torn line */ }
    }
    return rows;
  } catch (err) {
    logError('action-log', err);
    return [];
  }
}

function nextSeq(rows) {
  let max = 0;
  for (const row of rows) {
    if (typeof row.seq === 'number' && row.seq > max) max = row.seq;
  }
  // Derived from what is still in the file. Rotation drops old lines, so this
  // keeps climbing rather than restarting and colliding with a live entry.
  return max + 1;
}

/**
 * Writes one decision to the log.
 *
 * Never throws: a decision that succeeded must not be reported as failed
 * because its log line could not be written.
 *
 * @param {Object} entry action, projectId, projectName, before, after, undo, by
 * @returns {Object|null} The stored entry, or null when it could not be written
 */
function record(entry) {
  try {
    const rows = readAll();
    const stored = {
      seq: nextSeq(rows),
      ts: new Date().toISOString(),
      action: entry.action,
      projectId: entry.projectId || null,
      projectName: entry.projectName || null,
      before: entry.before === undefined ? null : entry.before,
      after: entry.after === undefined ? null : entry.after,
      // The payload that reverses this, decided NOW while the old value is
      // still known. null means this action has no honest reverse, and
      // undoReason must say why.
      undo: entry.undo || null,
      undoReason: entry.undoReason || null,
      by: entry.by || 'user'
    };
    appendBounded(LOG_PATH, JSON.stringify(stored) + '\n', MAX_BYTES, KEEP_LINES);
    return stored;
  } catch (err) {
    logError('action-log', err);
    return null;
  }
}

/**
 * The decisions taken, newest first, each marked if it has been undone.
 *
 * @param {number} [limit] How many to return
 * @returns {Array<Object>}
 */
function list(limit) {
  const rows = readAll();
  // Undoing appends a line rather than editing one: the log stays append-only,
  // so the history of a reversal is itself part of the history.
  const undone = new Map();
  for (const row of rows) {
    if (row.action === 'undo' && typeof row.targetSeq === 'number') undone.set(row.targetSeq, row);
  }

  const actions = rows
    .filter(r => r.action !== 'undo')
    .map(r => Object.assign({}, r, {
      undone: undone.has(r.seq),
      undoneAt: undone.has(r.seq) ? undone.get(r.seq).ts : null,
      canUndo: Boolean(r.undo) && !undone.has(r.seq)
    }))
    .reverse();

  return limit ? actions.slice(0, limit) : actions;
}

function get(seq) {
  return list().find(r => r.seq === seq) || null;
}

// How each recorded payload is replayed. A payload whose type is not here is
// refused rather than improvised — an undo that guesses is worse than no undo.
const EXECUTORS = {
  /**
   * Puts a project's port back to the recorded value.
   */
  'set-port': async (payload, entry) => {
    const store = require('./store');
    const projects = await store.getProjects();
    const project = projects.find(p => p.id === entry.projectId);
    if (!project) return { ok: false, error: 'المشروع لم يعد موجوداً في الكتالوج.' };

    project.assignedPort = payload.port;
    project.userPortSet = payload.userPortSet === true;
    // The original change propagated to backups, so the reversal must too, or
    // the copies keep a port the primary no longer has.
    for (const p of projects) {
      if (p.backupOf === entry.projectId) p.assignedPort = payload.port;
    }
    await store.saveProjects(projects);
    return { ok: true, detail: 'المنفذ رجع إلى ' + (payload.port === null ? '(بدون منفذ)' : payload.port) };
  },

  /**
   * Puts a manual classification back.
   */
  'set-classification': async (payload, entry) => {
    const store = require('./store');
    await store.setUserClassification(entry.projectId, payload.value === undefined ? null : payload.value);
    return { ok: true, detail: 'التصنيف رجع إلى ' + (payload.value === null ? '(بدون)' : payload.value) };
  },

  /**
   * Puts the autostart flag back.
   */
  'set-autostart': async (payload, entry) => {
    const store = require('./store');
    const projects = await store.getProjects();
    const project = projects.find(p => p.id === entry.projectId);
    if (!project) return { ok: false, error: 'المشروع لم يعد موجوداً في الكتالوج.' };
    project.autoStart = payload.enabled === true;
    await store.saveProjects(projects);
    return { ok: true, detail: 'الإقلاع التلقائي رجع إلى ' + (payload.enabled ? 'مُفعَّل' : 'مُعطَّل') };
  },

  /**
   * Puts a quarantine back the way it was.
   */
  'set-quarantine': async (payload, entry) => {
    const store = require('./store');
    const projects = await store.getProjects();
    const project = projects.find(p => p.id === entry.projectId);
    if (!project) return { ok: false, error: 'المشروع لم يعد موجوداً في الكتالوج.' };
    project.quarantine = payload.enabled === true;
    // The reason and timestamp are restored from the record too, so undoing a
    // release does not leave a held project with no explanation attached.
    project.quarantineReason = payload.enabled ? (payload.reason || 'حُجر يدوياً.') : null;
    project.quarantineAt = payload.enabled ? (payload.at || new Date().toISOString()) : null;
    await store.saveProjects(projects);
    return { ok: true, detail: payload.enabled ? 'رجع الحجر.' : 'رُفع الحجر.' };
  },

  /**
   * Stops a project Maktaba started.
   *
   * This is a true inverse only because Maktaba started it. Stopping something
   * it did not start is a different act, and is not recorded as an undo.
   */
  'stop-project': async (payload, entry) => {
    const runner = require('./runner');
    const state = runner.status(entry.projectId);
    if (!state || state.status !== 'running') {
      return { ok: false, error: 'المشروع ليس قيد التشغيل الآن — لا شيء لإيقافه.' };
    }
    runner.stop(entry.projectId);
    return { ok: true, detail: 'أُوقف المشروع.' };
  }
};

/**
 * Replays the payload recorded when the action was taken.
 *
 * @param {number} seq The action's sequence number
 * @returns {Promise<{ok: boolean, error?: string, detail?: string}>}
 */
async function undo(seq) {
  const n = parseInt(seq, 10);
  if (!Number.isInteger(n)) return { ok: false, error: 'رقم إجراء غير صالح.' };

  const entry = get(n);
  if (!entry) return { ok: false, error: 'لا يوجد إجراء بهذا الرقم.' };
  if (entry.undone) return { ok: false, error: 'هذا الإجراء متراجَع عنه بالفعل.' };
  if (!entry.undo) {
    return { ok: false, error: entry.undoReason || 'هذا الإجراء لا يمكن التراجع عنه.' };
  }

  const run = EXECUTORS[entry.undo.type];
  if (!run) {
    // A payload type this build does not know how to replay. Refusing is the
    // only safe answer: improvising one is exactly the computed inverse this
    // module exists to avoid.
    return { ok: false, error: 'نوع تراجع غير معروف: ' + entry.undo.type };
  }

  let result;
  try {
    result = await run(entry.undo, entry);
  } catch (err) {
    logError('action-log', err);
    return { ok: false, error: 'فشل التراجع: ' + String(err.message).slice(0, 200) };
  }

  if (!result.ok) return result;

  try {
    appendBounded(LOG_PATH, JSON.stringify({
      seq: nextSeq(readAll()),
      ts: new Date().toISOString(),
      action: 'undo',
      targetSeq: n,
      targetAction: entry.action,
      projectId: entry.projectId,
      projectName: entry.projectName,
      detail: result.detail || null,
      by: 'user'
    }) + '\n', MAX_BYTES, KEEP_LINES);
  } catch (err) {
    logError('action-log', err);
  }

  logInfo('action-log', 'Undid #' + n + ' (' + entry.action + ') on ' + (entry.projectName || entry.projectId));
  return result;
}

module.exports = { record, list, get, undo, readAll, EXECUTORS, LOG_PATH };
