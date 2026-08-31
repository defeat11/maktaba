// A ledger of every restore point Maktaba has taken, and a way to notice the
// ones it never gave back.
//
// snapshotGuard stashes uncommitted work before an AI agent is allowed to write
// to a project, and fixer.js is supposed to apply that stash back afterwards.
// There is exactly one call site for that (fixer.js:155), inside the child
// process exit path — so any run that does not reach it leaves the user's work
// sitting in a stash with nothing anywhere that says so.
//
// Measured on this machine: three maktaba-autofix stashes, taken 2026-08-26,
// none of them returned. Two held only .acp-sessions tool files, but the third
// held a real two-line edit to webui-user.bat that was no longer in the
// working tree. Searching the whole codebase for "stash" outside snapshotGuard
// and fixer returned nothing: no route, no page, no report. The work was not
// lost, but nothing could have told you where it was.
//
// Two rules here, both deliberate:
//   * apply, never pop or drop — a restore point is not consumed by using it
//   * refuse to apply onto a dirty tree — that turns a recovery into a merge
//     conflict, on top of work the user has since done by hand

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { logInfo, logError, appendBounded } = require('./logger');

const LEDGER_PATH = process.env.MAKTABA_RESTORE_LEDGER
  || path.join(__dirname, '..', 'logs', 'restore-points.jsonl');

// Files that are Maktaba's own leavings or ordinary build noise. A stash made
// entirely of these is worth reporting, but it is not the user's work and
// should not raise the same alarm — the classification is what makes the alarm
// mean something when it does fire.
const TOOLING_PATTERNS = [
  /^\.acp-sessions\//,
  /^\.acp-/,
  /^node_modules\//,
  /\.log$/i,
  /^logs?\//,
  /^\.venv\//,
  /^__pycache__\//,
  /^dist\//,
  /^build\//
];

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000
  }).trim();
}

function gitSafe(args, cwd) {
  try { return git(args, cwd); } catch (err) { return null; }
}

/**
 * Writes one entry to the ledger.
 *
 * Failing to write a ledger line must never fail the snapshot it describes —
 * a missing record is a reporting gap, a failed snapshot is lost work.
 *
 * @param {Object} entry What was taken, where, and how to get it back
 */
function record(entry) {
  try {
    appendBounded(LEDGER_PATH,
      JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n',
      5 * 1024 * 1024, 5000);
  } catch (err) {
    logError('restore-points', err);
  }
}

/**
 * Every ledger entry, newest first.
 *
 * @param {number} [limit] How many to return
 * @returns {Array<Object>}
 */
