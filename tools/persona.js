const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const PORT = String(process.env.PORT || 4700);

// Ensure shots directory exists
const shotsDir = path.join(root, 'public', 'shots');
if (!fs.existsSync(shotsDir)) {
  fs.mkdirSync(shotsDir, { recursive: true });
}

let serverProcess = null;

// Helper to kill process tree on Windows/Unix
function killProcessTree(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
    } else {
      proc.kill('SIGKILL');
    }
  } catch (err) {
    try { proc.kill('SIGKILL'); } catch (e) {}
  }
}

async function startServer() {
  return new Promise((resolve, reject) => {
    console.log(`[السيرفر] جاري تشغيل خادم مكتبة المشاريع على المنفذ ${PORT}...`);
    serverProcess = spawn('node', ['server.js'], {
      cwd: root,
      env: {
        ...process.env,
        PORT: PORT,
        MAKTABA_TEST: '1',
        ACP_DELEGATE_OPEN: '0'
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let started = false;
    serverProcess.stdout.on('data', (data) => {
      const out = data.toString();
      if (out.includes('listening') || out.includes('localhost') || out.includes(PORT)) {
        if (!started) {
          started = true;
          resolve();
        }
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`[السيرفر - خطأ]: ${data.toString().trim()}`);
    });

    setTimeout(() => {
      if (!started) {
        reject(new Error('فشل السيرفر في العمل خلال 10 ثوانٍ.'));
      }
    }, 10000);
  });
}

async function runPersonaTest() {
  console.log('==================================================');
  console.log('🎭 شخصية الاختبار: "ياسمين" - مهندسة ضمان الجودة (QA)');
  console.log('الهدف: محاكاة تجربة مستخدم حقيقي لفحص واجهة مكتبة المشاريع وتجربتها.');
  console.log('==================================================\n');

  let browser;
  try {
    await startServer();
    console.log('🚀 [ياسمين]: بدأت جلسة الاختبار.');

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    // Set viewport for consistent screenshots
    await page.setViewport({ width: 1280, height: 800 });

    // Enable console logging from the browser page
    page.on('console', msg => console.log(`[المتصفح - Console]: ${msg.text()}`));
    page.on('pageerror', err => console.error(`[المتصفح - خطأ صفحة]: ${err.toString()}`));

    // 1. Load the home page
    console.log(`📖 [ياسمين]: تقوم بفتح صفحة لوحة التحكم http://localhost:${PORT}...`);
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle2' });

    // Wait for the skeleton loaders to finish and cards to render
    console.log('⏳ [ياسمين]: تنتظر تحميل بطاقات المشاريع...');
    await page.waitForSelector('.project-card', { timeout: 15000 });
    
    // Take screenshot of loaded state
    const loadShotPath = path.join(shotsDir, 'persona-1-load.png');
    await page.screenshot({ path: loadShotPath });
    console.log(`📸 [ياسمين]: أخذت لقطة شاشة للحالة الافتراضية للواجهة وحفظتها في: \n   ${loadShotPath}`);

    // Check project count
    const cardCount = await page.evaluate(() => document.querySelectorAll('.project-card').length);
    console.log(`📊 [ياسمين]: رأت ${cardCount} مشروعاً معروضاً في لوحة التحكم.`);

    // 2. Theme Toggle Test
    console.log('🌙 [ياسمين]: ترغب في اختبار تبديل الوضع الليلي لراحة العين...');
    const bodyClassBefore = await page.evaluate(() => document.body.className);
    console.log(`- مظهر الجسم الحالي: "${bodyClassBefore}"`);

    await page.click('#themeToggle');
    await new Promise(r => setTimeout(r, 1000)); // wait for transition

    const bodyClassAfter = await page.evaluate(() => document.body.className);
    console.log(`- مظهر الجسم بعد الضغط على الزر: "${bodyClassAfter}"`);

    const themeShotPath = path.join(shotsDir, 'persona-2-theme.png');
    await page.screenshot({ path: themeShotPath });
    console.log(`📸 [ياسمين]: أخذت لقطة شاشة بعد تغيير الوضع الليلي وحفظتها في: \n   ${themeShotPath}`);

    // 3. Search Box Filtering Test
    console.log('🔍 [ياسمين]: تريد البحث عن مشروع محدد باسم "ai-browser" باستخدام حقل البحث السريع...');
    await page.type('#searchBox', 'ai-browser');
    await new Promise(r => setTimeout(r, 1000)); // wait for DOM filter

    // Verify visible cards
    const visibleCards = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.project-card'));
      return cards.filter(c => c.style.display !== 'none').map(c => {
        const title = c.querySelector('h3') ? c.querySelector('h3').innerText : '';
        return title;
      });
    });

    console.log(`- المشاريع الظاهرة بعد فلترة البحث:`, visibleCards);

    const searchShotPath = path.join(shotsDir, 'persona-3-search.png');
    await page.screenshot({ path: searchShotPath });
    console.log(`📸 [ياسمين]: أخذت لقطة شاشة لنتائج البحث وحفظتها في: \n   ${searchShotPath}`);

    // Clear search for next steps
    console.log('🧹 [ياسمين]: تقوم بمسح حقل البحث لإظهار جميع البطاقات مجدداً...');
    await page.evaluate(() => {
      const search = document.getElementById('searchBox');
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 1000));

    // 4. Export CSV Verification
    console.log('⬇ [ياسمين]: تختبر الآن إمكانية تحميل قائمة المشاريع كملف CSV...');
    
    // Check if the CSV export API returns 200 OK
    const csvResponse = await page.evaluate(async (port) => {
      try {
        const res = await fetch(`http://localhost:${port}/api/projects/export.csv`);
        return {
          status: res.status,
          contentType: res.headers.get('content-type'),
          isCSV: res.headers.get('content-disposition')?.includes('attachment')
        };
      } catch (err) {
        return { error: err.message };
      }
    }, PORT);

    if (csvResponse.error) {
      console.error(`❌ [ياسمين]: فشل طلب الـ CSV: ${csvResponse.error}`);
    } else {
      console.log(`- حالة استجابة رابط تصدير الـ CSV: ${csvResponse.status} (${csvResponse.status === 200 ? 'نجاح ✅' : 'فشل ❌'})`);
      console.log(`- نوع المحتوى (Content-Type): ${csvResponse.contentType}`);
    }

    console.log('\n🎉 [ياسمين]: أكملت ياسمين جولتها التجريبية بنجاح دون وجود أي انهيارات في الواجهة أو الخادم.');
    console.log('==================================================');

  } catch (err) {
    console.error(`❌ حدث خطأ أثناء اختبار الشخصية:`, err);
  } finally {
    if (browser) {
      await browser.close();
    }
    if (serverProcess) {
      console.log('🔌 [السيرفر] إغلاق خادم التطبيق وإنهائه...');
      killProcessTree(serverProcess);
    }
  }
}

runPersonaTest();
