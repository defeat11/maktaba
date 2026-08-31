const fs = require('fs');
const path = require('path');

// Overridable so a test run does not write into the fleet's real error log.
//
// It did, and the effect was backwards: tools/unit/store.test.js proves the
// row-count guard refuses a bad save, and tools/integration-test.js proves the
// Host guard rejects evil.example.com — and each proof wrote an ERROR line to
// logs/error.log. truth-check then reported "111 errors in 24 hours, mostly
// store-rowguard (41) and security-host (32)", so the health of the project got
// worse every time its guards were shown to work. A report that cries wolf is
// the report nobody reads on the day something is actually wrong.
const LOGS_DIR = process.env.MAKTABA_LOGS_DIR || path.join(__dirname, '../logs');
const ERROR_LOG = path.join(LOGS_DIR, 'error.log');
const APP_LOG = path.join(LOGS_DIR, 'app.log');
// Structured, machine-readable mirror of every error (one JSON object per line).
const ERROR_JSONL = path.join(LOGS_DIR, 'error-reports.jsonl');
// Human-readable rolled-up report regenerated on demand / on startup.
const REPORT_MD = path.join(LOGS_DIR, 'ERROR-REPORT.md');

// Ensure the logs directory exists
try {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
} catch (err) {
  console.error('Failed to create logs directory:', err.message);
}

// Size ceilings. Nothing here rotated at all before: across 65 days of use
// error.log reached 3.2 MB, error-reports.jsonl 3.0 MB and app.log 1.2 MB, all
// growing forever with no upper bound. tools/maktaba-guardian.ps1 already
// solved this for its own log by keeping the tail past a cap, so the same shape
// is used here rather than introducing numbered rotation and a new class of
// file to reason about.
const MAX_LOG_BYTES = 5 * 1024 * 1024;
// Recent lines are the useful ones; this is how many survive a trim.
const KEEP_LINES = 2000;

/**
 * Appends a line, trimming the file to its most recent lines once it grows past
 * a size ceiling. Never throws: logging must not be able to fail its caller.
 *
 * @param {string} filePath Target file
 * @param {string} line Text to append, ending in a newline
 * @param {number} maxBytes Size past which the file is trimmed
 * @param {number} keepLines How many trailing lines to keep when trimming
 */
function appendBounded(filePath, line, maxBytes, keepLines) {
  try {
    fs.appendFileSync(filePath, line, 'utf8');
  } catch (err) {
    console.error('Failed to write to ' + path.basename(filePath) + ':', err.message);
    return;
  }
  try {
    if (fs.statSync(filePath).size <= maxBytes) return;
    const kept = fs.readFileSync(filePath, 'utf8').split(EOL_SPLIT).slice(-keepLines).join('\n');
    // Trimmed through a temp file and renamed: a trim interrupted halfway would
    // otherwise leave the log truncated in the middle of a record.
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, kept, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // A log that cannot be trimmed is a far smaller problem than one that throws.
    console.error('Failed to trim ' + path.basename(filePath) + ':', err.message);
  }
}

const EOL_SPLIT = /\r?\n/;

let _seq = 0;
function nextId() {
  _seq = (_seq + 1) % 1000000;
  return `${Date.now().toString(36)}-${_seq.toString(36)}`;
}

/**
 * Appends info log lines.
 *
 * @param {string} scope Category or file origin.
 * @param {string} msg Log message.
 */