function list(limit) {
  try {
    if (!fs.existsSync(LEDGER_PATH)) return [];
    const rows = [];
    for (const line of fs.readFileSync(LEDGER_PATH, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch (e) { /* skip a torn line */ }
    }
    rows.reverse();
    return limit ? rows.slice(0, limit) : rows;
  } catch (err) {
    logError('restore-points', err);
    return [];
  }
}

/**
 * Describes what is actually inside a stash.
 *
 * `git stash show` alone is not enough: it reports tracked changes only, and
 * `stash push -u` puts untracked files in a third parent that it never
 * mentions. Both of the empty-looking stashes on this machine held 25 and 3
 * untracked files respectively — reading only the tracked side would have
 * reported them as holding nothing.
 *
 * @param {string} projectPath Repository path
 * @param {string} sha The stash commit
 * @returns {{tracked: Array<string>, untracked: Array<string>, toolingOnly: boolean, holdsRealWork: boolean}}
 */
function inspectStash(projectPath, sha) {
  const tracked = (gitSafe(['stash', 'show', '--name-only', sha], projectPath) || '')
    .split('\n').map(s => s.trim()).filter(Boolean);

  // The untracked half lives in the third parent, which only exists for -u.
  const rawUntracked = gitSafe(['show', '--pretty=format:', '--name-only', sha + '^3'], projectPath);
  const untracked = (rawUntracked || '').split('\n').map(s => s.trim()).filter(Boolean);

  const all = tracked.concat(untracked);
  const toolingOnly = all.length > 0 && all.every(f => TOOLING_PATTERNS.some(rx => rx.test(f)));

  return {
    tracked,
    untracked,
    toolingOnly,
    // A tracked change is an edit the user made to a file the project follows.
    // That is the case worth interrupting someone for.
    holdsRealWork: tracked.length > 0 || (untracked.length > 0 && !toolingOnly)
  };
}

/**
 * Finds every Maktaba stash still sitting in a project, and says whether the
 * work it holds is back in the working tree or only in the stash.
 *
 * @param {Array<Object>} projects Catalogue rows
 * @returns {{checked: number, pending: Array<Object>, returned: number}}
 */
function reconcile(projects) {
  const ledger = list();
  const returnedShas = new Set(ledger.filter(e => e.event === 'returned').map(e => e.handle));

  const pending = [];
  let checked = 0;

  for (const project of (projects || [])) {
    if (!project || !project.path || project.missing) continue;
    if (!fs.existsSync(path.join(project.path, '.git'))) continue;

    const listing = gitSafe(['stash', 'list', '--format=%H%x09%gd%x09%gs'], project.path);
    if (listing === null) continue;
    checked++;
    if (!listing) continue;

    for (const line of listing.split('\n')) {
      const [sha, ref, subject] = line.split('\t');
      if (!sha || !subject) continue;
      // Only stashes Maktaba made. A stash the user created themselves is
      // theirs, and offering to "return" it would be Maktaba claiming work it
      // never touched.
      if (!/maktaba-autofix-/.test(subject)) continue;

      const contents = inspectStash(project.path, sha);
      const dirty = (gitSafe(['status', '--porcelain'], project.path) || '').length > 0;

      pending.push({
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        sha,
        ref,
        label: subject.replace(/^.*?(maktaba-autofix-[\d-]+).*$/, '$1'),
        alreadyReturned: returnedShas.has(sha),
        workingTreeDirty: dirty,
        trackedCount: contents.tracked.length,
        untrackedCount: contents.untracked.length,
        toolingOnly: contents.toolingOnly,
        holdsRealWork: contents.holdsRealWork,
        sample: contents.tracked.concat(contents.untracked).slice(0, 6),
        // Applying onto a dirty tree turns a recovery into a merge conflict on
        // top of work done since, so it is refused rather than attempted.
        canReturn: !dirty,
        hint: 'git -C "' + project.path + '" stash apply ' + sha
      });
    }
  }

  return { checked, pending, returned: returnedShas.size };
}

/**
 * Puts one stash back into its project.
 *
 * @param {string} projectPath Repository path
 * @param {string} sha The stash commit to apply
 * @returns {{ok: boolean, error: string|null, hint: string}}
 */
function returnWork(projectPath, sha) {
  const hint = 'git -C "' + projectPath + '" stash apply ' + sha;

  if (!projectPath || !fs.existsSync(projectPath)) {
    return { ok: false, error: 'مسار المشروع غير موجود.', hint };
  }
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha || ''))) {
    // The sha goes to git as an argument; refusing anything that is not a sha
    // keeps it from being anything else.
    return { ok: false, error: 'معرّف نقطة الاسترجاع غير صالح.', hint };
  }
  if (gitSafe(['cat-file', '-e', sha], projectPath) === null) {
    return { ok: false, error: 'نقطة الاسترجاع لم تعد موجودة في هذا المستودع.', hint };
  }

  const dirty = (gitSafe(['status', '--porcelain'], projectPath) || '').length > 0;
  if (dirty) {
    return {
      ok: false,
      error: 'الشجرة فيها تعديلات غير محفوظة. الإرجاع الآن يصنع تعارض دمج فوق شغلك الحالي — احفظ أو التزم أولاً.',
      hint
    };
  }

  try {
    // apply, never pop: the stash survives, so a bad outcome is still undoable.
    git(['stash', 'apply', sha], projectPath);
    record({ event: 'returned', projectPath, handle: sha, kind: 'git-stash' });
    logInfo('restore-points', 'Returned stashed work in ' + projectPath + ' from ' + sha.slice(0, 8) + '.');
    return { ok: true, error: null, hint };
  } catch (err) {
    logError('restore-points', err);
    return {
      ok: false,
      error: 'تعذّر الإرجاع: ' + String(err.message).slice(0, 200) + ' — الـstash ما زال محفوظاً.',
      hint
    };
  }
}

module.exports = { record, list, reconcile, returnWork, inspectStash, TOOLING_PATTERNS };
