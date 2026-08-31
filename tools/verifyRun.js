// Exit codes are the health signal the doctor pipeline reads:
//
//   0  ok       — a POSITIVE sign of life (a port/listening banner, or a clean
//                 exit from something that was never meant to serve)
//   1  broken   — the project itself failed: non-zero exit with real output
//   2  usage    — bad arguments / unknown project id
//   3  unknown  — we could not tell: timed out, could not be spawned at all,
//                 or the launch plan is not something we know how to check
//
// The unknown state is the point of this scheme. Before it, a timeout exited 0,
// so a project that started and hung read as healthy — and a spawn failure on
// maktaba's side exited 1, marking perfectly good code "broken" and making it a
// target for an AI agent to rewrite. Both directions were wrong.
const EXIT_OK = 0;
const EXIT_BROKEN = 1;
const EXIT_USAGE = 2;
const EXIT_UNKNOWN = 3;

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

/**
 * True for output lines that carry a "file:LINE" pair rather than a port.
 *
 * This matters more than it looks. The success test used to be /:\d{4,5}\b/
 * over the whole output, and a Node crash dump opens with
 * `node:internal/modules/cjs/loader:1459` — a four-digit line number that the
 * pattern reads as a port. So a project that could not start at all was
 * declared healthy by its own crash trace, which is a large part of why the
 * repair pipeline never found anything to repair.
 *
 * @param {string} line One line of child output
 * @returns {boolean} True when the line is stack-trace or module-path noise
 */
function isStackNoise(line) {
  return /^\s*at\s/.test(line)
    || /node:internal/.test(line)
    || /\.(js|mjs|cjs|ts|jsx|tsx|py|rb|go):\d+/.test(line)
    || /^\s*require stack:/i.test(line)
    || /^\s*-\s+\S+\.(js|mjs|cjs|ts)\b/i.test(line)
    || /^\s*(throw err|\^+)\s*$/.test(line);
}

/**
 * True when the output shows that WE never had a workable way to start the
 * project — as opposed to the project itself failing.
 *
 * This distinction decides which projects an AI agent gets pointed at, and it
 * was wrong for 6 of 8 candidates in a real scan: a Python project carrying a
 * small package.json for browser tooling was typed as Node, run with npm, and
 * recorded as "broken" when npm reported no start script. Sending an agent to
 * repair a project that is not broken — to make a Python program run under
 * Node — is the most harmful thing this pipeline could do.
 *
 * The discriminator for a missing module is the require stack. Node prints an
 * empty `requireStack: []` when the ENTRY FILE ITSELF could not be resolved,
 * which means the launch plan named a file that is not there. A non-empty stack
 * means the project's own code asked for something missing — that is a genuine
 * fault and must stay 'broken'.
 *
 * @param {string} output Accumulated child output
 * @returns {boolean} True when the failure is on the launcher's side
 */
