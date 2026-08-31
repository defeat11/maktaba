# Maktaba Guardian — keeps the maktaba server (port 4500) alive forever.
# Handles: crash (process gone), hang (port up but not responding), and
# is itself relaunched at logon/reboot by the Maktaba-Guardian scheduled task.
# Safe: only starts/monitors `node server.js`. Never touches the database.

$ErrorActionPreference = 'SilentlyContinue'

# Derived from this script's own location, so the guardian works from any
# checkout path. Override either with an environment variable if needed.
$Root          = if ($env:MAKTABA_ROOT) { $env:MAKTABA_ROOT } else { Split-Path -Parent $PSScriptRoot }
$Node          = if ($env:MAKTABA_NODE) { $env:MAKTABA_NODE } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $Node) { $Node = 'node' }
$Port          = 4500
# Probe /api/health, never /api/projects: the latter does a sync fs.existsSync
# per project and gets slow under load, which made this guardian kill the server
# in the middle of every doctor scan.
$Url           = "http://127.0.0.1:$Port/api/health"
$CheckInterval = 15        # seconds between health checks
$FailsToRestart= 4         # consecutive failures before a restart (debounce)
$ProbeTimeout  = 8         # seconds per HTTP probe
$ScanGraceFails= 12        # allow this many failures while a scan was last seen running
$ScanGraceMax  = 2700      # ...but never longer than 45 min of scan (seconds)
$LogDir        = Join-Path $Root 'logs'
$LogFile       = Join-Path $LogDir 'guardian.log'

# --- single instance guard --------------------------------------------------
$mtxCreated = $false
$mutex = New-Object System.Threading.Mutex($true, 'Global\MaktabaGuardian', [ref]$mtxCreated)
if (-not $mtxCreated) { exit 0 }   # another guardian already running

# --- helpers ----------------------------------------------------------------
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

function Write-Log([string]$msg) {
  $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
  # rotate: keep tail if file grows past ~512 KB
  $fi = Get-Item $LogFile -ErrorAction SilentlyContinue
  if ($fi -and $fi.Length -gt 512KB) {
    $tail = Get-Content $LogFile -Tail 200
    Set-Content -Path $LogFile -Value $tail -Encoding UTF8
  }
}

# Set by Test-Healthy from the last SUCCESSFUL probe. A wedged server cannot
# tell us it is scanning, so the decision to be patient has to be made from the
# last answer we did get -- and it has to expire, or a stuck scan flag would
# disable the watchdog forever.
$script:ScanSeenAt = $null

function Test-Healthy {
  try {
    $r = Invoke-WebRequest -Uri $Url -TimeoutSec $ProbeTimeout -UseBasicParsing -ErrorAction Stop
    if ($r.StatusCode -ne 200) { return $false }
    try {
      $body = $r.Content | ConvertFrom-Json
      if ($body.scan -and $body.scan.running -and $body.scan.ageMs -lt ($ScanGraceMax * 1000)) {
        $script:ScanSeenAt = Get-Date
      } else {
        $script:ScanSeenAt = $null
      }
    } catch { $script:ScanSeenAt = $null }
    return $true
  } catch { return $false }
}

# How many consecutive failures to tolerate before restarting. A doctor scan
# runs real projects and can make the box briefly unresponsive, so we are more
# patient when the last good probe reported a scan in flight -- bounded by
# $ScanGraceMax so this can never become "never restart".
function Get-FailThreshold {
  if ($script:ScanSeenAt) {
    $age = ((Get-Date) - $script:ScanSeenAt).TotalSeconds
    if ($age -lt $ScanGraceMax) { return $ScanGraceFails }
    $script:ScanSeenAt = $null
  }
  return $FailsToRestart
}

function Restart-Server([string]$why) {
  Write-Log "restart: $why"
  # kill whatever owns the port (a hung/stale process tree, incl. child projects)
  try {
    $pids = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($p in $pids) {
      if ($p -and $p -ne 0) {
        # Stop-Process avoids cmd.exe console flash from taskkill
        try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {}
        try {
          $children = Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $p) -ErrorAction SilentlyContinue
          foreach ($ch in $children) {
            try { Stop-Process -Id $ch.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
          }
        } catch {}
      }
    }
  } catch {}
  Start-Sleep -Seconds 2
  Start-Process -FilePath $Node -ArgumentList 'server.js' -WorkingDirectory $Root -WindowStyle Hidden
  Write-Log "launched node server.js"
}

# --- main -------------------------------------------------------------------
Write-Log "guardian start (pid $PID)"

# bring it up immediately if it is down
if (-not (Test-Healthy)) { Restart-Server 'initial: server not responding' }
else { Write-Log 'already healthy on start; adopting existing server' }

$fails = 0
while ($true) {
  Start-Sleep -Seconds $CheckInterval
  if (Test-Healthy) {
    if ($fails -gt 0) { Write-Log "recovered after $fails failed check(s)" }
    $fails = 0
  } else {
    $fails++
    $threshold = Get-FailThreshold
    $note = if ($threshold -ne $FailsToRestart) { ' (scan in flight — being patient)' } else { '' }
    Write-Log "health check failed ($fails/$threshold)$note"
    if ($fails -ge $threshold) {
      Restart-Server "unresponsive x$fails"
      $fails = 0
      Start-Sleep -Seconds 5   # give it a moment to bind before next probe
    }
  }
}
