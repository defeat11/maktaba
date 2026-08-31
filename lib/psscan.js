const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const store = require('./store');

// The eight executables this scan has always asked Windows about. They stay,
// whatever else is added: this is a floor, never a replacement.
const BASE_EXECUTABLES = [
  'node.exe', 'python.exe', 'pythonw.exe', 'agy.exe',
  'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe'
];

// What each language runs as. Consulted ONLY for runtimes the catalogue
// actually contains, which is the whole safeguard: the filter can only grow by
// a language the user writes in, so it can never swallow installed software.
//
// Measured cost of not having this: 69 processes visible out of 592, and
// php.exe serving a CATALOGUED project on port 8000 — the row says
// assignedPort 8000 — invisible not by accident but by construction.
const RUNTIME_EXECUTABLES = {
  php: ['php.exe'],
  java: ['java.exe', 'javaw.exe'],
  dotnet: ['dotnet.exe'],
  ruby: ['ruby.exe'],
  deno: ['deno.exe'],
  bun: ['bun.exe']
};

/**
 * Builds the executable filter from the languages in the catalogue.
 *
 * @param {Array<Object>} projects Catalogue rows
 * @returns {{executables: Array<string>, runtimesQueried: Array<string>}}
 */
function executablesForCatalogue(projects) {
  const found = new Set();

  for (const project of (projects || [])) {
    if (!project || project.missing) continue;

    let runtime = '';
    try {
      const profile = typeof project.profile === 'string' ? JSON.parse(project.profile) : project.profile;
      if (profile && profile.runtime) runtime = String(profile.runtime);
    } catch (err) { /* an unparseable profile just means one less hint */ }

    const haystack = (String(project.type || '') + ' ' + runtime).toLowerCase();
    for (const key of Object.keys(RUNTIME_EXECUTABLES)) {
      // ".net" and "dotnet" are the same language written two ways.
      const needle = key === 'dotnet' ? /(dotnet|\.net|c#|csharp)/ : new RegExp(key);
      if (needle.test(haystack)) found.add(key);
    }
  }

  const extra = [];
  for (const key of found) {
    for (const exe of RUNTIME_EXECUTABLES[key]) {
      if (BASE_EXECUTABLES.indexOf(exe) === -1 && extra.indexOf(exe) === -1) extra.push(exe);
    }
  }

  return { executables: BASE_EXECUTABLES.concat(extra), runtimesQueried: Array.from(found).sort() };
}

// How much of the machine the last scan could see. Kept here rather than pushed
// into the returned array, so every existing caller keeps the shape it expects.
let lastCoverage = { totalProcesses: null, inFilter: null, outOfFilter: null, runtimesQueried: [], at: null };

/**
 * Coverage of the most recent process scan.
 *
 * Deliberately a handful of numbers and not a list. "I can see 74 of 592" is a
 * useful thing to know about yourself; a browsable table of the other 518 would
 * make this a task manager, which is not what a library of your projects is.
 *
 * @returns {Object}
 */
function getCoverage() {
  return Object.assign({}, lastCoverage);
}

/**
 * Extracts script path or main module file from process command line.
 */
function extractScriptPath(commandLine) {
  if (!commandLine) return null;
  // Match tokens, respecting double quotes
  const parts = commandLine.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  for (const part of parts) {
    const cleanPart = part.replace(/^"|"$/g, '');
    if (cleanPart.startsWith('-')) continue;
    
    let base = '';
    try {
      base = path.basename(cleanPart).toLowerCase();
    } catch (e) {
      continue;
    }
    
    const isExecutable = ['node', 'node.exe', 'python', 'python.exe', 'pythonw', 'pythonw.exe',
      'agy', 'agy.exe', 'ts-node', 'tsx', 'nodemon', 'npx', 'npm',
      'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'wscript', 'wscript.exe',
      'cscript', 'cscript.exe',
      // The interpreters added with the widened filter: the runtime is never
      // the script, so it must be skipped over to reach the file that is.
      'php', 'php.exe', 'java', 'java.exe', 'javaw', 'javaw.exe',
      'dotnet', 'dotnet.exe', 'ruby', 'ruby.exe', 'deno', 'deno.exe', 'bun', 'bun.exe'].includes(base);
    if (isExecutable) continue;
    
    const ext = path.extname(cleanPart).toLowerCase();
    if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.jsx', '.json',
      '.php', '.rb', '.jar', '.dll'].includes(ext)) {
      return cleanPart;
    }
  }
  return null;
}

