// In-memory store for projects list
let projectsCache = [];

// Filtering state
let currentFilterType = 'الكل';
let currentSearchQuery = '';
let currentFilterClassification = 'الكل';
let currentStatusQuickFilter = 'all';
let showNonProjects = false;

// Active polling interval for the logs modal
let logsPollInterval = null;

// Track active overview generation timers
let runningOverviewTimers = {};

// Track active AI fix process timers
let runningFixTimers = {};

// Backups display state
let showBackups = false;

// Polling interval identifier for batch AI overview progress
let batchProgressInterval = null;

// Polling interval identifiers for doctor scan and fix-queue progress
let doctorScanProgressInterval = null;
let doctorFixProgressInterval = null;

// Active run command project id tracking
let activeRunCommandProjectId = null;

// Initial application load
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  const initialLoad = loadProjects();
  checkInitialBatchProgress();
  checkInitialDoctorProgress();
  fetchReviewQueue();
  setupRunningDock();
  checkDoctorAlert();
  checkProcessesBadge();
  refreshRestorePoints();
  refreshAuditBadge();

  // Both must finish before re-rendering. Firing the redraw off the container
  // fetch alone raced the first render, which landed later with no container
  // data and painted the badges straight back out.
  Promise.all([initialLoad, refreshContainers()]).then(() => {
    // Redraw only when there is something to show, so a machine without Docker
    // pays nothing for this.
    if (Object.keys(containersByProject).length) loadProjects();
  });
});

/**
 * Attaches event listeners to header search input, rescan buttons, filter chips, and modals.
 */
function setupEventListeners() {
  // Rescan Button
  const rescanBtn = document.getElementById('rescanBtn');
  rescanBtn.addEventListener('click', runRescan);

  // Export CSV Button
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', () => {
      window.location = '/api/projects/export.csv';
    });
  }

  // Theme Toggle Button
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      document.body.classList.toggle('dark');
      const isDark = document.body.classList.contains('dark');
      localStorage.setItem('maktaba-theme', isDark ? 'dark' : 'light');
    });
  }

  // Actions Menu Button
  const actionsMenuBtn = document.getElementById('actionsMenuBtn');
  if (actionsMenuBtn) {
    actionsMenuBtn.addEventListener('click', toggleActionsMenu);
  }

  // Live Search Input with simple debounce
  const searchInput = document.getElementById('searchInput');
  let searchTimeout = null;
  searchInput.addEventListener('input', (e) => {
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }
    searchTimeout = setTimeout(() => {
      currentSearchQuery = e.target.value;
      filterAndRenderProjects();
    }, 250);
  });

  // Client-side Instant Search Box

  // Filter Type Chips
  const filterChips = document.getElementById('filterChips');
  filterChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;

    // Toggle active classes on chips
    filterChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');

    currentFilterType = chip.getAttribute('data-type');
    filterAndRenderProjects();
  });

  // Classification Filter Chips
  const classificationChips = document.getElementById('classificationChips');
  if (classificationChips) {
    classificationChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;

      // Toggle active classes on chips
      classificationChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');

      currentFilterClassification = chip.getAttribute('data-classification');
      filterAndRenderProjects();
    });
  }

  // Quick Status Filter Chips
  const statusQuickFilters = document.getElementById('statusQuickFilters');
  if (statusQuickFilters) {
    statusQuickFilters.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;

      statusQuickFilters.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');

      currentStatusQuickFilter = chip.getAttribute('data-status');
      filterAndRenderProjects();
    });
  }

  // Show Non Projects Checkbox
  const showNonProjectsCheck = document.getElementById('showNonProjects');
  if (showNonProjectsCheck) {
    showNonProjectsCheck.addEventListener('change', (e) => {
      showNonProjects = e.target.checked;
      filterAndRenderProjects();
    });
  }

  // Show Backups Checkbox
  const showBackupsCheck = document.getElementById('showBackups');
  if (showBackupsCheck) {
    showBackupsCheck.addEventListener('change', (e) => {
      showBackups = e.target.checked;
      filterAndRenderProjects();
    });
  }

  // Close Logs Modal Buttons
  document.getElementById('closeLogsBtn').addEventListener('click', closeLogsModal);

  const modelsBtn = document.getElementById('modelsBtn');
  if (modelsBtn) modelsBtn.addEventListener('click', openModelsModal);

  const closeModelsBtn = document.getElementById('closeModelsModalBtn');
  if (closeModelsBtn) {
    closeModelsBtn.addEventListener('click', () => {
      document.getElementById('modelsModal').classList.add('hidden');
    });
  }

  const orFilter = document.getElementById('orFilter');
  if (orFilter) orFilter.addEventListener('input', orRenderModels);

  const orRefresh = document.getElementById('orRefreshBtn');
  if (orRefresh) orRefresh.addEventListener('click', () => orLoadModels(true));

  const actionsLogBtn = document.getElementById('actionsLogBtn');
  if (actionsLogBtn) actionsLogBtn.addEventListener('click', openActionsLog);

  const closeActionsLog = document.getElementById('closeActionsLogBtn');
  if (closeActionsLog) {
    closeActionsLog.addEventListener('click', () => document.getElementById('actionsLogModal').classList.add('hidden'));
  }

  const auditBtn = document.getElementById('auditBtn');
  if (auditBtn) auditBtn.addEventListener('click', openAuditModal);

  const closeAudit = document.getElementById('closeAuditModalBtn');
  if (closeAudit) {
    closeAudit.addEventListener('click', () => document.getElementById('auditModal').classList.add('hidden'));
  }

  const auditRun = document.getElementById('auditRunBtn');
  if (auditRun) {
    auditRun.addEventListener('click', async () => {
      auditRun.disabled = true;
      auditRun.textContent = 'يعمل…';
      try {
        const res = await fetch('/api/audit/run', { method: 'POST' });
        const data = await res.json();
        if (!data.started) throw new Error(data.error || 'لم يبدأ');
        showToast('بدأ التدقيق — يأخذ دقيقة أو اثنتين.', 'success');
        // The audit walks every repo and asks Windows about scheduled tasks, so
        // it is slow by nature. Poll for the file rather than pretending it is
        // instant.
        const started = Date.now();
        const timer = setInterval(async () => {
          const r = await fetch('/api/audit').then(x => x.json()).catch(() => null);
          const fresh = r && r.generatedAt && new Date(r.generatedAt).getTime() > started;
          if (fresh || Date.now() - started > 300000) {
            clearInterval(timer);
            auditRun.disabled = false;
            auditRun.textContent = 'شغّل التدقيق الآن';
            if (fresh) { await loadAudit(); refreshAuditBadge(); showToast('اكتمل التدقيق.', 'success'); }
            else showToast('التدقيق يأخذ وقتاً أطول من المتوقّع — افتح النافذة لاحقاً.', 'warning');
          }
        }, 5000);
      } catch (err) {
        auditRun.disabled = false;
        auditRun.textContent = 'شغّل التدقيق الآن';
        showToast(err.message, 'error');
      }
    });
  }

  const restoreBtn = document.getElementById('restoreBannerBtn');
  if (restoreBtn) {
    restoreBtn.addEventListener('click', () => {
      const list = document.getElementById('restoreBannerList');
      const open = list.style.display !== 'none';
      list.style.display = open ? 'none' : 'flex';
      restoreBtn.textContent = open ? 'اعرض التفاصيل' : 'أخفِ التفاصيل';
    });
  }

  const orAvail = document.getElementById('orAvailBtn');
  if (orAvail) orAvail.addEventListener('click', orRunAvailability);

  const orBench = document.getElementById('orBenchBtn');
  if (orBench) orBench.addEventListener('click', orRunBench);

  const orBenchStop = document.getElementById('orBenchStopBtn');
  if (orBenchStop) {
    orBenchStop.addEventListener('click', async () => {
      await fetch('/api/models/bench/stop', { method: 'POST' });
      showToast('أُوقِف القياس. النتائج المُسجَّلة محفوظة.', 'info');
      orRefreshScores();
    });
  }

  const gwToken = document.getElementById('gwTokenBtn');
  if (gwToken) gwToken.addEventListener('click', gwCreateToken);

  const gwUsage = document.getElementById('gwUsageBtn');
  if (gwUsage) gwUsage.addEventListener('click', gwShowUsage);

  const orSaveKey = document.getElementById('orSaveKeyBtn');
  if (orSaveKey) {
    orSaveKey.addEventListener('click', async () => {
      const input = document.getElementById('orKeyInput');
      const key = input.value.trim();
      if (!key) { showToast('الصق المفتاح أولاً.', 'warning'); return; }
      try {
        const res = await fetch('/api/openrouter/key', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key })
        });
        const data = await res.json();
        // Clear the field either way — the key does not linger in the DOM.
        input.value = '';
        if (!res.ok || !data.ok) throw new Error(data.error || 'فشل الحفظ');
        showToast('حُفظ المفتاح على جهازك.', 'success');
        await orRefreshKeyState();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  const orClearKey = document.getElementById('orClearKeyBtn');
  if (orClearKey) {
    orClearKey.addEventListener('click', async () => {
      try {
        await fetch('/api/openrouter/key', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clear: true })
        });
        showToast('حُذف المفتاح.', 'success');
        await orRefreshKeyState();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  const orSendBtn = document.getElementById('orSendBtn');
  if (orSendBtn) orSendBtn.addEventListener('click', orSend);

  const orChatInput = document.getElementById('orChatInput');
  if (orChatInput) {
    orChatInput.addEventListener('keydown', (e) => {
      // Enter sends, Shift+Enter makes a new line.
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); orSend(); }
    });
  }

  const closeProfileBtn = document.getElementById('closeProfileModalBtn');
  if (closeProfileBtn) {
    closeProfileBtn.addEventListener('click', () => {
      document.getElementById('profileModal').classList.add('hidden');
    });
  }
  
  // Close Logs Modal by clicking outside
  document.getElementById('logsModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('logsModal')) {
      closeLogsModal();
    }
  });

  // Close Duplicates Modal Buttons
  document.getElementById('closeDuplicatesBtn').addEventListener('click', closeDuplicatesModal);
  document.getElementById('confirmDuplicatesBtn').addEventListener('click', closeDuplicatesModal);
  
  // Close Duplicates Modal by clicking outside
  document.getElementById('duplicatesModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('duplicatesModal')) {
      closeDuplicatesModal();
    }
  });

  // Error Logs Modal Listeners
  document.getElementById('errorLogsBtn').addEventListener('click', openErrorLogsModal);
  document.getElementById('closeErrorLogsBtn').addEventListener('click', closeErrorLogsModal);
  document.getElementById('refreshErrorLogsBtn').addEventListener('click', refreshErrorLogs);
  document.getElementById('errorLogsModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('errorLogsModal')) {
      closeErrorLogsModal();
    }
  });

  // Close Signals Modal Buttons
  const signalsModal = document.getElementById('signalsModal');
  if (signalsModal) {
    document.getElementById('closeSignalsBtn').addEventListener('click', () => {
      signalsModal.classList.add('hidden');
    });
    document.getElementById('confirmSignalsBtn').addEventListener('click', () => {
      signalsModal.classList.add('hidden');
    });
    signalsModal.addEventListener('click', (e) => {
      if (e.target === signalsModal) {
        signalsModal.classList.add('hidden');
      }
    });
  }

  // Close Overview Modal Buttons
  const overviewModal = document.getElementById('overviewModal');
  if (overviewModal) {
    document.getElementById('closeOverviewBtn').addEventListener('click', () => {
      overviewModal.classList.add('hidden');
    });
    document.getElementById('confirmOverviewBtn').addEventListener('click', () => {
      overviewModal.classList.add('hidden');
    });
    overviewModal.addEventListener('click', (e) => {
      if (e.target === overviewModal) {
        overviewModal.classList.add('hidden');
      }
    });
  }

  // Generate All AI Overviews Button
  const generateAllBtn = document.getElementById('generateAllBtn');
  if (generateAllBtn) {
    generateAllBtn.addEventListener('click', generateAllAIOverviews);
  }

  // Stop Batch AI Overviews Button
  const stopBatchBtn = document.getElementById('stopBatchBtn');
  if (stopBatchBtn) {
    stopBatchBtn.addEventListener('click', stopBatchAIOverviews);
  }

  // Close Backups Modal Buttons
  const backupsModal = document.getElementById('backupsModal');
  if (backupsModal) {
    document.getElementById('closeBackupsBtn').addEventListener('click', () => {
      backupsModal.classList.add('hidden');
    });
    document.getElementById('confirmBackupsBtn').addEventListener('click', () => {
      backupsModal.classList.add('hidden');
    });
    backupsModal.addEventListener('click', (e) => {
      if (e.target === backupsModal) {
        backupsModal.classList.add('hidden');
      }
    });
  }

  // Close Fix Modal Buttons
  const fixModal = document.getElementById('fixModal');
  if (fixModal) {
    document.getElementById('closeFixBtn').addEventListener('click', () => {
      fixModal.classList.add('hidden');
    });
    document.getElementById('confirmFixBtn').addEventListener('click', () => {
      fixModal.classList.add('hidden');
    });
    fixModal.addEventListener('click', (e) => {
      if (e.target === fixModal) {
        fixModal.classList.add('hidden');
      }
    });
  }

  // Run Command Modal Listeners
  const runCommandModal = document.getElementById('runCommandModal');
  if (runCommandModal) {
    document.getElementById('closeRunCommandBtn').addEventListener('click', () => {
      runCommandModal.classList.add('hidden');
    });
    document.getElementById('confirmRunCommandBtn').addEventListener('click', () => {
      runCommandModal.classList.add('hidden');
    });
    runCommandModal.addEventListener('click', (e) => {
      if (e.target === runCommandModal) {
        runCommandModal.classList.add('hidden');
      }
    });
    document.getElementById('saveRunCommandBtn').addEventListener('click', saveRunCommand);
    document.getElementById('clearRunCommandBtn').addEventListener('click', clearRunCommand);
  }

  // Review Queue Button
  const reviewBtn = document.getElementById('reviewBtn');
  if (reviewBtn) {
    reviewBtn.addEventListener('click', openReviewModal);
  }

  // Close Review Modal Buttons
  const reviewModal = document.getElementById('reviewModal');
  if (reviewModal) {
    document.getElementById('closeReviewModalBtn').addEventListener('click', () => {
      reviewModal.classList.add('hidden');
    });
    document.getElementById('confirmReviewModalBtn').addEventListener('click', () => {
      reviewModal.classList.add('hidden');
    });
    reviewModal.addEventListener('click', (e) => {
      if (e.target === reviewModal) {
        reviewModal.classList.add('hidden');
      }
    });
  }

  // Live Projects Button
  const liveBtn = document.getElementById('liveBtn');
  if (liveBtn) {
    liveBtn.addEventListener('click', openLiveModal);
  }

  // Doctor Button & Modal
  const doctorBtn = document.getElementById('doctorBtn');
  if (doctorBtn) {
    doctorBtn.addEventListener('click', openDoctorModal);
  }

  const doctorModal = document.getElementById('doctorModal');
  if (doctorModal) {
    document.getElementById('closeDoctorModalBtn').addEventListener('click', () => {
      doctorModal.classList.add('hidden');
    });
    document.getElementById('confirmDoctorModalBtn').addEventListener('click', () => {
      doctorModal.classList.add('hidden');
    });
    doctorModal.addEventListener('click', (e) => {
      if (e.target === doctorModal) {
        doctorModal.classList.add('hidden');
      }
    });
  }

  // Processes Button & Modal
  const processesBtn = document.getElementById('processesBtn');
  if (processesBtn) {
    processesBtn.addEventListener('click', openProcessesModal);
  }

  const processesModal = document.getElementById('processesModal');
  if (processesModal) {
    document.getElementById('closeProcessesModalBtn').addEventListener('click', () => {
      processesModal.classList.add('hidden');
    });
    document.getElementById('confirmProcessesModalBtn').addEventListener('click', () => {
      processesModal.classList.add('hidden');
    });
    processesModal.addEventListener('click', (e) => {
      if (e.target === processesModal) {
        processesModal.classList.add('hidden');
      }
    });
    const refreshProcessesBtn = document.getElementById('refreshProcessesBtn');
    if (refreshProcessesBtn) {
      refreshProcessesBtn.addEventListener('click', loadProcesses);
    }
  }

  // Doctor Scan/Fix start/stop buttons
  const startDoctorScanBtn = document.getElementById('startDoctorScanBtn');
  if (startDoctorScanBtn) {
    startDoctorScanBtn.addEventListener('click', startDoctorScan);
  }
  const stopDoctorScanBtn = document.getElementById('stopDoctorScanBtn');
  if (stopDoctorScanBtn) {
    stopDoctorScanBtn.addEventListener('click', stopDoctorScan);
  }

  const startDoctorFixBtn = document.getElementById('startDoctorFixBtn');
  if (startDoctorFixBtn) {
    startDoctorFixBtn.addEventListener('click', startDoctorFix);
  }
  const stopDoctorFixBtn = document.getElementById('stopDoctorFixBtn');
  if (stopDoctorFixBtn) {
    stopDoctorFixBtn.addEventListener('click', stopDoctorFix);
  }

  // Autostart Boot Checkbox
  const autostartBootCheck = document.getElementById('autostartBootCheck');
  if (autostartBootCheck) {
    autostartBootCheck.addEventListener('change', async (e) => {
      try {
        const response = await fetch('/api/autostart/boot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: e.target.checked })
        });
        if (!response.ok) throw new Error('Failed to update boot autostart');
        const data = await response.json();
        showToast(data.installed ? 'تم تفعيل تشغيل المكتبة تلقائياً عند الإقلاع' : 'تم إلغاء تشغيل المكتبة تلقائياً عند الإقلاع', 'success');
      } catch (err) {
        showToast(`خطأ: ${err.message}`, 'error');
        // Revert check
        e.target.checked = !e.target.checked;
      }
    });
  }

  // Start Live Now Button
  const startLiveNowBtn = document.getElementById('startLiveNowBtn');
  if (startLiveNowBtn) {
    startLiveNowBtn.addEventListener('click', startLiveNow);
  }

  // Close Health Modal Buttons
  const healthModal = document.getElementById('healthModal');
  if (healthModal) {
    document.getElementById('closeHealthModalBtn').addEventListener('click', () => {
      healthModal.classList.add('hidden');
    });
    document.getElementById('confirmHealthModalBtn').addEventListener('click', () => {
      healthModal.classList.add('hidden');
    });
    healthModal.addEventListener('click', (e) => {
      if (e.target === healthModal) {
        healthModal.classList.add('hidden');
      }
    });
  }

  // Close AI Onboarding Modal Buttons
  const aiOnboardModal = document.getElementById('aiOnboardModal');
  if (aiOnboardModal) {
    document.getElementById('closeAiOnboardBtn').addEventListener('click', () => {
      aiOnboardModal.classList.add('hidden');
    });
    document.getElementById('confirmAiOnboardBtn').addEventListener('click', () => {
      aiOnboardModal.classList.add('hidden');
    });
    aiOnboardModal.addEventListener('click', (e) => {
      if (e.target === aiOnboardModal) {
        aiOnboardModal.classList.add('hidden');
      }
    });
  }

  // Close Live Modal Buttons
  const liveModal = document.getElementById('liveModal');
  if (liveModal) {
    document.getElementById('closeLiveModalBtn').addEventListener('click', closeLiveModal);
    document.getElementById('confirmLiveModalBtn').addEventListener('click', closeLiveModal);
    liveModal.addEventListener('click', (e) => {
      if (e.target === liveModal) {
        closeLiveModal();
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.card-menu-container')) {
      document.querySelectorAll('.card-menu').forEach(menu => {
        menu.classList.remove('open');
      });
    }
    if (!e.target.closest('.actions-menu-container')) {
      const actionsMenu = document.getElementById('actionsMenu');
      if (actionsMenu) {
        actionsMenu.classList.remove('open');
      }
    }
  });

  // Doctor Alert Banner buttons
  const doctorAlertFixBtn = document.getElementById('doctorAlertFixBtn');
  if (doctorAlertFixBtn) {
    doctorAlertFixBtn.addEventListener('click', async () => {
      const banner = document.getElementById('doctorAlertBanner');
      if (banner) banner.classList.add('hidden');
      await startDoctorFix();
    });
  }

  const doctorAlertDismissBtn = document.getElementById('doctorAlertDismissBtn');
  if (doctorAlertDismissBtn) {
    doctorAlertDismissBtn.addEventListener('click', () => {
      sessionStorage.setItem('doctorAlertDismissed', '1');
      const banner = document.getElementById('doctorAlertBanner');
      if (banner) banner.classList.add('hidden');
    });
  }
}

/**
 * Fetches projects from the backend and updates statuses.
 */
async function loadProjects() {
  renderSkeletons();
  try {
    const response = await fetch('/api/projects');
    if (!response.ok) {
      throw new Error(`Failed to load projects: ${response.statusText}`);
    }
    
    const fetchedProjects = await response.json();
    
    // Fetch live run status for each project in parallel
    const statusPromises = fetchedProjects.map(p => 
      fetch(`/api/projects/${p.id}/status`)
        .then(res => res.ok ? res.json() : { status: 'stopped', port: null, kind: null })
        .catch(() => ({ status: 'stopped', port: null, kind: null }))
    );

    const statuses = await Promise.all(statusPromises);
    
    // Attach status states to each project cache item
    projectsCache = fetchedProjects.map((p, index) => ({
      ...p,
      status: statuses[index].status,
      runningPort: statuses[index].port,
      runningKind: statuses[index].kind
    }));

    // Update doctor modal if open
    const doctorModal = document.getElementById('doctorModal');
    if (doctorModal && !doctorModal.classList.contains('hidden')) {
      updateDoctorStats();
      renderDoctorNeedsReviewTable();
    }

    filterAndRenderProjects();
  } catch (err) {
    showToast(`حدث خطأ أثناء تحميل المشاريع: ${err.message}`, 'error');
    renderEmptyState('error');
  }
}

/**
 * Triggers a backend scanning request and updates the UI state.
 */
async function runRescan() {
  const rescanBtn = document.getElementById('rescanBtn');
  const rescanIcon = document.getElementById('rescanIcon');
  const rescanText = document.getElementById('rescanText');

  rescanBtn.disabled = true;
  rescanIcon.classList.add('spinner');
  rescanText.textContent = 'جاري مسح الملفات...';
  renderSkeletons();

  try {
    const response = await fetch('/api/scan', { method: 'POST' });
    if (!response.ok) {
      throw new Error(`Scan request failed: ${response.statusText}`);
    }
    const result = await response.json();
    showToast(`اكتمل المسح! تم العثور على ${result.count} مشروع.`, 'success');
  } catch (err) {
    showToast(`فشل المسح: ${err.message}`, 'error');
  } finally {
    rescanBtn.disabled = false;
    rescanIcon.classList.remove('spinner');
    rescanText.textContent = 'إعادة المسح';
    loadProjects();
  }
}

/**
 * Computes the effective classification for a project.
 * User Classification override has highest priority, then fallback auto classification.
 */
function effectiveClassification(p) {
  if (p.userClassification === 'project') return 'confirmed';
  if (p.userClassification === 'not-project') return 'not-project';
  return p.classification || 'weak';
}

/**
 * Returns UI metadata (label and CSS class) for a given classification level.
 */
function classificationMeta(c) {
  switch (c) {
    case 'confirmed':
      return { label: 'مؤكّد', cls: 'conf-confirmed' };
    case 'likely':
      return { label: 'محتمل', cls: 'conf-likely' };
    case 'weak':
      return { label: 'ضعيف', cls: 'conf-weak' };
    case 'not-project':
      return { label: 'غير مشروع', cls: 'conf-notproject' };
    default:
      return { label: 'ضعيف', cls: 'conf-weak' };
  }
}

/**
 * Filter projects using current search query and chip category/classification selection, then render.
 */
function filterAndRenderProjects() {
  // Compute counts over the FULL projectsCache
  let countConfirmed = 0;
  let countLikely = 0;
  let countWeak = 0;
  let countNotProject = 0;

  projectsCache.forEach(p => {
    const eff = effectiveClassification(p);
    if (eff === 'confirmed') countConfirmed++;
    else if (eff === 'likely') countLikely++;
    else if (eff === 'weak') countWeak++;
    else if (eff === 'not-project') countNotProject++;
  });

  const countsContainer = document.getElementById('classificationCounts');
  if (countsContainer) {
    countsContainer.textContent = `مؤكّد: ${countConfirmed} · محتمل: ${countLikely} · ضعيف: ${countWeak} · مستبعد: ${countNotProject}`;
  }

  const filtered = projectsCache.filter(p => {
    // 0. Primary/Backup filtering
    if (p.isPrimary === false && !showBackups) {
      return false;
    }

    const eff = effectiveClassification(p);

    // Exclusion filter
    if (eff === 'not-project' && !(showNonProjects || currentFilterClassification === 'not-project')) {
      return false;
    }

    // Classification filter
    if (currentFilterClassification !== 'الكل' && eff !== currentFilterClassification) {
      return false;
    }

    // 1. Filter by category type
    if (currentFilterType !== 'الكل' && p.type !== currentFilterType) {
      return false;
    }

    // 2. Filter by status quick filter
    if (currentStatusQuickFilter === 'running') {
      if (!(p.status === 'running' || p.status === 'starting')) return false;
    } else if (currentStatusQuickFilter === 'broken') {
      if (p.doctorHealth !== 'broken') return false;
    } else if (currentStatusQuickFilter === 'review') {
      if (p.doctorNeedsReview !== true) return false;
    } else if (currentStatusQuickFilter === 'healthy') {
      if (p.doctorHealth !== 'ok') return false;
    }
    
    // 3. Filter by search query
    if (currentSearchQuery) {
      return matchesSearch(p, currentSearchQuery);
    }
    
    return true;
  });

  // Favourites first, then most recently modified. Sorting only by favourite
  // left the rest in scan-traversal order, which put hidden tool directories at
  // the very top of the screen — the first cards shown were .bun, .codex and
  // .grok caches rather than anything worked on recently.
  // Note: sort on lastModified, which the store actually persists.
  filtered.sort((a, b) => {
    const aFav = a.favorite ? 1 : 0;
    const bFav = b.favorite ? 1 : 0;
    if (aFav !== bFav) return bFav - aFav;

    const aTime = a.lastModified ? new Date(a.lastModified).getTime() : 0;
    const bTime = b.lastModified ? new Date(b.lastModified).getTime() : 0;
    if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return bTime - aTime;
  });

  const searchCount = document.getElementById('searchCount');
  if (searchCount) {
    if (currentSearchQuery && currentSearchQuery.trim()) {
      searchCount.textContent = `${filtered.length} نتيجة`;
      searchCount.style.display = 'inline-block';
    } else {
      searchCount.style.display = 'none';
    }
  }

  renderProjects(filtered);
  updateHeaderStats();
}

