const { getBotUserById, getBotUserByTelegramId } = require('./bot-users-db');

const REPORT_JOB_TTL_SECONDS = 24 * 60 * 60;
const REPORT_JOB_TYPES = Object.freeze(['technician', 'commission', 'finance']);
const IN_FLIGHT_STATUSES = Object.freeze(['pending', 'running']);

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function ensureReportJobTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS report_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      params_json TEXT NOT NULL,
      result_json TEXT,
      error_message TEXT,
      created_by_type TEXT NOT NULL,
      created_by_telegram_id INTEGER,
      created_by_user_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_report_jobs_status ON report_jobs(status, created_at)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_report_jobs_actor ON report_jobs(created_by_type, created_by_telegram_id, created_by_user_id, type, status)'
  );
}

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function mapReportJobRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    type: row.type,
    status: row.status,
    params: parseJson(row.params_json, {}),
    params_json: row.params_json,
    result: row.status === 'ready' ? parseJson(row.result_json, null) : null,
    error_message: row.error_message || null,
    created_by_type: row.created_by_type,
    created_by_telegram_id: row.created_by_telegram_id == null ? null : Number(row.created_by_telegram_id),
    created_by_user_id: row.created_by_user_id == null ? null : Number(row.created_by_user_id),
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

function presentReportJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    error_message: job.error_message,
    result: job.result,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function snapshotActor(db, actor) {
  if (!actor || actor.type === 'password') {
    return { type: 'password', telegramId: null, userId: null };
  }
  if (actor.type === 'telegram') {
    const telegramId = Number(actor.telegramId);
    const user = Number.isFinite(telegramId) ? getBotUserByTelegramId(db, telegramId) : null;
    return {
      type: 'telegram',
      telegramId: Number.isFinite(telegramId) ? telegramId : null,
      userId: user?.id == null ? null : Number(user.id),
    };
  }
  if (actor.type === 'user') {
    const userId = Number(actor.userId);
    const user = Number.isFinite(userId) ? getBotUserById(db, userId) : null;
    const telegramId = Number(user?.telegram_id);
    return {
      type: 'user',
      telegramId: Number.isFinite(telegramId) ? telegramId : null,
      userId: Number.isFinite(userId) ? userId : null,
    };
  }
  return { type: String(actor.type || 'password'), telegramId: null, userId: null };
}

function actorKey(actor) {
  if (!actor || actor.type === 'password') return 'password';
  if (actor.type === 'telegram') return `telegram:${actor.telegramId}`;
  if (actor.type === 'user') return `user:${actor.userId}`;
  return 'unknown';
}

function actorKeyFromJob(job) {
  if (!job) return 'unknown';
  if (job.created_by_type === 'telegram' && job.created_by_telegram_id != null) {
    return `telegram:${job.created_by_telegram_id}`;
  }
  if (job.created_by_type === 'user' && job.created_by_user_id != null) {
    return `user:${job.created_by_user_id}`;
  }
  return 'password';
}

