const { getLocationViewer } = require('../db/locations');
const { listRegosChannelSettings } = require('../db/regos-channel-settings');
const {
  REPORT_JOB_TYPES,
  actorKeyFromJob,
  completeReportJob,
  createReportJob,
  failReportJob,
  findInFlightReportJob,
  getReportJob,
  listUnfinishedReportJobs,
  markReportJobRunning,
  resetStuckRunningReportJobs,
  resolveActorTelegramId,
} = require('../db/report-jobs');
const { buildCommissionReport, buildTechnicianReport } = require('../db/staff-reports');
const { buildFinanceReport } = require('../db/finance-reports');
const {
  DEFAULT_DUPLICATE_INTERVAL_MINUTES,
  RegosCrmError,
  buildTicketFilters,
  fetchAllTickets: defaultFetchAllTickets,
} = require('../integrations/regos-crm');
const { getPublicBaseUrl } = require('../payments/payments-api');
const { getOutboundBot } = require('../bot/payment-notification');
const { bold, link, withHtml } = require('../bot/telegram-html');
const { countTicketsByResponsible } = require('./ticket-duration');
const { reportEventHub } = require('./report-events');

const REPORT_TYPE_LABELS = Object.freeze({
  technician: 'Баллы техника',
  commission: 'Комиссия менеджера',
  finance: 'Финансы',
});

