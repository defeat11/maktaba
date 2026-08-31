const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { logError, logInfo } = require('./logger');
const { planLaunch } = require('./launcher');

// Map of running processes: id -> { child, port, logs, startedAt, status, kind }
const runningProcesses = new Map();

function sha1(str) {
  const crypto = require('crypto');
  return crypto.createHash('sha1').update(str).digest('hex');
}

/**
 * Appends a log line to a project's log buffer.
 * 
 * @param {string} id Project ID.
 * @param {string} line Log line.
 */
function recordLog(id, line) {
  const processState = runningProcesses.get(id);
  if (processState) {
    processState.logs.push(line);
    if (processState.logs.length > 200) {
      processState.logs.shift();
    }
  }
}

/**
 * Extracts a port number from a line of output.
 */
function extractPort(text) {
  const urlMatch = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i);
  if (urlMatch) return parseInt(urlMatch[1], 10);

  const listenMatch = text.match(/(?:listening|running|started)\s+on\s+(?:https?:\/\/)?(?:[^\s:]+):?(\d+)/i);
  if (listenMatch) return parseInt(listenMatch[1], 10);

  const listenPortMatch = text.match(/(?:listening|running)\s+on\s+port\s+(\d+)/i);
  if (listenPortMatch) return parseInt(listenPortMatch[1], 10);

  const hostPortMatch = text.match(/(?:localhost|127\.0\.0\.1):(\d+)/);
  if (hostPortMatch) return parseInt(hostPortMatch[1], 10);

  const portLabelMatch = text.match(/\bport\s*[:=]?\s*(\d+)\b/i);
  if (portLabelMatch) return parseInt(portLabelMatch[1], 10);

  return null;
}

/**
 * Starts a project using the smart launcher planning.
 * @param {Object} project Project metadata from store
 * @returns {Promise<number|null>} Resolves with the port of the running process or null if non-web
 */
