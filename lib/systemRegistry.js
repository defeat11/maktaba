// Everything on this machine that can start a program without Maktaba being
// asked: scheduled tasks, startup folder shortcuts, Run registry keys and
// auto-starting services.
//
// The catalogue knows what exists on disk and psscan knows what is running
// right now, but neither answers "what will start itself later, and who told
// it to". That gap is how three separate watchdogs ended up restarting each
// other, and how a doctor scan was killed mid-cycle by a supervisor nobody had
// registered.
//
// Read-only. Nothing here creates, changes or removes a task.

const path = require('path');
const { execFile } = require('child_process');
const { logError } = require('./logger');

const PS_TIMEOUT_MS = 45000;

// PowerShell -like patterns, kept as named constants because they were wrong in
// a way nothing could see.
//
// They were written inline in a template literal with four backslashes.
// JavaScript collapsed those to two, so PowerShell received a DOUBLE backslash
// while TaskPath holds single ones — and backslash is not an escape character
// in a -like pattern. The filter therefore matched nothing and excluded
// nothing, silently, while still returning a perfectly plausible list.
//
// Measured: Maktaba reported 300 autostart entries and 175 "unknown", counting
// all 186 scheduled tasks on the machine. 161 of those are Windows's own. The
// 25 that remain are the ones that actually describe this setup.
//
// A filter that stops filtering but keeps answering cannot be caught by
// reading the output, so the shape of these patterns is asserted in
// tools/unit/system_registry_filter.test.js.
const VENDOR_TASK_PATTERN = '\\Microsoft\\*';
const VENDOR_SERVICE_PATTERN = '*\\Windows\\*';

/**
 * Runs a PowerShell snippet and parses its JSON output.
 * Returns [] rather than throwing: a registry read that fails must not be able
 * to take down a page.
 *
 * @param {string} script PowerShell producing JSON
 * @returns {Promise<Array<Object>>}
 */
function psJson(script) {
  return new Promise((resolve) => {
    execFile('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 12 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) { resolve([]); return; }
        const text = String(stdout || '').trim();
        if (!text) { resolve([]); return; }
        try {
          const parsed = JSON.parse(text);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (e) {
          logError('system-registry', new Error('Unparseable PowerShell output: ' + e.message));
          resolve([]);
        }
      });
  });
}

/**
 * Scheduled tasks the user created — the Microsoft-shipped tree is skipped
 * because it describes Windows, not this machine's setup.
 *
 * @returns {Promise<Array<Object>>}
 */
async function scheduledTasks() {
  const script = `
    Get-ScheduledTask -ErrorAction SilentlyContinue |
      Where-Object { $_.TaskPath -notlike '${VENDOR_TASK_PATTERN}' } |
      ForEach-Object {
        $info = $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
        [PSCustomObject]@{
          name      = $_.TaskName
          taskPath  = $_.TaskPath
          state     = [string]$_.State
          action    = ($_.Actions | ForEach-Object { (($_.Execute) + ' ' + ($_.Arguments)).Trim() }) -join ' ; '
          workDir   = ($_.Actions | ForEach-Object { $_.WorkingDirectory }) -join ' ; '
          lastRun   = if ($info) { [string]$info.LastRunTime } else { $null }
          nextRun   = if ($info) { [string]$info.NextRunTime } else { $null }
          lastResult= if ($info) { $info.LastTaskResult } else { $null }
        }
      } | ConvertTo-Json -Compress -Depth 3`;
  return (await psJson(script)).map(t => ({ kind: 'scheduled-task', ...t }));
}

/**
 * Shortcuts and scripts sitting in either Startup folder.
 *
 * @returns {Promise<Array<Object>>}
 */
async function startupFolder() {
  const script = `
    $paths = @(
      [Environment]::GetFolderPath('Startup'),
      [Environment]::GetFolderPath('CommonStartup')
    ) | Where-Object { $_ -and (Test-Path $_) }
    $out = foreach ($p in $paths) {
      Get-ChildItem -LiteralPath $p -File -ErrorAction SilentlyContinue | ForEach-Object {
        $target = $null
        if ($_.Extension -eq '.lnk') {
          try {
            $sh = New-Object -ComObject WScript.Shell
            $lnk = $sh.CreateShortcut($_.FullName)
            $target = ($lnk.TargetPath + ' ' + $lnk.Arguments).Trim()
          } catch { $target = $null }
        }
        [PSCustomObject]@{
          name   = $_.Name
          file   = $_.FullName
          action = if ($target) { $target } else { $_.FullName }
          folder = $p
        }
      }
    }
    $out | ConvertTo-Json -Compress -Depth 3`;
  return (await psJson(script)).map(s => ({ kind: 'startup-folder', ...s }));
}

/**
 * Run / RunOnce registry entries for this user and the machine.
 *
 * @returns {Promise<Array<Object>>}
 */
