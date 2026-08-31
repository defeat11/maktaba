const fs = require('fs');
const path = require('path');
const store = require('./store');

function addToGitignore(line) {
  const gitignorePath = path.join(__dirname, '../.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      let content = fs.readFileSync(gitignorePath, 'utf8');
      const lines = content.split(/\r?\n/);
      if (!lines.includes(line)) {
        const ending = content.endsWith('\n') ? '' : '\n';
        fs.appendFileSync(gitignorePath, ending + line + '\n', 'utf8');
      }
    } catch (err) {
      console.warn('Failed to append to .gitignore:', err.message);
    }
  }
}

function getTodayString() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function getDailyLimit() {
  const configPath = path.join(__dirname, '../config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.doctorDailyBudget !== undefined) {
        return Number(config.doctorDailyBudget);
      }
    } catch (err) {
      console.warn('Failed to read doctorDailyBudget from config.json, using default 8:', err.message);
    }
  }
  return 8;
}

const BUDGET_FILE = path.join(__dirname, '../doctor-budget.json');

function readBudget() {
  addToGitignore('doctor-budget.json');
  const today = getTodayString();
  if (fs.existsSync(BUDGET_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
      if (data && data.date === today) {
        return data;
      }
    } catch (err) {
      console.warn('Failed to read budget file, resetting:', err.message);
    }
  }
  return { date: today, count: 0 };
}

function writeBudget(budget) {
  try {
    fs.writeFileSync(BUDGET_FILE, JSON.stringify(budget, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to write budget file:', err.message);
  }
}

function backupDbBeforeCycle() {
  const rootDir = path.join(__dirname, '..');
  const backupsDir = path.join(rootDir, 'backups');

  if (!fs.existsSync(backupsDir)) {
    try {
      fs.mkdirSync(backupsDir, { recursive: true });
    } catch (err) {
      console.warn('Failed to create backups directory:', err.message);
      return;
    }
  }

  addToGitignore('backups/');

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const filesToBackup = ['db.sqlite', 'db.json'];
  for (const file of filesToBackup) {
    const srcPath = path.join(rootDir, file);
    if (fs.existsSync(srcPath)) {
      const destPath = path.join(backupsDir, `${file}.bak-${timestamp}`);
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch (err) {
        console.warn(`Failed to backup ${file}:`, err.message);
      }
    }
  }
}

async function checkRowCountSafe(beforeCount) {
  try {
    const currentProjects = await store.getProjects();
    const currentCount = currentProjects.length;

    let isUnsafe = false;
    if (beforeCount > 0) {
      const decrease = beforeCount - currentCount;
      if (decrease / beforeCount > 0.10) {
        isUnsafe = true;
      }
    }

    if (isUnsafe) {
      return { safe: false, before: beforeCount, after: currentCount };
    }
  } catch (err) {
    console.warn('Error checking row count safety:', err.message);
  }
  return { safe: true };
}

function canSpendBudget() {
  const limit = getDailyLimit();
  const budget = readBudget();
  return budget.count < limit;
}

function recordSpend() {
  const budget = readBudget();
  budget.count += 1;
  writeBudget(budget);
}

/**
 * Reports today's AI spend against the daily cap, for display in the UI.
 * The cap was previously invisible: nothing in public/ ever mentioned it, so
 * work could stop at the limit with only a log line to explain why.
 *
 * @returns {{spent: number, limit: number, remaining: number, date: string}}
 */
function getBudgetStatus() {
  const limit = getDailyLimit();
  const budget = readBudget();
  return {
    spent: budget.count,
    limit,
    remaining: Math.max(0, limit - budget.count),
    date: budget.date
  };
}

module.exports = {
  backupDbBeforeCycle,
  checkRowCountSafe,
  canSpendBudget,
  recordSpend,
  getBudgetStatus
};