function start(project) {
  return new Promise((resolve, reject) => {
    const id = project.id || sha1(project.path);

    // The quarantine is checked at the very top, before anything is spawned.
    // Every other launch path funnels through here eventually, so a block that
    // sits anywhere later would be a block with a hole in it.
    const block = require('./quarantine').launchBlock(project);
    if (block.blocked) {
      const err = new Error(block.reason);
      err.code = 'QUARANTINED';
      err.since = block.since;
      return reject(err);
    }
    
    // If already running, stop it first
    if (runningProcesses.has(id)) {
      const active = runningProcesses.get(id);
      if (active.status === 'starting' || active.status === 'running') {
        stop(id);
      }
    }

    const projectDir = project.path;
    
    // Generate smart launch plan
    let plan;
    try {
      plan = planLaunch(project);
    } catch (planErr) {
      logError('runner', `Launch planning failed: ${planErr.message}`);
      reject(planErr);
      return;
    }

    logInfo('runner', `Launch planned for project ${id}. Kind: ${plan.kind}, Cmd: ${plan.cmd}, Args: ${JSON.stringify(plan.args)}`);

    // Initialize the project process state
    const logs = [];
    const processState = {
      child: null,
      port: null,
      logs,
      startedAt: new Date(),
      status: 'starting',
      kind: plan.kind
    };
    runningProcesses.set(id, processState);

    if (plan.kind === 'multi') {
      processState.children = [];
      
      let resolved = false;
      let primaryChild = null;
      let timeoutId = null;

      const primaryName = plan.primaryName;
      const primaryPort = plan.port;

      const cleanUpAndResolve = (detectedPort) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          processState.port = detectedPort;
          processState.status = 'running';
          resolve(detectedPort);
        }
      };

      const cleanUpAndReject = (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          processState.status = 'error';
          stop(id);
          reject(err);
        }
      };

      const services = plan.services;
      for (const service of services) {
        const cwd = path.join(projectDir, service.dir || '.');
        const env = {
          ...process.env,
          ...(service.port ? { PORT: String(service.port) } : {})
        };

        logInfo('runner', `Spawning multi-service [${service.name}] command: ${service.command} in cwd: ${cwd}`);

        let proc;
        try {
          proc = spawn(service.command, [], {
            cwd,
            shell: true,
            windowsHide: true,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
          });
        } catch (spawnErr) {
          logError('runner', `Spawn failed for service ${service.name}: ${spawnErr.message}`);
          recordLog(id, `[${service.name}] Spawn error: ${spawnErr.message}`);
          if (service.name === primaryName) {
            cleanUpAndReject(spawnErr);
            return;
          }
          continue;
        }

        const childObj = {
          name: service.name,
          child: proc,
          port: service.port
        };
        processState.children.push(childObj);

        if (service.name === primaryName) {
          primaryChild = proc;
          processState.child = proc;
        }

        let stdoutRemainder = '';
        let stderrRemainder = '';

        const handleData = (chunk, isStderr) => {
          const text = chunk.toString();
          const lines = (isStderr ? (stderrRemainder + text) : (stdoutRemainder + text)).split(/\r?\n/);
          
          if (isStderr) {
            stderrRemainder = lines.pop();
          } else {
            stdoutRemainder = lines.pop();
          }

          for (const line of lines) {
            recordLog(id, `[${service.name}] ${line}`);
            if (!resolved) {
              const detected = extractPort(line);
              if (detected && detected > 0 && detected < 65536) {
                if (service.name === primaryName) {
                  cleanUpAndResolve(detected);
                }
              }
            }
          }
        };

        proc.stdout.on('data', (chunk) => handleData(chunk, false));
        proc.stderr.on('data', (chunk) => handleData(chunk, true));

        proc.on('error', (err) => {
          recordLog(id, `[${service.name}] Process error: ${err.message}`);
          logError('runner', `Process error for service ${service.name}: ${err.message}`);
          if (service.name === primaryName) {
            cleanUpAndReject(err);
          }
        });

        proc.on('close', (code) => {
          recordLog(id, `[${service.name}] Process exited with code ${code}`);
          if (service.name === primaryName) {
            if (processState.status === 'starting' || processState.status === 'running') {
              processState.status = 'stopped';
            }
            if (!resolved) {
              cleanUpAndReject(new Error(`Primary service [${service.name}] exited early with code ${code}`));
            }
          }
        });
      }

      timeoutId = setTimeout(() => {
        if (!resolved) {
          recordLog(id, `Multi-service port detection timed out after 12s. Falling back to primary port ${primaryPort}.`);
          cleanUpAndResolve(primaryPort);
        }
      }, 12000);

      return;
    }

    let options = {
      cwd: projectDir,
      detached: false,
      shell: plan.shell,
      env: {
        ...process.env,
        ...(plan.port ? { PORT: String(plan.port) } : {}),
        ...(plan.env || {})
      }
    };

    if (plan.stdinIgnore || plan.kind === 'script' || plan.kind === 'custom') {
      options.stdio = ['ignore', 'pipe', 'pipe'];
    }

    // Spawning child process helper
    const spawnProcess = (command, commandArgs, shellOption) => {
      // Fix for Windows spawn EINVAL on Node 24: Use shellOption or true if it's cmd/bat
      const isCmdOrBat = typeof command === 'string' && (command.endsWith('.cmd') || command.endsWith('.bat'));
      let finalShell = shellOption;
      if (process.platform === 'win32' && isCmdOrBat) {
        finalShell = true;
        // Wrap arguments containing spaces in double quotes when shell:true
        commandArgs = commandArgs.map(arg => {
          if (typeof arg === 'string' && arg.includes(' ') && !arg.startsWith('"') && !arg.endsWith('"')) {
            return `"${arg}"`;
          }
          return arg;
        });
      } else {
        options.shell = finalShell;
      }

      options.shell = finalShell;

      logInfo('runner', `Spawning project ${id} [${plan.kind}] command: ${command} ${commandArgs.join(' ')} (shell: ${options.shell})`);
      
      let proc;
      const finalCommand = options.shell ? [command, ...commandArgs].join(' ') : command;
      const finalArgs = options.shell ? [] : commandArgs;
      try {
        proc = spawn(finalCommand, finalArgs, options);
      } catch (spawnErr) {
        logError('runner', `Sync spawn failed for command ${command}: ${spawnErr.message}`);
        recordLog(id, `Sync spawn error: ${spawnErr.message}`);
        processState.status = 'error';
        reject(spawnErr);
        return;
      }

      processState.child = proc;

      let resolved = false;
      let stdoutRemainder = '';
      let stderrRemainder = '';

      const handleData = (chunk, isStderr) => {
        const text = chunk.toString();
        const lines = (isStderr ? (stderrRemainder + text) : (stdoutRemainder + text)).split(/\r?\n/);
        
        if (isStderr) {
          stderrRemainder = lines.pop();
        } else {
          stdoutRemainder = lines.pop();
        }

        for (const line of lines) {
          recordLog(id, line);
          if (!resolved) {
            const detected = extractPort(line);
            if (detected && detected > 0 && detected < 65536) {
              resolved = true;
              clearTimeout(timeoutId);
              processState.port = detected;
              processState.status = 'running';
              resolve(detected);
            }
          }
        }
      };

      proc.stdout.on('data', (chunk) => handleData(chunk, false));
      proc.stderr.on('data', (chunk) => handleData(chunk, true));

      proc.on('error', (err) => {
        recordLog(id, `Error: ${err.message}`);
        logError('runner', `Process error for project ${id}: ${err.message}`);
        
        if (!resolved) {
          // Fall back only for plain 'python' command
          if (command === 'python' && err.code === 'ENOENT') {
            recordLog(id, 'python not found, attempting to fall back to py...');
            clearTimeout(timeoutId);
            proc.removeAllListeners();
            spawnProcess('py', commandArgs, finalShell);
            return;
          }

          resolved = true;
          clearTimeout(timeoutId);
          processState.status = 'error';
          reject(err);
        } else {
          processState.status = 'error';
        }
      });

      proc.on('close', (code) => {
        recordLog(id, `Process exited with code ${code}`);
        if (code !== null && code !== 0) {
          logError('runner', `Project ${id} process exited with error code ${code}`);
        }

        // Launcher-style kinds (script/custom/multi) spawn detached services then exit;
        // their own exit code (often 1 from a trailing taskkill/pause) does NOT reflect the
        // spawned services. Treat any exit as "launched" and let probePort verify the real port.
        if (!resolved && (plan.kind === 'script' || plan.kind === 'custom' || plan.kind === 'multi')) {
          resolved = true;
          clearTimeout(timeoutId);
          processState.status = 'running';
          processState.port = plan.port || null;
          resolve(plan.port || null);
          return;
        }

        if (processState.status === 'starting' || processState.status === 'running') {
          processState.status = 'stopped';
        }

        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          reject(new Error(`Process exited early with code ${code}`));
        }
      });

      // 8 seconds port detection timeout
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (plan.expectsWeb) {
            // Web service fallback
            const fallbackPort = plan.port || 3000;
            processState.port = fallbackPort;
            processState.status = 'running';
            recordLog(id, `Port detection timed out after 8s. Falling back to expected port ${fallbackPort}.`);
            resolve(fallbackPort);
          } else {
            // Strongly implies non-web: resolve to null
            processState.port = null;
            processState.status = 'running';
            recordLog(id, `Port detection timed out after 8s. No port expected. Treating as non-web project.`);
            resolve(null);
          }
        }
      }, 8000);
    };

    spawnProcess(plan.cmd, plan.args, plan.shell);
  });
}