/**
 * Renders list of project cards into the HTML grid.
 * @param {Array} projects List of filtered projects
 */
function renderProjects(projects) {
  const grid = document.getElementById('projectGrid');
  grid.innerHTML = '';

  if (projects.length === 0) {
    if (currentSearchQuery && currentSearchQuery.trim()) {
      renderEmptyState('search');
    } else {
      renderEmptyState('empty');
    }
    return;
  }

  projects.forEach(p => {
    const card = document.createElement('div');
    card.className = 'project-card';
    card.setAttribute('data-id', p.id);

    const isRunning = p.status === 'running' || p.status === 'starting';
    const hasPort = p.runningPort !== null && p.runningPort !== undefined;

    // Formatted details
    const humanSize = formatBytes(p.sizeBytes);
    const modifiedStr = formatDate(p.lastModified);
    const duplicateCount = p.duplicates ? p.duplicates.length : 0;

    const effClass = effectiveClassification(p);
    const meta = classificationMeta(effClass);
    const isConfidenceNumber = typeof p.confidence === 'number';
    const confidenceText = isConfidenceNumber ? ' ' + p.confidence : '';
    const manualText = p.userClassification !== null && p.userClassification !== undefined ? ' (يدوي)' : '';
    const confidencePillHtml = `<span class="confidence-badge ${meta.cls}" onclick="showSignalsPopover('${p.id}')" title="اضغط لمعرفة السبب">${meta.label}${confidenceText}${manualText}</span>`;

    const kindMapping = {
      'node-dev': 'تشغيل React/Vite (npm run dev)',
      'node-start': 'npm start',
      'node-serve': 'npm run serve',
      'node-file': 'node',
      'static': 'سيرفر ثابت (Live)',
      'django': 'Django runserver',
      'flask': 'Flask',
      'python': 'Python',
      'php': 'PHP'
    };
    const humanKind = p.runningKind ? kindMapping[p.runningKind] : '';
    const kindLabelHtml = humanKind ? `<span class="kind-badge">${humanKind}</span>` : '';
    
    // Construct Card HTML
    const backupCount = p.backups ? p.backups.length : 0;
    const backupBadgeHtml = (p.isPrimary !== false && backupCount > 0) ? `<span class="backup-badge" onclick="showBackupsModal('${p.id}')" title="نسخ احتياطية أقدم">📦 ${backupCount} نسخة احتياطية</span>` : '';
    const backupRibbonHtml = p.isPrimary === false ? `<div class="backup-ribbon">📦 نسخة احتياطية</div>` : '';

    const starClass = p.favorite ? 'fa-solid fa-star' : 'fa-regular fa-star';
    const starColor = p.favorite ? '#eab308' : '#64748b';
    const starHtml = `
      <button class="btn-text favorite-btn" onclick="toggleFavorite('${p.id}', ${!p.favorite})" style="padding: 0 4px; color: ${starColor}; font-size: 1.15rem; background: none; border: none; cursor: pointer;" title="${p.favorite ? 'إزالة من المفضلة' : 'إضافة للمفضلة'}">
        <i class="${starClass}"></i>
      </button>
    `;

    const boltClass = 'fa-solid fa-bolt';
    const boltColor = p.autoStart ? '#eab308' : '#64748b';
    const boltText = p.autoStart ? 'حيّ ✓' : 'اجعله حيّاً';
    const boltTitle = p.autoStart ? 'إلغاء تشغيل تلقائي' : 'تشغيل تلقائي عند الإقلاع';
    const boltStyle = p.autoStart 
      ? 'background: rgba(234, 179, 8, 0.15); color: #eab308; border: 1px solid rgba(234, 179, 8, 0.3);' 
      : 'background: var(--bg-tertiary); color: var(--text-secondary); border: 1px solid var(--border-color);';
    const boltHtml = `
      <button class="btn-text autostart-badge" onclick="toggleAutostart('${p.id}', ${!p.autoStart})" style="${boltStyle}" title="${boltTitle}">
        <i class="${boltClass}"></i> <span>${boltText}</span>
      </button>
    `;

    let isMulti = false;
    if (p.aiProfile) {
      try {
        const profile = typeof p.aiProfile === 'string' ? JSON.parse(p.aiProfile) : p.aiProfile;
        if (profile && profile.runMode === 'multi') {
          isMulti = true;
        }
      } catch (err) {
        console.error('Error parsing aiProfile for project ' + p.id, err);
      }
    }
    const multiServiceBadgeHtml = isMulti ? `<span class="badge-multi">⚙ متعدد الخدمات</span>` : '';
    // A container serving traffic is evidence the program runs. It is NOT the
    // evidence the health scan collects, so it sits beside the verdict rather
    // than replacing it — two containers were serving ports 9119 and 9120 from
    // a project the catalogue called "unknown".
    // A held project must look held wherever it appears. The doctor scan, the
    // supervisor and the Run button all refuse it, and a card that gave no sign
    // of that would make three separate refusals look like three bugs.
    const quarantineBadgeHtml = p.quarantine
      ? `<span class="badge-multi" style="background:rgba(239,68,68,.16);border-color:rgba(239,68,68,.45);" title="${escapeHTML(p.quarantineReason || 'محجور')}">⛔ محجور</span>`
      : '';

    const containerBadgeHtml = (containersByProject[p.id] || []).length
      ? `<span class="badge-multi" style="background:rgba(56,189,248,.16);border-color:rgba(56,189,248,.4);" title="${escapeHTML((containersByProject[p.id] || []).map(c => c.name + (c.ports.length ? ' :' + c.ports.join(',') : '')).join(' · '))}">🐳 يعمل في حاوية</span>`
      : '';
    const doctorBrokenBadgeHtml = p.doctorHealth === 'broken' ? `<span class="badge-doctor-broken">🩺 معطوب</span>` : '';
    const doctorReviewBadgeHtml = p.doctorNeedsReview === true || p.doctorNeedsReview === 1 ? `<span class="badge-doctor-review">🩺 مراجعة</span>` : '';

    const imgHtml = p.hasShot
      ? `<img src="/shots/${p.id}.png?t=${Date.now()}" alt="${p.name}" class="project-thumb-img">`
      : `
        <div class="placeholder-thumb">
          <i class="fa-solid fa-laptop-code"></i>
          <span>لا توجد صورة بعد</span>
        </div>
      `;

    let primaryButtonHtml = '';
    if (isRunning) {
      primaryButtonHtml = `
        <button class="btn btn-danger stop-btn" onclick="stopProject('${p.id}')">
          <i class="fa-solid fa-stop"></i> إيقاف
        </button>
      `;
    } else if (p.status === 'error') {
      primaryButtonHtml = `
        <button class="btn btn-warning fix-btn" onclick="aiFixProject('${p.id}')">
          <i class="fa-solid fa-wrench"></i> إصلاح بالذكاء
        </button>
      `;
    } else if (!p.aiProfile) {
      primaryButtonHtml = `
        <button class="btn btn-info onboard-btn" onclick="analyzeThenRun('${p.id}')">
          <i class="fa-solid fa-wand-magic-sparkles"></i> تحليل وتشغيل
        </button>
      `;
    } else {
      primaryButtonHtml = `
        <button class="btn btn-success run-btn" onclick="runProject('${p.id}')">
          <i class="fa-solid fa-play"></i> تشغيل
        </button>
      `;
    }

    card.innerHTML = `
      <div class="card-thumbnail-container">
        ${imgHtml}
        <div class="card-badge badge-${(p.type || 'Static').toLowerCase()}">${p.type || 'Static'}</div>
        ${p.captureMethod ? `<div class="capture-method-badge badge-${p.captureMethod}">${p.captureMethod === 'web' ? 'ويب' : 'نافذة'}</div>` : ''}
        ${backupRibbonHtml}
      </div>
      <div class="card-body">
        <div class="card-title-row" style="display: flex; align-items: center; gap: 8px;">
          <h3 style="flex: 1; min-width: 0; margin: 0; display: flex; align-items: center; gap: 6px;" title="${p.name || 'مشروع بدون اسم'}">
            <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;">${p.name || 'مشروع بدون اسم'}</span>
            ${multiServiceBadgeHtml}${quarantineBadgeHtml}${containerBadgeHtml}
            ${doctorBrokenBadgeHtml}
            ${doctorReviewBadgeHtml}
          </h3>
          ${starHtml}
          <div class="card-menu-container">
            <button class="card-menu-btn" onclick="toggleCardMenu(event, '${p.id}')">⋮</button>
            <div class="card-menu" id="cardMenu-${p.id}">
              <button onclick="classifyManual('${p.id}', 'project')">تعليم كمشروع</button>
              <button onclick="classifyManual('${p.id}', 'not-project')">تعليم كغير مشروع</button>
              <button onclick="classifyManual('${p.id}', null)">إلغاء التعليم اليدوي</button>
              <div class="card-menu-divider"></div>
              <button onclick="openRunCommandModal('${p.id}')">أمر التشغيل</button>
              <button onclick="toggleOverview('${p.id}')">ما هذا المشروع؟</button>
              <button onclick="checkProjectHealth('${p.id}')">فحص التشغيل</button>
              <button onclick="runAiDeepDoctor('${p.id}')">إصلاح شامل وتشغيل</button>
              <div class="card-menu-divider"></div>
              <button onclick="toggleQuarantine('${p.id}', ${p.quarantine ? 'false' : 'true'})">${p.quarantine ? '✅ ارفع الحجر' : '⛔ احجره (امنع تشغيله)'}</button>
            </div>
          </div>
        </div>
        <div class="card-badges-row">
          ${boltHtml}
          ${confidencePillHtml}
          ${backupBadgeHtml}
          ${duplicateCount > 0 ? `<span class="duplicate-badge" onclick="showDuplicatesModal('${p.id}')"><i class="fa-solid fa-triangle-exclamation"></i> مكرر (${duplicateCount})</span>` : ''}
        </div>
        <p class="card-description" title="${p.description || ''}">${p.description || 'لا يوجد وصف متاح لهذا المشروع حالياً.'}</p>
        
        <div class="card-details-box">
          <div class="detail-item">
            <span class="detail-label">الملف الرئيسي:</span>
            <span class="detail-value">${p.entryFile || '—'}</span>
          </div>
          <div class="detail-item" id="portItem-${p.id}" style="align-items: center; min-height: 24px;">
            <span class="detail-label">البورت:</span>
            <span class="detail-value" id="portValContainer-${p.id}" style="display: inline-flex; align-items: center; gap: 6px;">
              <span id="portText-${p.id}">${(p.userPortSet ? p.assignedPort : (p.port || p.assignedPort)) || '—'}</span>
              <button class="btn-text" onclick="startEditPort('${p.id}', '${(p.userPortSet ? p.assignedPort : (p.port || p.assignedPort)) || ''}')" style="padding: 0; color: var(--primary); font-size: 0.75rem; display: inline-flex; align-items: center; gap: 2px;">
                <i class="fa-solid fa-pencil"></i> تغيير
              </button>
            </span>
          </div>
          <div class="detail-item">
            <span class="detail-label">الحجم التقريبي:</span>
            <span class="detail-value">${humanSize}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">آخر تعديل:</span>
            <span class="detail-value">${modifiedStr}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">أنشئ:</span>
            <span class="detail-value">${formatISODate(p.createdAt)}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">عُدّل:</span>
            <span class="detail-value">${formatISODate(p.modifiedAt)}</span>
          </div>
        </div>

        <div class="card-path-box" style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
          <button class="copy-path-btn" onclick="copyPathToClipboard('${p.id}')" title="نسخ المسار">
            <i class="fa-regular fa-copy"></i>
          </button>
          <button class="copy-path-btn" onclick="openInWindows('${p.id}', 'folder')" title="فتح مجلد المشروع في الويندوز" style="background: rgba(59, 130, 246, 0.15); color: #3b82f6; border-color: rgba(59, 130, 246, 0.3);">
            <i class="fa-regular fa-folder-open"></i>
            <span style="font-size: 0.75rem; margin-right: 4px; font-family: 'Cairo', sans-serif;">فتح المجلد</span>
          </button>
          ${p.entryFile ? `
          <button class="copy-path-btn" onclick="openInWindows('${p.id}', 'file')" title="فتح الملف الرئيسي في الويندوز" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border-color: rgba(16, 185, 129, 0.3);">
            <i class="fa-regular fa-file-code"></i>
            <span style="font-size: 0.75rem; margin-right: 4px; font-family: 'Cairo', sans-serif;">فتح الملف</span>
          </button>
          ` : ''}
          <button class="copy-path-btn" onclick="openInVSCode('${p.id}')" title="فتح المشروع في VS Code" style="background: rgba(168, 85, 247, 0.15); color: #a855f7; border-color: rgba(168, 85, 247, 0.3);">
            <i class="fa-solid fa-code"></i>
            <span style="font-size: 0.75rem; margin-right: 4px; font-family: 'Cairo', sans-serif;">VS Code</span>
          </button>
          <span class="path-text" title="${p.path}" style="flex: 1; min-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px;">${p.path}</span>
        </div>

        <div class="status-pill-container" id="statusPillContainer-${p.id}">
          ${isRunning && hasPort ? `
            <div class="status-pill running" style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">
              <span><i class="fa-solid fa-play fa-beat" style="margin-left: 6px;"></i>شغّال على المنفذ: ${p.runningPort}</span>
              ${kindLabelHtml}
              <a href="http://127.0.0.1:${p.runningPort}" target="_blank" class="status-link">
                زيارة الموقع <i class="fa-solid fa-arrow-up-right-from-square"></i>
              </a>
            </div>
          ` : isRunning && p.runningPort === null ? `
            <div class="status-pill running" style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">
              <span><i class="fa-solid fa-play fa-beat" style="margin-left: 6px;"></i>شغّال (مكتبي / صامت)</span>
              ${kindLabelHtml}
            </div>
          ` : p.status === 'error' ? `
            <div class="status-pill error" style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
              <span><i class="fa-solid fa-triangle-exclamation" style="margin-left: 6px;"></i>فشل في التشغيل</span>
            </div>
          ` : ''}
        </div>

        <!-- AI Overview Section -->
        <div class="overview-box" id="overviewBox-${p.id}" style="${p.overview ? 'display: block;' : 'display: none;'}">
          <div class="overview-header">
            <span><i class="fa-solid fa-brain"></i> نظرة عامة (AI)</span>
            <span class="overview-time" id="overviewTime-${p.id}">${p.overviewGeneratedAt ? 'تاريخ التوليد: ' + formatISODate(p.overviewGeneratedAt) : ''}</span>
          </div>
          <div class="overview-content collapsed" id="overviewContent-${p.id}">${p.overview || ''}</div>
          <div class="overview-footer" style="display: flex; gap: 8px; align-items: center;">
            <button class="btn-text" onclick="toggleOverviewContent('${p.id}')" id="toggleOverviewBtn-${p.id}">
              عرض التفاصيل <i class="fa-solid fa-chevron-down"></i>
            </button>
            <button class="btn-text" onclick="openOverviewModal('${p.id}')" style="color: var(--primary);">
              عرض النظرة التفصيلية <i class="fa-solid fa-expand"></i>
            </button>
            <button class="btn-text btn-refresh" onclick="generateAIOverview('${p.id}')" title="إعادة توليد النظرة العامة" style="margin-right: auto;">
              <i class="fa-solid fa-arrows-rotate"></i> إعادة التوليد
            </button>
          </div>
        </div>

        <div class="overview-loading" id="overviewLoading-${p.id}" style="display: none;">
          <div class="spinner-inline"></div>
          <span>العام...</span>
        </div>

        <div class="overview-loading" id="onboardLoading-${p.id}" style="display: none;">
          <div class="spinner-inline"></div>
          <span>جارٍ التحليل الذكي للمشروع… (0:00)</span>
        </div>

        <div class="overview-loading" id="deepLoading-${p.id}" style="display: none;">
          <div class="spinner-inline"></div>
          <span class="loading-text">جارٍ البدء في فحص الطبيب الذكي… (0:00)</span>
        </div>

        <div class="card-actions">
          ${primaryButtonHtml}
          <button class="btn btn-secondary logs-btn" onclick="openLogsModal('${p.id}')">
            <i class="fa-solid fa-terminal"></i> السجل
          </button>
          <button class="btn btn-secondary logs-btn" onclick="openProfileModal('${p.id}')" title="كل ما قِيس عن هذا البرنامج">
            <i class="fa-solid fa-id-card"></i> التفاصيل
          </button>
        </div>
      </div>
    `;

    // Hook image onerror fallback inside the newly added image element
    const imgElement = card.querySelector('.project-thumb-img');
    if (imgElement) {
      imgElement.onerror = () => {
        imgElement.parentNode.innerHTML = `
          <div class="placeholder-thumb">
            <i class="fa-solid fa-laptop-code"></i>
            <span>لا توجد صورة بعد</span>
          </div>
          <div class="card-badge badge-${(p.type || 'Static').toLowerCase()}">${p.type || 'Static'}</div>
          ${p.captureMethod ? `<div class="capture-method-badge badge-${p.captureMethod}">${p.captureMethod === 'web' ? 'ويب' : 'نافذة'}</div>` : ''}
          ${backupRibbonHtml}
        `;
      };
    }

    grid.appendChild(card);
  });
}

// applySearchBoxFilter and the #searchBox input were removed. Two search
// fields fought over the same grid with incompatible mechanisms: this one hid
// DOM nodes with display:none, while #searchInput rebuilds the grid entirely —
// so typing in one silently clobbered the other, and the result counter (bound
// to the model, not the DOM) kept reporting matches for hidden cards.
// #searchInput covers name and path already, with Arabic normalisation.

/**
 * Launches the target project process.
 * @param {string} id Project ID
 */
async function runProject(id) {
  const cardElement = document.querySelector(`.project-card[data-id="${id}"]`);
  if (!cardElement) return;

  const runBtn = cardElement.querySelector('.run-btn');
  const statusContainer = cardElement.querySelector('.status-pill-container');

  runBtn.disabled = true;
  runBtn.innerHTML = '<i class="fa-solid fa-spinner spinner"></i> تشغيل...';
  statusContainer.innerHTML = '';

  try {
    const response = await fetch(`/api/projects/${id}/run`, { method: 'POST' });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || `Failed to run project.`);
    }

    // Update Cache
    const projIdx = projectsCache.findIndex(p => p.id === id);
    if (projIdx !== -1) {
      projectsCache[projIdx].status = result.status;
      projectsCache[projIdx].runningPort = result.port;
      projectsCache[projIdx].captureMethod = result.method;
      projectsCache[projIdx].runningKind = result.kind || null;
    }

    showToast('تم تشغيل المشروع وبدء مراقبة المنفذ!', 'success');
    filterAndRenderProjects();
    if (typeof refreshRunningDock === 'function') refreshRunningDock();
  } catch (err) {
    showToast(`فشل تشغيل المشروع: ${err.message}`, 'error');
    
    // Update Cache Status
    const projIdx = projectsCache.findIndex(p => p.id === id);
    if (projIdx !== -1) {
      projectsCache[projIdx].status = 'error';
      projectsCache[projIdx].runningPort = null;
      projectsCache[projIdx].captureMethod = null;
    }
    filterAndRenderProjects();
  }
}

/**
 * Runs AI Onboarding and then runs the project.
 * @param {string} id Project ID
 */
async function analyzeThenRun(id) {
  await runAiOnboarding(id);
  const p = projectsCache.find(p => p.id === id);
  if (p && p.aiProfile) {
    await runProject(id);
  }
}

/**
 * Stops execution of the target running project.
 * @param {string} id Project ID
 */
async function stopProject(id) {
  const cardElement = document.querySelector(`.project-card[data-id="${id}"]`);
  let stopBtn = null;
  if (cardElement) {
    stopBtn = cardElement.querySelector('.stop-btn');
    if (stopBtn) {
      stopBtn.disabled = true;
      stopBtn.innerHTML = '<i class="fa-solid fa-spinner spinner"></i> إيقاف...';
    }
  }

  try {
    const response = await fetch(`/api/projects/${id}/stop`, { method: 'POST' });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || `Failed to stop project.`);
    }

    // Update Cache
    const projIdx = projectsCache.findIndex(p => p.id === id);
    if (projIdx !== -1) {
      projectsCache[projIdx].status = result.status;
      projectsCache[projIdx].runningPort = null;
      projectsCache[projIdx].captureMethod = null;
    }

    showToast('تم إيقاف تشغيل المشروع.', 'success');
    filterAndRenderProjects();
    if (typeof refreshRunningDock === 'function') refreshRunningDock();
  } catch (err) {
    showToast(`فشل إيقاف المشروع: ${err.message}`, 'error');
    filterAndRenderProjects();
  }
}

/**
 * Opens the monospace stdout/stderr logs viewer and initiates 2s polling.
 * @param {string} id Project ID
 * @param {string} projectName Escaped Project Name
 */
// ─── OpenRouter free models ────────────────────────────────────────────────
// The key is never held here. The page asks the server whether one is
// configured and sends chat turns through it, so nothing secret is ever in the
// browser, a screenshot or the network tab.

let orModels = [];
let orSelected = null;
let orConversation = [];
let orBusy = false;

function orEscape(s) { return escapeHTML(String(s === null || s === undefined ? '' : s)); }

/**
 * Formats a context window the way a person compares them: 1M, 128K, 8,192.
 *
 * @param {number} n Token count
 * @returns {string}
 */
function orContext(n) {
  if (!n) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}

