const { inspectPage } = require('./screenshot');
const { logError } = require('./logger');

/**
 * Performs a health check on a given project.
 * 
 * @param {Object} project The project object
 * @param {Object} runner The runner module
 * @returns {Promise<Object>} The health check result
 */
async function checkProject(project, runner) {
  try {
    const st = runner.status(project.id);
    const isRunning = st.status === 'running' || st.status === 'starting';
    
    if (!isRunning) {
      return {
        running: false,
        healthy: false,
        problems: ['المشروع غير مشغّل حالياً — شغّله أولاً ثم افحص'],
        port: null
      };
    }

    const port = st.port;
    if (port) {
      const inspectUrl = `http://127.0.0.1:${port}`;
      const inspectRes = await inspectPage(inspectUrl);
      
      const problems = [];
      if (!inspectRes.ok) {
        problems.push('تعذّر الاتصال بالمنفذ أو تحميل الصفحة');
      } else {
        if (inspectRes.httpStatus >= 400) {
          problems.push('استجابة HTTP خطأ: ' + inspectRes.httpStatus);
        }
        if (inspectRes.bodyTextLength < 10 && inspectRes.elementCount < 8) {
          problems.push('صفحة بيضاء/فارغة تقريباً (لا محتوى ظاهر)');
        }
        if (inspectRes.consoleErrors && inspectRes.consoleErrors.length > 0) {
          problems.push('أخطاء JavaScript في الكونسول: ' + inspectRes.consoleErrors.length);
        }
        if (inspectRes.failedRequests && inspectRes.failedRequests.length > 0) {
          problems.push('طلبات شبكة فاشلة: ' + inspectRes.failedRequests.length);
        }
      }

      return {
        running: true,
        healthy: problems.length === 0,
        port,
        httpStatus: inspectRes.httpStatus,
        title: inspectRes.title,
        bodyTextLength: inspectRes.bodyTextLength,
        elementCount: inspectRes.elementCount,
        consoleErrors: inspectRes.consoleErrors || [],
        failedRequests: inspectRes.failedRequests || [],
        problems
      };
    } else {
      // Non-web running project
      return {
        running: true,
        healthy: true,
        port: null,
        problems: [],
        note: 'مشروع غير ويب يعمل — لا يمكن فحص الصفحة'
      };
    }
  } catch (err) {
    logError('healthcheck-checkProject-failed', err);
    return {
      running: false,
      healthy: false,
      problems: ['حدث خطأ أثناء إجراء فحص الصحة: ' + err.message],
      port: null
    };
  }
}

module.exports = {
  checkProject
};
