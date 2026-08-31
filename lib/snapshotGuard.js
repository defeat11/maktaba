// Takes a restorable snapshot of a project BEFORE an AI agent is allowed to
// write to it, and refuses the write when no snapshot can be taken.
//
// Why this exists: deepDoctor/fixer hand an agent write access to the whole
// project directory, and the prompt explicitly encourages it to run commands
// like `npm install`. The only backup in the codebase was of maktaba's OWN
// catalog database — not a single file of the project being modified. So an
// agent could overwrite uncommitted work in the user's real projects with no
// way back. maktaba isolates AI edits to its own code carefully (standalone
// repo + manual cherry-pick); this gives the user's other projects the same
// courtesy.
//
// Strategy per project:
//   - a git repo with a clean tree  -> record HEAD (restore = git reset --hard)
//   - a git repo with a dirty tree  -> `git stash -u` and record the stash ref
//   - not a git repo                -> zip the folder into backups/
//   - none of the above possible    -> refuse

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { logInfo, logError } = require('./logger');
const restorePoints = require('./restorePoints');

const BACKUPS_DIR = path.join(__dirname, '..', 'backups');
// A zip is only worth taking if the project is a sane size. Anything larger is
// refused rather than silently skipped: 168 MB of project folders on this
// machine have no git history at all, so this path is the common case, not the
// exception, and it must not quietly fill the disk.
const MAX_ZIP_BYTES = 500 * 1024 * 1024;
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
// Directories never worth copying into a snapshot.
const ZIP_EXCLUDES = ['node_modules', '.git', 'venv', '.venv', '__pycache__', 'dist', 'build'];

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function isGitRepo(projectPath) {
  try {
    return git(['rev-parse', '--is-inside-work-tree'], projectPath) === 'true';
  } catch (err) {
    return false;
  }
}

/**
 * True only for a repository that can actually provide a restore point.
 *
 * `git init` with nothing committed yet is a real and common state, and it has
 * no HEAD: rev-parse fails, and `git stash` has nothing to stash against. The
 * guard used to take the git branch on the strength of isGitRepo alone and then
 * report a confusing "git snapshot failed: fatal: ambiguous argument 'HEAD'".
 * Such a repository has to fall through to the archive path like any other
 * folder — which may then refuse it on size, but for the true reason.
 *
 * @param {string} projectPath Path to check
 * @returns {boolean} True when the repository has at least one commit
 */
function hasCommits(projectPath) {
  try {
    git(['rev-parse', '--verify', 'HEAD'], projectPath);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Finds a stash entry by the unique message it was created with.
 * Used to tell "the stash never happened" apart from "the stash happened and
 * then the command failed", which need opposite responses.
 *
 * @param {string} projectPath Repository path
 * @param {string} label The -m message the stash was created with
 * @returns {string|null} The stash commit sha, or null when absent
 */
function findStashByLabel(projectPath, label) {
  try {
    const list = git(['stash', 'list', '--format=%H %gs'], projectPath);
    for (const line of list.split('\n')) {
      const sep = line.indexOf(' ');
      if (sep === -1) continue;
      if (line.slice(sep + 1).includes(label)) return line.slice(0, sep);
    }
  } catch (err) {
    logError('snapshot-guard', err);
  }
  return null;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Measures a directory, stopping early once the cap is exceeded.
 *
 * @param {string} dir Directory to measure
 * @param {number} cap Byte ceiling; measurement stops once passed
 * @returns {number} Total bytes seen (>= cap means "too big")
 */
function directorySize(dir, cap) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ZIP_EXCLUDES.includes(entry.name)) continue;
        stack.push(path.join(current, entry.name));
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(path.join(current, entry.name)).size;
        } catch (err) {
          continue;
        }
        if (total >= cap) return total;
      }
    }
  }
  return total;
}

function freeSpaceBytes(targetPath) {
  try {
    return Number(fs.statfsSync(targetPath).bavail) * Number(fs.statfsSync(targetPath).bsize);
  } catch (err) {
    return Infinity;   // cannot measure: do not block on this alone
  }
}

/**
 * Creates a restore point for a project directory.
 *
 * @param {string} projectPath Absolute path to the project
 * @returns {{ok: boolean, kind: string, handle: string|null, restoreHint: string, reason: string|null}}
 */
