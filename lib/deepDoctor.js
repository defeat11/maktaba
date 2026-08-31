const path = require('path');
const acpResolver = require('./acpResolver');
const launcher = require('./launcher');
const store = require('./store');
const { runVerifier, runDelegate } = require('./fixer');

/**
 * Executes a unified AI onboarding flow:
 * 1. AI analysis & profile generation
 * 2. Automated fixing using AI delegate (if fixes exist)
 * 3. Wiring up the launch parameters/command
 * 4. Verifying if the project executes successfully
 * 
 * @param {Object} project The project object.
 * @returns {Promise<Object>} Verification report.
 */
async function runDeep(project) {
  const report = {
    ok: false,
    structureKind: null,
    verdict: null,
    fixesCount: 0,
    fixesAuto: 0,
    fixesRisky: 0,
    fixesApplied: false,
    needsReview: false,
    fixSummary: 'لم يتم تطبيق أي إصلاحات.',
    runWired: false,
    runMode: null,
    runVerified: false,
    verifyExit: null,
    error: null
  };

  try {
    // 1. Run AI Onboarding Analysis
    const onboarding = await require('./aiOnboard').analyzeProject(project);
    if (!onboarding.ok) {
      report.error = onboarding.error || 'فشل تحليل المشروع.';
      return report;
    }

    const profile = onboarding.profile || {};
    report.structureKind = profile.structureKind || null;
    report.verdict = profile.verdict || '';
    report.runMode = profile.runMode || null;
    report.fixesCount = Array.isArray(profile.fixes) ? profile.fixes.length : 0;

    // 2. Automatically apply fixes if they are proposed
    if (report.fixesCount > 0) {
      const delegate = acpResolver.resolveDelegate();
      if (!delegate) {
        report.fixesApplied = false;
        report.fixSummary = 'تعذر تطبيق الإصلاحات لعدم توفر أداة acp/agy.';
      } else {
        const verifyRunPath = path.join(__dirname, '..', 'tools', 'verifyRun.js');
        const verifyCmd = `node "${verifyRunPath}" ${project.id}`;

        // The analysis step asks the model to tag each fix `safe`, the UI shows
        // that tag to the user — and then this step used to send every fix to
        // the agent regardless, so the only risk assessment the pipeline
        // produces was discarded at the one moment it mattered. Only an
        // explicit `safe: false` is withheld; an absent flag (null) keeps the
        // previous behaviour rather than silently applying nothing.
        const riskyFixes = profile.fixes.filter(f => f.safe === false);
        const autoFixes = profile.fixes.filter(f => f.safe !== false);

        report.fixesRisky = riskyFixes.length;
        report.fixesAuto = autoFixes.length;

        if (autoFixes.length === 0) {
          // Nothing safe to hand an agent — but wiring the run command and
          // verifying (steps 3 and 4) are non-destructive and still useful, so
          // fall through rather than returning early.
          report.fixesApplied = false;
          report.needsReview = true;
          report.fixSummary =
            `كل الإصلاحات المقترحة (${riskyFixes.length}) موسومة بأنها غير آمنة للتطبيق التلقائي — تحتاج مراجعتك.`;
        } else {

        const fixesList = autoFixes.map((f, i) => {
          const safety = f.safe === true ? 'موسوم آمن' : 'غير موسوم — كن متحفظاً';
          return `${i + 1}. الهدف: ${f.target}\n   التفاصيل: ${f.detail}\n   الإجراء: ${f.action}\n   التصنيف: ${safety}`;
        }).join('\n');

        const withheldNote = riskyFixes.length > 0
          ? `\nملاحظة: حُجبت عنك ${riskyFixes.length} إصلاحات موسومة بأنها خطِرة — لا تنفّذها ولا تخمّنها.`
          : '';

        const prompt = `هذا المشروع يحتاج إلى الإصلاحات التالية التي تم اكتشافها بواسطة نظام التحليل:\n${fixesList}${withheldNote}\nقم بتطبيق هذه الإصلاحات فقط في المجلد، واجعل المشروع قابلاً للتشغيل بنجاح دون إتلاف وظائفه أو إعادة كتابته من الصفر. لا تتردد في تشغيل الأوامر اللازمة مثل تثبيت الحزم (npm install) إذا لزم الأمر.`;

        try {
          const delegateResult = await runDelegate(delegate, verifyCmd, prompt, project.path);
          const parsed = require('./fixer').parseJSONFromOutput(delegateResult.stdout);
          const verify = parsed.verify;
          report.fixesApplied = !!(verify && verify.ok === true);
          report.fixSummary = (parsed.summary || '').trim();
        } catch (err) {
          report.fixesApplied = false;
          report.fixSummary = 'خطأ أثناء تطبيق الإصلاحات: ' + err.message;
        }

        }   // end: autoFixes.length > 0
      }
    }

    // 3. Configure launch command and mode
    let updates = {
      aiProfile: profile,
      aiAnalyzedAt: onboarding.analyzedAt
    };

    if (profile.runCommand && project.userRunCommandSet !== true) {
      updates.runCommand = profile.runCommand;
      updates.userRunCommandSet = false;
      report.runWired = true;

      // Update in-memory object properties so the verifier uses them
      project.runCommand = profile.runCommand;
      project.userRunCommandSet = false;
    }

    if (typeof profile.port === 'number' && Number.isInteger(profile.port) && !project.userPortSet) {
      updates.assignedPort = profile.port;
      project.assignedPort = profile.port;
    }

    if (profile.runMode) {
      project.runMode = profile.runMode;
    }

    project.aiProfile = profile;
    project.aiAnalyzedAt = onboarding.analyzedAt;

    // Persist to store
    await store.saveAiProfile(project.id, updates);

    // 4. Verify execution
    const verifyRunPath = path.join(__dirname, '..', 'tools', 'verifyRun.js');
    const verifyResult = await runVerifier(verifyRunPath, project.id, project.path);
    report.verifyExit = verifyResult.code;
    report.runVerified = (verifyResult.code === 0);

    report.profile = profile;
    report.ok = true;
  } catch (err) {
    report.ok = false;
    report.error = err.message;
  }

  return report;
}

module.exports = {
  runDeep
};