function isLauncherSideFailure(output) {
  const text = String(output || '');
  // npm was handed a script that the project does not define.
  if (/npm (error|ERR!)\s+Missing script/i.test(text)) return true;
  // python was handed a file that does not exist.
  if (/python:\s*can't open file/i.test(text)) return true;
  // The entry module we chose could not be resolved at all.
  if (/MODULE_NOT_FOUND/.test(text) && /requireStack:\s*\[\s*\]/.test(text)) return true;
  // Same case, the human-readable form: a Require stack with no frames.
  if (/Cannot find module/.test(text) && /Require stack:\s*(\r?\n\s*)*$/.test(text)) return true;
  // Browser code handed to node. kitchen-app's package.json declares a main
  // that is not on disk, so the launcher fell back to app.js — a file full of
  // document.getElementById — and the resulting ReferenceError was stored as
  // the project's health. Running frontend code under node is always our
  // mistake about how to start the project, never a defect in the project.
  if (/ReferenceError:\s*(document|window|localStorage|navigator|alert) is not defined/.test(text)) return true;
  // A toolchain this machine does not have. label-tool reports
  // "JAVA_HOME is not set and no 'java' command could be found in your PATH":
  // the project is not broken and we did not start it wrongly — the runtime it
  // needs is simply absent here, so its health cannot be determined. Pointing an
  // agent at this would have it install a JDK or hardcode a path into someone
  // else's build.
  if (/is not set and no '[^']+' command could be found/i.test(text)) return true;
  if (/is not recognized as an internal or external command/i.test(text)) return true;
  if (/:\s*command not found/i.test(text)) return true;
  return false;
}

/**
 * Looks for a positive sign that a server actually came up.
 * Only non-noise lines are considered, and a bare number is never enough on
 * its own — it has to be a URL, or sit next to language that means "up".
 *
 * @param {string} output Accumulated child output
 * @returns {boolean} True when the output announces a running server
 */
function hasServerBanner(output) {
  const lines = String(output || '').split(/\r?\n/).filter(l => !isStackNoise(l));
  for (const raw of lines) {
    const line = raw.toLowerCase();
    // A URL is the strongest and least ambiguous signal.
    if (/https?:\/\/[^\s"'<>]*:\d{2,5}\b/.test(line)) return true;
    // Explicit "up" language, with or without a port next to it.
    if (/(listening|local:|running on|running at|server (started|running|ready)|started server|app listening|ready (in|on|at)\b)/.test(line)) return true;
    // "port 3000", "port: 8080", "port=5173" — the word carries the meaning.
    if (/\bport\b\s*[:=]?\s*\d{2,5}\b/.test(line)) return true;
  }
  return false;
}

async function main() {
  const projectId = process.argv[2];
  if (!projectId) {
    console.error("Project ID parameter is missing.");
    process.exit(2);
  }

  let child = null;
  let hasDecided = false;
  let timer20s = null;
  let combinedOutput = '';

  function killProcessTree(childProcess) {
    if (!childProcess || childProcess.killed) return;
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${childProcess.pid} /T /F`, { stdio: 'ignore' });
      } else {
        childProcess.kill('SIGKILL');
      }
    } catch (err) {
      try {
        childProcess.kill('SIGKILL');
      } catch (e) {}
    }
  }

  function cleanUp() {
    if (timer20s) {
      clearTimeout(timer20s);
      timer20s = null;
    }
    if (child) {
      killProcessTree(child);
    }
  }

  // Ensure clean up when this parent process exits
  process.on('exit', () => {
    cleanUp();
  });

  try {
    const store = require('../lib/store');
    const projects = await store.getProjects();
    const project = projects.find(p => p.id === projectId);
    
    if (!project) {
      console.error(`Project with ID ${projectId} not found.`);
      process.exit(2);
    }

    const launcher = require('../lib/launcher');
    const plan = launcher.planLaunch(project);

    // A plan we cannot actually execute (e.g. a 'multi' plan that carries
    // services but no cmd/args) is not evidence that the project is broken.
    // Spreading undefined args here used to throw and exit 1, which marked
    // working projects broken.
    if (!plan || !plan.cmd || (!plan.shell && !Array.isArray(plan.args))) {
      console.error(`Unsupported launch plan (kind=${plan && plan.kind}) — cannot verify this project.`);
      process.exit(EXIT_UNKNOWN);
    }

    const finalCmd = plan.shell ? [plan.cmd, ...(plan.args || [])].join(' ') : plan.cmd;
    const finalArgs = plan.shell ? [] : plan.args;
    let sawSuccessSignal = false;

    child = spawn(finalCmd, finalArgs, {
      cwd: project.path,
      shell: plan.shell,
      windowsHide: true
    });

    const checkOutput = (output) => {
      if (hasDecided) return;
      if (!hasServerBanner(output)) return;
      sawSuccessSignal = true;
      hasDecided = true;
      cleanUp();
      process.exit(EXIT_OK);
    };

    child.stdout.on('data', (data) => {
      combinedOutput += data.toString('utf8');
      checkOutput(combinedOutput);
    });

    child.stderr.on('data', (data) => {
      combinedOutput += data.toString('utf8');
      checkOutput(combinedOutput);
    });

    timer20s = setTimeout(() => {
      if (hasDecided) return;
      hasDecided = true;
      cleanUp();
      // Still alive after 20s with no sign of serving. That is not health —
      // it is the absence of information. Exiting 0 here is what made 22 rows
      // read 'ok' while carrying maktaba's own startup line as their evidence.
      console.error('Timed out after 20s with no success signal — health is unknown.');
      process.exit(EXIT_UNKNOWN);
    }, 20000);

    child.on('exit', (code, signal) => {
      if (hasDecided) return;
      hasDecided = true;
      cleanUp();

      if (code !== null && code !== 0) {
        const lines = combinedOutput.split('\n');
        const last40 = lines.slice(-40).join('\n');
        console.error(last40);
        // A non-zero exit that produced no output at all is more likely a
        // launch problem on our side than a fault in the project.
        if (combinedOutput.trim().length === 0) process.exit(EXIT_UNKNOWN);
        // Nor is it the project's fault when the command we chose was never
        // one it could run.
        if (isLauncherSideFailure(combinedOutput)) {
          console.error('The launch command was not one this project supports — health is unknown, not broken.');
          process.exit(EXIT_UNKNOWN);
        }
        process.exit(EXIT_BROKEN);
      }

      // Clean exit. For something that was never expected to serve (a CLI
      // script, a one-shot python job) that is a real pass. For a web project
      // that exited immediately without ever announcing a port, it is not.
      if (plan.expectsWeb && !sawSuccessSignal) {
        console.error('Web project exited cleanly without ever announcing a port — health is unknown.');
        process.exit(EXIT_UNKNOWN);
      }
      process.exit(EXIT_OK);
    });

    child.on('error', (err) => {
      if (hasDecided) return;
      hasDecided = true;
      cleanUp();
      // ENOENT and friends mean WE could not start it (missing runtime, bad
      // command) — that says nothing about the project's own health, and must
      // never mark it broken and hand it to an agent.
      console.error('Could not spawn the project: ' + err.message);
      process.exit(EXIT_UNKNOWN);
    });

  } catch (err) {
    hasDecided = true;
    cleanUp();
    console.error('Unexpected error in verification: ' + err.message);
    process.exit(EXIT_UNKNOWN);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  // Exported for tests; requiring this file does not run main().
  hasServerBanner,
  isLauncherSideFailure,
  isStackNoise,
  EXIT_OK,
  EXIT_BROKEN,
  EXIT_USAGE,
  EXIT_UNKNOWN
};