function snapshot(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return { ok: false, kind: 'none', handle: null, restoreHint: '', reason: 'project path does not exist' };
  }

  // A repo with no commits cannot give us a HEAD or a stash, so it is treated
  // as an ordinary folder and archived instead.
  if (isGitRepo(projectPath) && hasCommits(projectPath)) {
    try {
      const head = git(['rev-parse', 'HEAD'], projectPath);
      const dirty = git(['status', '--porcelain'], projectPath).length > 0;

      if (!dirty) {
        logInfo('snapshot-guard', `Clean git repo at ${projectPath}; restore point is HEAD ${head.slice(0, 8)}.`);
        return {
          ok: true, kind: 'git-head', handle: head,
          restoreHint: `git -C "${projectPath}" reset --hard ${head}`,
          reason: null
        };
      }

      // `git stash push -u` is not atomic. It can move files out of the working
      // tree and THEN fail — e.g. when it cannot delete an untracked file that
      // another process holds open. Reporting that as "refused, nothing
      // happened" while the user's uncommitted work has silently vanished from
      // their folder is the exact failure this guard exists to prevent, so the
      // stash is tagged with a unique message and looked for either way.
      const stashLabel = `maktaba-autofix-${timestamp()}`;
      let stashRef = null;
      try {
        git(['stash', 'push', '-u', '-m', stashLabel], projectPath);
        stashRef = git(['rev-parse', 'stash@{0}'], projectPath);
      } catch (stashErr) {
        stashRef = findStashByLabel(projectPath, stashLabel);
        if (!stashRef) {
          // Nothing was stashed; the tree is as we found it. Safe to refuse.
          logError('snapshot-guard', stashErr);
          return {
            ok: false, kind: 'git', handle: null, restoreHint: '',
            reason: `git stash failed and nothing was stashed: ${stashErr.message}`
          };
        }

        // A stash exists despite the error, so the tree HAS been modified.
        // Put it back before refusing, so "refused" really means untouched.
        logError('snapshot-guard', new Error(
          `git stash reported failure but created ${stashRef.slice(0, 8)} at ${projectPath}; restoring the working tree.`));
        try {
          git(['stash', 'pop', stashRef], projectPath);
          return {
            ok: false, kind: 'git', handle: null, restoreHint: '',
            reason: `git stash failed and was rolled back — the project is untouched: ${stashErr.message}`
          };
        } catch (popErr) {
          // Could not restore. Never leave the user guessing where their work
          // went: refuse, but hand back the exact command that recovers it.
          return {
            ok: false, kind: 'git', handle: stashRef,
            restoreHint: `git -C "${projectPath}" stash apply ${stashRef}`,
            reason: `git stash failed midway and could not be rolled back. Your uncommitted work is saved in stash ${stashRef.slice(0, 8)} — restore it with the command in restoreHint. (${stashErr.message})`
          };
        }
      }

      logInfo('snapshot-guard', `Dirty git repo at ${projectPath}; stashed uncommitted work as ${stashRef.slice(0, 8)}.`);
      // Write it down the moment the work leaves the folder. Returning it
      // happens at exactly one call site (fixer.js), so any run that does not
      // reach that line leaves the stash behind — and before this ledger
      // existed, nothing anywhere recorded that it had. Three such stashes
      // were found on this machine, one holding nineteen files the user needed.
      restorePoints.record({
        event: 'taken', kind: 'git-stash', projectPath, handle: stashRef, label: stashLabel
      });
      return {
        ok: true, kind: 'git-stash', handle: stashRef,
        restoreHint: `git -C "${projectPath}" stash apply ${stashRef}`,
        reason: null
      };
    } catch (err) {
      logError('snapshot-guard', err);
      return { ok: false, kind: 'git', handle: null, restoreHint: '', reason: `git snapshot failed: ${err.message}` };
    }
  }

  // Not a git repo: fall back to a zip.
  const size = directorySize(projectPath, MAX_ZIP_BYTES);
  if (size >= MAX_ZIP_BYTES) {
    return {
      ok: false, kind: 'zip', handle: null, restoreHint: '',
      reason: `project is larger than ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)} MB and is not a git repo — refusing to let an agent edit it without a restore point`
    };
  }

  try {
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  } catch (err) {
    return { ok: false, kind: 'zip', handle: null, restoreHint: '', reason: `cannot create backups dir: ${err.message}` };
  }

  if (freeSpaceBytes(BACKUPS_DIR) < MIN_FREE_BYTES) {
    return { ok: false, kind: 'zip', handle: null, restoreHint: '', reason: 'less than 2 GB free on disk — refusing to snapshot' };
  }

  const zipPath = path.join(BACKUPS_DIR, `${path.basename(projectPath)}-${timestamp()}.zip`);
  try {
    const excludeArgs = ZIP_EXCLUDES.map(d => `'${d}'`).join(',');
    const psCommand =
      `$ErrorActionPreference='Stop';` +
      `$items = Get-ChildItem -LiteralPath '${projectPath.replace(/'/g, "''")}' -Force | ` +
      `Where-Object { $_.Name -notin @(${excludeArgs}) };` +
      `if ($items) { Compress-Archive -Path $items.FullName -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force }`;
    execSync(`powershell -NoProfile -NonInteractive -Command "${psCommand.replace(/"/g, '\\"')}"`, {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 180000
    });
    if (!fs.existsSync(zipPath)) {
      return { ok: false, kind: 'zip', handle: null, restoreHint: '', reason: 'archive was not produced' };
    }
    logInfo('snapshot-guard', `No git repo at ${projectPath}; archived to ${zipPath}.`);
    restorePoints.record({ event: 'taken', kind: 'zip', projectPath, handle: zipPath });
    return {
      ok: true, kind: 'zip', handle: zipPath,
      restoreHint: `Expand-Archive -Path "${zipPath}" -DestinationPath "${projectPath}" -Force`,
      reason: null
    };
  } catch (err) {
    logError('snapshot-guard', err);
    return { ok: false, kind: 'zip', handle: null, restoreHint: '', reason: `archive failed: ${err.message}` };
  }
}