async function runKeys() {
  const script = `
    $keys = @(
      'HKCU:\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run',
      'HKCU:\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\RunOnce',
      'HKLM:\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run',
      'HKLM:\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\RunOnce'
    )
    $out = foreach ($k in $keys) {
      if (Test-Path $k) {
        $item = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
        $item.PSObject.Properties |
          Where-Object { $_.Name -notlike 'PS*' } |
          ForEach-Object {
            [PSCustomObject]@{ name = $_.Name; action = [string]$_.Value; hive = $k }
          }
      }
    }
    $out | ConvertTo-Json -Compress -Depth 3`;
  return (await psJson(script)).map(r => ({ kind: 'run-key', ...r }));
}

/**
 * Services set to start automatically that are not shipped by Windows.
 *
 * @returns {Promise<Array<Object>>}
 */
async function autoServices() {
  const script = `
    Get-CimInstance Win32_Service -ErrorAction SilentlyContinue |
      Where-Object { $_.StartMode -eq 'Auto' -and $_.PathName -notlike '${VENDOR_SERVICE_PATTERN}' } |
      ForEach-Object {
        [PSCustomObject]@{
          name    = $_.Name
          display = $_.DisplayName
          action  = $_.PathName
          state   = $_.State
        }
      } | ConvertTo-Json -Compress -Depth 3`;
  return (await psJson(script)).map(s => ({ kind: 'service', ...s }));
}

/**
 * Attaches the catalogued project each entry belongs to, by looking for a
 * project path inside the command line. This is what turns a list of registry
 * strings into "these six autostarts belong to projects Maktaba manages, and
 * these four belong to nothing it knows about".
 *
 * @param {Array<Object>} entries Registry entries
 * @param {Array<Object>} projects Catalogue rows
 * @returns {Array<Object>} Entries with matchedProject / matchedPath attached
 */
// Software that ships with Windows or with a vendor's installer. It starts
// itself by design and is nobody's project, so listing it as "unknown to
// Maktaba" buries the eight entries that actually matter under two hundred that
// do not.
const VENDOR_MARKERS = [
  '\\windows\\', '\\program files\\microsoft', '\\program files (x86)\\microsoft',
  'onedrive', 'microsoft office', 'clicktorun', 'nvidia', 'realtek', 'intel',
  'thunderbolt', '\\google\\chrome', '\\opera', '\\edge', 'adobe', 'dropbox',
  'steam', 'epic games', 'oracle\\java', 'dell', 'lenovo', 'hp inc',
  'windowsapps', 'packages\\microsoft'
];

/**
 * True when an entry belongs to installed third-party software rather than to
 * something the user built.
 *
 * @param {Object} entry Registry entry
 * @returns {boolean}
 */
function isVendorEntry(entry) {
  const text = [entry.action, entry.file, entry.display, entry.name]
    .filter(Boolean).join(' ').toLowerCase();
  return VENDOR_MARKERS.some(m => text.includes(m));
}

function attachProjects(entries, projects) {
  // Longest path first, so a nested project wins over its parent.
  const byLength = projects
    .filter(p => p.path)
    .slice()
    .sort((a, b) => b.path.length - a.path.length);

  return entries.map(e => {
    const haystack = [e.action, e.workDir, e.file].filter(Boolean).join(' ').toLowerCase();
    const hit = byLength.find(p => haystack.includes(p.path.toLowerCase()));
    const vendor = isVendorEntry(e);
    return {
      ...e,
      matchedProject: hit ? hit.name : null,
      matchedPath: hit ? hit.path : null,
      vendor,
      // The entries that matter: they start something on this machine, they are
      // not installed vendor software, and Maktaba has no project for them.
      unknownToMaktaba: !hit && !vendor
    };
  });
}

/**
 * The full picture of what can start itself on this machine.
 *
 * @param {Array<Object>} projects Catalogue rows to match against
 * @returns {Promise<Object>} Registry with entries and a summary
 */
async function scanSystem(projects) {
  const [tasks, startup, keys, services] = await Promise.all([
    scheduledTasks(), startupFolder(), runKeys(), autoServices()
  ]);

  const all = attachProjects([...tasks, ...startup, ...keys, ...services], projects || []);
  const byKind = {};
  all.forEach(e => { byKind[e.kind] = (byKind[e.kind] || 0) + 1; });

  return {
    scannedAt: new Date().toISOString(),
    total: all.length,
    byKind,
    vendor: all.filter(e => e.vendor).length,
    knownToMaktaba: all.filter(e => e.matchedProject).length,
    unknownToMaktaba: all.filter(e => e.unknownToMaktaba).length,
    entries: all
  };
}

module.exports = { scanSystem, scheduledTasks, startupFolder, runKeys, autoServices, attachProjects, isVendorEntry,
  VENDOR_TASK_PATTERN, VENDOR_SERVICE_PATTERN };