function positiveId(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

function actorOwnsReportJob(db, job, actor) {
  if (!job || !actor) return false;
  if (actor.type === 'password') return job.created_by_type === 'password';
  if (actor.type === 'telegram') {
    const telegramId = positiveId(actor.telegramId);
    return telegramId != null && positiveId(job.created_by_telegram_id) === telegramId;
  }
  if (actor.type === 'user') {
    const userId = positiveId(actor.userId);
    if (userId != null && positiveId(job.created_by_user_id) === userId) return true;
    const user = userId != null ? getBotUserById(db, userId) : null;
    const telegramId = positiveId(user?.telegram_id);
    return telegramId != null && positiveId(job.created_by_telegram_id) === telegramId;
  }
  return false;
}

function resolveActorTelegramId(job) {
  return positiveId(job?.created_by_telegram_id);
}

function getReportJob(db, jobId) {
  ensureReportJobTables(db);
  const id = Number(jobId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return mapReportJobRow(db.prepare('SELECT * FROM report_jobs WHERE id = ?').get(id));
}

function findInFlightReportJob(db, { type, paramsJson, actor }) {
  ensureReportJobTables(db);
  const snapshot = snapshotActor(db, actor);
  return mapReportJobRow(
    db
      .prepare(
        `SELECT * FROM report_jobs
         WHERE type = ?
           AND status IN ('pending', 'running')
           AND params_json = ?
           AND created_by_type = ?
           AND IFNULL(created_by_telegram_id, 0) = IFNULL(?, 0)
           AND IFNULL(created_by_user_id, 0) = IFNULL(?, 0)
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(type, paramsJson, snapshot.type, snapshot.telegramId, snapshot.userId)
  );
}

function listUnfinishedReportJobs(db) {
  ensureReportJobTables(db);
  return db
    .prepare(
      `SELECT * FROM report_jobs
       WHERE status IN ('pending', 'running')
       ORDER BY id ASC`
    )
    .all()
    .map(mapReportJobRow);
}

function createReportJob(db, { type, paramsJson, actor }) {
  ensureReportJobTables(db);
  const snapshot = snapshotActor(db, actor);
  const now = nowUnix();
  const result = db
    .prepare(
      `INSERT INTO report_jobs (
         type, status, params_json,
         created_by_type, created_by_telegram_id, created_by_user_id,
         created_at, updated_at
       ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?)`
    )
    .run(type, paramsJson, snapshot.type, snapshot.telegramId, snapshot.userId, now, now);
  return getReportJob(db, Number(result.lastInsertRowid));
}

function markReportJobRunning(db, jobId) {
  ensureReportJobTables(db);
  db.prepare(
    `UPDATE report_jobs
     SET status = 'running', error_message = NULL, updated_at = ?
     WHERE id = ? AND status IN ('pending', 'running')`
  ).run(nowUnix(), jobId);
  return getReportJob(db, jobId);
}

function completeReportJob(db, jobId, result) {
  ensureReportJobTables(db);
  db.prepare(
    `UPDATE report_jobs
     SET status = 'ready', result_json = ?, error_message = NULL, updated_at = ?
     WHERE id = ?`
  ).run(JSON.stringify(result ?? null), nowUnix(), jobId);
  return getReportJob(db, jobId);
}

function failReportJob(db, jobId, errorMessage) {
  ensureReportJobTables(db);
  db.prepare(
    `UPDATE report_jobs
     SET status = 'failed', error_message = ?, updated_at = ?
     WHERE id = ?`
  ).run(String(errorMessage || 'Не удалось построить отчёт.'), nowUnix(), jobId);
  return getReportJob(db, jobId);
}

function resetStuckRunningReportJobs(db) {
  ensureReportJobTables(db);
  db.prepare(
    `UPDATE report_jobs
     SET status = 'pending', updated_at = ?
     WHERE status = 'running'`
  ).run(nowUnix());
}

function deleteExpiredReportJobs(db, { now = nowUnix(), ttlSeconds = REPORT_JOB_TTL_SECONDS } = {}) {
  ensureReportJobTables(db);
  const cutoff = Number(now) - Number(ttlSeconds);
  db.prepare('DELETE FROM report_jobs WHERE created_at < ?').run(cutoff);
}

module.exports = {
  REPORT_JOB_TTL_SECONDS,
  REPORT_JOB_TYPES,
  IN_FLIGHT_STATUSES,
  ensureReportJobTables,
  snapshotActor,
  actorKey,
  actorKeyFromJob,
  actorOwnsReportJob,
  resolveActorTelegramId,
  presentReportJob,
  getReportJob,
  findInFlightReportJob,
  listUnfinishedReportJobs,
  createReportJob,
  markReportJobRunning,
  completeReportJob,
  failReportJob,
  resetStuckRunningReportJobs,
  deleteExpiredReportJobs,
};