async function openModelsModal() {
  const modal = document.getElementById('modelsModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  await orRefreshKeyState();
  await orLoadModels(false);
  orRefreshScores();
  orRefreshAvailability();
  gwRefresh();
}

async function orRefreshKeyState() {
  const el = document.getElementById('orKeyState');
  if (!el) return false;
  try {
    const res = await fetch('/api/openrouter/status');
    const data = await res.json();
    if (data.configured) {
      el.innerHTML = '<span style="color:#10b981;">✓ المفتاح مضبوط — يمكنك المحادثة</span>';
    } else {
      el.innerHTML = '<span style="color:var(--warning);">لا يوجد مفتاح — التصفّح متاح، والمحادثة تحتاج مفتاحاً</span>';
    }
    return data.configured === true;
  } catch (err) {
    el.textContent = 'تعذّر فحص حالة المفتاح.';
    return false;
  }
}

async function orLoadModels(force) {
  const list = document.getElementById('orModelList');
  const count = document.getElementById('orModelsCount');
  if (!list) return;
  list.innerHTML = '<div style="padding:20px;color:var(--text-secondary);">جاري الجلب…</div>';
  try {
    const res = await fetch('/api/openrouter/models' + (force ? '?refresh=1' : ''));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    orModels = data.models || [];
    count.textContent = orModels.length + ' نموذجاً مجانياً من ' + (data.totalOnOpenRouter || '?') + ' على OpenRouter';
    orRenderModels();
  } catch (err) {
    list.innerHTML = '<div style="padding:20px;color:var(--danger);">تعذّر الجلب: ' + orEscape(err.message) + '</div>';
  }
}

function orRenderModels() {
  const list = document.getElementById('orModelList');
  const filterEl = document.getElementById('orFilter');
  const q = (filterEl && filterEl.value || '').toLowerCase().trim();
  let shown = q
    ? orModels.filter(m => (m.name + ' ' + m.id + ' ' + m.vendor).toLowerCase().includes(q))
    : orModels.slice();

  // Once anything has been measured, measured order beats catalogue order:
  // scored models rise to the top, best first, and the rest keep their place.
  if (Object.keys(orScores).length) {
    shown.sort((a, b) => {
      const sa = orScores[a.id], sb = orScores[b.id];
      if (sa && sb) return sb.rank - sa.rank;
      if (sa) return -1;
      if (sb) return 1;
      return 0;
    });
  }

  if (!shown.length) {
    list.innerHTML = '<div style="padding:20px;color:var(--text-secondary);">لا نتائج.</div>';
    return;
  }

  list.innerHTML = shown.map(m => {
    const params = m.parameters.total
      ? m.parameters.total + (m.parameters.active ? ' <span style="color:var(--text-muted);">(' + orEscape(m.parameters.active) + ' نشط)</span>' : '')
      : '<span style="color:var(--text-muted);">غير مذكور</span>';
    const avail = orAvailability[m.id];
    const availChip = avail
      ? (function () {
          const st = AVAIL_STYLE[avail.status] || AVAIL_STYLE.unknown;
          return '<span class="or-chip" style="background:' + st.bg + ';border-color:' + st.border
            + ';color:' + st.colour + ';" title="' + orEscape(avail.detail || '') + '">'
            + orEscape(orAvailLabels[avail.status] || avail.status) + '</span>';
        })()
      : '';

    const score = orScores[m.id];
    // Why a model failed, not just that it did. Four causes used to show the
    // same red cross: a spent daily quota, an upstream provider outage, a model
    // that needs credits, and one that is simply not available here. They need
    // four different responses, so they get four different labels.
    const FAIL_LABELS = {
      'daily-quota': 'حصّة اليوم انتهت',
      'provider-failure': 'عطل عند المزوّد',
      'needs-credits': 'يحتاج رصيداً — ليس مجانياً',
      'access': 'غير متاح لهذا الاستخدام',
      'rate-limit': 'حدّ طلبات',
      'key': 'مشكلة في المفتاح'
    };
    const failedProbe = score ? (score.probes || []).find(p => !p.ok && p.kind) : null;
    const failChip = failedProbe
      ? '<span class="or-chip" style="background:rgba(245,158,11,.15);border-color:rgba(245,158,11,.4);" title="'
        + orEscape(failedProbe.error || '')
        + '">' + orEscape(FAIL_LABELS[failedProbe.kind] || failedProbe.kind)
        + (failedProbe.provider ? ' (' + orEscape(failedProbe.provider) + ')' : '') + '</span>'
      : '';
    const scoreChip = score
      ? '<span class="or-chip" style="background:rgba(16,185,129,.15);border-color:rgba(16,185,129,.35);" title="'
        + orEscape((score.probes || []).map(p => p.id + ': ' + (p.ok ? '✓' : '✗' + (p.kind ? ' ' + p.kind : ''))).join(' · '))
        + '">مقياس ' + score.passed + '/5'
        + (score.medianMs ? ' · ' + Math.round(score.medianMs / 100) / 10 + 's' : '') + '</span>'
      : '';

    const chips = [
      availChip,
      scoreChip,
      failChip,
      '<span class="or-chip">سياق ' + orContext(m.contextLength) + '</span>',
      m.maxOutput ? '<span class="or-chip">مخرجات ' + orContext(m.maxOutput) + '</span>' : '',
      (m.inputModalities || []).includes('image') ? '<span class="or-chip">صور</span>' : '',
      (m.inputModalities || []).includes('audio') ? '<span class="or-chip">صوت</span>' : '',
      (m.supports || []).includes('tools') ? '<span class="or-chip">أدوات</span>' : '',
      (m.supports || []).includes('reasoning') ? '<span class="or-chip">تفكير</span>' : '',
      m.moderated ? '<span class="or-chip">مُراقَب</span>' : ''
    ].filter(Boolean).join('');

    const selected = orSelected && orSelected.id === m.id;
    return '<div class="or-model' + (selected ? ' or-model-on' : '') + '" data-model-id="' + orEscape(m.id) + '">'
      + '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;">'
      + '<strong style="font-size:0.88rem;">' + orEscape(m.name) + '</strong>'
      + '<span style="font-size:0.78rem;white-space:nowrap;">' + params + '</span></div>'
      + '<div style="font-family:monospace;direction:ltr;text-align:right;font-size:0.7rem;color:var(--text-muted);margin:3px 0 6px;">' + orEscape(m.id) + '</div>'
      + '<div class="or-chips">' + chips + '</div>'
      + (m.description ? '<p style="font-size:0.76rem;color:var(--text-secondary);margin:7px 0 0;line-height:1.6;">'
          + orEscape(m.description.slice(0, 190)) + (m.description.length > 190 ? '…' : '') + '</p>' : '')
      + '</div>';
  }).join('');

  list.querySelectorAll('.or-model').forEach(el => {
    el.addEventListener('click', () => orSelectModel(el.getAttribute('data-model-id')));
  });
}

function orSelectModel(id) {
  const model = orModels.find(m => m.id === id);
  if (!model) return;
  orSelected = model;
  orConversation = [];
  orRenderModels();

  document.getElementById('orChatHeader').innerHTML =
    '<strong>' + orEscape(model.name) + '</strong>'
    + '<span style="color:var(--text-muted);"> · سياق ' + orContext(model.contextLength)
    + (model.parameters.total ? ' · ' + orEscape(model.parameters.total) + ' بارامتر' : '') + '</span>';
  document.getElementById('orChatLog').innerHTML =
    '<div style="color:var(--text-muted);font-size:0.82rem;text-align:center;padding:14px;">اكتب رسالتك لتجربة هذا النموذج</div>';
  document.getElementById('orChatInput').disabled = false;
  document.getElementById('orSendBtn').disabled = false;
  document.getElementById('orChatInput').focus();
}

function orAppend(role, text, meta) {
  const log = document.getElementById('orChatLog');
  const placeholder = log.querySelector('div[style*="text-align: center"], div[style*="text-align:center"]');
  if (placeholder) placeholder.remove();
  const mine = role === 'user';
  const bubble = document.createElement('div');
  bubble.style.cssText = 'max-width:88%;padding:9px 12px;border-radius:9px;font-size:0.85rem;line-height:1.75;white-space:pre-wrap;word-break:break-word;'
    + (mine
      ? 'align-self:flex-start;background:var(--primary);color:#fff;'
      : 'align-self:flex-end;background:var(--bg-tertiary);border:1px solid var(--border-color);color:var(--text-primary);');
  bubble.textContent = text;
  if (meta) {
    const m = document.createElement('div');
    m.style.cssText = 'margin-top:6px;font-size:0.68rem;opacity:.7;font-family:monospace;direction:ltr;text-align:right;';
    m.textContent = meta;
    bubble.appendChild(m);
  }
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

async function orSend() {
  if (orBusy || !orSelected) return;
  const input = document.getElementById('orChatInput');
  const text = input.value.trim();
  if (!text) return;

  orBusy = true;
  input.value = '';
  input.disabled = true;
  document.getElementById('orSendBtn').disabled = true;

  orAppend('user', text);
  orConversation.push({ role: 'user', content: text });
  const pending = orAppend('assistant', '…');

  try {
    const res = await fetch('/api/openrouter/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: orSelected.id, messages: orConversation })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);

    pending.textContent = data.reply || '(رد فارغ)';
    const bits = [Math.round(data.elapsedMs / 100) / 10 + 's'];
    if (data.usage) {
      bits.push('in ' + (data.usage.prompt_tokens || 0));
      bits.push('out ' + (data.usage.completion_tokens || 0));
    }
    if (data.finishReason && data.finishReason !== 'stop') bits.push(data.finishReason);
    const meta = document.createElement('div');
    meta.style.cssText = 'margin-top:6px;font-size:0.68rem;opacity:.7;font-family:monospace;direction:ltr;text-align:right;';
    meta.textContent = bits.join(' · ');
    pending.appendChild(meta);

    orConversation.push({ role: 'assistant', content: data.reply || '' });
  } catch (err) {
    pending.textContent = '⚠ ' + err.message;
    pending.style.color = 'var(--danger)';
    // A failed turn is dropped so the next attempt does not resend a dead exchange.
    orConversation.pop();
  } finally {
    orBusy = false;
    input.disabled = false;
    document.getElementById('orSendBtn').disabled = false;
    input.focus();
  }
}

/**
 * Holds a project so nothing launches it, or lets it go again.
 *
 * @param {string} id Project id
 * @param {boolean} on Whether to hold it
 */
async function toggleQuarantine(id, on) {
  let reason = null;
  if (on) {
    reason = prompt('لماذا تمنع تشغيله؟ (السبب يُعرض في كل مكان يُرفض فيه التشغيل)', 'يقتل عمليات أو يعمل كحارس');
    // Cancel means cancel. An empty answer is a reason left blank, which is a
    // choice; a dismissed dialog is not a decision to quarantine.
    if (reason === null) return;
  }
  try {
    const res = await fetch('/api/projects/' + encodeURIComponent(id) + '/quarantine', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: on, reason: reason || undefined })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'تعذّر التنفيذ');
    showToast(on ? 'حُجر المشروع — لن يُشغَّل تلقائياً ولا يدوياً.' : 'رُفع الحجر.', 'success');
    loadProjects();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── What Maktaba did to your projects ─────────────────────────────────────

const ACTION_LABELS = {
  'set-port': 'غيّرت المنفذ',
  'classify': 'غيّرت التصنيف',
  'autostart': 'الإقلاع التلقائي',
  'run': 'شغّلت المشروع',
  'stop': 'أوقفت المشروع'
};

function actionValue(v) {
  if (v === null || v === undefined) return '—';
  if (v === true) return 'مُفعَّل';
  if (v === false) return 'مُعطَّل';
  return String(v);
}

async function openActionsLog() {
  const modal = document.getElementById('actionsLogModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  await loadActionsLog();
}

async function loadActionsLog() {
  const body = document.getElementById('actionsLogBody');
  if (!body) return;
  body.innerHTML = '<div style="padding:20px;color:var(--text-secondary);">جاري القراءة…</div>';
  try {
    const res = await fetch('/api/actions?limit=100');
    const data = await res.json();
    const actions = data.actions || [];

    if (!actions.length) {
      body.innerHTML = '<div style="padding:20px;color:var(--text-secondary);">لم تسجَّل قرارات بعد.</div>';
      return;
    }

    body.innerHTML = actions.map(a => {
      const when = new Date(a.ts).toLocaleString('ar-EG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const changed = (a.before !== null || a.after !== null)
        ? '<span style="font-family:monospace;direction:ltr;display:inline-block;">'
          + escapeHTML(actionValue(a.before)) + ' → ' + escapeHTML(actionValue(a.after)) + '</span>'
        : '';

      let control;
      if (a.undone) {
        control = '<span style="font-size:0.76rem;color:#10b981;">✓ متراجَع عنه</span>';
      } else if (a.canUndo) {
        control = '<button class="btn btn-secondary undo-action-btn" data-seq="' + a.seq
          + '" style="font-size:0.76rem;padding:5px 12px;">تراجع</button>';
      } else {
        // Say why there is no button. A greyed-out control with no explanation
        // reads as a bug rather than a deliberate limit.
        control = '<span style="font-size:0.72rem;color:var(--text-muted);max-width:230px;text-align:left;">'
          + escapeHTML(a.undoReason || 'لا يمكن التراجع') + '</span>';
      }

      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 12px;margin-bottom:6px;'
        + 'background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:6px;flex-wrap:wrap;">'
        + '<div style="min-width:0;flex:1;">'
        + '<strong style="font-size:0.86rem;">' + escapeHTML(ACTION_LABELS[a.action] || a.action) + '</strong>'
        + ' <span style="font-size:0.82rem;color:var(--text-secondary);">' + escapeHTML(a.projectName || '') + '</span>'
        + '<div style="font-size:0.74rem;color:var(--text-muted);margin-top:3px;">'
        + '#' + a.seq + ' · ' + escapeHTML(when) + (changed ? ' · ' + changed : '') + '</div></div>'
        + control + '</div>';
    }).join('');

    body.querySelectorAll('.undo-action-btn').forEach(btn => {
      btn.addEventListener('click', () => undoAction(parseInt(btn.getAttribute('data-seq'), 10)));
    });
  } catch (err) {
    body.innerHTML = '<div style="padding:20px;color:var(--danger);">تعذّرت القراءة: ' + escapeHTML(err.message) + '</div>';
  }
}

async function undoAction(seq) {
  try {
    const res = await fetch('/api/actions/' + seq + '/undo', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'تعذّر التراجع');
    showToast(data.detail || 'تم التراجع.', 'success');
    await loadActionsLog();
    // The catalogue changed underneath, so the cards must be redrawn or they
    // keep showing the value that was just reversed.
    loadProjects();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── The fleet audit, finally readable ─────────────────────────────────────
// A scheduled task has written logs/fleet-audit.json every morning since it was
// registered, and /api/audit has served it the whole time. Nothing in the page
// ever called that route, so every finding it produced — committed credentials,
// autostart entries with no owner, work never given back — existed only for
// whoever happened to run `npm run audit` in a terminal.

const AUDIT_SEVERITY = {
  warn: { label: 'يحتاج نظرة', colour: 'var(--warning)', bg: 'rgba(245,158,11,.12)', border: 'rgba(245,158,11,.35)' },
  info: { label: 'للعلم', colour: '#38bdf8', bg: 'rgba(56,189,248,.10)', border: 'rgba(56,189,248,.30)' },
  ok: { label: 'سليم', colour: '#10b981', bg: 'rgba(16,185,129,.08)', border: 'rgba(16,185,129,.25)' }
};

async function openAuditModal() {
  const modal = document.getElementById('auditModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  await loadAudit();
}

async function loadAudit() {
  const body = document.getElementById('auditBody');
  const meta = document.getElementById('auditMeta');
  if (!body) return;
  body.innerHTML = '<div style="padding:20px;color:var(--text-secondary);">جاري القراءة…</div>';
  try {
    const res = await fetch('/api/audit');
    const data = await res.json();

    if (!data.generatedAt) {
      meta.textContent = 'لم يُشغَّل تدقيق بعد.';
      body.innerHTML = '<div style="padding:20px;color:var(--text-secondary);">اضغط «شغّل التدقيق الآن».</div>';
      return;
    }

    const c = data.counts || {};
    // The age is part of the finding. A clean report from three weeks ago says
    // nothing about the machine today.
    meta.innerHTML = 'آخر تدقيق قبل <strong>' + (data.ageHours || 0) + '</strong> ساعة · '
      + '<span style="color:' + AUDIT_SEVERITY.ok.colour + ';">' + (c.ok || 0) + ' سليم</span> · '
      + '<span style="color:' + AUDIT_SEVERITY.info.colour + ';">' + (c.info || 0) + ' للعلم</span> · '
      + '<span style="color:' + AUDIT_SEVERITY.warn.colour + ';">' + (c.warn || 0) + ' يحتاج نظرة</span>';

    const order = { warn: 0, info: 1, ok: 2 };
    const findings = (data.findings || []).slice().sort((a, b) => order[a.severity] - order[b.severity]);
    body.innerHTML = findings.map(f => {
      const s = AUDIT_SEVERITY[f.severity] || AUDIT_SEVERITY.info;
      const items = (f.items || []).length
        ? '<ul style="margin:8px 0 0;padding-inline-start:18px;font-size:0.78rem;color:var(--text-secondary);line-height:1.9;">'
          + f.items.slice(0, 12).map(i => '<li style="word-break:break-word;">' + escapeHTML(i) + '</li>').join('')
          + (f.items.length > 12 ? '<li style="color:var(--text-muted);">…و' + (f.items.length - 12) + ' غيرها</li>' : '')
          + '</ul>'
        : '';
      return '<div style="margin-bottom:10px;padding:12px 14px;border-radius:8px;background:' + s.bg
        + ';border:1px solid ' + s.border + ';">'
        + '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap;">'
        + '<strong style="font-size:0.9rem;">' + escapeHTML(f.title) + '</strong>'
        + '<span style="font-size:0.72rem;color:' + s.colour + ';font-weight:700;">' + escapeHTML(f.area) + ' · ' + s.label + '</span></div>'
        + '<div style="font-size:0.82rem;color:var(--text-secondary);margin-top:5px;line-height:1.8;">' + escapeHTML(f.detail) + '</div>'
        + items + '</div>';
    }).join('');
  } catch (err) {
    body.innerHTML = '<div style="padding:20px;color:var(--danger);">تعذّرت القراءة: ' + escapeHTML(err.message) + '</div>';
  }
}

/**
 * Shows a count of findings that need a decision, so the audit is noticed
 * without being opened.
 */
async function refreshAuditBadge() {
  try {
    const res = await fetch('/api/audit');
    const data = await res.json();
    const badge = document.getElementById('auditWarnBadge');
    if (!badge) return;
    const warns = (data.counts && data.counts.warn) || 0;
    badge.textContent = warns;
    badge.style.display = warns ? 'inline-block' : 'none';
  } catch (err) { /* a badge is never worth an error */ }
}

// ─── Work Maktaba stashed and has not given back ───────────────────────────
// Stashing a project's uncommitted work happens silently, and returning it runs
// at exactly one place in the code. When that place is not reached, the work
// stays in the stash and the folder looks finished. This banner is the only
// thing that would have shown it.

let restorePending = [];

// Containers tied to catalogued projects, keyed by project id. Empty until the
// first fetch, and empty forever if Docker is not installed — a card simply
// shows no badge, which is the honest state when nothing can be observed.
let containersByProject = {};

async function refreshContainers() {
  try {
    const res = await fetch('/api/containers');
    const data = await res.json();
    const next = {};
    (data.containers || []).forEach(c => {
      if (!next[c.matchedProjectId]) next[c.matchedProjectId] = [];
      next[c.matchedProjectId].push(c);
    });
    containersByProject = next;
  } catch (err) {
    containersByProject = {};
  }
}

async function refreshRestorePoints() {
  const banner = document.getElementById('restoreBanner');
  if (!banner) return;
  try {
    const res = await fetch('/api/restore-points');
    const data = await res.json();
    restorePending = (data.pending || []).filter(p => !p.alreadyReturned);

    if (!restorePending.length) { banner.classList.add('hidden'); return; }

    const real = restorePending.filter(p => p.holdsRealWork).length;
    const files = restorePending.reduce((n, p) => n + p.trackedCount + p.untrackedCount, 0);
    document.getElementById('restoreBannerText').innerHTML =
      '⚠ المكتبة حفظت شغلاً من ' + restorePending.length + ' مشروع ولم تُعِده — ' + files + ' ملفاً'
      + (real ? ' <span style="color:var(--warning);">(' + real + ' منها فيه شغل حقيقي)</span>' : ' (كلها ملفات أدوات)');
    banner.classList.remove('hidden');
    renderRestoreList();
  } catch (err) {
    banner.classList.add('hidden');
  }
}

function renderRestoreList() {
  const box = document.getElementById('restoreBannerList');
  if (!box) return;
  box.innerHTML = restorePending.map((p, i) => {
    // Say what is inside before asking anyone to act on it: a stash of tool
    // leftovers and a stash holding an edited source file deserve different
    // levels of attention, and only the contents can tell them apart.
    const what = p.toolingOnly
      ? '<span style="color:var(--text-muted);">ملفات أدوات فقط</span>'
      : '<span style="color:var(--warning);">' + p.trackedCount + ' معدّل · ' + p.untrackedCount + ' جديد</span>';
    const blocked = !p.canReturn;
    return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-tertiary);border-radius:6px;flex-wrap:wrap;">'
      + '<div style="min-width:0;"><strong style="font-size:0.86rem;">' + escapeHTML(p.projectName) + '</strong>'
      + ' <span style="font-size:0.78rem;">' + what + '</span>'
      + '<div style="font-size:0.72rem;color:var(--text-muted);direction:ltr;text-align:right;font-family:monospace;">'
      + escapeHTML(p.sample.slice(0, 3).join(' · ')) + (p.sample.length > 3 ? ' …' : '') + '</div></div>'
      + (blocked
        ? '<span style="font-size:0.76rem;color:var(--text-muted);">شجرة المشروع فيها تعديلات — احفظها أولاً</span>'
        : '<button class="btn btn-primary restore-return-btn" data-idx="' + i + '" style="font-size:0.78rem;padding:6px 12px;">رجّع شغلي</button>')
      + '</div>';
  }).join('');

  box.querySelectorAll('.restore-return-btn').forEach(btn => {
    btn.addEventListener('click', () => returnStashedWork(parseInt(btn.getAttribute('data-idx'), 10)));
  });
}

async function returnStashedWork(idx) {
  const p = restorePending[idx];
  if (!p) return;
  try {
    const res = await fetch('/api/restore-points/return', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: p.projectId, sha: p.sha })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'تعذّر الإرجاع');
    showToast('رجع شغلك إلى ' + p.projectName + '.', 'success');
    await refreshRestorePoints();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Which models are actually open to this account ────────────────────────
// The catalogue's "free" is a statement about price. Models listed free have
// answered 403 "only available on agentic harnesses", 402 "needs credits", and
// 502 from the provider behind them — none of which is visible in a price.

let orAvailability = {};
let orAvailTimer = null;

const AVAIL_STYLE = {
  'open': { colour: '#10b981', bg: 'rgba(16,185,129,.16)', border: 'rgba(16,185,129,.4)' },
  'rate-limited': { colour: 'var(--warning)', bg: 'rgba(245,158,11,.14)', border: 'rgba(245,158,11,.38)' },
  'provider-down': { colour: 'var(--warning)', bg: 'rgba(245,158,11,.12)', border: 'rgba(245,158,11,.3)' },
  'needs-credits': { colour: '#a855f7', bg: 'rgba(168,85,247,.14)', border: 'rgba(168,85,247,.35)' },
  'blocked': { colour: 'var(--danger)', bg: 'rgba(239,68,68,.14)', border: 'rgba(239,68,68,.38)' },
  'not-text': { colour: 'var(--text-muted)', bg: 'rgba(148,163,184,.12)', border: 'rgba(148,163,184,.3)' },
  'key-rejected': { colour: 'var(--danger)', bg: 'rgba(239,68,68,.14)', border: 'rgba(239,68,68,.38)' },
  'unknown': { colour: 'var(--text-muted)', bg: 'rgba(148,163,184,.1)', border: 'rgba(148,163,184,.25)' }
};

let orAvailLabels = {};

async function orRefreshAvailability() {
  const el = document.getElementById('orAvailState');
  if (!el) return;
  try {
    const res = await fetch('/api/models/availability');
    const data = await res.json();
    orAvailLabels = data.labels || {};
    orAvailability = {};
    (data.models || []).forEach(m => { orAvailability[m.id] = m; });

    const p = data.progress || {};
    const btn = document.getElementById('orAvailBtn');

    if (p.running) {
      if (btn) btn.disabled = true;
      el.innerHTML = 'يفحص: <strong>' + p.done + ' / ' + p.total + '</strong>'
        + (p.current ? '<div style="font-family:monospace;direction:ltr;text-align:right;font-size:0.7rem;color:var(--text-muted);">' + orEscape(p.current) + '</div>' : '');
      if (!orAvailTimer) orAvailTimer = setInterval(orRefreshAvailability, 4000);
    } else {
      if (btn) btn.disabled = false;
      if (orAvailTimer) { clearInterval(orAvailTimer); orAvailTimer = null; }

      if (!data.total) {
        el.innerHTML = '<span style="color:var(--text-muted);">لم يُفحص بعد.</span>';
      } else {
        const parts = Object.keys(data.byStatus || {})
          .sort((a, b) => (b === 'open') - (a === 'open'))
          .map(k => {
            const st = AVAIL_STYLE[k] || AVAIL_STYLE.unknown;
            return '<span style="color:' + st.colour + ';">' + data.byStatus[k] + ' ' + orEscape(orAvailLabels[k] || k) + '</span>';
          });
        el.innerHTML = '<strong>' + data.open + '</strong> مفتوح من ' + data.total
          + '<div style="font-size:0.74rem;margin-top:3px;">' + parts.join(' · ') + '</div>'
          // A sweep that stopped at the quota measured fewer models than it set
          // out to, and saying so is the difference between "these are the
          // results" and "these are the results so far".
          + (p.stoppedReason === 'daily-quota'
            ? '<div style="font-size:0.72rem;color:var(--warning);margin-top:3px;">توقّف عند حصّة اليوم — الباقي غير مفحوص</div>' : '');
      }
    }
    if (Object.keys(orAvailability).length) orRenderModels();
  } catch (err) {
    el.textContent = 'تعذّرت القراءة.';
  }
}

async function orRunAvailability() {
  try {
    const res = await fetch('/api/models/availability/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    const data = await res.json();
    if (!data.started) { showToast(data.reason || 'لم يبدأ.', 'warning'); return; }
    showToast('يفحص ' + data.total + ' نموذجاً — سؤال واحد صغير لكل واحد.', 'success');
    orRefreshAvailability();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Measured ranking ──────────────────────────────────────────────────────
// orScores maps a model id to its scorecard so the list can show a rank badge
// next to a model without a second request per card.
let orScores = {};
let orBenchTimer = null;

async function orRefreshScores() {
  const el = document.getElementById('orBenchState');
  try {
    const res = await fetch('/api/models/scores');
    const data = await res.json();
    orScores = {};
    (data.models || []).forEach(m => { orScores[m.id] = m; });

    const p = data.progress || {};
    const best = (data.models || [])[0];
    const stopBtn = document.getElementById('orBenchStopBtn');
    const runBtn = document.getElementById('orBenchBtn');

    if (p.running) {
      if (stopBtn) stopBtn.classList.remove('hidden');
      if (runBtn) runBtn.disabled = true;
      el.innerHTML = 'يقيس الآن: <strong>' + p.done + ' / ' + p.total + '</strong>'
        + (p.current ? '<div style="font-family:monospace;direction:ltr;text-align:right;font-size:0.72rem;color:var(--text-muted);margin-top:3px;">' + orEscape(p.current) + '</div>' : '');
      if (!orBenchTimer) orBenchTimer = setInterval(orRefreshScores, 4000);
    } else {
      if (stopBtn) stopBtn.classList.add('hidden');
      if (runBtn) runBtn.disabled = false;
      if (orBenchTimer) { clearInterval(orBenchTimer); orBenchTimer = null; }
      if (p.stoppedReason === 'daily-quota') {
        // The run did not fail — it stopped on purpose, and everything measured
        // before that point is kept. Saying so prevents a re-run that would only
        // hit the same wall.
        el.innerHTML = '<span style="color:var(--warning);">توقّف القياس: انتهت حصّة اليوم المجانية.</span>'
          + '<div style="font-size:0.74rem;color:var(--text-muted);margin-top:3px;">'
          + 'النتائج المقيسة محفوظة · ' + (p.scoredModels || 0) + ' نموذجاً مُقيَّماً · أكمِل غداً</div>'
          + (best ? '<div style="font-size:0.78rem;margin-top:3px;">الأفضل حتى الآن: <strong>'
              + orEscape(best.name || best.id) + '</strong></div>' : '');
      } else if (best) {
        el.innerHTML = 'الأفضل الآن: <strong>' + orEscape(best.name || best.id) + '</strong>'
          + ' <span style="color:var(--text-muted);">(' + best.passed + '/5 · '
          + (best.medianMs ? Math.round(best.medianMs / 100) / 10 + 's' : '—') + ')</span>'
          + '<div style="font-size:0.74rem;color:var(--text-muted);margin-top:3px;">'
          + (p.scoredModels || 0) + ' نموذجاً مُقيَّماً</div>';
      } else {
        el.innerHTML = '<span style="color:var(--warning);">لم تُقَس أي نماذج بعد — اضغط «قِس النماذج».</span>';
      }
    }
    if (Object.keys(orScores).length) orRenderModels();
  } catch (err) {
    if (el) el.textContent = 'تعذّرت قراءة النتائج.';
  }
}

async function orRunBench() {
  try {
    const res = await fetch('/api/models/bench/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (!data.started) { showToast(data.reason || 'لم يبدأ القياس.', 'warning'); return; }
    showToast('بدأ قياس ' + data.total + ' نموذجاً — واحداً تلو الآخر حتى لا نصطدم بحدّ الطلبات.', 'success');
    orRefreshScores();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Gateway ───────────────────────────────────────────────────────────────

async function gwRefresh() {
  const el = document.getElementById('gwState');
  if (!el) return;
  try {
    const res = await fetch('/api/gateway/status');
    const s = await res.json();
    const ready = s.tokenCreated && s.keyConfigured;
    const lines = [];
    lines.push(ready
      ? '<span style="color:#10b981;">✓ البوابة جاهزة</span>'
      : '<span style="color:var(--warning);">'
        + (!s.keyConfigured ? 'تحتاج مفتاح OpenRouter' : 'تحتاج مفتاح بوابة')
        + '</span>');
    lines.push('<div style="font-family:monospace;direction:ltr;text-align:right;font-size:0.72rem;color:var(--text-muted);margin-top:3px;">'
      + orEscape(s.baseUrl) + '</div>');
    if (s.best) {
      lines.push('<div style="font-size:0.74rem;margin-top:3px;">auto → <span style="font-family:monospace;direction:ltr;">'
        + orEscape(s.best.id) + '</span></div>');
    }
    el.innerHTML = lines.join('');
    const btn = document.getElementById('gwTokenBtn');
    if (btn) btn.textContent = s.tokenCreated ? 'مفتاح جديد' : 'أنشئ مفتاحاً';
  } catch (err) {
    el.textContent = 'تعذّرت قراءة حالة البوابة.';
  }
}

async function gwCreateToken() {
  // A new token invalidates the old one, so anything already pointed at the
  // gateway stops working until it is updated. Say that before doing it.
  const status = await fetch('/api/gateway/status').then(r => r.json()).catch(() => ({}));
  if (status.tokenCreated && !confirm('إنشاء مفتاح جديد يُبطل المفتاح القديم، وأي برنامج يستخدمه سيتوقف. متابعة؟')) return;

  try {
    const res = await fetch('/api/gateway/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    const data = await res.json();
    if (!data.token) throw new Error(data.error || 'فشل الإنشاء');

    const box = document.getElementById('gwToken');
    box.classList.remove('hidden');
    box.innerHTML =
      '<div style="font-size:0.74rem;color:var(--text-secondary);margin-bottom:4px;">انسخه الآن — لن يُعرض تلقائياً مرة أخرى:</div>'
      + '<div style="display:flex;gap:6px;align-items:center;">'
      + '<code id="gwTokenText" style="flex:1;direction:ltr;text-align:right;font-family:monospace;font-size:0.72rem;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:6px;padding:6px 8px;word-break:break-all;">'
      + orEscape(data.token) + '</code>'
      + '<button id="gwCopyBtn" class="btn btn-secondary" style="font-size:0.72rem;padding:6px 10px;">نسخ</button></div>';

    document.getElementById('gwCopyBtn').addEventListener('click', () => {
      navigator.clipboard.writeText(data.token)
        .then(() => showToast('نُسخ المفتاح.', 'success'))
        .catch(() => showToast('انسخه يدوياً.', 'warning'));
    });
    gwRefresh();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function gwShowUsage() {
  try {
    const res = await fetch('/api/gateway/usage?limit=15');
    const u = await res.json();
    if (!u.calls) { showToast('لم تستقبل البوابة أي طلب بعد.', 'info'); return; }
    const box = document.getElementById('gwToken');
    box.classList.remove('hidden');
    const rows = Object.keys(u.byModel).map(k =>
      '<div style="display:flex;justify-content:space-between;gap:8px;font-size:0.74rem;padding:2px 0;">'
      + '<span style="font-family:monospace;direction:ltr;text-align:right;">' + orEscape(k) + '</span>'
      + '<span>' + u.byModel[k].calls + ' طلب'
      + (u.byModel[k].failures ? ' · <span style="color:var(--danger);">' + u.byModel[k].failures + ' فشل</span>' : '')
      + '</span></div>').join('');
    box.innerHTML = '<div style="font-size:0.78rem;margin-bottom:5px;"><strong>' + u.calls + '</strong> طلباً · '
      + u.tokens.toLocaleString('en-US') + ' توكن</div>' + rows;
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/**
 * Shows the measured detail sheet for one program.
 * Everything here was read off the disk by lib/profiler.js — no AI, no guesses,
 * so a field is either true or absent.
 *
 * @param {string} id Project id
 */
async function openProfileModal(id) {
  const modal = document.getElementById('profileModal');
  const body = document.getElementById('profileBody');
  const title = document.getElementById('profileModalTitle');
  if (!modal || !body) return;

  const cached = projectsCache.find(p => p.id === id);
  title.textContent = 'تفاصيل: ' + ((cached && cached.name) || '');
  body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary);">جاري القراءة…</div>';
  modal.classList.remove('hidden');

  let data = null;
  try {
    const res = await fetch('/api/projects/' + encodeURIComponent(id) + '/profile');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (err) {
    body.innerHTML = '<div style="padding:24px;color:var(--danger);">تعذّرت القراءة: ' + escapeHTML(err.message) + '</div>';
    return;
  }

  const p = data.profile;
  if (!p) {
    body.innerHTML = '<div style="padding:24px;color:var(--text-secondary);">لم يُوصف هذا البرنامج بعد. شغّل «وصف البرامج» من قائمة الإجراءات.</div>';
    return;
  }

  const row = (label, value, tone) => {
    if (value === null || value === undefined || value === '' ||
        (Array.isArray(value) && value.length === 0)) return '';
    const shown = Array.isArray(value) ? value.join('، ') : String(value);
    const color = tone === 'warn' ? 'var(--warning)' : tone === 'bad' ? 'var(--danger)'
      : tone === 'good' ? '#10b981' : 'var(--text-primary)';
    return '<div style="display:grid;grid-template-columns:9rem 1fr;gap:12px;padding:7px 0;border-bottom:1px solid var(--border-color);">'
      + '<span style="color:var(--text-secondary);font-size:0.82rem;">' + escapeHTML(label) + '</span>'
      + '<span style="color:' + color + ';font-size:0.86rem;word-break:break-word;">' + escapeHTML(shown) + '</span></div>';
  };
  const section = (heading, inner) => inner
    ? '<div style="margin-bottom:18px;"><div style="font-weight:600;font-size:0.9rem;margin-bottom:6px;color:var(--primary);">'
      + escapeHTML(heading) + '</div>' + inner + '</div>'
    : '';

  const q = Object.entries(p.quality).filter(([, v]) => v).map(([k]) => k);
  const risks = [];
  if (p.risk.isWatchdog) risks.push('يعمل كحارس');
  if (p.risk.killsProcesses) risks.push('يقتل عمليات');
  if (p.risk.autoStarts) risks.push('يسجّل إقلاعاً تلقائياً');

  body.innerHTML =
    (p.purpose ? '<div style="padding:12px 14px;background:var(--bg-tertiary);border-radius:8px;margin-bottom:18px;font-size:0.9rem;line-height:1.7;">'
      + escapeHTML(p.purpose) + '</div>' : '')
    + section('الأساس',
        row('اللغة', p.runtime) + row('مدير الحزم', p.packageManager) +
        row('ملفات التعريف', p.manifests) + row('المسار', data.path))
    + section('التشغيل',
        row('الملف المسجَّل', p.entry.recorded) +
        row('موجود فعلاً؟', p.entry.recordedExists === null ? null : (p.entry.recordedExists ? 'نعم' : 'لا'),
            p.entry.recordedExists === false ? 'bad' : 'good') +
        row('main المعلَن', p.entry.declaredMain) +
        row('أوامر npm', p.scripts) +
        row('منافذ يذكرها', p.declaredPorts))
    + section('الاعتماديات',
        row('العدد', p.dependencies.count) + row('أبرزها', p.dependencies.names.slice(0, 12)))
    + section('الإصدارات',
        row('مستودع git', p.git.isRepo ? 'نعم' : 'لا', p.git.isRepo ? 'good' : 'warn') +
        row('عدد الالتزامات', p.git.isRepo ? p.git.commits : null, p.git.commits === 0 ? 'bad' : undefined) +
        row('الفرع', p.git.branch) + row('نسخة بعيدة', p.git.remote || (p.git.isRepo ? 'لا يوجد' : null),
            p.git.isRepo && !p.git.remote ? 'warn' : undefined) +
        row('ملفات معلّقة', p.git.dirty) + row('آخر التزام', p.git.lastCommit))
    + section('الحجم',
        row('كوده الخاص', p.size.megabytes + ' ميجابايت' + (p.size.truncated ? ' (أو أكثر)' : '')) +
        row('عدد الملفات', p.size.files.toLocaleString('en-US')))
    + section('الجودة', row('موجود', q.length ? q : null, 'good'))
    + (risks.length ? section('تحذيرات',
        row('يفعل', risks, 'warn') + row('الدليل', p.risk.evidence, 'warn')) : '')
    + '<div style="color:var(--text-muted);font-size:0.74rem;margin-top:10px;">قُيس في ' + escapeHTML(String(p.profiledAt).slice(0, 16).replace('T', ' ')) + '</div>';
}

function openLogsModal(id, projectName) {
  const modal = document.getElementById('logsModal');
  const modalTitle = document.getElementById('logsModalTitle');
  const logsContent = document.getElementById('logsContent');

  // Read the name from the cache rather than from the inline attribute, and
  // escape it: a project name comes from a folder or package.json on disk, so
  // it is not trusted markup.
  const cached = projectsCache.find(p => p.id === id);
  const safeName = escapeHTML((cached && cached.name) || projectName || '');
  modalTitle.innerHTML = `<i class="fa-solid fa-terminal logs-title-icon"></i> سجل مخرجات المشروع: ${safeName}`;
  logsContent.textContent = 'جاري الاتصال وسحب المخرجات...';
  
  modal.classList.remove('hidden');

  // Trigger immediate log pull
  pullLogs(id);

  // Poll logs backend endpoint every 2 seconds
  logsPollInterval = setInterval(() => {
    pullLogs(id);
  }, 2000);
}

/**
 * Disconnects log polling and hides logs overlay window.
 */
function closeLogsModal() {
  if (logsPollInterval) {
    clearInterval(logsPollInterval);
    logsPollInterval = null;
  }
  document.getElementById('logsModal').classList.add('hidden');
}

/**
 * Fetches logs and auto-scrolls down if checkbox checked.
 * @param {string} id Project ID
 */
async function pullLogs(id) {
  try {
    const response = await fetch(`/api/projects/${id}/logs`);
    if (!response.ok) {
      throw new Error(`Could not load logs.`);
    }
    const result = await response.json();
    const logsContent = document.getElementById('logsContent');
    
    if (result.logs && result.logs.length > 0) {
      logsContent.textContent = result.logs.join('\n');
    } else {
      logsContent.textContent = 'لا توجد مخرجات مسجلة في الذاكرة المؤقتة حتى الآن.';
    }

    // AutoScroll checkbox implementation
    const autoScrollCheck = document.getElementById('autoScrollCheck');
    const logsContainer = document.querySelector('.logs-container');
    if (autoScrollCheck.checked) {
      logsContainer.scrollTop = logsContainer.scrollHeight;
    }
  } catch (err) {
    console.error('Error fetching logs:', err);
  }
}

/**
 * Displays overlay modal with matching duplicated project paths.
 * @param {string} id Project ID
 */
function showDuplicatesModal(id) {
  const project = projectsCache.find(p => p.id === id);
  if (!project || !project.duplicates || project.duplicates.length === 0) return;

  const list = document.getElementById('duplicatesList');
  list.innerHTML = '';

  project.duplicates.forEach(path => {
    const item = document.createElement('li');
    item.textContent = path;
    list.appendChild(item);
  });

  document.getElementById('duplicatesModal').classList.remove('hidden');
}

/**
 * Hides duplicates warning popup.
 */
function closeDuplicatesModal() {
  document.getElementById('duplicatesModal').classList.add('hidden');
}

/**
 * Displays overlay modal with all backups for a project.
 * @param {string} id Project ID
 */
function showBackupsModal(id) {
  const p = projectsCache.find(proj => proj.id === id);
  if (!p) return;

  const modal = document.getElementById('backupsModal');
  const titleText = document.getElementById('backupsModalTitleText');
  const list = document.getElementById('backupsList');

  if (!modal || !list) return;

  if (titleText) {
    titleText.textContent = `النسخ الاحتياطية لـ ${p.name || 'مشروع بدون اسم'}`;
  }

  list.innerHTML = '';

  // 1. First Row: Primary itself
  const primaryItem = document.createElement('li');
  primaryItem.style.display = 'flex';
  primaryItem.style.justify = 'space-between';
  primaryItem.style.alignItems = 'center';
  primaryItem.style.background = 'rgba(16, 185, 129, 0.1)';
  primaryItem.style.border = '1px solid rgba(16, 185, 129, 0.25)';
  primaryItem.style.padding = '12px';
  primaryItem.style.borderRadius = '6px';
  primaryItem.style.gap = '12px';
  primaryItem.style.borderRight = '4px solid var(--success)';

  primaryItem.innerHTML = `
    <div style="flex: 1; min-width: 0; text-align: right; direction: rtl;">
      <div style="font-weight: 700; color: var(--success); margin-bottom: 4px;">✅ الأحدث (المشروع الحالي)</div>
      <div style="font-size: 0.75rem; color: var(--text-muted); font-family: monospace; direction: ltr; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${p.path}">${p.path}</div>
      <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">آخر تعديل: ${formatISODate(p.modifiedAt)}</div>
    </div>
    <button class="btn btn-secondary" onclick="openInWindows('${p.id}', 'folder')" style="padding: 4px 10px; font-size: 0.8rem; white-space: nowrap;">
      <i class="fa-regular fa-folder-open" style="margin-left: 4px;"></i> فتح في الويندوز
    </button>
  `;
  list.appendChild(primaryItem);

  // 2. Subsequent Rows: Backups sorted newest-first
  const backups = p.backups || [];
  backups.forEach(backup => {
    const backupItem = document.createElement('li');
    backupItem.style.display = 'flex';
    backupItem.style.justify = 'space-between';
    backupItem.style.alignItems = 'center';
    backupItem.style.background = 'var(--bg-primary)';
    backupItem.style.border = '1px solid var(--border-color)';
    backupItem.style.padding = '12px';
    backupItem.style.borderRadius = '6px';
    backupItem.style.gap = '12px';
    backupItem.style.borderRight = '4px solid var(--primary)';

    backupItem.innerHTML = `
      <div style="flex: 1; min-width: 0; text-align: right; direction: rtl;">
        <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">${backup.name || 'نسخة احتياطية'}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted); font-family: monospace; direction: ltr; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${backup.path}">${backup.path}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">آخر تعديل: ${formatISODate(backup.modifiedAt)}</div>
      </div>
      <button class="btn btn-secondary" onclick="openInWindows('${backup.id}', 'folder')" style="padding: 4px 10px; font-size: 0.8rem; white-space: nowrap;">
        <i class="fa-regular fa-folder-open" style="margin-left: 4px;"></i> فتح في الويندوز
      </button>
    `;
    list.appendChild(backupItem);
  });

  modal.classList.remove('hidden');
}

/**
 * Helper to copy absolute project directory path to clipboard.
 * @param {string} id Project ID
 * @param {string} path Absolute filepath
 */
function copyPathToClipboard(id) {
  // The path is read from the cache and never travels through an inline HTML
  // attribute, so no escaping can corrupt it. Windows paths are backslash-heavy
  // and a missed escape silently mangled all 110 of them.
  const cached = projectsCache.find(p => p.id === id);
  navigator.clipboard.writeText((cached && cached.path) || '')
    .then(() => {
      showToast('تم نسخ مسار المجلد إلى الحافظة بنجاح!', 'success');
    })
    .catch(() => {
      showToast('فشل في نسخ المسار.', 'error');
    });
}

/**
 * Renders skeleton card animations.
 */
function renderSkeletons() {
  const grid = document.getElementById('projectGrid');
  let skeletonsHtml = '';

  for (let i = 0; i < 6; i++) {
    skeletonsHtml += `
      <div class="skeleton-card">
        <div class="skeleton-thumb shimmer"></div>
        <div class="skeleton-body">
          <div class="skeleton-title shimmer"></div>
          <div class="skeleton-text shimmer"></div>
          <div class="skeleton-text-short shimmer"></div>
          <div class="skeleton-details shimmer"></div>
          <div class="skeleton-button-row">
            <div class="skeleton-btn shimmer"></div>
            <div class="skeleton-btn shimmer"></div>
            <div class="skeleton-btn shimmer"></div>
          </div>
        </div>
      </div>
    `;
  }
  grid.innerHTML = skeletonsHtml;
}

/**
 * Renders empty list state warnings or backend network errors.
 * @param {string} mode 'empty' or 'error' state
 */
function renderEmptyState(mode) {
  const grid = document.getElementById('projectGrid');
  
  if (mode === 'error') {
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-triangle-exclamation" style="color: var(--danger);"></i>
        <h3>فشل الاتصال بالخادم</h3>
        <p>لا يمكن الوصول لقاعدة البيانات حالياً. تأكد من تشغيل خادم backend وتحديث الصفحة.</p>
        <button class="btn btn-secondary" onclick="loadProjects()"><i class="fa-solid fa-arrows-rotate"></i> إعادة المحاولة</button>
      </div>
    `;
  } else if (mode === 'search') {
    grid.innerHTML = `
      <div class="empty-state" style="text-align: center; padding: 40px; color: var(--text-secondary);">
        <i class="fa-solid fa-magnifying-glass" style="font-size: 3rem; margin-bottom: 12px; opacity: 0.5;"></i>
        <h3>لا نتائج للبحث: "${escapeHTML(currentSearchQuery)}"</h3>
      </div>
    `;
  } else {
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fa-regular fa-folder-open"></i>
        <h3>لا توجد مشاريع</h3>
        <p>لم نجد أي مشروع يطابق خيارات البحث أو التصفية الحالية.</p>
      </div>
    `;
  }
}

/**
 * Shows interactive snackbar notification at the bottom left side.
 * @param {string} message Arabic localized message content
 * @param {string} type 'success', 'error', 'warning'
 */
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = 'fa-check-circle';
  if (type === 'error') icon = 'fa-exclamation-circle';
  if (type === 'warning') icon = 'fa-triangle-exclamation';

  toast.innerHTML = `
    <i class="fa-solid ${icon}"></i>
    <span>${message}</span>
  `;
  
  container.appendChild(toast);

  // Remove toast animation triggers
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    toast.addEventListener('animationend', () => {
      toast.remove();
    });
    // Fallback if animationend doesn't trigger
    setTimeout(() => toast.remove(), 350);
  }, 3500);
}

/**
 * Helper to humanize size in bytes.
 * @param {number} bytes Size in bytes
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 بايت';
  const k = 1024;
  const sizes = ['بايت', 'كيلوبايت', 'ميجابايت', 'جيجابايت'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Formats ISO date strings to localized Cairo/Arabic date string.
 * @param {string} dateString ISO Datestring
 */
function formatDate(dateString) {
  if (!dateString) return '—';
  try {
    const d = new Date(dateString);
    return d.toLocaleDateString('ar-EG', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
  } catch (e) {
    return '—';
  }
}

// escapeJsString was removed: no user-controlled string is embedded in an
// inline JS event any more. Handlers pass only a project id (a sha1 hex
// string) and read the real values from projectsCache, so there is nothing
// left to escape — and no escaping bug left to have.

/**
 * Formats ISO date strings to YYYY-MM-DD local format.
 * @param {string} isoString ISO Datestring
 */
function formatISODate(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '—';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  } catch (e) {
    return '—';
  }
}

/**
 * Toggles the visibility of the AI overview panel or triggers generation if none exists.
 * @param {string} id Project ID
 */
async function toggleOverview(id) {
  const project = projectsCache.find(p => p.id === id);
  if (!project) return;

  const overviewBox = document.getElementById(`overviewBox-${id}`);
  const isHidden = overviewBox.style.display === 'none';

  if (isHidden && !project.overview) {
    await generateAIOverview(id);
  } else {
    toggleOverviewContent(id);
  }
}

/**
 * Collapses or expands the overview content box.
 * @param {string} id Project ID
 */
function toggleOverviewContent(id) {
  const content = document.getElementById(`overviewContent-${id}`);
  const toggleBtn = document.getElementById(`toggleOverviewBtn-${id}`);
  
  if (content.classList.contains('collapsed')) {
    content.classList.remove('collapsed');
    toggleBtn.innerHTML = 'إغلاق التفاصيل <i class="fa-solid fa-chevron-up"></i>';
  } else {
    content.classList.add('collapsed');
    toggleBtn.innerHTML = 'عرض التفاصيل <i class="fa-solid fa-chevron-down"></i>';
  }
}

/**
 * Invokes the backend API to run the AI overview analysis.
 * @param {string} id Project ID
 */
// Re-entrancy guard: this operation can run for minutes, and a card
// re-render used to hide it, inviting a second click and a second agent.
async function generateAIOverview(id) {
  if (!beginOp(id, 'توليد نظرة عامة')) return;
  try {
    return await generateAIOverviewInner(id);
  } finally {
    endOp(id);
  }
}

async function generateAIOverviewInner(id) {
  const cardElement = document.querySelector(`.project-card[data-id="${id}"]`);
  if (!cardElement) return;

  const aiBtn = cardElement.querySelector('.overview-btn');
  const refreshBtn = cardElement.querySelector('.btn-refresh');
  const loading = document.getElementById(`overviewLoading-${id}`);
  const overviewBox = document.getElementById(`overviewBox-${id}`);
  const content = document.getElementById(`overviewContent-${id}`);
  const timeText = document.getElementById(`overviewTime-${id}`);
  const toggleBtn = document.getElementById(`toggleOverviewBtn-${id}`);
  const loadingText = loading ? loading.querySelector('span') : null;

  // Disable UI elements and show loading state
  if (aiBtn) aiBtn.disabled = true;
  if (refreshBtn) refreshBtn.disabled = true;
  overviewBox.style.display = 'none';

  if (loading) {
    loading.style.display = 'flex';
  }

  // Clear any existing timer for this project
  if (runningOverviewTimers[id]) {
    clearInterval(runningOverviewTimers[id]);
  }

  const startTime = Date.now();
  if (loadingText) {
    loadingText.textContent = 'جارٍ التحليل عبر الذكاء الاصطناعي… (0:00)';
  }

  runningOverviewTimers[id] = setInterval(() => {
    const elapsedMs = Date.now() - startTime;
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const formattedSeconds = String(seconds).padStart(2, '0');
    const timeStr = `${minutes}:${formattedSeconds}`;
    if (loadingText) {
      loadingText.textContent = `جارٍ التحليل عبر الذكاء الاصطناعي… (${timeStr})`;
    }
  }, 1000);

  try {
    const response = await fetch(`/api/projects/${id}/overview`, { method: 'POST' });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'فشل توليد النظرة العامة.');
    }

    // Stop timer early to prevent visual jump before redraw
    if (runningOverviewTimers[id]) {
      clearInterval(runningOverviewTimers[id]);
      delete runningOverviewTimers[id];
    }

    // Update frontend memory cache
    const projIdx = projectsCache.findIndex(p => p.id === id);
    if (projIdx !== -1) {
      projectsCache[projIdx].overview = result.overview;
      projectsCache[projIdx].overviewGeneratedAt = result.generatedAt;
      projectsCache[projIdx].overviewStack = result.stack;
    }

    // Refresh cards representation to include the new detailed button
    filterAndRenderProjects();

    // Automatically open the detailed overview popup
    openOverviewModal(id);

    showToast(result.ok ? 'تم توليد النظرة العامة بنجاح!' : 'تنبيه أثناء توليد النظرة العامة.', result.ok ? 'success' : 'warning');
  } catch (err) {
    showToast(`فشل توليد النظرة العامة: ${err.message}`, 'error');
    
    // Stop timer
    if (runningOverviewTimers[id]) {
      clearInterval(runningOverviewTimers[id]);
      delete runningOverviewTimers[id];
    }

    // Show inline error in the card's overview section
    if (overviewBox && content) {
      overviewBox.style.display = 'block';
      content.innerHTML = `<span style="color: var(--danger); font-size: 0.9rem;"><i class="fa-solid fa-triangle-exclamation"></i> فشل توليد النظرة العامة: ${escapeHTML(err.message)}</span>`;
      content.classList.remove('collapsed');
      if (toggleBtn) toggleBtn.style.display = 'none';
    }
  } finally {
    if (runningOverviewTimers[id]) {
      clearInterval(runningOverviewTimers[id]);
      delete runningOverviewTimers[id];
    }
    if (aiBtn) aiBtn.disabled = false;
    if (refreshBtn) refreshBtn.disabled = false;
    if (loading) {
      loading.style.display = 'none';
    }
    if (loadingText) {
      loadingText.textContent = 'جارٍ تحليل المشروع عبر acp… قد يستغرق دقائق';
    }
  }
}

/**
 * Opens the system error logs modal and pulls logs from backend.
 */
function openErrorLogsModal() {
  document.getElementById('errorLogsModal').classList.remove('hidden');
  refreshErrorLogs();
}

/**
 * Closes the system error logs modal.
 */
function closeErrorLogsModal() {
  document.getElementById('errorLogsModal').classList.add('hidden');
}

/**
 * Refreshes error log text, showing the newest entries first.
 */
async function refreshErrorLogs() {
  const content = document.getElementById('errorLogsContent');
  const refreshBtn = document.getElementById('refreshErrorLogsBtn');

  refreshBtn.disabled = true;
  content.textContent = 'جاري سحب سجل الأخطاء من الخادم...';

  try {
    const response = await fetch('/api/logs/errors');
    if (!response.ok) {
      throw new Error(`Failed to load error logs: ${response.statusText}`);
    }
    const text = await response.text();
    if (text.trim()) {
      const blocks = text.split(/----------------------------------------\r?\n/);
      const nonEmptyBlocks = blocks.map(b => b.trim()).filter(b => b.length > 0);
      content.textContent = nonEmptyBlocks.reverse().join('\n\n----------------------------------------\n\n');
    } else {
      content.textContent = 'سجل الأخطاء فارغ حالياً. لا توجد أي أخطاء مسجلة.';
    }
  } catch (err) {
    content.textContent = `فشل تحميل سجل الأخطاء: ${err.message}`;
  } finally {
    refreshBtn.disabled = false;
  }
}

/**
 * Opens a modal displaying project evaluation confidence signals.
 * @param {string} id Project ID
 */
function showSignalsPopover(id) {
  const project = projectsCache.find(p => p.id === id);
  if (!project) return;

  const signalsList = document.getElementById('signalsList');
  if (!signalsList) return;

  signalsList.innerHTML = '';

  const signals = project.signals || [];
  if (signals.length === 0) {
    const item = document.createElement('li');
    item.textContent = 'لا توجد تفاصيل';
    signalsList.appendChild(item);
  } else {
    signals.forEach(sig => {
      const item = document.createElement('li');
      const points = sig.points;
      if (points > 0) {
        item.textContent = `✓ ${sig.label} (+${points})`;
      } else if (points < 0) {
        item.textContent = `✕ ${sig.label} (${points})`;
      } else {
        item.textContent = `• ${sig.label}`;
      }
      signalsList.appendChild(item);
    });
  }

  const signalsModal = document.getElementById('signalsModal');
  if (signalsModal) {
    signalsModal.classList.remove('hidden');
  }
}

/**
 * Submits manual classification for a project.
 * @param {string} id Project ID
 * @param {string|null} value 'project' | 'not-project' | null
 */
async function classifyManual(id, value) {
  try {
    const response = await fetch(`/api/projects/${id}/classify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ value })
    });

    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }

    const updatedProject = await response.json();

    // Update in projectsCache
    const idx = projectsCache.findIndex(p => p.id === id);
    if (idx !== -1) {
      projectsCache[idx].classification = updatedProject.classification;
      projectsCache[idx].userClassification = updatedProject.userClassification;
      if (updatedProject.confidence !== undefined) {
        projectsCache[idx].confidence = updatedProject.confidence;
      }
      if (updatedProject.signals !== undefined) {
        projectsCache[idx].signals = updatedProject.signals;
      }
    }

    showToast('تم تحديث التصنيف بنجاح', 'success');
    filterAndRenderProjects();
  } catch (err) {
    console.error('Error manual classification:', err);
    alert('تعذّر تحديث التصنيف');
  }
}

/**
 * Toggles visibility of card overflow dropdown menu.
 * @param {Event} event Click event object
 * @param {string} id Project ID
 */
function toggleCardMenu(event, id) {
  event.stopPropagation();
  // Close all other open card menus
  document.querySelectorAll('.card-menu').forEach(menu => {
    if (menu.id !== `cardMenu-${id}`) {
      menu.classList.remove('open');
    }
  });

  const menu = document.getElementById(`cardMenu-${id}`);
  if (menu) {
    menu.classList.toggle('open');
  }
}

/**
 * Toggles visibility of actions dropdown menu.
 * @param {Event} event Click event object
 */
function toggleActionsMenu(event) {
  event.stopPropagation();
  // Close all card menus
  document.querySelectorAll('.card-menu').forEach(menu => {
    menu.classList.remove('open');
  });

  const menu = document.getElementById('actionsMenu');
  if (menu) {
    menu.classList.toggle('open');
  }
}

/**
 * Opens the detailed overview modal for the specified project.
 * @param {string} id Project ID
 */
function openOverviewModal(id) {
  const p = projectsCache.find(proj => proj.id === id);
  if (!p) return;

  const modal = document.getElementById('overviewModal');
  const titleText = document.getElementById('overviewModalTitleText');
  const techStackContainer = document.getElementById('overviewTechStack');
  const techStackBadge = document.getElementById('overviewTechStackBadge');
  const modalBody = document.getElementById('overviewModalBody');
  const modalTime = document.getElementById('overviewModalTime');

  if (!modal) return;

  // Set title to include p.name
  if (titleText) {
    titleText.textContent = `نظرة تفصيلية على المشروع: ${p.name || 'مشروع بدون اسم'}`;
  }

  // Render stack badge (hide if empty)
  if (techStackContainer && techStackBadge) {
    if (p.overviewStack) {
      techStackBadge.textContent = `اللغة/التقنيات: ${p.overviewStack}`;
      techStackContainer.style.display = 'block';
    } else {
      techStackContainer.style.display = 'none';
    }
  }

  // Format overview text: escape HTML first, then format headings and linebreaks
  if (modalBody) {
    const rawText = p.overview || 'لا توجد تفاصيل متوفرة حالياً.';
    modalBody.innerHTML = formatMarkdownOverview(rawText);
  }

  // Set formatted time at the bottom
  if (modalTime) {
    modalTime.textContent = p.overviewGeneratedAt ? `تاريخ التوليد: ${formatISODate(p.overviewGeneratedAt)}` : '';
  }

  // Open the modal
  modal.classList.remove('hidden');
}

/**
 * Safely escapes HTML content to prevent XSS.
 * @param {string} str Raw text
 * @returns {string} Escaped HTML
 */
function escapeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Converts markdown-style headings starting with '## ' into bold section headings (<h4>)
 * and preserves linebreaks.
 * @param {string} text Raw overview text
 * @returns {string} Formatted HTML
 */
function formatMarkdownOverview(text) {
  const escaped = escapeHTML(text);
  const lines = escaped.split('\n');
  const formattedLines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      return `<h4 style="margin-top: 16px; margin-bottom: 8px; font-weight: 700; color: var(--primary); font-size: 1.05rem;">${trimmed.substring(3).trim()}</h4>`;
    }
    return line;
  });
  return formattedLines.join('<br>');
}

/**
 * Requests the backend to open the project folder or entry file in Windows Explorer.
 * @param {string} id Project ID
 * @param {string} target 'folder' | 'file'
 */
async function openInWindows(id, target) {
  try {
    const response = await fetch(`/api/projects/${id}/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ target })
    });

    if (!response.ok) {
      throw new Error(`HTTP status ${response.status}`);
    }

    const result = await response.json();
    if (result.ok) {
      showToast(target === 'file' ? 'تم فتح الملف في الويندوز' : 'تم فتح مجلد المشروع في الويندوز', 'success');
    } else {
      throw new Error('Backend failed to open');
    }
  } catch (err) {
    console.error('Error opening path in windows:', err);
    alert('تعذّر فتح المسار في الويندوز');
  }
}

/**
 * Starts the batch AI overview generation for all primary projects.
 */
async function generateAllAIOverviews() {
  const btn = document.getElementById('generateAllBtn');
  if (btn) btn.disabled = true;

  try {
    const response = await fetch('/api/overviews/generate-all', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ scope: 'primaries' })
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.reason || result.error || 'Failed to start batch generation.');
    }

    showToast('بدأ توليد تقارير الكل للمشاريع الأساسية.', 'success');

    // Show progress banner
    const banner = document.getElementById('batchProgress');
    if (banner) banner.classList.remove('hidden');

    // Start polling
    pollBatchProgress();
  } catch (err) {
    showToast(`فشل بدء التوليد: ${err.message}`, 'error');
    if (btn) btn.disabled = false;
  }
}

/**
 * Stops the running batch AI overview generation.
 */
async function stopBatchAIOverviews() {
  const btn = document.getElementById('stopBatchBtn');
  if (btn) btn.disabled = true;

  try {
    const response = await fetch('/api/overviews/stop', { method: 'POST' });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to stop batch.');
    }

    showToast('تم إرسال طلب إيقاف التوليد التلقائي.', 'warning');
  } catch (err) {
    showToast(`فشل إيقاف التوليد: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Polls the batch overview generation status every 3 seconds.
 */
function pollBatchProgress() {
  // Guard against multiple concurrent pollers
  if (batchProgressInterval) {
    return;
  }

  // Disable the generate button while running
  const generateBtn = document.getElementById('generateAllBtn');
  if (generateBtn) generateBtn.disabled = true;

  const banner = document.getElementById('batchProgress');
  const fill = document.getElementById('batchProgressBarFill');
  const text = document.getElementById('batchProgressText');

  if (banner) banner.classList.remove('hidden');

  batchProgressInterval = setInterval(async () => {
    try {
      const response = await fetch('/api/overviews/progress');
      if (!response.ok) {
        throw new Error('Failed to fetch progress');
      }
      const data = await response.json();

      if (data.running) {
        const total = data.total || 0;
        const done = data.done || 0;
        const failed = data.failed || 0;
        const percent = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;

        if (text) {
          text.textContent = `يُولّد التقارير… ${done + failed} / ${total} (فشل: ${failed})`;
        }
        if (fill) {
          fill.style.width = `${percent}%`;
        }
      } else {
        // running === false, batch has ended/stopped
        clearInterval(batchProgressInterval);
        batchProgressInterval = null;

        if (generateBtn) generateBtn.disabled = false;

        const total = data.total || 0;
        const done = data.done || 0;
        const failed = data.failed || 0;

        if (text) {
          text.textContent = `اكتمل توليد التقارير! تم إنجاز: ${done}، فشل: ${failed}، المجموع: ${total}`;
        }
        if (fill) {
          fill.style.width = '100%';
        }

        showToast('اكتمل توليد التقارير للمشاريع', 'success');

        // Hide the bar after a short delay
        setTimeout(() => {
          if (banner) banner.classList.add('hidden');
          if (fill) fill.style.width = '0%';
        }, 3000);

        // Reload projects to update cards
        loadProjects();
      }
    } catch (err) {
      console.error('Error polling batch progress:', err);
    }
  }, 3000);
}

/**
 * Checks if a batch overview generation is already running on page load and starts polling if true.
 */
async function checkInitialBatchProgress() {
  try {
    const response = await fetch('/api/overviews/progress');
    if (!response.ok) return;

    const data = await response.json();
    if (data.running === true) {
      // Show progress banner immediately
      const banner = document.getElementById('batchProgress');
      if (banner) banner.classList.remove('hidden');

      const fill = document.getElementById('batchProgressBarFill');
      const text = document.getElementById('batchProgressText');

      const total = data.total || 0;
      const done = data.done || 0;
      const failed = data.failed || 0;
      const percent = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;

      if (text) {
        text.textContent = `يُولّد التقارير… ${done + failed} / ${total} (فشل: ${failed})`;
      }
      if (fill) {
        fill.style.width = `${percent}%`;
      }

      // Start polling
      pollBatchProgress();
    }
  } catch (err) {
    console.error('Error checking initial batch progress:', err);
  }
}

/**
 * Attempts to automatically fix a broken project using the backend AI diagnostic/fix endpoint.
 * Keyed by project ID inside runningFixTimers, updates the UI button text with live progress.
 * @param {string} id Project ID
 */
// Re-entrancy guard: this operation can run for minutes, and a card
// re-render used to hide it, inviting a second click and a second agent.
async function aiFixProject(id) {
  if (!beginOp(id, 'إصلاح ذكي')) return;
  try {
    return await aiFixProjectInner(id);
  } finally {
    endOp(id);
  }
}

async function aiFixProjectInner(id) {
  const cardElement = document.querySelector(`.project-card[data-id="${id}"]`);
  const fixBtn = document.getElementById(`fixBtn-${id}`);
  
  if (fixBtn) {
    fixBtn.disabled = true;
    fixBtn.innerHTML = `<i class="fa-solid fa-spinner spinner" style="margin-left: 4px;"></i> <span class="fix-btn-text">جارٍ التشخيص والإصلاح عبر الذكاء الاصطناعي… (0:00)</span>`;
  }

  if (runningFixTimers[id]) {
    clearInterval(runningFixTimers[id]);
  }

  const startTime = Date.now();
  runningFixTimers[id] = setInterval(() => {
    const elapsedMs = Date.now() - startTime;
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const formattedSeconds = String(seconds).padStart(2, '0');
    const timeStr = `${minutes}:${formattedSeconds}`;
    const textSpan = fixBtn ? fixBtn.querySelector('.fix-btn-text') : null;
    if (textSpan) {
      textSpan.textContent = `جارٍ التشخيص والإصلاح عبر الذكاء الاصطناعي… (${timeStr})`;
    }
  }, 1000);

  try {
    const response = await fetch(`/api/projects/${id}/fix`, { method: 'POST' });
    if (!response.ok) {
      throw new Error(`HTTP status ${response.status}`);
    }
    
    const result = await response.json();
    
    if (runningFixTimers[id]) {
      clearInterval(runningFixTimers[id]);
      delete runningFixTimers[id];
    }

    if (fixBtn) {
      fixBtn.disabled = false;
      fixBtn.innerHTML = `<i class="fa-solid fa-wrench" style="margin-left: 4px;"></i> <span class="fix-btn-text">إصلاح بالذكاء الاصطناعي</span>`;
    }

    const statusContainer = document.getElementById(`statusPillContainer-${id}`);
    const isFixed = result.fixed === true || result.verified === true;

    if (isFixed) {
      if (statusContainer) {
        statusContainer.innerHTML = `
          <div class="status-pill running" style="background: rgba(16, 185, 129, 0.15); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.3);">
            <span><i class="fa-solid fa-circle-check" style="margin-left: 6px;"></i>تم الإصلاح والتحقق ✓ — جرّب التشغيل الآن</span>
          </div>
        `;
      }
      if (cardElement) {
        const runBtn = cardElement.querySelector('.run-btn');
        if (runBtn) {
          runBtn.disabled = false;
          runBtn.style.boxShadow = '0 0 15px var(--success)';
          setTimeout(() => {
            runBtn.style.boxShadow = '';
          }, 5000);
        }
      }
      showToast('تم إصلاح المشروع والتحقق من تشغيله بنجاح!', 'success');
    } else {
      if (statusContainer) {
        statusContainer.innerHTML = `
          <div class="status-pill error" style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            <span><i class="fa-solid fa-circle-xmark" style="margin-left: 6px;"></i>تعذّر الإصلاح تلقائياً</span>
            <button class="btn btn-secondary fix-btn" id="fixBtn-${id}" onclick="aiFixProject('${id}')" style="padding: 4px 10px; font-size: 0.8rem; background: rgba(239, 68, 68, 0.2); border-color: rgba(239, 68, 68, 0.4); color: #f8fafc; font-family: 'Cairo', sans-serif; display: inline-flex; align-items: center; gap: 4px;">
              <i class="fa-solid fa-wrench"></i>
              <span class="fix-btn-text">إصلاح بالذكاء الاصطناعي</span>
            </button>
          </div>
        `;
      }
      showToast('تعذّر إصلاح المشروع تلقائياً.', 'error');
    }

    openFixModal(result.summary);

  } catch (err) {
    if (runningFixTimers[id]) {
      clearInterval(runningFixTimers[id]);
      delete runningFixTimers[id];
    }
    if (fixBtn) {
      fixBtn.disabled = false;
      fixBtn.innerHTML = `<i class="fa-solid fa-wrench" style="margin-left: 4px;"></i> <span class="fix-btn-text">إصلاح بالذكاء الاصطناعي</span>`;
    }
    console.error('Error during AI fix:', err);
    alert('تعذّر تنفيذ الإصلاح');
  }
}

/**
 * Opens a modal displaying the diagnostics and action logs of the AI Fix process.
 * @param {string} summary Markdown-formatted summary text from agy
 */
function openFixModal(summary) {
  const modal = document.getElementById('fixModal');
  const modalBody = document.getElementById('fixModalBody');
  if (!modal || !modalBody) return;

  modalBody.innerHTML = formatMarkdownOverview(summary || 'لا يوجد ملخص متاح لمراجعة تفاصيل المحاولة.');
  modal.classList.remove('hidden');
}

// Active AI Judge timers
let runningJudgeTimers = {};

/**
 * Fetches the review queue statistics and lists from the backend.
 * Updates the header count badge.
 */
async function fetchReviewQueue() {
  try {
    const response = await fetch('/api/review/queue');
    if (!response.ok) throw new Error('Failed to fetch review queue');
    const data = await response.json();
    
    const total = (data.classReviewCount || 0) + (data.backupReviewCount || 0);
    const badge = document.getElementById('reviewCountBadge');
    if (badge) {
      badge.textContent = total;
      badge.style.display = total > 0 ? 'inline-block' : 'none';
    }
    const actionsDot = document.getElementById('actionsMenuDot');
    if (actionsDot) {
      actionsDot.classList.toggle('hidden', total <= 0);
    }
    return data;
  } catch (err) {
    console.error('Error fetching review queue:', err);
    return { classReview: [], backupReview: [], classReviewCount: 0, backupReviewCount: 0 };
  }
}

/**
 * Opens the review modal and populates it with items needing classification or grouping decisions.
 */
async function openReviewModal() {
  const modal = document.getElementById('reviewModal');
  const body = document.getElementById('reviewModalBody');
  if (!modal || !body) return;

  body.innerHTML = '<div style="text-align: center; padding: 20px;"><i class="fa-solid fa-spinner spinner" style="font-size: 1.5rem; color: var(--primary);"></i><p style="margin-top: 8px; font-size: 0.9rem;">جاري تحميل عناصر المراجعة...</p></div>';
  modal.classList.remove('hidden');

  const data = await fetchReviewQueue();
  const classReview = data.classReview || [];
  const backupReview = data.backupReview || [];

  if (classReview.length === 0 && backupReview.length === 0) {
    body.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted);"><i class="fa-regular fa-face-smile" style="font-size: 3rem; margin-bottom: 12px;"></i><h3>لا توجد عناصر تحتاج مراجعة 🎉</h3><p style="font-size: 0.85rem;">كل المشاريع مصنفة ومؤكدة بشكل صحيح.</p></div>';
    return;
  }

  let html = '';

  if (classReview.length > 0) {
    html += `
      <div style="margin-bottom: 24px;">
        <h3 style="font-size: 1.05rem; font-weight: 700; border-bottom: 2px solid var(--border-color); padding-bottom: 8px; margin-bottom: 12px; color: var(--primary); display: flex; align-items: center; gap: 8px;">
          <i class="fa-solid fa-folder-open"></i> هل هذا مشروع؟ (${classReview.length})
        </h3>
        <div class="review-section-list">
    `;
    classReview.forEach(item => {
      html += renderReviewItemRow(item, true);
    });
    html += '</div></div>';
  }

  if (backupReview.length > 0) {
    html += `
      <div>
        <h3 style="font-size: 1.05rem; font-weight: 700; border-bottom: 2px solid var(--border-color); padding-bottom: 8px; margin-bottom: 12px; color: var(--warning); display: flex; align-items: center; gap: 8px;">
          <i class="fa-solid fa-copy"></i> نسخة احتياطية أم مشروع مستقل؟ (${backupReview.length})
        </h3>
        <div class="review-section-list">
    `;
    backupReview.forEach(item => {
      html += renderReviewItemRow(item, false);
    });
    html += '</div></div>';
  }

  body.innerHTML = html;
}

/**
 * Returns HTML string representing a single triage queue row item.
 */
function renderReviewItemRow(item, isClass) {
  const isBackup = !isClass;
  return `
    <div class="review-item" id="reviewItem-${item.id}" style="border-bottom: 1px solid var(--border-color); padding: 16px 0; display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;">
        <div style="flex: 1; min-width: 0;">
          <h4 style="font-weight: 700; color: var(--text-primary); margin: 0; font-size: 0.95rem;">${item.name || 'مشروع بدون اسم'}</h4>
          <div style="font-size: 0.8rem; color: var(--text-secondary); font-family: monospace; word-break: break-all; direction: ltr; text-align: right; margin-top: 4px;">${item.path}</div>
          ${isBackup && item.primary ? `<div style="font-size: 0.8rem; color: var(--warning); margin-top: 4px;"><i class="fa-solid fa-triangle-exclamation"></i> يبدو نسخة من: <strong>${item.primary.name}</strong> (${item.primary.path})</div>` : ''}
        </div>
        ${isClass ? `<div style="font-size: 0.85rem; font-weight: 600; color: var(--primary);">مستوى الثقة: %${item.confidence || 0}</div>` : ''}
      </div>
      ${isClass ? `
        <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;">
          ${(item.signals || []).map(sig => {
            const isNegative = sig.points < 0;
            const isPositive = sig.points > 0;
            const color = isNegative ? '#ef4444' : (isPositive ? '#10b981' : 'var(--text-secondary)');
            return `<span style="font-size: 0.75rem; background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); padding: 2px 6px; border-radius: 4px; color: ${color};">${sig.label}</span>`;
          }).join('')}
        </div>
      ` : ''}
      <div class="review-actions-row" style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; gap: 12px; flex-wrap: wrap;">
        <div style="display: flex; gap: 8px;">
          ${isClass ? `
            <button class="btn btn-success" onclick="classifyDecision('${item.id}', 'project')" style="padding: 4px 12px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;"><i class="fa-solid fa-circle-check"></i> نعم، مشروع</button>
            <button class="btn btn-danger" onclick="classifyDecision('${item.id}', 'not-project')" style="padding: 4px 12px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;"><i class="fa-solid fa-circle-xmark"></i> ليس مشروعاً</button>
          ` : `
            <button class="btn btn-primary" onclick="backupDecision('${item.id}', 'backup')" style="padding: 4px 12px; font-size: 0.8rem; background: rgba(148, 163, 184, 0.15); border-color: rgba(148, 163, 184, 0.25); color: #94a3b8; display: inline-flex; align-items: center; gap: 4px;"><i class="fa-solid fa-box"></i> نعم، نسخة احتياطية</button>
            <button class="btn btn-success" onclick="backupDecision('${item.id}', 'independent')" style="padding: 4px 12px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;"><i class="fa-solid fa-plus"></i> مشروع مستقل</button>
          `}
        </div>
        <button class="btn btn-secondary judge-btn" id="judgeBtn-${item.id}" onclick="askAiJudge('${item.id}')" style="padding: 4px 10px; font-size: 0.8rem; color: #a855f7; border-color: rgba(168, 85, 247, 0.3); background: rgba(168, 85, 247, 0.05); display: inline-flex; align-items: center; gap: 4px;"><i class="fa-solid fa-brain"></i> رأي AI</button>
      </div>
      <div class="ai-judge-box hidden" id="aiJudgeBox-${item.id}" style="margin-top: 8px; padding: 10px 12px; background: rgba(168, 85, 247, 0.08); border: 1px dashed rgba(168, 85, 247, 0.25); border-radius: 6px; font-size: 0.85rem; color: var(--text-primary); line-height: 1.6;">
      </div>
    </div>
  `;
}

/**
 * Handles classification triage decision logic.
 */
async function classifyDecision(id, value) {
  try {
    const response = await fetch(`/api/projects/${id}/classify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ value })
    });
    if (!response.ok) throw new Error('Failed to classify');
    showToast('تم حفظ التصنيف', 'success');
    handleDecisionDone(id);
  } catch (err) {
    showToast(`فشل حفظ التصنيف: ${err.message}`, 'error');
  }
}

/**
 * Handles backup grouping triage decision logic.
 */
async function backupDecision(id, decision) {
  try {
    const response = await fetch(`/api/projects/${id}/backup-decision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ decision })
    });
    if (!response.ok) throw new Error('Failed to record decision');
    showToast('تم تسجيل القرار وتحديث المجموعات', 'success');
    handleDecisionDone(id);
  } catch (err) {
    showToast(`فشل تسجيل القرار: ${err.message}`, 'error');
  }
}

/**
 * Transition and remove triage row upon confirmed decision.
 */
function handleDecisionDone(id) {
  const row = document.getElementById(`reviewItem-${id}`);
  if (row) {
    row.innerHTML = `<div style="color: var(--success); font-weight: 600; padding: 12px 0; display: flex; align-items: center; gap: 6px;"><i class="fa-solid fa-circle-check"></i> تم مراجعة العنصر ✓</div>`;
    setTimeout(() => {
      row.style.transition = 'all 0.3s ease';
      row.style.height = '0';
      row.style.padding = '0';
      row.style.opacity = '0';
      setTimeout(() => {
        row.remove();
        
        const body = document.getElementById('reviewModalBody');
        const remaining = body.querySelectorAll('.review-item');
        if (remaining.length === 0) {
          body.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted);"><i class="fa-regular fa-face-smile" style="font-size: 3rem; margin-bottom: 12px;"></i><h3>لا توجد عناصر تحتاج مراجعة 🎉</h3><p style="font-size: 0.85rem;">كل المشاريع مصنفة ومؤكدة بشكل صحيح.</p></div>';
        }
      }, 300);
    }, 1000);
  }

  // Decrement badge count
  const badge = document.getElementById('reviewCountBadge');
  let count = 0;
  if (badge) {
    count = parseInt(badge.textContent, 10) || 0;
    if (count > 0) {
      count--;
      badge.textContent = count;
      badge.style.display = count > 0 ? 'inline-block' : 'none';
    }
  }
  const actionsDot = document.getElementById('actionsMenuDot');
  if (actionsDot) {
    actionsDot.classList.toggle('hidden', count <= 0);
  }

  // Reload projects in background
  loadProjects();
}

/**
 * Triggers AI judge command on-demand for a project.
 */
// Re-entrancy guard: this operation can run for minutes, and a card
// re-render used to hide it, inviting a second click and a second agent.
async function askAiJudge(id) {
  if (!beginOp(id, 'حكم الذكاء')) return;
  try {
    return await askAiJudgeInner(id);
  } finally {
    endOp(id);
  }
}

async function askAiJudgeInner(id) {
  const btn = document.getElementById(`judgeBtn-${id}`);
  const judgeBox = document.getElementById(`aiJudgeBox-${id}`);

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner spinner"></i> <span class="judge-btn-text">يستشير AI… (0:00)</span>`;
  }

  if (runningJudgeTimers[id]) {
    clearInterval(runningJudgeTimers[id]);
  }

  const startTime = Date.now();
  runningJudgeTimers[id] = setInterval(() => {
    const elapsedMs = Date.now() - startTime;
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const formattedSeconds = String(seconds).padStart(2, '0');
    const timeStr = `${minutes}:${formattedSeconds}`;
    const textSpan = btn ? btn.querySelector('.judge-btn-text') : null;
    if (textSpan) {
      textSpan.textContent = `يستشير AI… (${timeStr})`;
    }
  }, 1000);

  try {
    const response = await fetch(`/api/projects/${id}/ai-judge`, { method: 'POST' });
    if (!response.ok) throw new Error('Judge HTTP error');
    const result = await response.json();

    if (runningJudgeTimers[id]) {
      clearInterval(runningJudgeTimers[id]);
      delete runningJudgeTimers[id];
    }

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-brain"></i> رأي AI`;
    }

    if (judgeBox) {
      judgeBox.classList.remove('hidden');
      if (result.ok && result.reasoning) {
        judgeBox.innerHTML = `<strong>رأي AI:</strong><br>${formatMarkdownOverview(result.reasoning)}`;
      } else {
        judgeBox.innerHTML = `<span style="color: var(--danger);">تعذّر الحصول على رأي AI: ${result.reasoning || ''}</span>`;
      }
    }
  } catch (err) {
    if (runningJudgeTimers[id]) {
      clearInterval(runningJudgeTimers[id]);
      delete runningJudgeTimers[id];
    }
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-brain"></i> رأي AI`;
    }
    if (judgeBox) {
      judgeBox.classList.remove('hidden');
      judgeBox.innerHTML = `<span style="color: var(--danger);">تعذّر الحصول على رأي AI</span>`;
    }
  }
}

/**
 * Initiates the inline port editing mode on the card details.
 */
function startEditPort(id, currentPort) {
  const container = document.getElementById(`portValContainer-${id}`);
  if (!container) return;

  container.innerHTML = `
    <div style="display: flex; align-items: center; gap: 4px;">
      <input type="number" id="portInput-${id}" value="${currentPort}" style="width: 70px; padding: 2px 4px; font-size: 0.8rem; background: var(--bg-primary); border: 1px solid var(--border-color); color: var(--text-primary); border-radius: 4px; text-align: center;" min="1024" max="65535">
      <button class="btn btn-success" onclick="savePort('${id}')" style="padding: 2px 6px; font-size: 0.75rem;">حفظ</button>
      <button class="btn btn-secondary" onclick="cancelEditPort('${id}', '${currentPort}')" style="padding: 2px 6px; font-size: 0.75rem;">إلغاء</button>
    </div>
    <div id="portError-${id}" style="color: var(--danger); font-size: 0.7rem; margin-top: 4px; display: none; white-space: nowrap;"></div>
  `;
}

/**
 * Cancels port editing and restores the standard template.
 */
function cancelEditPort(id, originalPort) {
  filterAndRenderProjects();
}

/**
 * Submits the port edit payload.
 */
async function savePort(id) {
  const input = document.getElementById(`portInput-${id}`);
  const errorDiv = document.getElementById(`portError-${id}`);
  if (!input) return;

  const portVal = parseInt(input.value, 10);
  if (isNaN(portVal) || portVal < 1024 || portVal > 65535) {
    if (errorDiv) {
      errorDiv.textContent = 'منفذ غير صالح (1024-65535)';
      errorDiv.style.display = 'block';
    }
    return;
  }

  try {
    const response = await changePort(id, portVal);

    if (response.status === 409) {
      if (errorDiv) {
        errorDiv.textContent = 'البورت مستخدم من مشروع آخر';
        errorDiv.style.display = 'block';
      }
      return;
    }

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Failed to update port');
    }

    // Success! Update projectsCache
    const projectIdx = projectsCache.findIndex(p => p.id === id);
    if (projectIdx !== -1) {
      projectsCache[projectIdx].assignedPort = portVal;
      projectsCache[projectIdx].userPortSet = true;
    }

    showToast('تم تغيير البورت', 'success');
    filterAndRenderProjects();
  } catch (err) {
    console.error('Error saving port:', err);
    alert('تعذّر تغيير البورت');
  }
}

/**
 * Triggers the POST endpoint for updating project ports.
 */
async function changePort(id, port) {
  const response = await fetch(`/api/projects/${id}/port`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ port: Number(port) })
  });
  return response;
}