/**
 * Removes snapshot archives older than the retention window, so the guard
 * cannot fill the disk over time. Git snapshots cost nothing and are untouched.
 *
 * @param {number} keepDays Retention window in days
 */
function pruneSnapshots(keepDays = 14) {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) return;
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(BACKUPS_DIR)) {
      if (!name.endsWith('.zip')) continue;
      const full = path.join(BACKUPS_DIR, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
          logInfo('snapshot-guard', `Pruned old snapshot ${name}`);
        }
      } catch (err) {
        continue;
      }
    }
  } catch (err) {
    logError('snapshot-guard', err);
  }
}

/**
 * Puts stashed uncommitted work back after the agent has finished.
 *
 * Taking a `git stash` removes the user's work-in-progress from their folder.
 * Leaving it there after a successful repair means a "success" silently
 * emptied their working tree — the restore hint sits in a log they may never
 * read. So the stash is applied back, and when that conflicts we say so
 * plainly and keep the stash rather than forcing anything.
 *
 * @param {string} projectPath Repository path
 * @param {Object} restore Restore descriptor from snapshot()
 * @returns {{restored: boolean, reason: string|null, hint: string}}
 */
function restoreStashedWork(projectPath, restore) {
  if (!restore || restore.kind !== 'git-stash' || !restore.handle) {
    return { restored: false, reason: null, hint: '' };
  }
  const hint = `git -C "${projectPath}" stash apply ${restore.handle}`;
  try {
    // apply, not pop: if anything goes wrong later the stash is still there.
    git(['stash', 'apply', restore.handle], projectPath);
    logInfo('snapshot-guard', `Restored stashed work in ${projectPath} from ${restore.handle.slice(0, 8)}.`);
    restorePoints.record({ event: 'returned', kind: 'git-stash', projectPath, handle: restore.handle });
    return { restored: true, reason: null, hint };
  } catch (err) {
    logError('snapshot-guard', new Error(
      `Could not restore stashed work in ${projectPath}: ${err.message}. Stash ${restore.handle} is kept.`));
    return {
      restored: false,
      reason: `تعذّرت إعادة عملك غير المُلتزَم تلقائياً (تعارض مع تعديلات الوكيل). عملك محفوظ في stash — استرجعه بـ: ${hint}`,
      hint
    };
  }
}

module.exports = { snapshot, pruneSnapshots, isGitRepo, restoreStashedWork };