/**
 * Stops a running process.
 * @param {string} id Project ID
 */
/**
 * Takes ownership of a process Maktaba did not start, so it can be stopped.
 *
 * Measured: psscan ties 23 live processes to catalogued projects and 13 of them
 * hold listening ports, and NOT ONE could be stopped — stop() only knows the
 * children start() spawned. Worse, start() consults the same private map, so
 * pressing Run on a project that is already running launched a SECOND copy on
 * the same port.
 *
 * Three things are refused outright, because getting any of them wrong is worse
 * than never adopting anything:
 *   * Maktaba's own row, and the process tree this server is running in
 *   * anything whose command line names a guardian
 *   * a match Maktaba is not confident about
 *
 * `listening_port` alone is not accepted as evidence: psscan can match a
 * process to a project BY its port, and adopting on that basis then killing it
 * would be acting on a circular inference.
 *
 * @param {Object} project Catalogue row
 * @param {Object} observed pid, startedAt, listeningPorts, confidence, matchedMethod, commandLine
 * @returns {{ok: boolean, error?: string, adopted?: Object}}
 */
function adopt(project, observed) {
  const id = project.id || sha1(project.path);
  const pid = Number(observed && observed.pid);

  // Positive integer, explicitly. Number.isInteger(-5) is true, so checking
  // only for an integer let a negative pid through to a value that is later
  // handed to taskkill.
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, error: 'رقم عملية غير صالح.' };
  if (pid === process.pid || pid === process.ppid) {
    return { ok: false, error: 'هذه عملية المكتبة نفسها.' };
  }
  if (observed.confidence !== 'high') {
    return { ok: false, error: 'الثقة في الربط ليست عالية — لن تتبنّى المكتبة عملية قد لا تكون لهذا المشروع.' };
  }
  if (observed.matchedMethod === 'listening_port') {
    // Circular: the process was identified BY the port, so the port cannot then
    // be the proof that this process belongs to the project.
    return { ok: false, error: 'المطابقة تمّت عبر رقم المنفذ وحده — دليل دائري لا يكفي للتبنّي.' };
  }
  // One shared list, not a regex written from memory: the previous one covered
  // three guardians and missed master-supervisor.js and run-guardian-hidden.vbs,
  // both of which are real files in tools/.
  if (require('./quarantine').isGuardianCommand(observed.commandLine)) {
    return { ok: false, error: 'حارس — إيقافه من هنا هو ما أسقط الخادم من قبل.' };
  }
  if (runningProcesses.has(id)) {
    return { ok: false, error: 'المكتبة تتابع هذا المشروع بالفعل.' };
  }

  runningProcesses.set(id, {
    // No child handle: Maktaba never spawned this, so there is nothing to hold.
    child: null,
    pid,
    port: (observed.listeningPorts && observed.listeningPorts[0]) || null,
    // Null, not an empty array. An empty list of logs says "it produced none";
    // the truth is that nobody was listening when it started.
    logs: null,
    logsReason: 'العملية بدأت خارج المكتبة، فلم تُلتقط مخرجاتها.',
    startedAt: observed.startedAt ? new Date(observed.startedAt) : null,
    status: 'running',
    kind: 'adopted',
    origin: 'adopted',
    adoptedAt: new Date().toISOString(),
    commandLine: observed.commandLine || null
  });

  logInfo('runner', 'Adopted pid ' + pid + ' as ' + (project.name || id) + '.');
  return { ok: true, adopted: { id, pid, port: (observed.listeningPorts || [])[0] || null } };
}