/**
 * Extracts port number if passed as CLI arguments (--port, -p, PORT=, etc.)
 */
function extractPortFromCommandLine(commandLine) {
  if (!commandLine) return null;
  const match = commandLine.match(/(?:--port|-p|PORT=)\s*["']?(\d{2,5})["']?/i);
  if (match && match[1]) {
    const portNum = parseInt(match[1], 10);
    if (!isNaN(portNum) && portNum > 0 && portNum <= 65535) {
      return portNum;
    }
  }
  return null;
}

/**
 * Resolves the root project directory from a script or binary path.
 */
function resolveProjectDirectory(scriptPath) {
  if (!scriptPath) return null;
  const normalized = scriptPath.replace(/[\/\\]/g, '\\');
  
  // If it's inside node_modules, root is before node_modules
  const nodeModulesIdx = normalized.toLowerCase().indexOf('\\node_modules\\');
  if (nodeModulesIdx !== -1) {
    return normalized.substring(0, nodeModulesIdx);
  }
  
  // If it's a file path, dirname is the project folder or one level up
  if (normalized.includes(':\\') || normalized.startsWith('\\\\')) {
    try {
      const dir = path.dirname(normalized);
      // If inside dist, build, src, lib, bin, return parent
      const baseDir = path.basename(dir).toLowerCase();
      if (['dist', 'build', 'src', 'lib', 'bin', 'public', 'server'].includes(baseDir)) {
        return path.dirname(dir);
      }
      return dir;
    } catch (e) {
      return null;
    }
  }
  
  return null;
}

function isPrefixOf(projPath, scriptPath) {
  if (!projPath || !scriptPath) return false;
  const p = projPath.replace(/[\/\\]/g, '\\').toLowerCase();
  const s = scriptPath.replace(/[\/\\]/g, '\\').toLowerCase();
  
  if (s === p) return true;
  if (s.startsWith(p)) {
    return p.endsWith('\\') || s[p.length] === '\\';
  }
  return false;
}

function parseWmiDate(str) {
  if (typeof str !== 'string' || str.length < 14) return null;
  try {
    const year = parseInt(str.substring(0, 4), 10);
    const month = parseInt(str.substring(4, 6), 10);
    const day = parseInt(str.substring(6, 8), 10);
    const hour = parseInt(str.substring(8, 10), 10);
    const minute = parseInt(str.substring(10, 12), 10);
    const second = parseInt(str.substring(12, 14), 10);
    if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(minute) || isNaN(second)) {
      return null;
    }
    return new Date(year, month - 1, day, hour, minute, second);
  } catch (e) {
    return null;
  }
}

/**
 * Scans all active Node.js, Python, and agy processes across the machine,
 * maps their listening TCP ports, matches them against the Maktaba catalog,
 * and detects any untracked running developer projects.
 */
async function scanProcesses() {
  // The filter is decided here, from the catalogue, rather than frozen in the
  // query string. A project written in PHP makes php.exe worth asking about;
  // nothing else does.
  let catalogueForFilter = [];
  try {
    catalogueForFilter = await store.getProjects();
  } catch (err) {
    // Without the catalogue the floor still applies — a narrower scan, never a
    // failed one.
    console.error('Failed to read catalogue for the process filter:', err.message);
  }
  const { executables, runtimesQueried } = executablesForCatalogue(catalogueForFilter);
  const nameFilter = executables.map(name => `Name='${name}'`).join(' OR ');

  const query = `
$procs = Get-CimInstance Win32_Process -Filter "${nameFilter}" | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,@{Name='CreationDate';Expression={if ($_.CreationDate) {[System.Management.ManagementDateTimeConverter]::ToDmtfDateTime($_.CreationDate)} else {$null}}};
$ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess;
$total = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue).Count;
[PSCustomObject]@{ procs = $procs; ports = $ports; total = $total } | ConvertTo-Json -Compress -Depth 4
`;

  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', query], {
      windowsHide: true
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', async (code) => {
      let rawProcs = [];
      let rawPorts = [];
      let totalProcesses = null;
      const trimmed = stdout.trim();
      
      if (trimmed) {
        // Sanitize control characters (0x00 to 0x1F)
        const sanitized = trimmed.replace(/[\x00-\x1f]/g, (char) => {
          if (char === '\n') return '\\n';
          if (char === '\r') return '\\r';
          if (char === '\t') return '\\t';
          return ' ';
        });
        
        try {
          const parsed = JSON.parse(sanitized);
          if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.procs)) rawProcs = parsed.procs;
            else if (parsed.procs) rawProcs = [parsed.procs];
            
            if (Array.isArray(parsed.ports)) rawPorts = parsed.ports;
            else if (parsed.ports) rawPorts = [parsed.ports];

            if (typeof parsed.total === 'number') totalProcesses = parsed.total;
          }
        } catch (err) {
          console.error('Failed to parse processes & ports JSON:', err);
        }
      }
      
      // Build map of PID -> array of listening ports
      const portMap = new Map();
      for (const pt of rawPorts) {
        const pid = pt.OwningProcess !== undefined ? Number(pt.OwningProcess) : null;
        const port = pt.LocalPort !== undefined ? Number(pt.LocalPort) : null;
        if (pid && port) {
          if (!portMap.has(pid)) portMap.set(pid, []);
          const list = portMap.get(pid);
          if (!list.includes(port)) list.push(port);
        }
      }
      
      // Get all projects for matching
      let allProjects = [];
      try {
        allProjects = await store.getProjects();
      } catch (err) {
        console.error('Failed to get projects from store:', err);
      }
      
      const results = [];
      const acpList = readAcpRegistry();
      
      for (const item of rawProcs) {
        const pid = item.ProcessId !== undefined && item.ProcessId !== null ? Number(item.ProcessId) : null;
        const parentPid = item.ParentProcessId !== undefined && item.ParentProcessId !== null ? Number(item.ParentProcessId) : null;
        const nameLower = (item.Name || '').toLowerCase();
        
        let kind = 'unknown';
        if (nameLower === 'node.exe' || nameLower === 'node') kind = 'node';
        else if (nameLower === 'python.exe' || nameLower === 'python') kind = 'python';
        else if (nameLower === 'pythonw.exe' || nameLower === 'pythonw') kind = 'python';
        else if (nameLower === 'agy.exe' || nameLower === 'agy') kind = 'agy';
        // Script hosts: this is how the user's own .ps1 and .vbs run, and the
        // guardian and its silent launcher were invisible without them. Only
        // hosts are added, never installed applications — Maktaba tracks the
        // programs you wrote, not the ones you installed.
        else if (nameLower === 'powershell.exe' || nameLower === 'pwsh.exe') kind = 'powershell';
        else if (nameLower === 'wscript.exe' || nameLower === 'cscript.exe') kind = 'wscript';
        // Runtimes added because the catalogue contains projects written in
        // them. Without a kind of their own these would all read 'unknown',
        // which is the same as not knowing what the process is.
        else if (nameLower === 'php.exe' || nameLower === 'php') kind = 'php';
        else if (nameLower === 'java.exe' || nameLower === 'javaw.exe') kind = 'java';
        else if (nameLower === 'dotnet.exe') kind = 'dotnet';
        else if (nameLower === 'ruby.exe') kind = 'ruby';
        else if (nameLower === 'deno.exe') kind = 'deno';
        else if (nameLower === 'bun.exe') kind = 'bun';
        
        const commandLine = item.CommandLine || null;
        const executablePath = item.ExecutablePath || null;
        const scriptPath = extractScriptPath(commandLine);
        const resolvedDir = resolveProjectDirectory(scriptPath);
        const cliPort = extractPortFromCommandLine(commandLine);
        const listeningPorts = pid && portMap.has(pid) ? portMap.get(pid) : (cliPort ? [cliPort] : []);
        
        let matchedProject = null;
        let confidence = 'unknown';
        let matchedMethod = null;
        
        // 1) High confidence match by exact/prefix path
        if (scriptPath && (scriptPath.includes(':\\') || scriptPath.startsWith('\\\\'))) {
          let bestProj = null;
          let maxLen = -1;
          for (const proj of allProjects) {
            if (proj.path && isPrefixOf(proj.path, scriptPath)) {
              if (proj.path.length > maxLen) {
                maxLen = proj.path.length;
                bestProj = proj;
              }
            }
          }
          if (bestProj) {
            matchedProject = bestProj;
            confidence = 'high';
            matchedMethod = 'path_prefix';
          }
        }
        
        // 1b) A bare script name, resolved only when it is unambiguous.
        //
        // A process started as `node stack-guardian.mjs` carries no absolute
        // path, so the prefix match above can never see it — three of the
        // user's own background programs were unmatched for exactly this
        // reason. Searching the catalogue for that filename fixes it, but only
        // when EXACTLY ONE project has the file: `stack-guardian.mjs` resolves
        // to one project and is safe, while `server.js` exists in 55 and would
        // produce a confident wrong answer.
        if (!matchedProject && scriptPath && !scriptPath.includes(':\\') && !scriptPath.startsWith('\\\\')) {
          const bare = path.basename(scriptPath);
          if (bare && /\.(js|mjs|cjs|ts|py|ps1|vbs|bat|cmd)$/i.test(bare)) {
            const holders = allProjects.filter(proj => {
              if (!proj.path) return false;
              try { return fs.existsSync(path.join(proj.path, bare)); } catch (e) { return false; }
            });
            if (holders.length === 1) {
              matchedProject = holders[0];
              confidence = 'medium';
              matchedMethod = 'unique_filename';
            }
          }
        }

        // 2) High confidence match by listening port
        if (!matchedProject && listeningPorts.length > 0) {
          for (const p of listeningPorts) {
            const portMatch = allProjects.find(proj => (proj.assignedPort === p || proj.port === p));
            if (portMatch) {
              matchedProject = portMatch;
              confidence = 'high';
              matchedMethod = 'listening_port';
              break;
            }
          }
        }
        
        // 3) High confidence match (Python venv)
        if (!matchedProject && executablePath) {
          const normalizedExe = executablePath.replace(/[\/\\]/g, '\\').toLowerCase();
          if (normalizedExe.includes('\\.venv\\') || normalizedExe.includes('\\venv\\')) {
            let current = executablePath;
            for (let i = 0; i < 3; i++) {
              current = path.dirname(current);
            }
            const venvParentPath = current;
            
            let bestProj = null;
            let maxLen = -1;
            for (const proj of allProjects) {
              if (proj.path && isPrefixOf(proj.path, venvParentPath)) {
                if (proj.path.length > maxLen) {
                  maxLen = proj.path.length;
                  bestProj = proj;
                }
              }
            }
            if (bestProj) {
              matchedProject = bestProj;
              confidence = 'high';
              matchedMethod = 'venv_parent';
            }
          }
        }
        
        // 4) Medium confidence match by entry file name
        if (!matchedProject && scriptPath) {
          const isRelativeNoPath = !scriptPath.includes('/') && !scriptPath.includes('\\');
          if (isRelativeNoPath) {
            const scriptName = scriptPath.toLowerCase();
            const matches = allProjects.filter(proj => proj.entryFile && proj.entryFile.toLowerCase() === scriptName);
            if (matches.length === 1) {
              matchedProject = matches[0];
              confidence = 'medium';
              matchedMethod = 'entry_file';
            }
          }
        }
        
        // 5) ACP Registry match for 'agy' processes
        if (kind === 'agy') {
          const matchedAcp = acpList.find(a => a.pid === pid);
          if (matchedAcp) {
            confidence = 'high';
            matchedMethod = 'acp_registry';
            if (matchedAcp.project) {
              let bestProj = null;
              let maxLen = -1;
              for (const proj of allProjects) {
                if (proj.path && isPrefixOf(proj.path, matchedAcp.project)) {
                  if (proj.path.length > maxLen) {
                    maxLen = proj.path.length;
                    bestProj = proj;
                  }
                }
              }
              if (bestProj) {
                matchedProject = bestProj;
              }
            }
          }
        }
        
        // 6) Discovered Untracked Project (running Node app with directory not yet in catalog)
        let discoveredPath = null;
        if (!matchedProject && resolvedDir && fs.existsSync(resolvedDir)) {
          // Verify it is not in node_modules or system folders
          const lowerDir = resolvedDir.toLowerCase();
          const isSystem = lowerDir.includes('\\appdata\\') || lowerDir.includes('\\windows\\') || lowerDir.includes('\\program files');
          if (!isSystem) {
            discoveredPath = resolvedDir;
            confidence = 'discovered';
            matchedMethod = 'untracked_filesystem';
          }
        }
        
        const dateObj = parseWmiDate(item.CreationDate);
        const startedAt = (dateObj && !isNaN(dateObj.getTime())) ? dateObj.toISOString() : null;
        const identityKey = `${kind}|${scriptPath || commandLine || ''}`;

        // Package-manager wrappers and installed CLI tools belong to nobody's
        // project and appear and vanish on their own. Counting them as
        // "unaccounted for" makes that number meaningless, which hides the
        // processes that genuinely are unexplained.
        const haystack = `${executablePath || ''} ${scriptPath || ''} ${commandLine || ''}`.toLowerCase();
        const isTooling = !matchedProject && (
          /[\\/]node_modules[\\/]npm[\\/]bin[\\/]/.test(haystack) ||
          /npm-cli\.js|npx-cli\.js|yarn\.js|pnpm\.cjs/.test(haystack) ||
          /[\\/]npm-cache[\\/]_npx[\\/]/.test(haystack) ||
          /[\\/]appdata[\\/]roaming[\\/]npm[\\/]node_modules[\\/]/.test(haystack) ||
          /[\\/]site-packages[\\/]pip[\\/]/.test(haystack) ||
          /[\\/]pnpm[\\/](store|links)[\\/]/.test(haystack) ||
          // Editor extension hosts, language servers and MCP servers. They are
          // the IDE's plumbing, come and go with it, and belong to no project —
          // fourteen of them were being reported as unexplained programs.
          /[\\/]\.(antigravity-ide|vscode|vscode-server|cursor|windsurf)[\\/]/.test(haystack) ||
          /language[_-]server|extension-?host|[\\/]mcp[_-]servers?[\\/]/.test(haystack) ||
          // A bare host with no script is a shell someone opened, not a program.
          (!scriptPath && /^(powershell|pwsh|python|node)(\.exe)?"?\s*$/i.test(String(commandLine || '').trim()))
        );

        results.push({
          pid,
          parentPid,
          kind,
          commandLine,
          executablePath,
          scriptPath,
          projectDir: matchedProject ? matchedProject.path : (discoveredPath || resolvedDir || null),
          matchedProjectId: matchedProject ? matchedProject.id : null,
          matchedProjectName: matchedProject ? matchedProject.name : (discoveredPath ? path.basename(discoveredPath) : null),
          confidence,
          matchedMethod,
          // true = package-manager plumbing or an installed CLI, not a program
          // of the user's that Maktaba should be able to account for.
          isTooling,
          // The number that actually matters: a real program, running now, that
          // Maktaba cannot tie to anything it knows.
          unaccountedFor: !matchedProject && !isTooling,
          listeningPorts,
          discoveredPath,
          matchedProjectPath: matchedProject ? matchedProject.path : (discoveredPath || null),
          startedAt,
          identityKey
        });
      }
      
      // How much of the machine this scan could see. One honest ratio, kept
      // out of the returned array so every existing caller is unaffected.
      lastCoverage = {
        totalProcesses,
        inFilter: results.length,
        outOfFilter: totalProcesses === null ? null : Math.max(0, totalProcesses - results.length),
        runtimesQueried,
        executables,
        at: new Date().toISOString()
      };

      resolve(results);
    });
    
    child.on('error', (err) => {
      console.error('Failed to spawn powershell for process scan:', err);
      resolve([]);
    });
  });
}