/**
 * Initiates health check for a project.
 */
async function checkProjectHealth(id) {
  const modal = document.getElementById('healthModal');
  const body = document.getElementById('healthModalBody');
  if (!modal || !body) return;

  body.innerHTML = `
    <div style="text-align: center; padding: 20px;">
      <i class="fa-solid fa-spinner spinner" style="font-size: 1.5rem; color: var(--primary);"></i>
      <p style="margin-top: 8px; font-size: 0.9rem;">جاري فحص تشغيل وصحة الصفحة...</p>
    </div>
  `;
  modal.classList.remove('hidden');

  try {
    const response = await fetch(`/api/projects/${id}/healthcheck`, { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const result = await response.json();
    
    renderHealthResult(id, result);
  } catch (err) {
    body.innerHTML = `
      <div style="color: var(--danger); text-align: center; padding: 20px;">
        <i class="fa-solid fa-circle-xmark" style="font-size: 2rem; margin-bottom: 8px;"></i>
        <p>حدث خطأ أثناء إجراء الفحص: ${err.message}</p>
      </div>
    `;
  }
}

/**
 * Renders healthcheck results inside the health modal body.
 */
function renderHealthResult(id, result) {
  const body = document.getElementById('healthModalBody');
  if (!body) return;

  if (result.running === false) {
    body.innerHTML = `
      <div style="text-align: center; padding: 24px; color: var(--warning);">
        <i class="fa-solid fa-triangle-exclamation" style="font-size: 3rem; margin-bottom: 12px;"></i>
        <h3 style="font-weight: 700;">المشروع غير مشغّل حالياً</h3>
        <p style="font-size: 0.9rem; margin-top: 6px;">يجب تشغيل المشروع أولاً من بطاقة التحكم لتتمكن من فحص صحة الصفحة البرمجية.</p>
      </div>
    `;
    return;
  }

  // running === true
  const badgeText = result.healthy ? 'سليم ✓' : 'به مشاكل';
  const badgeStyle = result.healthy 
    ? 'background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3);' 
    : 'background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3);';

  let problemsHtml = '';
  if (result.problems && result.problems.length > 0) {
    problemsHtml = `
      <div style="margin-top: 12px; background: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.15); padding: 12px; border-radius: 6px;">
        <h4 style="color: #ef4444; font-weight: 700; margin: 0 0 8px 0; font-size: 0.9rem;"><i class="fa-solid fa-circle-exclamation"></i> المشاكل المكتشفة:</h4>
        <ul style="margin: 0; padding-right: 20px; font-size: 0.85rem; color: var(--text-primary); line-height: 1.6;">
          ${result.problems.map(p => `<li>${p}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  // White page alert
  let whitePageAlert = '';
  if (result.bodyTextLength < 10 && result.elementCount < 8) {
    whitePageAlert = `
      <div style="margin-top: 12px; background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.3); padding: 12px; border-radius: 6px; color: #f59e0b; display: flex; align-items: center; gap: 8px;">
        <i class="fa-solid fa-triangle-exclamation" style="font-size: 1.5rem;"></i>
        <div>
          <strong style="display: block; font-size: 0.9rem;">تنبيه: تم كشف صفحة بيضاء/فارغة!</strong>
          <span style="font-size: 0.8rem; opacity: 0.9;">الصفحة تحتوي على كود هيكلي ولكن لا يظهر أي نص مرئي أو عناصر تفاعلية.</span>
        </div>
      </div>
    `;
  }

  // JavaScript console errors list
  let consoleErrorsHtml = '';
  if (result.consoleErrors && result.consoleErrors.length > 0) {
    consoleErrorsHtml = `
      <div style="margin-top: 12px;">
        <h5 style="font-weight: 700; margin-bottom: 6px; font-size: 0.85rem; color: var(--text-primary);">أخطاء الكونسول (${result.consoleErrors.length}):</h5>
        <div style="background: #0f172a; padding: 10px; border-radius: 6px; max-height: 120px; overflow-y: auto; font-family: monospace; font-size: 0.75rem; color: #ef4444; direction: ltr; text-align: left;">
          ${result.consoleErrors.map(err => `<div>• ${escapeHTML(err)}</div>`).join('')}
        </div>
      </div>
    `;
  }

  // Failed Requests list
  let failedRequestsHtml = '';
  if (result.failedRequests && result.failedRequests.length > 0) {
    failedRequestsHtml = `
      <div style="margin-top: 12px;">
        <h5 style="font-weight: 700; margin-bottom: 6px; font-size: 0.85rem; color: var(--text-primary);">طلبات الشبكة الفاشلة (${result.failedRequests.length}):</h5>
        <div style="background: #0f172a; padding: 10px; border-radius: 6px; max-height: 120px; overflow-y: auto; font-family: monospace; font-size: 0.75rem; color: #f59e0b; direction: ltr; text-align: left;">
          ${result.failedRequests.map(req => `<div>• ${escapeHTML(req)}</div>`).join('')}
        </div>
      </div>
    `;
  }

  // AI Fix Button
  let aiFixBtnHtml = '';
  if (!result.healthy) {
    aiFixBtnHtml = `
      <div style="margin-top: 16px; display: flex; justify-content: flex-end;">
        <button class="btn btn-primary" id="healthFixBtn-${id}" onclick="runHealthFix('${id}')" style="font-family: 'Cairo', sans-serif; display: inline-flex; align-items: center; gap: 6px;">
          <i class="fa-solid fa-wrench"></i>
          <span class="fix-text">شخّص وأصلح بالـAI</span>
        </button>
      </div>
    `;
  }

  body.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 8px;">
        <span style="font-weight: 700; color: var(--text-secondary);">الحالة العامة:</span>
        <span style="padding: 4px 12px; border-radius: 6px; font-weight: 700; font-size: 0.85rem; ${badgeStyle}">${badgeText}</span>
      </div>
      
      <div class="card-details-box" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px;">
        <div class="detail-item">
          <span class="detail-label">منفذ التشغيل:</span>
          <span class="detail-value" style="direction: ltr;">${result.port || '—'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">HTTP Status:</span>
          <span class="detail-value" style="direction: ltr;">${result.httpStatus || '—'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">عنوان الصفحة:</span>
          <span class="detail-value">${result.title || '—'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">طول نص الصفحة:</span>
          <span class="detail-value">${result.bodyTextLength} حرف</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">عدد عناصر DOM:</span>
          <span class="detail-value">${result.elementCount} عنصر</span>
        </div>
      </div>

      ${whitePageAlert}
      ${problemsHtml}
      ${consoleErrorsHtml}
      ${failedRequestsHtml}
      ${aiFixBtnHtml}
    </div>
  `;
}

/**
 * Triggers AI diagnostic and code correction for health failures.
 */
let runningHealthFixTimers = {};
// Re-entrancy guard: this operation can run for minutes, and a card
// re-render used to hide it, inviting a second click and a second agent.
async function runHealthFix(id) {
  if (!beginOp(id, 'إصلاح صحّي')) return;
  try {
    return await runHealthFixInner(id);
  } finally {
    endOp(id);
  }
}

async function runHealthFixInner(id) {
  const btn = document.getElementById(`healthFixBtn-${id}`);
  if (!btn) return;

  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner spinner" style="margin-left: 4px;"></i> <span class="fix-text">جارٍ التشخيص والإصلاح عبر الذكاء الاصطناعي… (0:00)</span>`;

  if (runningHealthFixTimers[id]) {
    clearInterval(runningHealthFixTimers[id]);
  }

  const startTime = Date.now();
  runningHealthFixTimers[id] = setInterval(() => {
    const elapsedMs = Date.now() - startTime;
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const formattedSeconds = String(seconds).padStart(2, '0');
    const timeStr = `${minutes}:${formattedSeconds}`;
    const textSpan = btn.querySelector('.fix-text');
    if (textSpan) {
      textSpan.textContent = `جارٍ التشخيص والإصلاح عبر الذكاء الاصطناعي… (${timeStr})`;
    }
  }, 1000);

  try {
    const response = await fetch(`/api/projects/${id}/healthfix`, { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const result = await response.json();

    if (runningHealthFixTimers[id]) {
      clearInterval(runningHealthFixTimers[id]);
      delete runningHealthFixTimers[id];
    }

    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-wrench"></i> <span class="fix-text">شخّص وأصلح بالـAI</span>`;

    const body = document.getElementById('healthModalBody');
    if (body) {
      const isFixed = result.fixed === true || result.verified === true;
      const statusColor = isFixed ? '#10b981' : '#ef4444';
      const statusTitle = isFixed ? 'تم الإصلاح بنجاح ✓' : 'تعذّر الإصلاح تلقائياً';
      
      body.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <div style="background: ${isFixed ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)'}; border: 1px solid ${statusColor}; padding: 12px; border-radius: 6px; text-align: center;">
            <i class="fa-solid ${isFixed ? 'fa-circle-check' : 'fa-circle-xmark'}" style="font-size: 2rem; color: ${statusColor}; margin-bottom: 6px;"></i>
            <h3 style="color: ${statusColor}; font-weight: 700; margin: 0;">${statusTitle}</h3>
          </div>
          
          <div style="margin-top: 12px;">
            <h4 style="font-weight: 700; margin-bottom: 6px; font-size: 0.9rem;">ملخص المحاولة:</h4>
            <div style="line-height: 1.6; font-size: 0.85rem; background: var(--bg-primary); padding: 12px; border: 1px solid var(--border-color); border-radius: 6px;">
              ${formatMarkdownOverview(result.summary || 'لا توجد تفاصيل')}
            </div>
          </div>
          
          <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;">
            <button class="btn btn-secondary" onclick="checkProjectHealth('${id}')" style="font-family: 'Cairo', sans-serif;">إعادة الفحص</button>
          </div>
        </div>
      `;
    }

    loadProjects();
  } catch (err) {
    if (runningHealthFixTimers[id]) {
      clearInterval(runningHealthFixTimers[id]);
      delete runningHealthFixTimers[id];
    }
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-wrench"></i> <span class="fix-text">شخّص وأصلح بالـAI</span>`;
    showToast(`فشل الإصلاح: ${err.message}`, 'error');
  }
}

/**
 * Opens the live projects management modal and starts polling.
 */
let liveModalPollInterval = null;
async function openLiveModal() {
  const modal = document.getElementById('liveModal');
  const bootCheck = document.getElementById('autostartBootCheck');
  if (!modal) return;

  modal.classList.remove('hidden');

  try {
    const bootRes = await fetch('/api/autostart/boot');
    if (bootRes.ok) {
      const bootData = await bootRes.json();
      if (bootCheck) {
        bootCheck.checked = !!bootData.installed;
      }
    }
  } catch (err) {
    console.error('Error fetching autostart boot status:', err);
  }

  await fetchAndRenderLiveList();

  if (liveModalPollInterval) {
    clearInterval(liveModalPollInterval);
  }
  liveModalPollInterval = setInterval(fetchAndRenderLiveList, 3000);
}

/**
 * Closes the live projects modal and clears the polling interval.
 */
function closeLiveModal() {
  const modal = document.getElementById('liveModal');
  if (modal) {
    modal.classList.add('hidden');
  }
  if (liveModalPollInterval) {
    clearInterval(liveModalPollInterval);
    liveModalPollInterval = null;
  }
}

/**
 * Fetches the current live status and renders the supervisor table/list.
 */
async function fetchAndRenderLiveList() {
  const listContainer = document.getElementById('liveModalList');
  if (!listContainer) return;

  try {
    const response = await fetch('/api/live');
    if (!response.ok) throw new Error('Failed to fetch live projects');
    const items = await response.json();

    if (items.length === 0) {
      listContainer.innerHTML = `
        <div style="text-align: center; padding: 24px; color: var(--text-muted);">
          <i class="fa-solid fa-bolt" style="font-size: 2.5rem; margin-bottom: 8px; opacity: 0.5;"></i>
          <p style="font-size: 0.9rem;">لم تحدّد مشاريع حيّة بعد — فعّل ⚡ على أي بطاقة.</p>
        </div>
      `;
      return;
    }

    let html = '';
    items.forEach(item => {
      const isRunning = item.status === 'running' || item.status === 'starting';
      const statusColor = isRunning ? '#10b981' : '#94a3b8';
      const statusText = isRunning ? 'تعمل' : 'متوقفة';
      
      let uptimeText = '—';
      if (isRunning && item.uptimeMs > 0) {
        const totalSecs = Math.floor(item.uptimeMs / 1000);
        const hours = Math.floor(totalSecs / 3600);
        const mins = Math.floor((totalSecs % 3600) / 60);
        const secs = totalSecs % 60;
        
        if (hours > 0) {
          uptimeText = `${hours} ساعة ${mins} دقيقة`;
        } else if (mins > 0) {
          uptimeText = `${mins} دقيقة ${secs} ثانية`;
        } else {
          uptimeText = `${secs} ثانية`;
        }
      }

      const portLink = item.port 
        ? `<a href="http://127.0.0.1:${item.port}" target="_blank" style="color: var(--primary); font-family: monospace; text-decoration: underline;">127.0.0.1:${item.port}</a>`
        : '—';

      html += `
        <div class="live-item-row" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 6px; gap: 12px; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 150px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="width: 8px; height: 8px; background: ${statusColor}; border-radius: 50%; display: inline-block;" title="${statusText}"></span>
              <strong style="font-size: 0.9rem; color: var(--text-primary);">${item.name || 'مشروع بدون اسم'}</strong>
            </div>
            <div style="font-size: 0.75rem; color: var(--text-secondary); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; margin-top: 4px;" title="${item.path}">${item.path}</div>
          </div>
          
          <div style="display: flex; gap: 16px; font-size: 0.8rem; color: var(--text-secondary); align-items: center;">
            <div>المنفذ: ${portLink}</div>
            <div>المدة: ${uptimeText}</div>
            <div>إعادة التشغيل: <span style="font-weight: 700; color: ${item.restarts > 0 ? 'var(--warning)' : 'var(--text-secondary)'};">${item.restarts}</span></div>
          </div>

          <div>
            <button class="btn-text" onclick="removeProjectFromLive('${item.id}')" style="color: var(--danger); font-size: 0.8rem; padding: 4px 8px; border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 4px; background: rgba(239, 68, 68, 0.05); cursor: pointer;" title="إزالة من الحية">
              <i class="fa-solid fa-trash"></i> إزالة
            </button>
          </div>
        </div>
      `;
    });

    listContainer.innerHTML = html;
  } catch (err) {
    listContainer.innerHTML = `<p style="color: var(--danger); font-size: 0.85rem; text-align: center;">خطأ أثناء جلب القائمة: ${err.message}</p>`;
  }
}

/**
 * Triggers supervisor startAll logic on demand.
 */
async function startLiveNow() {
  const btn = document.getElementById('startLiveNowBtn');
  if (btn) btn.disabled = true;

  try {
    const response = await fetch('/api/live/start-all', { method: 'POST' });
    if (!response.ok) throw new Error('Failed to start live projects');
    
    showToast('تم إرسال طلب تشغيل جميع المشاريع الحية', 'success');
    await fetchAndRenderLiveList();
    loadProjects();
  } catch (err) {
    showToast(`خطأ: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Removes a project from the supervisor live list.
 */
async function removeProjectFromLive(id) {
  try {
    const response = await fetch(`/api/projects/${id}/autostart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    });
    if (!response.ok) throw new Error('Failed to remove project');
    
    showToast('تمت إزالة المشروع من قائمة التشغيل الحي', 'success');
    await fetchAndRenderLiveList();
    loadProjects();
  } catch (err) {
    showToast(`خطأ: ${err.message}`, 'error');
  }
}

/**
 * Toggles the autostart status of a project.
 */
async function toggleAutostart(id, enabled) {
  try {
    const response = await fetch(`/api/projects/${id}/autostart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    
    if (!response.ok) throw new Error('Failed to update autostart status');
    const data = await response.json();
    
    const idx = projectsCache.findIndex(p => p.id === id);
    if (idx !== -1) {
      projectsCache[idx].autoStart = data.autoStart;
    }
    
    if (data.autoStart) {
      showToast('تمت إضافة المشروع للمشاريع الحية', 'success');
      openLiveModal();
    } else {
      showToast('تمت إزالة المشروع من المشاريع الحية', 'success');
    }
    
    filterAndRenderProjects();
    if (typeof refreshRunningDock === 'function') refreshRunningDock();
  } catch (err) {
    showToast(`خطأ: ${err.message}`, 'error');
  }
}

/**
 * Toggles the favorite status of a project.
 */
async function toggleFavorite(id, enabled) {
  try {
    const response = await fetch(`/api/projects/${id}/favorite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    
    if (!response.ok) throw new Error('Failed to update favorite status');
    const data = await response.json();
    
    const idx = projectsCache.findIndex(p => p.id === id);
    if (idx !== -1) {
      projectsCache[idx].favorite = data.favorite;
    }
    
    if (data.favorite) {
      showToast('تمت إضافة المشروع للمفضلة', 'success');
    } else {
      showToast('تمت إزالة المشروع من المفضلة', 'success');
    }
    
    filterAndRenderProjects();
  } catch (err) {
    showToast(`خطأ: ${err.message}`, 'error');
  }
}

/**
 * Opens the project folder in VS Code.
 */
async function openInVSCode(id) {
  try {
    const response = await fetch(`/api/projects/${id}/open-editor`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to open VS Code');
    }
    showToast('تم فتح المشروع في VS Code بنجاح!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/**
 * Updates the header status text with live counts.
 */
function updateHeaderStats() {
  const container = document.getElementById('headerStats');
  if (!container) return;

  const primaries = projectsCache.filter(p => p.isPrimary !== false);
  const total = primaries.length;
  const liveCount = primaries.filter(p => p.autoStart === true).length;
  const favCount = primaries.filter(p => p.favorite === true).length;
  const confirmedCount = primaries.filter(p => 
    p.classification === 'confirmed' || p.userClassification === 'project'
  ).length;

  container.textContent = `إجمالي: ${total} · مشاريع مؤكّدة: ${confirmedCount} · حيّة: ${liveCount} · مفضّلة: ${favCount}`;
}

/**
 * Normalizes Arabic string characters for robust search matching.
 */
function normalizeArabic(str) {
  if (!str) return '';
  let s = String(str).toLowerCase();
  // Remove diacritics
  s = s.replace(/[\u064B-\u0652\u0670]/g, '');
  // Unify Alef
  s = s.replace(/[أإآ]/g, 'ا');
  // Unify Yeh / Alef Maksura
  s = s.replace(/ى/g, 'ي');
  // Unify Teh Marbuta
  s = s.replace(/ة/g, 'ه');
  return s;
}

/**
 * Compiles all project search fields into a single space-separated string.
 */
function buildHaystack(p) {
  const parts = [];
  
  if (p.name) parts.push(p.name);
  if (p.description) parts.push(p.description);
  if (p.type) parts.push(p.type);
  if (p.path) parts.push(p.path);
  if (p.entryFile) parts.push(p.entryFile);
  if (p.port !== null && p.port !== undefined) parts.push(String(p.port));
  if (p.assignedPort !== null && p.assignedPort !== undefined) parts.push(String(p.assignedPort));
  if (p.overview) parts.push(p.overview);
  if (p.overviewStack) parts.push(p.overviewStack);
  if (p.classification) parts.push(p.classification);
  if (p.userClassification) parts.push(p.userClassification);
  if (p.runCommand) parts.push(p.runCommand);
  if (p.signals && p.signals.length > 0) {
    p.signals.forEach(sig => {
      if (sig.label) parts.push(sig.label);
    });
  }

  return parts.join(' ').toLowerCase();
}

/**
 * Smart search matcher that supports field queries and multi-token matching.
 */
function matchesSearch(p, query) {
  if (!query) return true;

  const normalizedQuery = normalizeArabic(query).trim();
  if (!normalizedQuery) return true;

  const tokens = normalizedQuery.split(/\s+/);
  const haystack = normalizeArabic(buildHaystack(p));

  for (const token of tokens) {
    if (!token) continue;

    const colonIdx = token.indexOf(':');
    if (colonIdx > 0 && colonIdx < token.length - 1) {
      const field = normalizeArabic(token.substring(0, colonIdx));
      const val = normalizeArabic(token.substring(colonIdx + 1));

      let matchedField = false;
      let fieldMatched = false;

      if (field === 'name') {
        fieldMatched = true;
        const target = normalizeArabic(p.name || '');
        if (target.includes(val)) matchedField = true;
      } else if (field === 'type' || field === 'lang') {
        fieldMatched = true;
        const target = normalizeArabic(p.type || '');
        if (target.includes(val)) matchedField = true;
      } else if (field === 'port') {
        fieldMatched = true;
        const p1 = p.port !== null && p.port !== undefined ? String(p.port) : '';
        const p2 = p.assignedPort !== null && p.assignedPort !== undefined ? String(p.assignedPort) : '';
        if (p1.includes(val) || p2.includes(val)) matchedField = true;
      } else if (field === 'path') {
        fieldMatched = true;
        const target = normalizeArabic(p.path || '');
        if (target.includes(val)) matchedField = true;
      } else if (field === 'desc' || field === 'وصف') {
        fieldMatched = true;
        const target = normalizeArabic(p.description || '');
        if (target.includes(val)) matchedField = true;
      } else if (field === 'stack') {
        fieldMatched = true;
        const target = normalizeArabic(p.overviewStack || '');
        if (target.includes(val)) matchedField = true;
      } else if (field === 'class') {
        fieldMatched = true;
        const c1 = normalizeArabic(p.classification || '');
        const c2 = normalizeArabic(p.userClassification || '');
        if (c1.includes(val) || c2.includes(val)) matchedField = true;
      } else if (field === 'entry') {
        fieldMatched = true;
        const target = normalizeArabic(p.entryFile || '');
        if (target.includes(val)) matchedField = true;
      }

      if (fieldMatched) {
        if (!matchedField) return false;
      } else {
        if (!haystack.includes(token)) return false;
      }
    } else {
      if (!haystack.includes(token)) return false;
    }
  }

  return true;
}

/**
 * Opens the run command modal and fetches the current launch info plan.
 */
async function openRunCommandModal(id) {
  activeRunCommandProjectId = id;
  const modal = document.getElementById('runCommandModal');
  const commandVal = document.getElementById('currentLaunchCommandVal');
  const sourceVal = document.getElementById('launchCommandSourceVal');
  const input = document.getElementById('runCommandInput');

  if (!modal) return;

  commandVal.textContent = 'جاري التحميل...';
  sourceVal.textContent = 'نوع المشغل: جاري التحميل...';
  input.value = '';

  modal.classList.remove('hidden');

  try {
    const response = await fetch(`/api/projects/${id}/launch-info`);
    if (!response.ok) throw new Error('Failed to fetch launch info');
    const data = await response.json();

    if (data.ok) {
      commandVal.textContent = data.command || '—';
      
      let sourceText = 'افتراضي';
      if (data.isCustom) sourceText = '⚡ أمر مخصّص';
      else if (data.isScript) sourceText = '📁 سكربت تشغيل تلقائي';
      
      sourceVal.textContent = `نوع المشغل: ${sourceText}`;
      input.value = data.runCommand || '';
    } else {
      commandVal.innerHTML = `<span style="color: var(--danger);">${escapeHTML(data.error || 'خطأ غير معروف في خطة التشغيل')}</span>`;
      sourceVal.textContent = 'نوع المشغل: فشل التحديد';
    }
  } catch (err) {
    commandVal.innerHTML = `<span style="color: var(--danger);">خطأ في الاتصال بالخادم: ${escapeHTML(err.message)}</span>`;
    sourceVal.textContent = 'نوع المشغل: غير معروف';
  }
}

/**
 * Saves the custom run command for the active project.
 */
async function saveRunCommand() {
  const id = activeRunCommandProjectId;
  if (!id) return;

  const input = document.getElementById('runCommandInput');
  const command = input ? input.value : '';
  const saveBtn = document.getElementById('saveRunCommandBtn');

  if (saveBtn) saveBtn.disabled = true;

  try {
    const response = await fetch(`/api/projects/${id}/run-command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ command })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Failed to update run command');
    }

    showToast('تم حفظ أمر التشغيل المخصص', 'success');
    
    // Update local cache item so that the search haystack is kept in sync
    const projIdx = projectsCache.findIndex(p => p.id === id);
    if (projIdx !== -1) {
      projectsCache[projIdx].runCommand = command || null;
    }
    
    // Refresh modal info
    await openRunCommandModal(id);
  } catch (err) {
    showToast(`خطأ: ${err.message}`, 'error');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * Clears the custom run command to restore auto-detection.
 */
async function clearRunCommand() {
  const id = activeRunCommandProjectId;
  if (!id) return;

  const input = document.getElementById('runCommandInput');
  if (input) input.value = '';

  const clearBtn = document.getElementById('clearRunCommandBtn');
  if (clearBtn) clearBtn.disabled = true;

  try {
    const response = await fetch(`/api/projects/${id}/run-command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ command: '' })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Failed to clear run command');
    }

    showToast('تم إرجاع أمر التشغيل للوضع التلقائي', 'success');

    const projIdx = projectsCache.findIndex(p => p.id === id);
    if (projIdx !== -1) {
      projectsCache[projIdx].runCommand = null;
    }

    // Refresh modal info
    await openRunCommandModal(id);
  } catch (err) {
    showToast(`خطأ: ${err.message}`, 'error');
  } finally {
    if (clearBtn) clearBtn.disabled = false;
  }
}

// Track active AI Onboarding process timers
let runningOnboardTimers = {};
let runningDeepTimers = {};

// Which projects currently have a long AI operation in flight, keyed by
// project id.
//
// These handlers capture a DOM node BEFORE awaiting, and any card finishing its
// own work calls filterAndRenderProjects(), which does grid.innerHTML = '' and
// detaches every captured node. The rebuilt card renders its progress elements
// hidden, so an operation the code itself warns "may take minutes" visibly
// vanishes — and the user, seeing an idle button, clicks again and launches a
// SECOND agent against the same project.
const inFlightOps = {};

/**
 * Claims a project for a long-running operation.
 *
 * @param {string} id Project id
 * @param {string} label What is running, shown if the card re-renders
 * @returns {boolean} False when an operation is already in flight
 */
function beginOp(id, label) {
  if (inFlightOps[id]) {
    showToast(`تعمل عملية بالفعل على هذا المشروع (${inFlightOps[id].label}) — انتظر انتهاءها.`, 'warning');
    return false;
  }
  inFlightOps[id] = { label, startedAt: Date.now() };
  return true;
}

/**
 * Releases a project once its operation finishes.
 *
 * @param {string} id Project id
 */
function endOp(id) {
  delete inFlightOps[id];
}

/**
 * True while a long AI operation is running for this project.
 *
 * @param {string} id Project id
 * @returns {boolean}
 */
function isOpInFlight(id) {
  return !!inFlightOps[id];
}

/**
 * Runs the AI Onboarding analysis for the project.
 */
// Re-entrancy guard: this operation can run for minutes, and a card
// re-render used to hide it, inviting a second click and a second agent.
async function runAiOnboarding(id) {
  if (!beginOp(id, 'تحليل وتشغيل')) return;
  try {
    return await runAiOnboardingInner(id);
  } finally {
    endOp(id);
  }
}

async function runAiOnboardingInner(id) {
  const cardElement = document.querySelector(`.project-card[data-id="${id}"]`);
  if (!cardElement) return;

  const onboardBtn = cardElement.querySelector(`#onboardBtn-${id}`);
  const loading = document.getElementById(`onboardLoading-${id}`);
  const loadingText = loading ? loading.querySelector('span') : null;

  // Disable onboard buttons
  if (onboardBtn) onboardBtn.disabled = true;
  if (loading) loading.style.display = 'flex';

  if (runningOnboardTimers[id]) {
    clearInterval(runningOnboardTimers[id]);
  }

  const startTime = Date.now();
  if (loadingText) {
    loadingText.textContent = 'جارٍ التحليل الذكي للمشروع… (0:00)';
  }

  runningOnboardTimers[id] = setInterval(() => {
    const elapsedMs = Date.now() - startTime;
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const formattedSeconds = String(seconds).padStart(2, '0');
    const timeStr = `${minutes}:${formattedSeconds}`;
    if (loadingText) {
      loadingText.textContent = `جارٍ التحليل الذكي للمشروع… (${timeStr})`;
    }
  }, 1000);

  try {
    const response = await fetch(`/api/projects/${id}/analyze`, { method: 'POST' });
    const result = await response.json();

    if (runningOnboardTimers[id]) {
      clearInterval(runningOnboardTimers[id]);
      delete runningOnboardTimers[id];
    }

    if (!response.ok || !result.ok) {
      throw new Error(result.error || 'فشل التحليل الذكي للمشروع.');
    }

    // Update frontend memory cache
    const projIdx = projectsCache.findIndex(p => p.id === id);
    if (projIdx !== -1) {
      projectsCache[projIdx].aiProfile = result.profile;
      projectsCache[projIdx].aiAnalyzedAt = new Date().toISOString();
      if (result.profile && result.profile.runCommand) {
        projectsCache[projIdx].runCommand = result.profile.runCommand;
      }
    }

    // Refresh UI list so that runCommand edits and other details match
    filterAndRenderProjects();

    // Open detailed onboarding modal
    openAiOnboardModal(id, result.profile);
    showToast('اكتمل التحليل الذكي بنجاح!', 'success');
  } catch (err) {
    showToast(`فشل التحليل الذكي: ${err.message}`, 'error');
  } finally {
    if (runningOnboardTimers[id]) {
      clearInterval(runningOnboardTimers[id]);
      delete runningOnboardTimers[id];
    }
    if (onboardBtn) onboardBtn.disabled = false;
    if (loading) loading.style.display = 'none';
  }
}

/**
 * Populates and shows the AI Onboarding footprint modal.
 */
function openAiOnboardModal(id, profile) {
  if (typeof profile === 'string') {
    try {
      profile = JSON.parse(profile);
    } catch (e) {
      console.error('Error parsing profile json in openAiOnboardModal', e);
    }
  }
  profile = profile || {};

  const modal = document.getElementById('aiOnboardModal');
  if (!modal) return;

  const runCmdEl = document.getElementById('aiOnboardRunCommand');
  const runCmdNoteEl = document.getElementById('aiOnboardRunCommandNote');
  const runKindEl = document.getElementById('aiOnboardRunKind');
  const webPortEl = document.getElementById('aiOnboardWebPort');
  const confidenceBarEl = document.getElementById('aiOnboardConfidenceBar');
  const confidenceValEl = document.getElementById('aiOnboardConfidenceVal');
  const missingFilesEl = document.getElementById('aiOnboardMissingFiles');
  const subProjectsEl = document.getElementById('aiOnboardSubProjects');
  const notesEl = document.getElementById('aiOnboardNotes');
  const runModeEl = document.getElementById('aiOnboardRunModeBadge');
  const servicesSection = document.getElementById('aiOnboardServicesSection');
  const servicesList = document.getElementById('aiOnboardServicesList');

  // Fill in run command
  if (runCmdEl) {
    runCmdEl.textContent = profile.runCommand || 'غير معرّف';
  }
  if (runCmdNoteEl) {
    runCmdNoteEl.style.display = profile.runCommand ? 'block' : 'none';
  }

  // Fill runMode Badge
  if (runModeEl) {
    const mode = profile.runMode || 'single';
    runModeEl.textContent = mode === 'multi' ? 'منظومة متعددة الخدمات' : (mode === 'script' ? 'سكربت موحّد' : 'خدمة فردية');
    runModeEl.style.background = mode === 'multi' ? 'rgba(59, 130, 246, 0.2)' : (mode === 'script' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(16, 185, 129, 0.2)');
    runModeEl.style.color = mode === 'multi' ? '#3b82f6' : (mode === 'script' ? '#f59e0b' : '#10b981');
    runModeEl.style.borderColor = mode === 'multi' ? 'rgba(59, 130, 246, 0.4)' : (mode === 'script' ? 'rgba(245, 158, 11, 0.4)' : 'rgba(16, 185, 129, 0.4)');
    runModeEl.style.borderStyle = 'solid';
    runModeEl.style.borderWidth = '1px';
  }

  // Fill runKind
  if (runKindEl) {
    runKindEl.textContent = profile.runKind || 'other';
  }

  // Fill web/port
  if (webPortEl) {
    if (profile.expectsWeb) {
      webPortEl.textContent = `نعم (منفذ: ${profile.port || 'تلقائي'})`;
    } else {
      webPortEl.textContent = 'لا خادم ويب';
    }
  }

  // Confidence
  const conf = typeof profile.confidence === 'number' ? profile.confidence : 0;
  if (confidenceBarEl) {
    confidenceBarEl.style.width = `${conf}%`;
  }
  if (confidenceValEl) {
    confidenceValEl.textContent = `${conf}%`;
  }

  // Missing files
  if (missingFilesEl) {
    missingFilesEl.innerHTML = '';
    const files = profile.missingFiles || [];
    if (files.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'لا يوجد ملفات ناقصة';
      li.style.color = 'var(--text-secondary)';
      li.style.listStyleType = 'none';
      missingFilesEl.appendChild(li);
    } else {
      files.forEach(f => {
        const li = document.createElement('li');
        li.textContent = f;
        missingFilesEl.appendChild(li);
      });
    }
  }

  // Services
  if (servicesSection && servicesList) {
    const services = profile.services || [];
    if (profile.runMode === 'multi' || services.length > 0) {
      servicesSection.style.display = 'block';
      servicesList.innerHTML = '';
      services.forEach(s => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
        
        const nameTd = document.createElement('td');
        nameTd.style.padding = '8px';
        nameTd.style.fontWeight = '600';
        nameTd.textContent = s.name;
        
        const dirTd = document.createElement('td');
        dirTd.style.padding = '8px';
        dirTd.style.fontFamily = 'monospace';
        dirTd.style.direction = 'ltr';
        dirTd.style.textAlign = 'right';
        dirTd.textContent = s.dir;
        
        const cmdTd = document.createElement('td');
        cmdTd.style.padding = '8px';
        cmdTd.style.fontFamily = 'monospace';
        cmdTd.style.direction = 'ltr';
        cmdTd.style.textAlign = 'right';
        cmdTd.textContent = s.command;
        
        const portTd = document.createElement('td');
        portTd.style.padding = '8px';
        portTd.textContent = s.port || '—';
        
        const primaryTd = document.createElement('td');
        primaryTd.style.padding = '8px';
        primaryTd.style.textAlign = 'center';
        primaryTd.innerHTML = s.primary ? '<span style="color: #eab308; font-size: 1.15rem;">★</span>' : '—';

        tr.appendChild(nameTd);
        tr.appendChild(dirTd);
        tr.appendChild(cmdTd);
        tr.appendChild(portTd);
        tr.appendChild(primaryTd);
        servicesList.appendChild(tr);
      });
    } else {
      servicesSection.style.display = 'none';
    }
  }

  // Subprojects
  if (subProjectsEl) {
    subProjectsEl.innerHTML = '';
    const subs = profile.subProjects || [];
    if (subs.length === 0) {
      subProjectsEl.innerHTML = '<span style="font-size: 0.85rem; color: var(--text-secondary);">لا توجد مجلدات فرعية منفصلة</span>';
    } else {
      subs.forEach(sp => {
        const div = document.createElement('div');
        div.style.background = 'var(--bg-tertiary)';
        div.style.border = '1px solid var(--border-color)';
        div.style.padding = '8px 10px';
        div.style.borderRadius = '4px';
        div.style.fontSize = '0.85rem';

        const actionText = sp.action === 'merge' ? 'دمج' : 'فصل';
        const actionColor = sp.action === 'merge' ? '#10b981' : '#f59e0b';

        div.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-family: monospace; color: var(--text-primary); direction: ltr; text-align: right;">${escapeHTML(sp.path)}</span>
            <span style="color: ${actionColor}; font-weight: 700; font-size: 0.8rem;">الإجراء: ${actionText}</span>
          </div>
          <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 2px;">السبب: ${escapeHTML(sp.reason)}</div>
        `;
        subProjectsEl.appendChild(div);
      });
    }
  }

  // Notes
  if (notesEl) {
    notesEl.textContent = profile.notes || 'لا توجد ملاحظات إضافية.';
  }

  // Remove existing deep analysis section if any, to avoid duplication
  let deepSec = document.getElementById('aiOnboardDeepAnalysisSection');
  if (deepSec) {
    deepSec.remove();
  }

  // Deep Analysis Fields
  const hasDeepData = profile.structureKind || profile.verdict || 
                      (profile.components && profile.components.length > 0) || 
                      (profile.duplicates && profile.duplicates.length > 0) || 
                      (profile.fixes && profile.fixes.length > 0) || 
                      (profile.suggestedClassification && profile.suggestedClassification.trim());

  if (hasDeepData) {
    const modalBody = modal.querySelector('.modal-body');
    if (modalBody) {
      deepSec = document.createElement('div');
      deepSec.id = 'aiOnboardDeepAnalysisSection';
      deepSec.style.display = 'flex';
      deepSec.style.flexDirection = 'column';
      deepSec.style.gap = '14px';

      // 1. الحكم
      if (profile.structureKind || profile.verdict) {
        const section = document.createElement('div');
        section.className = 'deep-section verdict-section';
        
        let kindBadgeHtml = '';
        if (profile.structureKind) {
          const kinds = {
            'single': { text: 'مشروع واحد', cls: 'kind-single' },
            'distributed': { text: 'مشروع موزّع', cls: 'kind-distributed' },
            'multi-project': { text: 'عدة مشاريع', cls: 'kind-multiproject' },
            'has-duplicates': { text: 'نسخ مكررة', cls: 'kind-hasduplicates' },
            'mixed': { text: 'مختلط', cls: 'kind-mixed' }
          };
          const kindData = kinds[profile.structureKind] || { text: profile.structureKind, cls: 'kind-unknown' };
          kindBadgeHtml = `<span class="structure-badge ${kindData.cls}">${escapeHTML(kindData.text)}</span>`;
        }
        
        section.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <strong style="font-size: 0.9rem;">الحكم وهيكل المشروع:</strong>
            ${kindBadgeHtml}
          </div>
          ${profile.verdict ? `<div class="verdict-text">${escapeHTML(profile.verdict)}</div>` : ''}
        `;
        deepSec.appendChild(section);
      }

      // 2. المكونات (components)
      if (profile.components && profile.components.length > 0) {
        const section = document.createElement('div');
        section.className = 'deep-section components-section';
        
        let rowsHtml = '';
        profile.components.forEach(c => {
          const star = c.partOfPrimary ? '<span style="color: #eab308; font-size: 1.15rem;" title="أساسي">★</span>' : '—';
          rowsHtml += `
            <tr style="border-bottom: 1px solid var(--border-color);">
              <td style="padding: 8px; font-family: monospace; direction: ltr; text-align: right;">${escapeHTML(c.path)}</td>
              <td style="padding: 8px;">${escapeHTML(c.role)}</td>
              <td style="padding: 8px; text-align: center;">${star}</td>
            </tr>
          `;
        });
        
        section.innerHTML = `
          <strong style="display: block; margin-bottom: 6px; font-size: 0.9rem;">مكوّنات المشروع (components):</strong>
          <div style="overflow-x: auto; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 6px;">
            <table style="width: 100%; border-collapse: collapse; font-size: 0.8rem; text-align: right; direction: rtl;">
              <thead>
                <tr style="border-bottom: 1px solid var(--border-color); color: var(--text-secondary); background: rgba(0,0,0,0.02);">
                  <th style="padding: 8px;">المسار</th>
                  <th style="padding: 8px;">الدور (role)</th>
                  <th style="padding: 8px; text-align: center;">أساسي</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>
        `;
        deepSec.appendChild(section);
      }

      // 3. النسخ المكررة (duplicates)
      if (profile.duplicates && profile.duplicates.length > 0) {
        const section = document.createElement('div');
        section.className = 'deep-section duplicates-section';
        
        let itemsHtml = '';
        profile.duplicates.forEach(d => {
          const kindLabels = {
            'backup': 'نسخة احتياطية (backup)',
            'copy': 'نسخة مكررة (copy)',
            'version': 'إصدار آخر (version)'
          };
          const kindLabel = kindLabels[d.kind] || d.kind;
          itemsHtml += `
            <div class="duplicate-alert-item">
              <div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-weight: 600; margin-bottom: 4px;">
                <span style="font-family: monospace; direction: ltr; text-align: right;">${escapeHTML(d.path)}</span>
                <span class="duplicate-kind-badge">${escapeHTML(kindLabel)}</span>
              </div>
              <div style="font-size: 0.78rem; opacity: 0.9;">السبب: ${escapeHTML(d.reason)}</div>
            </div>
          `;
        });
        
        section.innerHTML = `
          <strong style="display: block; margin-bottom: 6px; font-size: 0.9rem; color: var(--warning);">
            <i class="fa-solid fa-triangle-exclamation" style="margin-left: 4px;"></i>النسخ المكررة المكتشفة (duplicates):
          </strong>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${itemsHtml}
          </div>
        `;
        deepSec.appendChild(section);
      }

      // 4. الإصلاحات المقترحة (fixes)
      if (profile.fixes && profile.fixes.length > 0) {
        const section = document.createElement('div');
        section.className = 'deep-section fixes-section';
        
        let itemsHtml = '';
        profile.fixes.forEach(f => {
          // Three states, not two: an unflagged fix (safe === null) is applied
          // automatically like before, so labelling it "needs review" would be
          // a lie. Only an explicit safe:false is withheld from the agent.
          let safetyBadge;
          if (f.safe === true) {
            safetyBadge = '<span class="safety-badge safe-ok"><i class="fa-solid fa-shield-halved"></i> آمن</span>';
          } else if (f.safe === false) {
            safetyBadge = '<span class="safety-badge safe-review"><i class="fa-solid fa-triangle-exclamation"></i> خطِر — لن يُطبَّق تلقائياً</span>';
          } else {
            safetyBadge = '<span class="safety-badge safe-review"><i class="fa-solid fa-circle-question"></i> غير مصنَّف</span>';
          }
          
          itemsHtml += `
            <div class="fix-item-box">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; flex-wrap: wrap; gap: 8px;">
                <strong style="font-size: 0.85rem; color: var(--text-primary);">الهدف: ${escapeHTML(f.target)}</strong>
                ${safetyBadge}
              </div>
              <div style="font-size: 0.8rem; color: var(--text-secondary); line-height: 1.4;">${escapeHTML(f.detail)}</div>
              ${f.action ? `<div style="font-size: 0.75rem; color: var(--primary); margin-top: 4px; font-family: monospace;">الإجراء: ${escapeHTML(f.action)}</div>` : ''}
            </div>
          `;
        });
        
        section.innerHTML = `
          <strong style="display: block; margin-bottom: 6px; font-size: 0.9rem;">
            <i class="fa-solid fa-wrench" style="margin-left: 4px; color: var(--primary);"></i>الإصلاحات المقترحة (fixes):
          </strong>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${itemsHtml}
          </div>
        `;
        deepSec.appendChild(section);
      }

      // 5. التصنيف المقترح (suggestedClassification)
      if (profile.suggestedClassification && profile.suggestedClassification.trim()) {
        const section = document.createElement('div');
        section.className = 'deep-section classification-section';
        section.innerHTML = `
          <strong style="display: block; margin-bottom: 4px; font-size: 0.9rem;">التصنيف المقترح:</strong>
          <div class="suggested-classification-box">
            ${escapeHTML(profile.suggestedClassification)}
          </div>
        `;
        deepSec.appendChild(section);
      }

      modalBody.appendChild(deepSec);
    }
  }

  modal.classList.remove('hidden');
}

function formatUptime(uptimeMs) {
  if (uptimeMs <= 0) return '0 ثانية';
  const totalSecs = Math.floor(uptimeMs / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const minutes = Math.floor((totalSecs % 3600) / 60);
  const seconds = totalSecs % 60;
  
  const parts = [];
  if (hours > 0) parts.push(`${hours} ساعة`);
  if (minutes > 0) parts.push(`${minutes} دقيقة`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} ثانية`);
  
  return parts.join(' و ');
}

async function refreshRunningDock() {
  const dockContent = document.getElementById('dockContent');
  const dockCountBadge = document.getElementById('dockCountBadge');
  if (!dockContent) return;

  try {
    const response = await fetch('/api/running');
    if (!response.ok) throw new Error('فشل جلب المشاريع الشغالة');
    const runningProjects = await response.json();

    if (dockCountBadge) {
      dockCountBadge.textContent = runningProjects.length;
    }

    if (runningProjects.length === 0) {
      dockContent.innerHTML = `
        <div class="dock-empty">
          <i class="fa-solid fa-face-meh"></i>
          <span>لا مشاريع تعمل الآن</span>
        </div>
      `;
      return;
    }

    let html = '';
    for (const p of runningProjects) {
      const linkHtml = p.port 
        ? `<a href="http://127.0.0.1:${p.port}" target="_blank" class="dock-card-link">
             <i class="fa-solid fa-arrow-up-right-from-square"></i> 127.0.0.1:${p.port}
           </a>`
        : `<span style="color: var(--text-muted);">لا يوجد منفذ</span>`;

      const uptimeText = formatUptime(p.uptimeMs);
      const starClass = p.autoStart ? 'fa-solid fa-star' : 'fa-regular fa-star';
      const autostartText = p.autoStart ? 'حيّ' : 'اجعله حيّاً';
      const autostartBtnClass = p.autoStart ? 'dock-btn-autostart active' : 'dock-btn-autostart';

      html += `
        <div class="dock-card" data-id="${p.id}">
          <div class="dock-card-header">
            <span class="dock-card-name" title="${escapeHTML(p.name)}">${escapeHTML(p.name)}</span>
            <span class="dock-card-uptime" title="مدة التشغيل">
              <i class="fa-regular fa-clock"></i> ${uptimeText}
            </span>
          </div>
          <div class="dock-card-details">
            ${linkHtml}
            <span style="font-size: 0.7rem; background: var(--bg-kind-badge); color: var(--text-kind-badge); padding: 1px 6px; border-radius: 4px;">
              ${escapeHTML(p.kind || '')}
            </span>
          </div>
          <div class="dock-card-actions">
            <button class="dock-btn-stop" onclick="stopProject('${p.id}')">
              <i class="fa-solid fa-stop"></i> إيقاف
            </button>
            <button class="${autostartBtnClass}" onclick="toggleAutostart('${p.id}', ${!p.autoStart})">
              <i class="${starClass}"></i> ${autostartText}
            </button>
          </div>
        </div>
      `;
    }
    dockContent.innerHTML = html;
  } catch (err) {
    console.error('Error refreshing running dock:', err);
  }
}

function setupRunningDock() {
  const runningDock = document.getElementById('runningDock');
  const dockHeader = document.getElementById('dockHeader');
  if (runningDock && dockHeader) {
    dockHeader.addEventListener('click', (e) => {
      runningDock.classList.toggle('collapsed');
      const isCollapsed = runningDock.classList.contains('collapsed');
      localStorage.setItem('maktaba-running-dock-collapsed', isCollapsed ? '1' : '0');
    });

    const savedCollapsed = localStorage.getItem('maktaba-running-dock-collapsed');
    if (savedCollapsed === '1') {
      runningDock.classList.add('collapsed');
    }
  }

  refreshRunningDock();
  setInterval(refreshRunningDock, 4000);
}

/**
 * Runs the AI Deep Doctor process (Analysis + Auto-Fixes + Smart Launch configuration + Run Verification).
 * Updates UI to disable the button and show animated progress text.
 */
// Re-entrancy guard: this operation can run for minutes, and a card
// re-render used to hide it, inviting a second click and a second agent.
async function runAiDeepDoctor(id) {
  if (!beginOp(id, 'فحص شامل')) return;
  try {
    return await runAiDeepDoctorInner(id);
  } finally {
    endOp(id);
  }
}

async function runAiDeepDoctorInner(id) {
  const cardElement = document.querySelector(`.project-card[data-id="${id}"]`);
  if (!cardElement) return;

  const deepBtn = cardElement.querySelector(`#deepBtn-${id}`);
  const loading = document.getElementById(`deepLoading-${id}`);
  const loadingText = loading ? loading.querySelector('.loading-text') : null;

  // Disable deep button and show loading progress indicator
  if (deepBtn) deepBtn.disabled = true;
  if (loading) loading.style.display = 'flex';

  if (runningDeepTimers[id]) {
    clearInterval(runningDeepTimers[id]);
  }

  const startTime = Date.now();
  if (loadingText) {
    loadingText.textContent = 'جارٍ البدء في فحص الطبيب الذكي… (0:00)';
  }

  runningDeepTimers[id] = setInterval(() => {
    const elapsedMs = Date.now() - startTime;
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const formattedSeconds = String(seconds).padStart(2, '0');
    const timeStr = `${minutes}:${formattedSeconds}`;
    
    let stepText = 'جارٍ التحليل الذكي للمشروع…';
    if (totalSeconds >= 10 && totalSeconds < 45) {
      stepText = 'جارٍ إصلاح كل المشاكل تلقائياً…';
    } else if (totalSeconds >= 45 && totalSeconds < 55) {
      stepText = 'جارٍ ضبط زر التشغيل وأوامر الإقلاع…';
    } else if (totalSeconds >= 55) {
      stepText = 'جارٍ التحقق من تشغيل المشروع بنجاح…';
    }
    
    if (loadingText) {
      loadingText.textContent = `${stepText} (${timeStr})`;
    }
  }, 1000);

  try {
    const response = await fetch(`/api/projects/${id}/deep`, { method: 'POST' });
    const result = await response.json();

    if (runningDeepTimers[id]) {
      clearInterval(runningDeepTimers[id]);
      delete runningDeepTimers[id];
    }

    if (!response.ok || !result.ok) {
      throw new Error(result.error || 'فشل فحص الطبيب الذكي للمشروع.');
    }

    // Refresh memory cache and reload projects to keep UI perfectly aligned
    await loadProjects();

    // If running dock exists, refresh it
    if (typeof refreshRunningDock === 'function') {
      refreshRunningDock();
    }

    // Open the modal showing deep verdict and auto-fix report
    openDeepDoctorReportModal(id, result);
    showToast('اكتمل فحص الطبيب الذكي بنجاح!', 'success');
  } catch (err) {
    showToast(`فشل الطبيب الذكي: ${err.message}`, 'error');
  } finally {
    if (runningDeepTimers[id]) {
      clearInterval(runningDeepTimers[id]);
      delete runningDeepTimers[id];
    }
    if (deepBtn) deepBtn.disabled = false;
    if (loading) loading.style.display = 'none';
  }
}

/**
 * Renders the Deep Doctor detailed report inside the Onboarding modal.
 */
function openDeepDoctorReportModal(id, result) {
  // First, open the normal onboarding footprint modal
  openAiOnboardModal(id, result.profile || {});

  const modal = document.getElementById('aiOnboardModal');
  if (!modal) return;

  const modalBody = modal.querySelector('.modal-body');
  if (!modalBody) return;

  let deepSec = document.getElementById('aiOnboardDeepAnalysisSection');
  if (!deepSec) {
    deepSec = document.createElement('div');
    deepSec.id = 'aiOnboardDeepAnalysisSection';
    deepSec.style.display = 'flex';
    deepSec.style.flexDirection = 'column';
    deepSec.style.gap = '14px';
    modalBody.appendChild(deepSec);
  }

  // Check if a deep doctor result block already exists in deepSec to avoid duplication
  let docResultDiv = deepSec.querySelector('.doctor-result-section');
  if (docResultDiv) {
    docResultDiv.remove();
  }

  docResultDiv = document.createElement('div');
  docResultDiv.className = 'deep-section doctor-result-section';
  docResultDiv.style.border = '1px solid rgba(99, 102, 241, 0.4)';
  docResultDiv.style.background = 'rgba(99, 102, 241, 0.08)';
  docResultDiv.style.padding = '16px';
  docResultDiv.style.borderRadius = '8px';
  docResultDiv.style.marginTop = '14px';

  // Fixes status badge/text
  let fixesAppliedHtml = '';
  if (result.fixesCount > 0) {
    if (result.fixesApplied) {
      fixesAppliedHtml = `
        <div style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px;">
          <span style="background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4); padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: bold; white-space: nowrap;">تم الإصلاح تلقائياً ✓</span>
          <span style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.4;">${escapeHTML(result.fixSummary || 'تم تطبيق كافة الإصلاحات بنجاح.')}</span>
        </div>
      `;
    } else {
      fixesAppliedHtml = `
        <div style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px;">
          <span style="background: rgba(239, 68, 68, 0.2); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.4); padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: bold; white-space: nowrap;">فشل الإصلاح ✗</span>
          <span style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.4;">${escapeHTML(result.fixSummary || 'فشل تطبيق بعض أو كل الإصلاحات.')}</span>
        </div>
      `;
    }
  } else {
    fixesAppliedHtml = `
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 0.85rem; color: var(--text-secondary);">
        <i class="fa-solid fa-circle-info" style="color: #6366f1;"></i>
        <span>لم تكن هناك مشاكل تحتاج إلى إصلاح تلقائي.</span>
      </div>
    `;
  }

  // Verification status badge/text
  let runVerifiedHtml = '';
  if (result.runVerified) {
    runVerifiedHtml = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4); padding: 4px 10px; border-radius: 6px; font-size: 0.85rem; font-weight: bold; display: inline-flex; align-items: center; gap: 6px;">
          <i class="fa-solid fa-circle-check"></i> التحقق من التشغيل: يعمل بنجاح
        </span>
      </div>
    `;
  } else {
    runVerifiedHtml = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="background: rgba(239, 68, 68, 0.2); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.4); padding: 4px 10px; border-radius: 6px; font-size: 0.85rem; font-weight: bold; display: inline-flex; align-items: center; gap: 6px;">
          <i class="fa-solid fa-circle-xmark"></i> التحقق من التشغيل: فشل التشغيل (Exit code: ${result.verifyExit !== null ? result.verifyExit : 'غير معروف'})
        </span>
      </div>
    `;
  }

  // Run Wired info
  let runWiredHtml = '';
  if (result.runWired && result.profile && result.profile.runCommand) {
    runWiredHtml = `
      <div style="margin-top: 10px; font-size: 0.8rem; color: var(--text-secondary); background: rgba(0, 0, 0, 0.15); padding: 8px; border-radius: 4px; border: 1px dashed rgba(255, 255, 255, 0.05); font-family: monospace; direction: ltr; text-align: left;">
        <span style="color: var(--primary);">[System Wired]</span> runCommand: ${escapeHTML(result.profile.runCommand)}
      </div>
    `;
  }

  docResultDiv.innerHTML = `
    <h4 style="margin: 0 0 12px 0; font-size: 0.95rem; font-weight: 700; color: #818cf8; display: flex; align-items: center; gap: 6px;">
      <i class="fa-solid fa-user-doctor"></i> نتيجة تشخيص الطبيب الذكي (Deep Doctor):
    </h4>
    <div style="display: flex; flex-direction: column; gap: 6px;">
      ${fixesAppliedHtml}
      ${runVerifiedHtml}
      ${runWiredHtml}
    </div>
  `;

  deepSec.appendChild(docResultDiv);
}

/**
 * Self-Doctor (Doctor) Modal Helper Functions
 */

function openDoctorModal() {
  const modal = document.getElementById('doctorModal');
  if (!modal) return;

  modal.classList.remove('hidden');
  updateDoctorStats();
  renderDoctorNeedsReviewTable();
  refreshDoctorBudget();
}

/**
 * Shows today's AI spend against the daily cap. Without this the cap is
 * invisible: work just stops at the limit with nothing in the UI to say why.
 */
async function refreshDoctorBudget() {
  const el = document.getElementById('doctorBudgetText');
  const box = document.getElementById('doctorBudgetLine');
  if (!el) return;
  try {
    const res = await fetch('/api/doctor/budget');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const b = await res.json();
    el.textContent = `${b.spent} من ${b.limit} استدعاء (المتبقي ${b.remaining})`;
    if (box) {
      const exhausted = b.remaining <= 0;
      box.style.background = exhausted ? 'rgba(239, 68, 68, 0.12)' : 'rgba(148, 163, 184, 0.12)';
      box.style.borderColor = exhausted ? 'rgba(239, 68, 68, 0.3)' : 'rgba(148, 163, 184, 0.25)';
    }
  } catch (err) {
    el.textContent = 'غير متاحة';
  }
}

function updateDoctorStats() {
  let healthyCount = 0;
  let brokenCount = 0;
  let reviewCount = 0;
  let uninspectedCount = 0;
  let unknownCount = 0;

  projectsCache.forEach(p => {
    if (p.doctorNeedsReview == true || p.doctorNeedsReview == 1) {
      reviewCount++;
    }
    if (p.doctorHealth === 'ok') {
      healthyCount++;
    } else if (p.doctorHealth === 'broken') {
      brokenCount++;
    } else if (p.doctorHealth === 'unknown') {
      // Scanned, but the check could not reach a verdict. Counting these as
      // "not yet scanned" would hide the fact that we tried and learned
      // nothing — and these are deliberately never sent to an AI agent.
      unknownCount++;
    } else {
      uninspectedCount++;
    }
  });

  const healthyEl = document.getElementById('doctorStatHealthy');
  const brokenEl = document.getElementById('doctorStatBroken');
  const reviewEl = document.getElementById('doctorStatReview');
  const uninspectedEl = document.getElementById('doctorStatUninspected');

  const unknownEl = document.getElementById('doctorStatUnknown');

  if (healthyEl) healthyEl.textContent = healthyCount;
  if (brokenEl) brokenEl.textContent = brokenCount;
  if (reviewEl) reviewEl.textContent = reviewCount;
  if (uninspectedEl) uninspectedEl.textContent = uninspectedCount;
  if (unknownEl) unknownEl.textContent = unknownCount;
}

function renderDoctorNeedsReviewTable() {
  const tbody = document.getElementById('doctorNeedsReviewTableBody');
  if (!tbody) return;

  const reviewProjects = projectsCache.filter(p => p.doctorNeedsReview == true || p.doctorNeedsReview == 1);
  tbody.innerHTML = '';

  if (reviewProjects.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="3" style="text-align: center; padding: 16px; color: var(--text-secondary);">
          لا توجد مشاريع تحتاج مراجعة حالياً.
        </td>
      </tr>
    `;
    return;
  }

  reviewProjects.forEach(p => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border-color)';
    
    const pName = p.name || 'مشروع بدون اسم';
    const summary = p.doctorLastFixSummary || 'لا يوجد ملخص فشل متاح';
    
    tr.innerHTML = `
      <td style="padding: 10px 12px; font-weight: 600; color: var(--text-primary);">${pName}</td>
      <td style="padding: 10px 12px; color: var(--text-secondary); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${summary}">${summary}</td>
      <td style="padding: 10px 12px; text-align: center;">
        <button class="btn btn-primary btn-reset" data-id="${p.id}" style="padding: 4px 8px; font-size: 0.75rem; font-family: 'Cairo'; margin-left: 6px;">إعادة المحاولة</button>
        <button class="btn btn-secondary btn-exclude" data-id="${p.id}" style="padding: 4px 8px; font-size: 0.75rem; font-family: 'Cairo';">تجاهل مؤقتاً</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Attach event listeners to buttons
  tbody.querySelectorAll('.btn-reset').forEach(btn => {
    btn.addEventListener('click', () => doctorResetProject(btn.getAttribute('data-id')));
  });
  tbody.querySelectorAll('.btn-exclude').forEach(btn => {
    btn.addEventListener('click', () => doctorExcludeProject(btn.getAttribute('data-id')));
  });
}

async function doctorResetProject(id) {
  try {
    const row = document.querySelector(`.btn-reset[data-id="${id}"]`).closest('tr');
    const buttons = row.querySelectorAll('button');
    buttons.forEach(btn => btn.disabled = true);

    const response = await fetch(`/api/projects/${id}/doctor-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to reset project');
    }
    showToast('تمت إعادة تهيئة حالة الفحص للمشروع.', 'success');
    await loadProjects();
    updateDoctorStats();
    renderDoctorNeedsReviewTable();
  } catch (err) {
    showToast(`فشل إعادة التهيئة: ${err.message}`, 'error');
    const btn = document.querySelector(`.btn-reset[data-id="${id}"]`);
    if (btn) {
      const row = btn.closest('tr');
      if (row) {
        row.querySelectorAll('button').forEach(btn => btn.disabled = false);
      }
    }
  }
}

async function doctorExcludeProject(id) {
  try {
    const row = document.querySelector(`.btn-exclude[data-id="${id}"]`).closest('tr');
    const buttons = row.querySelectorAll('button');
    buttons.forEach(btn => btn.disabled = true);

    const response = await fetch(`/api/projects/${id}/exclude-autofix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excluded: true })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to exclude project');
    }
    showToast('تم استبعاد المشروع من طابور الإصلاح التلقائي.', 'success');
    await loadProjects();
    updateDoctorStats();
    renderDoctorNeedsReviewTable();
  } catch (err) {
    showToast(`فشل استبعاد المشروع: ${err.message}`, 'error');
    const btn = document.querySelector(`.btn-exclude[data-id="${id}"]`);
    if (btn) {
      const row = btn.closest('tr');
      if (row) {
        row.querySelectorAll('button').forEach(btn => btn.disabled = false);
      }
    }
  }
}

function formatElapsed(startedAt) {
  if (!startedAt) return '0:00';
  const start = new Date(startedAt).getTime();
  const diff = Math.max(0, Date.now() - start);
  const totalSeconds = Math.floor(diff / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

async function startDoctorScan() {
  const startBtn = document.getElementById('startDoctorScanBtn');
  if (startBtn) startBtn.disabled = true;

  try {
    const response = await fetch('/api/doctor/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to start doctor scan');
    }

    showToast('بدأ فحص المشاريع.', 'success');
    pollDoctorScanProgress();
  } catch (err) {
    showToast(`فشل بدء الفحص: ${err.message}`, 'error');
    if (startBtn) startBtn.disabled = false;
  }
}

async function stopDoctorScan() {
  const stopBtn = document.getElementById('stopDoctorScanBtn');
  if (stopBtn) stopBtn.disabled = true;

  try {
    const response = await fetch('/api/doctor/scan/stop', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to stop scan');
    }
    showToast('تم إيقاف الفحص.', 'warning');
  } catch (err) {
    showToast(`فشل إيقاف الفحص: ${err.message}`, 'error');
  } finally {
    if (stopBtn) stopBtn.disabled = false;
  }
}

function pollDoctorScanProgress() {
  if (doctorScanProgressInterval) return;

  const startBtn = document.getElementById('startDoctorScanBtn');
  const stopBtn = document.getElementById('stopDoctorScanBtn');
  const progressContainer = document.getElementById('doctorScanProgress');
  const fill = document.getElementById('doctorScanProgressBarFill');
  const text = document.getElementById('doctorScanProgressText');
  const timeEl = document.getElementById('doctorScanProgressTime');

  if (startBtn) startBtn.classList.add('hidden');
  if (stopBtn) stopBtn.classList.remove('hidden');
  if (progressContainer) progressContainer.classList.remove('hidden');

  doctorScanProgressInterval = setInterval(async () => {
    try {
      const response = await fetch('/api/doctor/scan/progress');
      if (!response.ok) throw new Error('Failed to fetch scan progress');
      const data = await response.json();

      if (data.running) {
        const total = data.total || 0;
        const done = data.done || 0;
        const failed = data.failed || 0;
        const percent = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;

        if (text) {
          text.textContent = `جاري الفحص... ${done + failed} / ${total} (فشل: ${failed})`;
        }
        if (fill) {
          fill.style.width = `${percent}%`;
        }
        if (timeEl && data.startedAt) {
          timeEl.textContent = formatElapsed(data.startedAt);
        }
      } else {
        clearInterval(doctorScanProgressInterval);
        doctorScanProgressInterval = null;

        if (startBtn) {
          startBtn.classList.remove('hidden');
          startBtn.disabled = false;
        }
        if (stopBtn) stopBtn.classList.add('hidden');

        const total = data.total || 0;
        const done = data.done || 0;
        const failed = data.failed || 0;

        if (text) {
          text.textContent = `اكتمل الفحص! تم فحص: ${done}، فشل: ${failed}، المجموع: ${total}`;
        }
        if (fill) {
          fill.style.width = '100%';
        }
        if (timeEl && data.startedAt) {
          timeEl.textContent = formatElapsed(data.startedAt);
        }

        showToast('اكتمل فحص المشاريع.', 'success');

        setTimeout(() => {
          if (progressContainer) progressContainer.classList.add('hidden');
          if (fill) fill.style.width = '0%';
        }, 3000);

        await loadProjects();
        updateDoctorStats();
        renderDoctorNeedsReviewTable();
      }
    } catch (err) {
      console.error('Error polling doctor scan progress:', err);
    }
  }, 3000);
}

async function startDoctorFix() {
  const startBtn = document.getElementById('startDoctorFixBtn');
  if (startBtn) startBtn.disabled = true;

  try {
    const response = await fetch('/api/doctor/fix-queue/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to start fix queue');
    }

    showToast('بدأ تشغيل طابور الإصلاح التلقائي.', 'success');
    pollDoctorFixProgress();
  } catch (err) {
    showToast(`فشل بدء طابور الإصلاح: ${err.message}`, 'error');
    if (startBtn) startBtn.disabled = false;
  }
}

async function stopDoctorFix() {
  const stopBtn = document.getElementById('stopDoctorFixBtn');
  if (stopBtn) stopBtn.disabled = true;

  try {
    const response = await fetch('/api/doctor/fix-queue/stop', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to stop fix queue');
    }
    showToast('تم إرسال طلب إيقاف طابور الإصلاح.', 'warning');
  } catch (err) {
    showToast(`فشل إيقاف طابور الإصلاح: ${err.message}`, 'error');
  } finally {
    if (stopBtn) stopBtn.disabled = false;
  }
}

function pollDoctorFixProgress() {
  if (doctorFixProgressInterval) return;

  const startBtn = document.getElementById('startDoctorFixBtn');
  const stopBtn = document.getElementById('stopDoctorFixBtn');
  const progressContainer = document.getElementById('doctorFixProgress');
  const fill = document.getElementById('doctorFixProgressBarFill');
  const text = document.getElementById('doctorFixProgressText');

  if (startBtn) startBtn.classList.add('hidden');
  if (stopBtn) stopBtn.classList.remove('hidden');
  if (progressContainer) progressContainer.classList.remove('hidden');

  doctorFixProgressInterval = setInterval(async () => {
    try {
      const response = await fetch('/api/doctor/fix-queue/progress');
      if (!response.ok) throw new Error('Failed to fetch fix queue progress');
      const data = await response.json();

      if (data.running) {
        const total = data.total || 0;
        const done = data.done || 0;
        const failed = data.failed || 0;
        const percent = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;

        if (text) {
          text.textContent = `جاري الإصلاح... ${done + failed} / ${total} (فشل: ${failed})`;
        }
        if (fill) {
          fill.style.width = `${percent}%`;
        }
      } else {
        clearInterval(doctorFixProgressInterval);
        doctorFixProgressInterval = null;

        if (startBtn) {
          startBtn.classList.remove('hidden');
          startBtn.disabled = false;
        }
        if (stopBtn) stopBtn.classList.add('hidden');

        const total = data.total || 0;
        const done = data.done || 0;
        const failed = data.failed || 0;

        if (text) {
          text.textContent = `اكتمل طابور الإصلاح! تم إصلاح: ${done}، فشل: ${failed}، المجموع: ${total}`;
        }
        if (fill) {
          fill.style.width = '100%';
        }

        showToast('اكتمل طابور الإصلاح التلقائي.', 'success');

        setTimeout(() => {
          if (progressContainer) progressContainer.classList.add('hidden');
          if (fill) fill.style.width = '0%';
        }, 3000);

        await loadProjects();
        updateDoctorStats();
        renderDoctorNeedsReviewTable();
      }
    } catch (err) {
      console.error('Error polling doctor fix queue progress:', err);
    }
  }, 3000);
}

async function checkInitialDoctorProgress() {
  try {
    const scanRes = await fetch('/api/doctor/scan/progress');
    if (scanRes.ok) {
      const scanData = await scanRes.json();
      if (scanData.running === true) {
        pollDoctorScanProgress();
      }
    }
    const fixRes = await fetch('/api/doctor/fix-queue/progress');
    if (fixRes.ok) {
      const fixData = await fixRes.json();
      if (fixData.running === true) {
        pollDoctorFixProgress();
      }
    }
  } catch (err) {
    console.error('Error checking initial doctor progress:', err);
  }
}

async function checkDoctorAlert() {
  try {
    const res = await fetch('/api/doctor/alert');
    if (!res.ok) return;
    const data = await res.json();
    if (data.show === true && !sessionStorage.getItem('doctorAlertDismissed')) {
      const textSpan = document.getElementById('doctorAlertText');
      if (textSpan) {
        textSpan.textContent = `🩺 ${data.brokenCount} مشروع معطوب و ${data.reviewCount} يحتاج مراجعة — هل تريد تشغيل طابور الإصلاح؟`;
      }
      const banner = document.getElementById('doctorAlertBanner');
      if (banner) {
        banner.classList.remove('hidden');
      }
    }
  } catch (err) {
    console.error('Error checking doctor alert:', err);
  }
}

async function checkProcessesBadge() {
  try {
    const res = await fetch('/api/processes/badge');
    if (!res.ok) return;
    const data = await res.json();
    const badge = document.getElementById('processesCountBadge');
    if (badge) {
      if (data.newCount > 0) {
        badge.textContent = data.newCount;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }
  } catch (err) {
    console.error('Error checking processes badge:', err);
  }
}

/**
 * Live Processes Modal Helper Functions
 */

function openProcessesModal() {
  const modal = document.getElementById('processesModal');
  if (!modal) return;

  modal.classList.remove('hidden');
  loadProcesses();
  
  const badge = document.getElementById('processesCountBadge');
  if (badge) {
    badge.style.display = 'none';
  }
}

async function loadProcesses() {
  const tbody = document.getElementById('processesTableBody');
  if (!tbody) return;

  const refreshBtn = document.getElementById('refreshProcessesBtn');
  let refreshIcon = null;
  if (refreshBtn) {
    refreshIcon = refreshBtn.querySelector('i');
    if (refreshIcon) refreshIcon.classList.add('spinner');
    refreshBtn.disabled = true;
  }

  tbody.innerHTML = `
    <tr>
      <td colspan="5" style="text-align: center; padding: 24px; color: var(--text-secondary);">
        <i class="fa-solid fa-spinner spinner" style="font-size: 1.5rem; color: var(--primary); margin-left: 8px;"></i>
        جاري تحميل العمليات الحية...
      </td>
    </tr>
  `;

  try {
    const response = await fetch('/api/processes');
    if (!response.ok) {
      throw new Error(`Failed to load processes: ${response.statusText}`);
    }
    const processes = await response.json();

    tbody.innerHTML = '';
    if (processes.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; padding: 24px; color: var(--text-secondary);">
            لا توجد عمليات حية نشطة حالياً.
          </td>
        </tr>
      `;
      return;
    }

    processes.forEach(proc => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid var(--border-color)';

      // 1. Type
      let kindHtml = '';
      const k = (proc.kind || 'unknown').toLowerCase();
      if (k === 'node') {
        kindHtml = `<span style="display: inline-flex; align-items: center; gap: 6px; font-weight: 600;"><i class="fa-brands fa-node-js" style="color: #68a063; font-size: 1.15rem;"></i> Node.js</span>`;
      } else if (k === 'python') {
        kindHtml = `<span style="display: inline-flex; align-items: center; gap: 6px; font-weight: 600;"><i class="fa-brands fa-python" style="color: #38bdf8; font-size: 1.15rem;"></i> Python</span>`;
      } else if (k === 'agy') {
        kindHtml = `<span style="display: inline-flex; align-items: center; gap: 6px; font-weight: 600;"><i class="fa-solid fa-cubes-stacked" style="color: #a855f7; font-size: 1.15rem;"></i> agy</span>`;
      } else {
        kindHtml = `<span style="display: inline-flex; align-items: center; gap: 6px;"><i class="fa-solid fa-circle-question" style="color: var(--text-muted); font-size: 1.1rem;"></i> ${escapeHTML(proc.kind || 'unknown')}</span>`;
      }

      // 2. PID & Parent
      const pidText = proc.pid !== null && proc.pid !== undefined ? proc.pid : '-';
      const parentPidText = proc.parentPid ? `<span style="font-size: 0.7rem; color: var(--text-muted); display: block;" title="Parent PID">PPID: ${proc.parentPid}</span>` : '';

      // 3. Matched Project & Path
      let projectHtml = '';
      const pName = proc.matchedProjectName;
      const pPath = proc.matchedProjectPath || proc.projectDir || proc.discoveredPath || '';
      
      if (pName) {
        projectHtml = `<div>
          <strong style="color: var(--primary); font-size: 0.9rem;">${escapeHTML(pName)}</strong>
          ${pPath ? `<div style="font-size: 0.72rem; color: var(--text-secondary); direction: ltr; text-align: right; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHTML(pPath)}">${escapeHTML(pPath)}</div>` : ''}
        </div>`;
      } else if (pPath) {
        projectHtml = `<div>
          <span style="color: #38bdf8; font-weight: 600; font-size: 0.85rem;">📁 مشروع نشط غير مسجل</span>
          <div style="font-size: 0.72rem; color: var(--text-secondary); direction: ltr; text-align: right; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHTML(pPath)}">${escapeHTML(pPath)}</div>
        </div>`;
      } else {
        projectHtml = `<span style="color: var(--text-muted); font-style: italic;">عملية خلفية / غير محدد</span>`;
      }

      // 4. Listening Ports
      let portsHtml = '<span style="color: var(--text-muted); font-size: 0.8rem;">—</span>';
      if (proc.listeningPorts && proc.listeningPorts.length > 0) {
        portsHtml = proc.listeningPorts.map(pt => `
          <a href="http://localhost:${pt}" target="_blank" rel="noopener" style="display: inline-flex; align-items: center; gap: 4px; background: rgba(0, 242, 254, 0.12); border: 1px solid rgba(0, 242, 254, 0.4); color: #00f2fe; padding: 2px 6px; border-radius: 4px; text-decoration: none; font-size: 0.75rem; font-family: monospace; font-weight: 700;" title="افتح http://localhost:${pt}">
            <i class="fa-solid fa-globe" style="font-size: 0.7rem;"></i> :${pt}
          </a>
        `).join(' ');
      }

      // 5. Confidence Badge
      let confidenceHtml = '';
      const conf = (proc.confidence || 'unknown').toLowerCase();
      if (conf === 'high') {
        const methodTitle = proc.matchedMethod === 'listening_port' ? 'تطابق المنفذ النشط' : (proc.matchedMethod === 'acp_registry' ? 'سجل ACP' : 'تطابق المسار');
        confidenceHtml = `<span class="proc-badge proc-badge-high" title="${methodTitle}" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600;">🟢 مؤكد</span>`;
      } else if (conf === 'medium') {
        confidenceHtml = `<span class="proc-badge proc-badge-medium" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600;">🟡 تطابق الملف</span>`;
      } else if (conf === 'discovered') {
        confidenceHtml = `<span class="proc-badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600;">🔵 مكتشف</span>`;
      } else {
        confidenceHtml = `<span class="proc-badge proc-badge-unknown" style="background: rgba(148, 163, 184, 0.15); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.3); padding: 2px 8px; border-radius: 4px; font-size: 0.75rem;">⚪ عام</span>`;
      }

      // 6. Command Line
      const fullCmd = proc.commandLine || proc.scriptPath || '-';
      const escapedCmd = escapeHTML(fullCmd);
      const cmdCellHtml = `<div style="max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: ltr; text-align: left; font-family: monospace; font-size: 0.75rem; color: var(--text-secondary);" title="${escapedCmd}">${escapedCmd}</div>`;

      // 7. Actions
      // The path is NOT written into the onclick attribute. escapeHTML escapes
      // markup, not JavaScript, so a Windows path placed inside a JS string
      // literal here is mangled by the JS parser before it ever reaches the
      // clipboard: "C:\temp\arch3d" arrives as "C:<TAB>emp\arch3d". The button
      // carries a marker class instead and the real value is bound below.
      let actionsHtml = '';
      if (pPath) {
        actionsHtml = `
          <button class="btn btn-secondary proc-copy-path-btn" style="padding: 4px 8px; font-size: 0.75rem;" title="نسخ المسار">
            <i class="fa-regular fa-copy"></i>
          </button>
        `;
      } else {
        actionsHtml = `<span style="color: var(--text-muted); font-size: 0.75rem;">—</span>`;
      }

      // Adoption is offered only where the evidence supports it: a high-confidence
      // match that was NOT made by port number, and not a guardian. Matching a
      // process to a project by its port and then citing that process as proof of
      // ownership is circular, and this button ends in a taskkill.
      const adoptable = proc.matchedProjectId && proc.confidence === 'high'
        && proc.matchedMethod !== 'listening_port'
        && !/guardian/i.test(String(proc.commandLine || ''));
      if (adoptable) {
        actionsHtml += `
          <button class="btn btn-secondary proc-adopt-btn" data-project="${escapeHTML(proc.matchedProjectId)}" data-pid="${proc.pid}"
                  style="padding: 4px 8px; font-size: 0.72rem; margin-right: 4px;" title="اجعل المكتبة تديره وتقدر توقفه">
            تبنّى
          </button>
        `;
      }

      tr.innerHTML = `
        <td style="padding: 10px 12px; vertical-align: middle;">${kindHtml}</td>
        <td style="padding: 10px 12px; vertical-align: middle; font-family: monospace;">${pidText}${parentPidText}</td>
        <td style="padding: 10px 12px; vertical-align: middle;">${projectHtml}</td>
        <td style="padding: 10px 12px; vertical-align: middle; text-align: center;">${portsHtml}</td>
        <td style="padding: 10px 12px; vertical-align: middle; text-align: center;">${confidenceHtml}</td>
        <td style="padding: 10px 12px; vertical-align: middle;">${cmdCellHtml}</td>
        <td style="padding: 10px 12px; vertical-align: middle; text-align: center;">${actionsHtml}</td>
      `;

      // Bind the copy button to the raw path object, so no escaping stands
      // between the real value and the clipboard.
      const adoptBtn = tr.querySelector('.proc-adopt-btn');
      if (adoptBtn) {
        adoptBtn.addEventListener('click', async () => {
          adoptBtn.disabled = true;
          try {
            const res = await fetch('/api/projects/' + encodeURIComponent(adoptBtn.getAttribute('data-project')) + '/adopt', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pid: Number(adoptBtn.getAttribute('data-pid')) })
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'تعذّر التبنّي');
            showToast('تبنّت المكتبة العملية — تقدر توقفها الآن.', 'success');
            loadProjects();
          } catch (e) {
            adoptBtn.disabled = false;
            showToast(e.message, 'error');
          }
        });
      }

      const copyBtn = tr.querySelector('.proc-copy-path-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(pPath)
            .then(() => showToast('تم نسخ مسار المشروع!', 'success'))
            .catch(() => showToast('فشل نسخ المسار.', 'error'));
        });
      }

      tbody.appendChild(tr);
    });

  } catch (err) {
    showToast(`فشل تحميل العمليات الحية: ${err.message}`, 'error');
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 24px; color: var(--danger);">
          <i class="fa-solid fa-circle-exclamation" style="margin-left: 8px;"></i>
          حدث خطأ أثناء تحميل البيانات: ${escapeHTML(err.message)}
        </td>
      </tr>
    `;
  } finally {
    if (refreshBtn) {
      if (refreshIcon) refreshIcon.classList.remove('spinner');
      refreshBtn.disabled = false;
    }
  }
}

