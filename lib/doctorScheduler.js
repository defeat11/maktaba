const fs = require('fs');
const path = require('path');
const doctorScan = require('./doctorScan');
const { logInfo, logError } = require('./logger');

/**
 * Optional config setting in config.json:
 * - doctorScanIntervalHours (number): defines how often (in hours) the automatic doctor scan runs.
 *   If not provided or invalid, the scheduler defaults to 6 hours.
 */

function start() {
  const configPath = path.join(__dirname, '..', 'config.json');
  let intervalHours = 6;

  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (typeof config.doctorScanIntervalHours === 'number' && config.doctorScanIntervalHours > 0) {
        intervalHours = config.doctorScanIntervalHours;
      }
    }
  } catch (err) {
    logError('doctor-scheduler', `Failed to read config.json, defaulting to 6 hours: ${err.message}`);
  }

  const intervalMs = intervalHours * 60 * 60 * 1000;
  logInfo('doctor-scheduler', `Starting doctor scheduler. Interval: ${intervalHours} hours (${intervalMs} ms)`);

  const timer = setInterval(async () => {
    try {
      const progress = doctorScan.getScanProgress();
      if (progress.running === true) {
        logInfo('doctor-scheduler', 'Doctor scan is already running. Skipping this tick.');
        return;
      }

      logInfo('doctor-scheduler', 'Scheduled doctor scan trigger started.');
      const targets = await doctorScan.getScanTargets();
      doctorScan.startScan(targets);
    } catch (err) {
      logError('doctor-scheduler', `Error in scheduled doctor scan tick: ${err.message}`);
    }
  }, intervalMs);

  // Keep the description of every program current.
  //
  // Separate from the doctor scan and far more frequent, because the two do
  // very different things: a doctor scan LAUNCHES each project and is expensive
  // and disruptive, while profiling only reads files. Profiling the whole
  // catalogue took 92 seconds for 162 projects and spends no agent budget, so
  // there is no reason for Maktaba's knowledge of a program to go stale.
  const PROFILE_INTERVAL_MS = 60 * 60 * 1000;
  const profileTimer = setInterval(async () => {
    try {
      const runner = require('./profileRunner');
      if (runner.getProfilingProgress().running) return;
      // Only what has actually gone stale, so an hourly tick is nearly free.
      const result = await runner.startProfiling({ onlyStale: true, maxAgeHours: 12 });
      if (result.started) {
        logInfo('profile-scheduler', `Refreshing details for ${result.total} programs.`);
      }
    } catch (err) {
      logError('profile-scheduler', `Error in scheduled profiling tick: ${err.message}`);
    }
  }, PROFILE_INTERVAL_MS);

  logInfo('profile-scheduler', 'Program details refresh every 1 hour (stale only).');

  // Keep a verified copy of the catalogue.
  //
  // A backup routine already existed, with one call site inside the doctor fix
  // queue — and that queue only touches projects whose health is 'broken',
  // which is true for 0 of 164 rows. So it has effectively never run: two
  // backup events exist on disk, 2026-06-14 and 2026-08-26, while db.json is
  // rewritten daily. A timer that fires regardless of whether anything is
  // broken is the whole point.
  const BACKUP_INTERVAL_MS = 60 * 60 * 1000;
  let backupTickLogged = false;
  const runBackup = async () => {
    try {
      const result = await require('./catalogueBackup').backupNow();
      if (result.ok && !result.skipped) {
        logInfo('catalogue-backup', 'Catalogue backup kept ' + result.entry.rows + ' rows.');
      } else if (!result.ok) {
        logError('catalogue-backup', new Error(result.error));
      } else if (!backupTickLogged) {
        // Said once per boot, not every hour. Without it a skip is silent, and
        // "no new backup" is indistinguishable from "the timer never fired" —
        // which is exactly how the previous backup routine went unnoticed for
        // seventy-three days.
        logInfo('catalogue-backup', 'Backup tick ran, nothing to copy: ' + result.reason);
      }
      backupTickLogged = true;
    } catch (err) {
      logError('catalogue-backup', `Error in catalogue backup tick: ${err.message}`);
    }
  };

  // A copy shortly after boot, so a machine that is rarely on for a full hour
  // still gets one. It skips itself when nothing has changed, so this is free.
  const firstBackup = setTimeout(runBackup, 60 * 1000);
  const backupTimer = setInterval(runBackup, BACKUP_INTERVAL_MS);
  logInfo('catalogue-backup', 'Catalogue backup every 1 hour (only when it has changed).');

  // Allow the process to exit cleanly without waiting for these timers
  timer.unref();
  profileTimer.unref();
  firstBackup.unref();
  backupTimer.unref();
}

module.exports = {
  start
};