function readAcpRegistry() {
  const agentsDir = path.join(os.homedir(), '.acp', 'agents');
  if (!fs.existsSync(agentsDir)) {
    return [];
  }

  let files;
  try {
    files = fs.readdirSync(agentsDir);
  } catch (err) {
    return [];
  }

  const results = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith('.json')) {
      continue;
    }
    const filePath = path.join(agentsDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      if (data && data.pid !== undefined && data.pid !== null) {
        const pid = Number(data.pid);
        if (!isNaN(pid)) {
          let isAlive = false;
          try {
            process.kill(pid, 0);
            isAlive = true;
          } catch (e) {
            if (e.code === 'EPERM') {
              isAlive = true;
            }
          }
          if (isAlive) {
            results.push({
              pid: pid,
              account: data.account !== undefined ? data.account : null,
              project: data.project !== undefined ? data.project : null,
              command: data.command !== undefined ? data.command : null,
              startedAt: data.startedAt !== undefined ? data.startedAt : null
            });
          }
        }
      }
    } catch (err) {
      // Ignore errors silently
    }
  }
  return results;
}

async function getNewProcessCount() {
  const snapshotPath = path.join(__dirname, '..', 'process-snapshot.json');
  let prevIdentities = [];
  try {
    if (fs.existsSync(snapshotPath)) {
      const content = fs.readFileSync(snapshotPath, 'utf8');
      prevIdentities = JSON.parse(content);
    }
  } catch (err) {
    prevIdentities = [];
  }
  if (!Array.isArray(prevIdentities)) {
    prevIdentities = [];
  }

  const currentProcesses = await scanProcesses();
  const prevSet = new Set(prevIdentities);
  
  const allIdentityKeysSet = new Set();
  const eligibleKeys = new Set();
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  
  for (const proc of currentProcesses) {
    if (proc.identityKey) {
      allIdentityKeysSet.add(proc.identityKey);
      
      if (proc.startedAt) {
        const startTime = new Date(proc.startedAt).getTime();
        if (!isNaN(startTime) && startTime < tenMinutesAgo) {
          eligibleKeys.add(proc.identityKey);
        }
      }
    }
  }
  
  let newCount = 0;
  for (const key of eligibleKeys) {
    if (!prevSet.has(key)) {
      newCount++;
    }
  }
  
  return {
    newCount,
    allIdentityKeys: Array.from(allIdentityKeysSet)
  };
}

function saveProcessSnapshot(identityKeys) {
  const snapshotPath = path.join(__dirname, '..', 'process-snapshot.json');
  try {
    fs.writeFileSync(snapshotPath, JSON.stringify(identityKeys, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save process snapshot:', err);
  }
}

module.exports = {
  scanProcesses,
  readAcpRegistry,
  getNewProcessCount,
  saveProcessSnapshot,
  extractPortFromCommandLine,
  resolveProjectDirectory,
  executablesForCatalogue,
  getCoverage,
  BASE_EXECUTABLES,
  RUNTIME_EXECUTABLES
};
