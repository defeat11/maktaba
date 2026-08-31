const { spawn } = require('child_process');
const { resolveDelegate } = require('./acpResolver');
const { logError, logInfo } = require('./logger');

/**
 * Runs the ACP delegate script to analyze the project in a read-only manner.
 */
function runDelegate(projectPath, prompt, resolved) {
  // Read-only analysis still costs an agent call, so it is capped too. This
  // path bypassed the daily budget entirely.
  const doctorGuard = require('./doctorGuard');
  if (!doctorGuard.canSpendBudget()) {
    const status = doctorGuard.getBudgetStatus();
    return Promise.reject(new Error(`تجاوز السقف اليومي لاستدعاءات الذكاء (${status.spent}/${status.limit}).`));
  }
  doctorGuard.recordSpend();

  return new Promise((resolve, reject) => {
    const child = resolved.mode === 'node'
      ? spawn(
          'node',
          [resolved.delegatePath, '--json', '--read-only', prompt],
          {
            cwd: projectPath,
            windowsHide: true,
            env: { ...process.env, ACP_DELEGATE_OPEN: '0' }
          }
        )
      : spawn(
          [resolved.cmd, '--json', '--read-only', `"${prompt.replace(/"/g, '\\"')}"`].join(' '),
          [],
          {
            cwd: projectPath,
            windowsHide: true,
            shell: true,
            env: { ...process.env, ACP_DELEGATE_OPEN: '0' }
          }
        );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // 3 minutes timeout (180000ms)
    const timeout = setTimeout(() => {
      // On Windows the delegate may run under a shell wrapper (shell: true);
      // child.kill() would only kill cmd.exe and leak the real node process,
      // so kill the whole tree with taskkill (same pattern as lib/fixer.js).
      try {
        if (process.platform === 'win32') {
          const { execSync } = require('child_process');
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch (err) {
        // Ignore kill errors
      }
      reject(new Error('Process timed out after 180000ms'));
    }, 180000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function parseDelegateJson(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(stdout.slice(start, end + 1));
    if (typeof obj.summary !== 'string') return null;
    return obj.summary.trim();
  } catch {
    return null;
  }
}

/**
 * Analyzes a project using AI to determine its onboarding profile/blueprint.
 * 
 * @param {Object} project The project object.
 * @returns {Promise<Object>} Results containing ok, profile, analyzedAt, and error.
 */
async function analyzeProject(project) {
  const nowStr = new Date().toISOString();

  if (!project || !project.path) {
    return { ok: false, error: 'مسار المشروع غير محدد.', analyzedAt: nowStr };
  }

  const resolved = resolveDelegate();
  if (!resolved) {
    return { ok: false, error: 'تعذّر العثور على acp', analyzedAt: nowStr };
  }

  try {
    const prompt = `مهمة قراءة فقط — لا تعدّل/تنشئ/تحذف أي ملف.
حلّل المشروع في هذا المجلد.
افحص بنية المجلد كاملة: عُدّ المجلدات الفرعية والملفات، اقرأ package.json (وأي manifest) لكل مجلد فرعي رئيسي، اقرأ ملفات .bat/.sh/.cmd و README وملفات الدخول مثل (server.js/index.js/app.py/main.py/bot.py، requirements.txt)، وافهم كيف تترابط المكوّنات.

احكم على بنية المشروع وحدد بدقة كيف يُشغَّل.

افحص كيف يجب تحديد وضع التشغيل runMode واختيار الخدمات بناءً على القواعد التالية بهذه الأولوية الدقيقة:
1. إذا أمكن تحديد خدمتين منفصلتين أو أكثر (حيث يكون لكل خدمة أمر تشغيل ومجلد ومنفذ خاص، سواء تم استنتاجها من مجلدات فرعية منفصلة أو من قراءة وفك محتوى ملفات .bat):
   - اختر runMode="multi" واملأ قائمة services[] كاملة.
   - افعل ذلك حتى لو وُجد مُطلِق موحّد (مثل ملف .bat) — لأن maktaba تفضل تشغيل وتتبّع كل خدمة على حدة (تحكّم وإيقاف وفحص صحة وصورة لكل خدمة). هذا أفضل بكثير من تفويض التشغيل لسكربت خارجي يفتح نوافذ منفصلة.
   - في قائمة services[] لكل خدمة، حدد بدقة: name، و dir (مسار نسبي، "." للجذر)، و command (الأمر الفعلي المباشر للخدمة)، و port، و primary (الخدمة الرئيسية/الويب)، و role. عيّن primary=true للخدمة الرئيسية (مثلاً gateway أو frontend الويب).
2. استخدم وضع runMode="script" فقط حين يكون هناك مُطلِق موحّد غير تفاعلي يشغّل الخدمات في نفس العملية/الطرفية (foreground) دون فتح نوافذ منفصلة عبر start (أو حين يتعذّر فصل الخدمات بوضوح). إن كان المُطلِق يستخدم أمر start لفتح نوافذ منفصلة، فضّل multi وفكّك الخدمات.
3. استخدم وضع runMode="single" فقط لمشروع يحتوي على خدمة واحدة بسيطة.
4. لا تستخدم مُطلِقاً تفاعلياً (يحتوي على set /p أو قائمة menu/choice) إطلاقاً.
5. في notes: اشرح المعمارية باللغة العربية بوضوح: كم خدمة تم رصدها ومنافذها وأيّها الخدمة الرئيسية وسبب اختيار هذا الوضع.

احكم على بنية المشروع وصنّفها كالتالي:
- حدد الحقل structureKind بإحدى القيم التالية:
  • single: مشروع واحد بسيط في مكان واحد.
  • distributed: مشروع واحد موزّع على عدة مجلدات/ملفات تخدم نفس الهدف وتترابط (مثل gateway + backend + ai-server يتواصلون) — يجب تشغيلها كلها معاً.
  • multi-project: عدة مشاريع مستقلة غير مترابطة داخل نفس المجلد (كلٌّ يُشغَّل وحده).
  • has-duplicates: يحتوي نسخاً مكررة واضحة (مجلدات backups/copies، نسخ بلاحقة - Copy، إصدارات v1/v2/old).
  • mixed: مزيج (مثلاً مشروع رئيسي + نسخ احتياطية + مجلد فرعي منفصل).
ملاحظة مهمة للتشغيل: إن كان structureKind = distributed فاجعل runMode = multi واملأ services[] بكل المكوّنات المترابطة اللازمة لتشغيل المشروع كوحدة واحدة.

املأ الحقول الجديدة المطلوبة كالتالي:
- verdict: شرح عربي واضح وموجز للحكم — ماذا اكتشفت ولماذا اخترت هذا التصنيف، وما المجلدات المكررة/المنفصلة/المترابطة.
- duplicates: قائمة النسخ المكررة، كل عنصر {path: مسار نسبي من جذر المشروع، kind: "backup" أو "copy" أو "version"، reason: سبب الاختيار باللغة العربية}.
- components: قائمة المكوّنات الرئيسية، كل عنصر {path: مسار نسبي، role: "gateway" أو "backend" أو "frontend" أو "ai" أو "worker" أو "shared" أو "other"، partOfPrimary: true إن كان جزءاً من المشروع الرئيسي الموحّد / false لغير ذلك}.
- suggestedClassification: التصنيف المقترح كنص عربي قصير.
- fixes: قائمة الإصلاحات المقترحة، كل عنصر {action: "create-file" أو "install-deps" أو "link-services" أو "other"، target: الملف/الهدف كـ string، detail: شرح عربي، safe: true إن كان آمناً للتطبيق التلقائي / false إن كان خطِراً كالحذف}.

يجب أن تُخرج في نهاية ردك كتلة JSON واحدة فقط محصورة حرفياً بين السطرين:
===MAKTABA_PROFILE_START===
{
  "runMode": "single أو multi أو script",
  "runCommand": "الأمر الدقيق كـ string أو null",
  "runKind": "node أو python أو php أو static أو bat أو other",
  "expectsWeb": true أو false,
  "port": المنفذ المتوقع كـ number أو null,
  "missingFiles": ["قائمة الملفات المفقودة كـ strings"],
  "subProjects": [
    {
      "path": "مسار المجلد الفرعي كـ string",
      "action": "merge أو separate",
      "reason": "السبب كـ string"
    }
  ],
  "services": [
    {
      "name": "اسم الخدمة كـ string",
      "dir": "مسار نسبي للمجلد من جذر المشروع كـ string",
      "command": "أمر التشغيل الفعلي كـ string",
      "port": المنفذ المتوقع للخدمة كـ number أو null,
      "primary": true أو false,
      "role": "gateway أو backend أو frontend أو ai أو worker أو other"
    }
  ],
  "notes": "ملاحظات عربية موجزة عن المعمارية وطريقة التشغيل وأي مشاكل أو تحذيرات وسبب اختيار وضع التشغيل",
  "confidence": درجة الثقة من 0 إلى 100 كـ number,
  "structureKind": "single أو distributed أو multi-project أو has-duplicates أو mixed",
  "verdict": "شرح الحكم باللغة العربية",
  "duplicates": [
    {
      "path": "مسار نسبي كـ string",
      "kind": "backup أو copy أو version",
      "reason": "سبب عربي كـ string"
    }
  ],
  "components": [
    {
      "path": "مسار نسبي كـ string",
      "role": "gateway أو backend أو frontend أو ai أو worker أو shared أو other",
      "partOfPrimary": true أو false
    }
  ],
  "suggestedClassification": "نص عربي قصير",
  "fixes": [
    {
      "action": "create-file أو install-deps أو link-services أو other",
      "target": "الملف/الهدف كـ string",
      "detail": "شرح عربي كـ string",
      "safe": true أو false
    }
  ]
}
===MAKTABA_PROFILE_END===`;

    logInfo('aiOnboard', `Starting AI Onboarding analysis for project path: ${project.path}`);
    const { stdout, stderr } = await runDelegate(project.path, prompt, resolved);

    let summaryText = parseDelegateJson(stdout);
    if (!summaryText) {
      summaryText = stdout;
    }

    let jsonContent = null;
    const startMarker = '===MAKTABA_PROFILE_START===';
    const endMarker = '===MAKTABA_PROFILE_END===';
    
    const startIdx = summaryText.indexOf(startMarker);
    const endIdx = summaryText.indexOf(endMarker);
    
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      jsonContent = summaryText.substring(startIdx + startMarker.length, endIdx).trim();
    }

    if (!jsonContent) {
      // Find first '{' and matching balanced '}'
      const firstBrace = summaryText.indexOf('{');
      if (firstBrace !== -1) {
        let braceCount = 0;
        let lastBrace = -1;
        for (let i = firstBrace; i < summaryText.length; i++) {
          if (summaryText[i] === '{') {
            braceCount++;
          } else if (summaryText[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              lastBrace = i;
              break;
            }
          }
        }
        if (lastBrace !== -1) {
          jsonContent = summaryText.substring(firstBrace, lastBrace + 1);
        }
      }
    }

    if (!jsonContent) {
      logError('aiOnboard', new Error(`Could not locate Maktaba Profile JSON block. Raw summaryText: ${summaryText}`));
      return { ok: false, error: 'تعذّر قراءة بصمة التشغيل', analyzedAt: nowStr };
    }

    let profileObj;
    try {
      profileObj = JSON.parse(jsonContent);
    } catch (parseErr) {
      logError('aiOnboard', new Error(`Failed to parse profile JSON block: ${parseErr.message}. jsonContent: ${jsonContent}`));
      return { ok: false, error: 'تعذّر قراءة بصمة التشغيل', analyzedAt: nowStr };
    }

    // Clean and apply defaults
    const profile = {
      runMode: (profileObj.runMode === 'single' || profileObj.runMode === 'multi' || profileObj.runMode === 'script') ? profileObj.runMode : 'single',
      runCommand: (profileObj.runCommand && typeof profileObj.runCommand === 'string' && profileObj.runCommand.trim() !== '') ? profileObj.runCommand.trim() : null,
      runKind: (profileObj.runKind && typeof profileObj.runKind === 'string') ? profileObj.runKind.trim() : 'other',
      expectsWeb: (typeof profileObj.expectsWeb === 'boolean') ? profileObj.expectsWeb : false,
      port: (typeof profileObj.port === 'number' && !isNaN(profileObj.port)) ? profileObj.port : null,
      missingFiles: Array.isArray(profileObj.missingFiles) ? profileObj.missingFiles.map(String) : [],
      subProjects: Array.isArray(profileObj.subProjects) ? profileObj.subProjects.filter(sp => sp && typeof sp === 'object').map(sp => ({
        path: typeof sp.path === 'string' ? sp.path : '',
        action: (sp.action === 'merge' || sp.action === 'separate') ? sp.action : 'separate',
        reason: typeof sp.reason === 'string' ? sp.reason : ''
      })) : [],
      services: Array.isArray(profileObj.services) ? profileObj.services.filter(s => s && typeof s === 'object' && s.name && s.command).map(s => ({
        name: String(s.name).trim(),
        dir: (s.dir && typeof s.dir === 'string' && s.dir.trim() !== '') ? s.dir.trim() : '.',
        command: String(s.command).trim(),
        port: (typeof s.port === 'number' && !isNaN(s.port)) ? s.port : null,
        primary: typeof s.primary === 'boolean' ? s.primary : false,
        role: (s.role && typeof s.role === 'string') ? s.role.trim() : 'other'
      })) : [],
      notes: typeof profileObj.notes === 'string' ? profileObj.notes.trim() : '',
      confidence: (typeof profileObj.confidence === 'number' && !isNaN(profileObj.confidence)) ? profileObj.confidence : 0,
      structureKind: (profileObj.structureKind === 'single' || profileObj.structureKind === 'distributed' || profileObj.structureKind === 'multi-project' || profileObj.structureKind === 'has-duplicates' || profileObj.structureKind === 'mixed') ? profileObj.structureKind : 'single',
      verdict: typeof profileObj.verdict === 'string' ? profileObj.verdict.trim() : '',
      duplicates: Array.isArray(profileObj.duplicates) ? profileObj.duplicates.filter(d => d && typeof d === 'object').map(d => ({
        path: typeof d.path === 'string' ? d.path.trim() : '',
        kind: (d.kind === 'backup' || d.kind === 'copy' || d.kind === 'version') ? d.kind : 'backup',
        reason: typeof d.reason === 'string' ? d.reason.trim() : ''
      })) : [],
      components: Array.isArray(profileObj.components) ? profileObj.components.filter(c => c && typeof c === 'object').map(c => ({
        path: typeof c.path === 'string' ? c.path.trim() : '',
        role: (c.role && typeof c.role === 'string' && ['gateway', 'backend', 'frontend', 'ai', 'worker', 'shared', 'other'].includes(c.role.trim())) ? c.role.trim() : 'other',
        partOfPrimary: typeof c.partOfPrimary === 'boolean' ? c.partOfPrimary : false
      })) : [],
      suggestedClassification: typeof profileObj.suggestedClassification === 'string' ? profileObj.suggestedClassification.trim() : '',
      fixes: Array.isArray(profileObj.fixes) ? profileObj.fixes.filter(f => f && typeof f === 'object').map(f => ({
        action: (f.action && typeof f.action === 'string' && ['create-file', 'install-deps', 'link-services', 'other'].includes(f.action.trim())) ? f.action.trim() : 'other',
        target: typeof f.target === 'string' ? f.target.trim() : '',
        detail: typeof f.detail === 'string' ? f.detail.trim() : '',
        // null means "the model did not say", which is NOT the same as the
        // model saying it is dangerous. Collapsing both to false would make a
        // `safe === true` filter downstream drop every fix whenever the model
        // omits the field, silently turning auto-repair into a no-op.
        safe: typeof f.safe === 'boolean' ? f.safe : null
      })) : []
    };

    if (profile.structureKind === 'distributed') {
      profile.runMode = 'multi';
    }

    // If no service is marked primary, and services is not empty, set first one with a port as primary
    if (profile.runMode === 'multi' && profile.services.length > 0) {
      const hasPrimary = profile.services.some(s => s.primary);
      if (!hasPrimary) {
        const firstWithPort = profile.services.find(s => typeof s.port === 'number' && s.port > 0);
        if (firstWithPort) {
          firstWithPort.primary = true;
        } else {
          profile.services[0].primary = true;
        }
      }
    }

    logInfo('aiOnboard', `Successfully analyzed project: ${project.path}`);
    return { ok: true, profile, analyzedAt: nowStr };

  } catch (err) {
    logError('aiOnboard', err);
    return { ok: false, error: err.message, analyzedAt: nowStr };
  }
}

module.exports = {
  analyzeProject
};
