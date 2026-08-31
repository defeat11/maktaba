const fs = require('fs');
const path = require('path');

function isInteractiveScript(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, 'utf8');
    const lowerContent = content.toLowerCase();
    if (lowerContent.includes('set /p')) {
      return true;
    }
    if (/\bchoice\b/i.test(content) || lowerContent.includes('choice.exe')) {
      return true;
    }
    if (lowerContent.includes('goto menu') || lowerContent.includes('goto :menu') || lowerContent.includes('goto choice')) {
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function buildCustomPlan(commandString, port) {
  const plan = {
    cmd: commandString.trim(),
    args: [],
    shell: true,
    kind: 'custom',
    expectsWeb: true,
    port: port || 3000,
    stdinIgnore: true
  };
  if (plan.port) {
    plan.env = {
      PORT: String(plan.port)
    };
  }
  return plan;
}

/**
 * Plans the launch parameters for a project based on its type and dependencies.
 * 
 * @param {Object} project Project metadata object containing path, type, port, and entryFile.
 * @returns {Object} { cmd, args, shell, kind, expectsWeb, port, env }
 */
function planLaunch(project) {
  const projectDir = project.path;
  const type = project.type || 'Static';
  const entryFile = project.entryFile;
  const metadataPort = project.assignedPort || project.port;

  // 1) User command (highest priority)
  if (project.userRunCommandSet === true && project.runCommand && typeof project.runCommand === 'string' && project.runCommand.trim() !== '') {
    return buildCustomPlan(project.runCommand, metadataPort);
  }

  // 2) AI profile multi-service
  if (project.aiProfile && project.aiProfile.runMode === 'multi' && Array.isArray(project.aiProfile.services) && project.aiProfile.services.length > 0) {
    const services = project.aiProfile.services;
    const primaryService = services.find(s => s.primary) || services[0];
    const totalPort = (primaryService && primaryService.port) ? primaryService.port : (services[0] && services[0].port ? services[0].port : 3000);

    return {
      kind: 'multi',
      services: services.map(s => {
        const sDir = s.dir || '.';
        return {
          name: s.name,
          dir: sDir,
          cwd: path.join(projectDir, sDir),
          command: s.command,
          port: s.port,
          env: s.port ? { PORT: String(s.port) } : {}
        };
      }),
      shell: true,
      expectsWeb: true,
      port: totalPort,
      primaryName: primaryService ? primaryService.name : ''
    };
  }

  // 3) AI profile script mode
  if (project.aiProfile && project.aiProfile.runMode === 'script' && project.aiProfile.runCommand && typeof project.aiProfile.runCommand === 'string' && project.aiProfile.runCommand.trim() !== '') {
    return buildCustomPlan(project.aiProfile.runCommand, metadataPort);
  }

  // 4) Legacy custom command (single)
  if (project.runCommand && typeof project.runCommand === 'string' && project.runCommand.trim() !== '') {
    return buildCustomPlan(project.runCommand, metadataPort);
  }

  // B) Script detection
  let files = [];
  try {
    files = fs.readdirSync(projectDir);
  } catch (err) {
    // Ignore read errors
  }

  const scriptOrder = [
    'start-all.bat', 'start_all.bat', 'run-project.bat', 'run_project.bat', 'start-server.bat', 'start_server.bat', 
    'run-original.bat', 'start-dev.bat', 'dev.bat', 'startup.bat', 'start.bat', 'run-all.bat', 'run_all.bat', 'run.bat', 'run_bot.bat', 'launch.bat', 'serve.bat',
    'start-all.cmd', 'run-project.cmd', 'run_project.cmd', 'start-server.cmd', 'start_server.cmd', 'run-original.cmd', 'start-dev.cmd', 'dev.cmd', 'startup.cmd', 'start.cmd', 'run.cmd',
    'start-all.sh', 'start.sh', 'run.sh', 'run_bot.sh'
  ];

  const lowerFilesMap = {};
  files.forEach(f => {
    lowerFilesMap[f.toLowerCase()] = f;
  });

  let matchedScript = null;
  for (const s of scriptOrder) {
    const sLower = s.toLowerCase();
    if (lowerFilesMap[sLower]) {
      const candidateScript = lowerFilesMap[sLower];
      const absScript = path.join(projectDir, candidateScript);
      if (sLower.endsWith('.bat') || sLower.endsWith('.cmd')) {
        if (isInteractiveScript(absScript)) {
          continue;
        }
      }
      matchedScript = candidateScript;
      break;
    }
  }

  if (!matchedScript) {
    const batFiles = files.filter(f => f.toLowerCase().endsWith('.bat'));
    if (batFiles.length === 1) {
      const absScript = path.join(projectDir, batFiles[0]);
      if (!isInteractiveScript(absScript)) {
        matchedScript = batFiles[0];
      }
    }
  }

  if (matchedScript) {
    const sScript = matchedScript;
    const lowerScript = sScript.toLowerCase();
    let plan = null;

    const absScript = path.join(projectDir, sScript);
    if (process.platform === 'win32' && (lowerScript.endsWith('.bat') || lowerScript.endsWith('.cmd'))) {
      plan = {
        cmd: 'cmd',
        args: ['/c', absScript],
        shell: false,
        kind: 'script',
        expectsWeb: true,
        port: metadataPort || 3000,
        stdinIgnore: true
      };
    } else if (lowerScript.endsWith('.sh')) {
      plan = {
        cmd: 'bash',
        args: [absScript],
        shell: false,
        kind: 'script',
        expectsWeb: true,
        port: metadataPort || 3000,
        stdinIgnore: true
      };
    } else if (lowerScript.endsWith('.bat') || lowerScript.endsWith('.cmd')) {
      plan = {
        cmd: sScript,
        args: [],
        shell: true,
        kind: 'script',
        expectsWeb: true,
        port: metadataPort || 3000,
        stdinIgnore: true
      };
    }

    if (plan) {
      if (plan.port) {
        plan.env = {
          PORT: String(plan.port)
        };
      }
      return plan;
    }
  }

  // Read package.json if it exists
  let pkg = null;
  let allDeps = {};
  let scripts = {};
  try {
    const pkgPath = path.join(projectDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      scripts = pkg.scripts || {};
      allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {})
      };
    }
  } catch (err) {
    // Ignore read/parse errors
  }

  // Helper to determine free or fallback port
  const findFreePort = (defaultPort = 3000) => {
    return metadataPort || defaultPort;
  };

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  let plan;

  // 1. NODE PROJECT DECISION LOGIC
  if (pkg) {
    if (scripts.dev) {
      const devPort = findFreePort(5173);
      plan = {
        cmd: npmCmd,
        args: ['run', 'dev', '--', '--port', String(devPort)],
        shell: true,
        kind: 'node-dev',
        expectsWeb: true,
        port: devPort
      };
    } else if (scripts.start) {
      // Check if start script implies a web app
      const webDeps = [
        'react', 'react-dom', 'next', 'express', 'koa', 'fastify',
        '@nestjs/core', 'vue', 'svelte', 'react-scripts'
      ];
      const expectsWeb = webDeps.some(dep => allDeps[dep] !== undefined);
      plan = {
        cmd: npmCmd,
        args: ['start'],
        shell: true,
        kind: 'node-start',
        expectsWeb: expectsWeb,
        port: findFreePort(3000)
      };
    } else if (scripts.serve) {
      plan = {
        cmd: npmCmd,
        args: ['run', 'serve'],
        shell: true,
        kind: 'node-serve',
        expectsWeb: true,
        port: findFreePort(8080)
      };
    } else {
      // Direct node file execution.
      //
      // package.json's own "main" is the project's declaration of its entry
      // point and outranks anything inferred from filenames. Without that,
      // kitchen-app — whose main is index.js — was launched as app.js,
      // a browser-side file, and died on `document is not defined`. That was
      // then stored as the project's health and it became a repair candidate,
      // when nothing about it is broken.
      //
      // A file that touches document/window at the top level is browser code
      // and must never be handed to node, whatever its name.
      const looksLikeBrowserCode = (src) =>
        /^\s*(const|let|var)\s+\w+\s*=\s*document\./m.test(src) ||
        /\bdocument\.(getElementById|querySelector|addEventListener)\b/.test(src);

      const readIfPresent = (name) => {
        if (!name) return null;
        try {
          const full = path.join(projectDir, name);
          return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
        } catch (e) { return null; }
      };

      let entry = null;
      let entryContent = '';
      for (const candidate of [pkg && pkg.main, entryFile, 'index.js', 'server.js', 'main.js', 'app.js']) {
        const src = readIfPresent(candidate);
        if (src === null) continue;
        if (looksLikeBrowserCode(src)) continue;
        entry = candidate;
        entryContent = src;
        break;
      }
      if (!entry) entry = entryFile || 'index.js';

      const hasExpressOrSimilar = ['express', 'koa', 'fastify', 'http'].some(dep => allDeps[dep] !== undefined);
      const looksLikeServer = hasExpressOrSimilar || 
                              entryContent.includes('express') || 
                              entryContent.includes('createServer') || 
                              entryContent.includes('listen(');

      plan = {
        cmd: 'node',
        args: [entry],
        shell: false,
        kind: 'node-file',
        expectsWeb: looksLikeServer,
        port: findFreePort(3000)
      };
    }
  } else {
    // 2. STATIC PROJECT DECISION LOGIC
    const hasIndexHtml = fs.existsSync(path.join(projectDir, 'index.html'));
    if (type === 'Static' || hasIndexHtml) {
      const staticPort = findFreePort(5500);
      const staticServerScript = path.join(__dirname, 'staticserver.js');
      plan = {
        cmd: 'node',
        args: [staticServerScript, projectDir, String(staticPort)],
        shell: false,
        kind: 'static',
        expectsWeb: true,
        port: staticPort
      };
    }
    // 3. PYTHON PROJECT DECISION LOGIC
    else if (type === 'Python') {
      let pythonExe = 'python';
      const venvPaths = [
        path.join(projectDir, '.venv', 'Scripts', 'python.exe'),
        path.join(projectDir, 'venv', 'Scripts', 'python.exe'),
        path.join(projectDir, '.venv', 'bin', 'python'),
        path.join(projectDir, 'venv', 'bin', 'python')
      ];
      for (const p of venvPaths) {
        if (fs.existsSync(p)) {
          pythonExe = p;
          break;
        }
      }

      // Django
      const hasManagePy = fs.existsSync(path.join(projectDir, 'manage.py'));
      if (hasManagePy) {
        const djangoPort = findFreePort(8000);
        plan = {
          cmd: pythonExe,
          args: ['manage.py', 'runserver', String(djangoPort)],
          shell: false,
          kind: 'django',
          expectsWeb: true,
          port: djangoPort
        };
      } else {
        // Flask detection
        let isFlask = false;
        try {
          const reqPath = path.join(projectDir, 'requirements.txt');
          if (fs.existsSync(reqPath)) {
            const reqs = fs.readFileSync(reqPath, 'utf8');
            if (/flask/i.test(reqs)) isFlask = true;
          }
          const pipPath = path.join(projectDir, 'Pipfile');
          if (fs.existsSync(pipPath)) {
            const pip = fs.readFileSync(pipPath, 'utf8');
            if (/flask/i.test(pip)) isFlask = true;
          }
          const flaskEntry = entryFile || 'app.py';
          const entryPath = path.join(projectDir, flaskEntry);
          if (fs.existsSync(entryPath)) {
            const content = fs.readFileSync(entryPath, 'utf8');
            if (content.includes('Flask(')) isFlask = true;
          }
        } catch (e) {}

        // Pick an entry file that is actually there.
        //
        // These defaults used to be applied blind: a project with no entryFile
        // was launched as `python app.py` (or main.py) whether or not such a
        // file existed. The scan then recorded "can't open file" as the
        // project's health, so folders that were merely missing that one
        // conventional name were listed as broken and became repair candidates.
        // Preferring a file that exists can only improve the plan — the
        // original default is still used when nothing better is found, and
        // verifyRun reports that case as unknown rather than broken.
        const pickEntry = (preferred, fallbacks) => {
          const candidates = [preferred, ...fallbacks].filter(Boolean);
          for (const c of candidates) {
            try {
              if (fs.existsSync(path.join(projectDir, c))) return c;
            } catch (e) { /* keep looking */ }
          }
          return preferred || fallbacks[0];
        };

        if (isFlask) {
          plan = {
            cmd: pythonExe,
            args: [pickEntry(entryFile, ['app.py', 'main.py', 'wsgi.py', 'server.py', 'run.py'])],
            shell: false,
            kind: 'flask',
            expectsWeb: true,
            port: findFreePort(5000)
          };
        } else {
          // Fallback Python file
          plan = {
            cmd: pythonExe,
            args: [pickEntry(entryFile, ['main.py', 'app.py', 'run.py', 'start.py', '__main__.py'])],
            shell: false,
            kind: 'python',
            expectsWeb: false,
            port: null
          };
        }
      }
    }
    // 4. PHP PROJECT DECISION LOGIC
    else if (type === 'PHP') {
      const phpPort = findFreePort(8000);
      plan = {
        cmd: 'php',
        args: ['-S', `127.0.0.1:${phpPort}`, '-t', projectDir],
        shell: false,
        kind: 'php',
        expectsWeb: true,
        port: phpPort
      };
    } else {
      throw new Error(`No launch strategy for type: ${type}`);
    }
  }

  // Inject PORT environment variable for all kinds if port is assigned
  if (plan && plan.port) {
    plan.env = {
      PORT: String(plan.port)
    };
  }

  return plan;
}

module.exports = {
  planLaunch
};