function parseUnixValue(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseTechnicianOptions(input) {
  const minimumCallDurationRaw = String(input?.minimum_call_duration_seconds ?? '').trim();
  const durationFilterActive = minimumCallDurationRaw !== '';
  const minimumCallDuration = Number(minimumCallDurationRaw);
  if (durationFilterActive && (!Number.isFinite(minimumCallDuration) || minimumCallDuration < 0)) {
    const error = new Error('Минимальная длительность должна быть неотрицательной.');
    error.status = 400;
    throw error;
  }
  const withoutDuplicates =
    input?.without_duplicates === true ||
    input?.without_duplicates === 1 ||
    input?.without_duplicates === '1' ||
    input?.without_duplicates === 'true';
  let duplicateIntervalMinutes = Number(input?.duplicate_interval_minutes);
  if (!Number.isFinite(duplicateIntervalMinutes) || duplicateIntervalMinutes < 0) {
    duplicateIntervalMinutes = DEFAULT_DUPLICATE_INTERVAL_MINUTES;
  }
  return {
    without_duplicates: withoutDuplicates,
    duplicate_interval_minutes: duplicateIntervalMinutes,
    minimum_call_duration_seconds: durationFilterActive ? minimumCallDuration : null,
  };
}

function buildStoredParams(type, input, viewer) {
  const params = {
    from_date: parseUnixValue(input?.from_date),
    to_date: parseUnixValue(input?.to_date),
    viewer: {
      seeAll: Boolean(viewer?.seeAll),
      userId: viewer?.userId == null ? null : Number(viewer.userId),
    },
  };
  if (type === 'technician') {
    Object.assign(params, parseTechnicianOptions(input));
  }
  return params;
}

function formatPeriodLabel(fromUnix, toUnix) {
  const fmt = (unix) => {
    if (unix == null) return null;
    const date = new Date(Number(unix) * 1000);
    if (Number.isNaN(date.getTime())) return null;
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  };
  const from = fmt(fromUnix);
  const to = fmt(toUnix);
  if (from && to) return `${from} – ${to}`;
  if (from) return `с ${from}`;
  if (to) return `по ${to}`;
  return 'весь период';
}

function reportTypeLabel(type) {
  return REPORT_TYPE_LABELS[type] || type;
}

function buildReportPageUrl(job) {
  const base = getPublicBaseUrl();
  if (!base || !job?.id) return null;
  return `${base}/bot-admin/reports/${encodeURIComponent(String(job.id))}`;
}

function formatTelegramChatId(telegramId) {
  if (typeof telegramId === 'bigint') return telegramId.toString();
  return telegramId;
}

async function loadTicketCounts(db, params, fetchAllTickets) {
  const fromDate = params.from_date == null ? '' : String(params.from_date);
  const toDate = params.to_date == null ? '' : String(params.to_date);
  const filters = buildTicketFilters({
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
  });
  const tickets = await fetchAllTickets({
    filters: filters.length ? filters : undefined,
    sort_orders: [{ column: 'last_update', direction: 'DESC' }],
  });

  return countTicketsByResponsible(tickets, {
    withoutDuplicates: Boolean(params.without_duplicates),
    duplicateIntervalMinutes: params.duplicate_interval_minutes,
    minimumCallDuration: params.minimum_call_duration_seconds,
    channelSettings: listRegosChannelSettings(db),
    db,
  });
}

async function buildReport(db, job, fetchAllTickets) {
  const params = job.params || {};
  const viewer = params.viewer || { seeAll: true, userId: null };
  const context = {
    fromUnix: params.from_date,
    toUnix: params.to_date,
    viewer,
  };
  if (job.type === 'commission') {
    return buildCommissionReport(db, context);
  }
  if (job.type === 'finance') {
    return buildFinanceReport(db, context);
  }
  if (job.type === 'technician') {
    const ticketCounts = await loadTicketCounts(db, params, fetchAllTickets);
    return buildTechnicianReport(db, {
      ...context,
      ticketsByRegosUserId: ticketCounts.byResponsible,
      unassignedTicketCount: ticketCounts.unassigned,
    });
  }
  const error = new Error('Неизвестный тип отчёта.');
  error.status = 400;
  throw error;
}

function jobErrorMessage(error) {
  if (error instanceof RegosCrmError) return error.message;
  if (error?.status === 400 && error.message) return error.message;
  return 'Не удалось построить отчёт.';
}

function sseEventForJob(job) {
  const label = reportTypeLabel(job.type);
  const ready = job.status === 'ready';
  return {
    type: ready ? 'report_ready' : 'report_failed',
    job_id: job.id,
    report_type: job.type,
    status: job.status,
    message: ready ? `Отчёт «${label}» готов.` : `Не удалось построить отчёт «${label}».`,
  };
}

function telegramTextForJob(job) {
  const label = reportTypeLabel(job.type);
  const params = job.params || {};
  const period = formatPeriodLabel(params.from_date, params.to_date);
  const url = buildReportPageUrl(job);
  if (job.status === 'ready') {
    const lines = [bold(`Отчёт «${label}» готов.`), `Период: ${period}`];
    if (url) lines.push(link(url, 'Открыть в админке'));
    return lines.join('\n');
  }
  const error = job.error_message || 'Не удалось построить отчёт.';
  return [bold(`Не удалось построить отчёт «${label}».`), error].join('\n');
}

async function defaultSendTelegram(telegramId, text) {
  if (telegramId == null) return { sent: false, reason: 'no_telegram_id' };
  const bot = getOutboundBot();
  if (!bot) {
    console.warn('[report-notify] TELEGRAM_BOT_TOKEN not set — skipping report notification.');
    return { sent: false, reason: 'no_token' };
  }
  try {
    await bot.sendMessage(formatTelegramChatId(telegramId), text, withHtml());
    return { sent: true };
  } catch (error) {
    console.error(`[report-notify] Failed to notify ${telegramId}:`, error.message);
    return { sent: false, reason: 'send_failed', error: error.message };
  }
}

function createOrReuseReportJob(db, { type, input, actor }) {
  if (!REPORT_JOB_TYPES.includes(type)) {
    const error = new Error('Неизвестный тип отчёта.');
    error.status = 404;
    throw error;
  }
  const viewer = getLocationViewer(db, actor);
  const params = buildStoredParams(type, input, viewer);
  const paramsJson = JSON.stringify(params);
  const existing = findInFlightReportJob(db, { type, paramsJson, actor });
  if (existing) {
    return { job: existing, created: false };
  }
  return { job: createReportJob(db, { type, paramsJson, actor }), created: true };
}

function createReportWorker(db, deps = {}) {
  const fetchAllTickets = deps.fetchAllTickets || defaultFetchAllTickets;
  const sendTelegram = deps.sendTelegram || defaultSendTelegram;
  const publishEvent = deps.publishEvent || ((actorKey, event) => reportEventHub.publish(actorKey, event));
  const schedule = deps.schedule || ((task) => setImmediate(task));

  const queue = [];
  const waiters = new Map();
  let busy = false;
  let activeJobId = null;

  async function notifyJob(job) {
    if (!job) return { sent: false, reason: 'missing_job' };
    const event = sseEventForJob(job);
    try {
      publishEvent(actorKeyFromJob(job), event);
    } catch (error) {
      console.warn('[report-notify] SSE publish failed:', error.message);
    }

    const telegramId = resolveActorTelegramId(job);
    if (telegramId == null) return { sent: false, reason: 'no_telegram_id' };
    try {
      return await sendTelegram(telegramId, telegramTextForJob(job));
    } catch (error) {
      console.error('[report-notify] Telegram notify failed:', error.message);
      return { sent: false, reason: 'send_failed', error: error.message };
    }
  }

  async function processJob(jobId) {
    const current = getReportJob(db, jobId);
    if (!current || (current.status !== 'pending' && current.status !== 'running')) return current;
    markReportJobRunning(db, jobId);
    try {
      const result = await buildReport(db, current, fetchAllTickets);
      const ready = completeReportJob(db, jobId, result);
      if (!ready) return null;
      await notifyJob(ready);
      return ready;
    } catch (error) {
      if (!(error instanceof RegosCrmError) && error.status !== 400) {
        console.error('Report job error:', error);
      }
      const failed = failReportJob(db, jobId, jobErrorMessage(error));
      if (!failed) return null;
      await notifyJob(failed);
      return failed;
    }
  }

  function waiterFor(jobId) {
    let waiter = waiters.get(jobId);
    if (!waiter) {
      waiter = {};
      waiter.promise = new Promise((resolve, reject) => {
        waiter.resolve = resolve;
        waiter.reject = reject;
      });
      waiters.set(jobId, waiter);
    }
    return waiter;
  }

  async function pump() {
    if (busy) return;
    const jobId = queue.shift();
    if (jobId == null) return;
    busy = true;
    activeJobId = jobId;
    const waiter = waiters.get(jobId);
    try {
      const job = await processJob(jobId);
      waiter?.resolve(job);
    } catch (error) {
      waiter?.reject(error);
    } finally {
      waiters.delete(jobId);
      activeJobId = null;
      busy = false;
      if (queue.length) schedule(pump);
    }
  }

  function enqueue(jobId) {
    const id = Number(jobId);
    const waiter = waiterFor(id);
    if (activeJobId !== id && !queue.includes(id)) {
      queue.push(id);
      schedule(pump);
    }
    return waiter.promise;
  }

  function resume() {
    resetStuckRunningReportJobs(db);
    for (const job of listUnfinishedReportJobs(db)) {
      enqueue(job.id);
    }
  }

  return {
    enqueue,
    resume,
    processJob,
    notifyJob,
  };
}

module.exports = {
  REPORT_TYPE_LABELS,
  parseUnixValue,
  parseTechnicianOptions,
  buildStoredParams,
  formatPeriodLabel,
  reportTypeLabel,
  buildReportPageUrl,
  createOrReuseReportJob,
  createReportWorker,
  sseEventForJob,
};