function logInfo(scope, msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [INFO] [${scope}] ${msg}\n`;
  appendBounded(APP_LOG, line, MAX_LOG_BYTES, KEEP_LINES);
}

/**
 * Appends detailed error stack traces to error.log (human log) AND a structured
 * JSON record to error-reports.jsonl (machine log powering the error report).
 *
 * Backward compatible: existing callers pass (scope, err); `context` is optional.
 *
 * @param {string} scope Category or file origin.
 * @param {Error|string} err Error object or message.
 * @param {object} [context] Optional extra structured context (e.g. { route, projectId }).
 */
function logError(scope, err, context) {
  const timestamp = new Date().toISOString();
  const errMessage = err instanceof Error ? err.message : String(err);
  const errStack = err instanceof Error && err.stack ? err.stack : '';

  // 1) Existing human-readable text log (unchanged format for backward compat).
  const line = `[${timestamp}] [ERROR] [${scope}] ${errMessage}${errStack ? `\nStack:\n${errStack}` : ''}\n----------------------------------------\n`;
  appendBounded(ERROR_LOG, line, MAX_LOG_BYTES, KEEP_LINES);

  // 2) Structured record for the error-report API/UI. Never let report logging
  //    throw — that could recurse into logError and mask the original error.
  try {
    const record = { id: nextId(), time: timestamp, scope, message: errMessage, stack: errStack || null };
    if (context !== undefined && context !== null) record.context = context;
    // readErrorRecords/generateErrorReport read the last 1000 records, so
    // KEEP_LINES must stay comfortably above that or the report silently
    // loses the history it summarises.
    appendBounded(ERROR_JSONL, JSON.stringify(record) + '\n', MAX_LOG_BYTES, KEEP_LINES);
  } catch (e) {
    console.error('Failed to write structured error record:', e.message);
  }
}

/**
 * Reads the most recent structured error records (newest last).
 * @param {number} [limit] Max records to return (from the tail).
 */
function readErrorRecords(limit = 1000) {
  try {
    if (!fs.existsSync(ERROR_JSONL)) return [];
    const content = fs.readFileSync(ERROR_JSONL, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const slice = limit > 0 ? lines.slice(-limit) : lines;
    const out = [];
    for (const ln of slice) {
      try { out.push(JSON.parse(ln)); } catch (_) { /* skip a corrupt line */ }
    }
    return out;
  } catch (e) {
    console.error('Failed to read error records:', e.message);
    return [];
  }
}

/**
 * Groups recent errors by (scope + message) and returns a summary object
 * suitable for an API response or a report.
 * @param {number} [limit] How many recent records to consider.
 */
function summarizeErrors(limit = 1000) {
  const records = readErrorRecords(limit);
  const groups = new Map();
  for (const r of records) {
    const key = `${r.scope}\u0000${r.message}`;
    let g = groups.get(key);
    if (!g) {
      g = { scope: r.scope, message: r.message, count: 0, firstSeen: r.time, lastSeen: r.time, sampleStack: r.stack || null };
      groups.set(key, g);
    }
    g.count++;
    if (r.time < g.firstSeen) g.firstSeen = r.time;
    if (r.time > g.lastSeen) g.lastSeen = r.time;
    if (!g.sampleStack && r.stack) g.sampleStack = r.stack;
  }
  const list = Array.from(groups.values()).sort((a, b) => {
    if (a.lastSeen > b.lastSeen) return -1;
    if (a.lastSeen < b.lastSeen) return 1;
    return b.count - a.count;
  });
  return {
    generatedAt: new Date().toISOString(),
    total: records.length,
    uniqueGroups: list.length,
    groups: list,
    recent: records.slice(-50).reverse()
  };
}

function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * Builds a human-readable Markdown error report and writes it to logs/ERROR-REPORT.md.
 * Returns { path, markdown, summary }.
 * @param {number} [limit]
 */
function generateErrorReport(limit = 1000) {
  const summary = summarizeErrors(limit);
  let md = '';
  md += '# تقرير أخطاء مكتبة — Maktaba Error Report\n\n';
  md += `> أُنشئ في: ${summary.generatedAt}\n\n`;
  md += `- إجمالي الأخطاء المسجّلة (آخر ${limit}): **${summary.total}**\n`;
  md += `- عدد أنواع الأخطاء الفريدة: **${summary.uniqueGroups}**\n\n`;

  if (summary.total === 0) {
    md += '✅ **لا توجد أخطاء مسجّلة. النظام نظيف.**\n';
  } else {
    md += '## الأخطاء مجمّعة حسب النوع (الأحدث أولاً)\n\n';
    md += '| # | المصدر (scope) | الرسالة | العدد | أول ظهور | آخر ظهور |\n';
    md += '|---|----------------|---------|:-----:|----------|----------|\n';
    summary.groups.forEach((g, i) => {
      md += `| ${i + 1} | \`${escapeCell(g.scope)}\` | ${escapeCell(g.message).slice(0, 160)} | ${g.count} | ${g.firstSeen} | ${g.lastSeen} |\n`;
    });

    const topByCount = [...summary.groups].sort((a, b) => b.count - a.count).slice(0, 5);
    md += '\n## تفاصيل أكثر الأخطاء تكراراً\n\n';
    topByCount.forEach((g, i) => {
      md += `### ${i + 1}. \`${g.scope}\` — ${String(g.message).slice(0, 180)}  (×${g.count})\n\n`;
      md += `- أول ظهور: ${g.firstSeen}\n- آخر ظهور: ${g.lastSeen}\n\n`;
      if (g.sampleStack) {
        md += '```\n' + g.sampleStack.slice(0, 1500) + '\n```\n\n';
      }
    });
  }

  try {
    fs.writeFileSync(REPORT_MD, md, 'utf8');
  } catch (e) {
    console.error('Failed to write ERROR-REPORT.md:', e.message);
  }
  return { path: REPORT_MD, markdown: md, summary };
}

module.exports = {
  appendBounded,
  MAX_LOG_BYTES,
  KEEP_LINES,
  logInfo,
  logError,
  readErrorRecords,
  summarizeErrors,
  generateErrorReport,
  paths: { ERROR_LOG, APP_LOG, ERROR_JSONL, REPORT_MD }
};
