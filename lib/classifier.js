const fs = require('fs').promises;
const path = require('path');

function getExcludePatterns() {
  try {
    const config = require('../config.json');
    if (config && Array.isArray(config.excludePathPatterns)) {
      return config.excludePathPatterns;
    }
  } catch (err) {
    // ignore
  }
  return [];
}

/**
 * Classifies a project based on directory structure, configuration manifest files, 
 * modified times, and other signals to filter out editor extensions and other junk.
 * 
 * @param {Object} project Project metadata object
 * @returns {Promise<Object>} classification results { confidence, classification, signals }
 */
async function classifyProject(project) {
  const projectPath = project.path;
  const signals = [];
  let confidence = 0;

  try {
    // 1. HARD DISQUALIFIERS
    // A. Check path against excludePathPatterns
    const excludePathPatterns = getExcludePatterns();
    const normPath = projectPath.toLowerCase().replace(/\//g, '\\');
    if (excludePathPatterns.some(pat => normPath.includes(pat.toLowerCase()))) {
      return {
        confidence: 0,
        classification: 'not-project',
        signals: [{ label: 'المسار يطابق نمط استبعاد المحتوى المستهدف', points: 0 }]
      };
    }

    // B. Check package.json for editor extension signature
    let packageJson = null;
    try {
      const pkgContent = await fs.readFile(path.join(projectPath, 'package.json'), 'utf8');
      packageJson = JSON.parse(pkgContent);
    } catch (e) {}

    if (packageJson) {
      const isVsCodeExtension = 
        (packageJson.engines && packageJson.engines.vscode) || 
        (packageJson.publisher && packageJson.contributes);
      if (isVsCodeExtension) {
        return {
          confidence: 0,
          classification: 'not-project',
          signals: [{ label: 'إضافة لمحرر الأكواد (VS Code Extension)', points: 0 }]
        };
      }
    }

    // C. Check composer.json type
    let composerJson = null;
    try {
      const compContent = await fs.readFile(path.join(projectPath, 'composer.json'), 'utf8');
      composerJson = JSON.parse(compContent);
    } catch (e) {}

    if (composerJson && composerJson.type === 'library') {
      return {
        confidence: 0,
        classification: 'not-project',
        signals: [{ label: 'مكتبة ملحقة للمشروع (Composer Library)', points: 0 }]
      };
    }

    // 2. SCORING SCENARIOS
    let score = 0;

    // A. Git Directory existence (+40)
    let hasGit = false;
    try {
      const gitStat = await fs.stat(path.join(projectPath, '.git'));
      hasGit = gitStat.isDirectory();
    } catch (e) {}

    if (hasGit) {
      score += 40;
      signals.push({ label: 'يحتوي على مجلد .git', points: 40 });
    }

    // B. README content (+15)
    let readmeLength = 0;
    for (const name of ['README.md', 'README.txt', 'readme.md', 'readme.txt']) {
      try {
        const content = await fs.readFile(path.join(projectPath, name), 'utf8');
        readmeLength = content.trim().length;
        if (readmeLength > 0) break;
      } catch (e) {}
    }

    if (readmeLength > 120) {
      score += 15;
      signals.push({ label: 'يحتوي على ملف README بأكثر من 120 حرف', points: 15 });
    }

    // C. Source folder or code files (+15)
    let hasSrcFolderOrFiles = false;
    let entries = [];
    try {
      entries = await fs.readdir(projectPath, { withFileTypes: true });
    } catch (e) {}

    const srcDirs = new Set(['src', 'app', 'lib', 'public', 'pages', 'routes', 'source', 'components']);
    const codeExtensions = new Set(['.js', '.ts', '.py', '.php', '.java', '.go', '.cs', '.html', '.css']);

    const hasSourceDir = entries.some(entry => 
      entry.isDirectory() && srcDirs.has(entry.name.toLowerCase())
    );

    let codeFilesCount = 0;
    if (!hasSourceDir) {
      const codeFiles = entries.filter(entry => {
        if (!entry.isFile()) return false;
        const ext = path.extname(entry.name).toLowerCase();
        const nameLower = entry.name.toLowerCase();
        const isConfig = nameLower.includes('config');
        return codeExtensions.has(ext) && !isConfig;
      });
      codeFilesCount = codeFiles.length;
    }

    if (hasSourceDir) {
      score += 15;
      signals.push({ label: 'يحتوي على مجلد مصدر (مثل src أو app)', points: 15 });
    } else if (codeFilesCount >= 3) {
      score += 15;
      signals.push({ label: 'يحتوي على 3 ملفات برمجية أو أكثر في المجلد الرئيسي', points: 15 });
    }

    // D. Manifest Description (+10)
    let hasDescription = false;
    if (packageJson && typeof packageJson.description === 'string' && packageJson.description.trim()) {
      hasDescription = true;
    } else if (composerJson && typeof composerJson.description === 'string' && composerJson.description.trim()) {
      hasDescription = true;
    }

    if (hasDescription) {
      score += 10;
      signals.push({ label: 'يحتوي ملف التعريف على وصف للمشروع', points: 10 });
    }

    // E. Manifest Dependencies/Scripts (+10)
    let hasDepsOrScripts = false;
    if (packageJson) {
      if (packageJson.dependencies || packageJson.devDependencies || packageJson.scripts) {
        hasDepsOrScripts = true;
      }
    }
    if (composerJson) {
      if (composerJson.require || composerJson['require-dev'] || composerJson.scripts) {
        hasDepsOrScripts = true;
      }
    }

    if (hasDepsOrScripts) {
      score += 10;
      signals.push({ label: 'يحتوي ملف التعريف على حزم معتمدة أو برامج تشغيلية', points: 10 });
    }

    // F. AppData or dot-folder check (+10)
    const checkAppDataOrDotFolder = (p) => {
      const lower = p.toLowerCase();
      if (lower.includes('\\appdata\\') || lower.includes('/appdata/')) return true;
      const segments = p.split(/[\\/]/);
      return segments.some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..');
    };

    if (!checkAppDataOrDotFolder(projectPath)) {
      score += 10;
      signals.push({ label: 'مسار الملفات ليس تحت AppData أو مجلد مخفي', points: 10 });
    }

    // G. Modified within last 18 months (+5)
    let isRecent = false;
    if (project.lastModified) {
      const diffMs = Date.now() - new Date(project.lastModified).getTime();
      const eighteenMonthsMs = 18 * 30 * 24 * 60 * 60 * 1000;
      if (diffMs < eighteenMonthsMs) {
        isRecent = true;
      }
    }

    if (isRecent) {
      score += 5;
      signals.push({ label: 'تم التعديل على الملفات خلال آخر 18 شهراً', points: 5 });
    }

    // H. Folder name looks like a published package (-15)
    const base = path.basename(projectPath);
    const semverRegex = /-\d+\.\d+\.\d+/;
    const publisherRegex = /^[a-z0-9_-]+\.[a-z0-9_-]+-/;
    const isPackageBasename = semverRegex.test(base) || publisherRegex.test(base);

    if (isPackageBasename) {
      score -= 15;
      signals.push({ label: 'اسم المجلد يطابق نمط الحزم المنشورة أو الإضافات', points: -15 });
    }

    confidence = Math.max(0, Math.min(100, score));

  } catch (err) {
    console.error('Error during project classification:', err.message);
    signals.push({ label: `خطأ في الكشف: ${err.message}`, points: 0 });
  }

  // Set default classification based on score
  let classification = 'weak';
  if (confidence >= 55) classification = 'confirmed';
  else if (confidence >= 30) classification = 'likely';

  // Override auto-classification if manual override is defined
  if (project.userClassification === 'project') {
    classification = 'confirmed';
  } else if (project.userClassification === 'not-project') {
    classification = 'not-project';
  }

  return {
    confidence,
    classification,
    signals
  };
}

module.exports = { classifyProject };