/**
 * Confirms a PID is still the process that was adopted, immediately before
 * acting on it.
 *
 * Windows reuses PID numbers, and psscan's data is a snapshot. Killing by a
 * number that has since been handed to something else is the exact accident
 * this check exists to prevent, so the command line is re-read and compared.
 *
 * @param {number} pid The process id
 * @param {string} expected The command line recorded at adoption
 * @returns {boolean} True only when it still matches
 */
function stillTheSameProcess(pid, expected) {
  if (!expected) return false;
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '").CommandLine'],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
    if (!out) return false;
    return out.trim() === String(expected).trim();
  } catch (err) {
    // Unreadable means unverified, and unverified means we do not kill it.
    return false;
  }
}

function stop(id) {
  const processState = runningProcesses.get(id);
  if (!processState) return;

  // An adopted process has no child handle — Maktaba never spawned it — so it
  // is stopped by pid, and only after confirming the pid is still the same
  // process that was adopted.
  if (processState.origin === 'adopted') {
    const pid = processState.pid;
    if (!stillTheSameProcess(pid, processState.commandLine)) {
      runningProcesses.delete(id);
      logError('runner', new Error('Refused to stop pid ' + pid + ': it is no longer the adopted process.'));
      return { ok: false, error: 'رقم العملية لم يعد يخصّ نفس البرنامج — لم يُنفَّذ أي إيقاف.' };
    }
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => {});
      logInfo('runner', 'Stopped adopted pid ' + pid + '.');
    } catch (err) {
      logError('runner', err);
      return { ok: false, error: err.message };
    }
    runningProcesses.delete(id);
    return { ok: true };
  }

  if (Array.isArray(processState.children) && processState.children.length > 0) {
    recordLog(id, 'Stopping all services...');
    for (const service of processState.children) {
      const { child, name } = service;
      if (child) {
        recordLog(id, `Stopping service [${name}] (PID: ${child.pid})...`);
        try {
          if (process.platform === 'win32') {
            const killer = spawn('taskkill', ['/pid', child.pid, '/T', '/F']);
            // A failed spawn emits an async 'error' event that escapes this
            // try/catch and would surface as an uncaughtException — swallow it.
            killer.on('error', () => {});
          } else {
            child.kill('SIGTERM');
          }
        } catch (err) {
          logError('runner', `Failed to kill service child process ${child.pid} [${name}] for project ${id}: ${err.message}`);
          recordLog(id, `Failed to kill service [${name}]: ${err.message}`);
        }
      }
    }
  } else {
    const { child } = processState;
    if (child) {
      recordLog(id, 'Stopping process...');
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', child.pid, '/T', '/F']);
          // Swallow the async spawn 'error' event so it can't crash the server.
          killer.on('error', () => {});
        } else {
          child.kill('SIGTERM');
        }
      } catch (err) {
        logError('runner', `Failed to kill child process ${child.pid} for project ${id}: ${err.message}`);
        recordLog(id, `Failed to kill process: ${err.message}`);
      }
    }
  }
  processState.status = 'stopped';
}

/**
 * Returns status of a project.
 */
function status(id) {
  const processState = runningProcesses.get(id);
  if (!processState) return { status: 'stopped', port: null, kind: null };
  return {
    status: processState.status,
    port: processState.port,
    startedAt: processState.startedAt,
    kind: processState.kind
  };
}

/**
 * Returns lists of all running/starting projects.
 */
function listRunning() {
  const list = [];
  for (const [id, proc] of runningProcesses.entries()) {
    if (proc.status === 'starting' || proc.status === 'running') {
      list.push({
        id,
        status: proc.status,
        port: proc.port,
        startedAt: proc.startedAt,
        kind: proc.kind
      });
    }
  }
  return list;
}

/**
 * Returns logs array for a project.
 */
function getLogs(id) {
  const processState = runningProcesses.get(id);
  return processState ? processState.logs : [];
}

module.exports = {
  start,
  adopt,
  stillTheSameProcess,
  stop,
  status,
  listRunning,
  getLogs
};
