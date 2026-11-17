import type { Db } from '../types/db';
import type { Unchecked } from '../types/unchecked';
import fs from 'fs';
import path from 'path';
import { dataDir, ticketVideoDir, ticketVideoFramePath } from '../paths';

const JOB_STATUSES = new Set(['pending', 'running', 'ready', 'failed']);

function ensureChatVideoTimelineTables(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_chat_video_jobs (
      file_id INTEGER PRIMARY KEY,
      ticket_id INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      duration_ms INTEGER,
      model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_chat_video_jobs_status
      ON ai_chat_video_jobs(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_ai_chat_video_jobs_ticket_id
      ON ai_chat_video_jobs(ticket_id);

    CREATE TABLE IF NOT EXISTS ai_chat_video_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY (file_id) REFERENCES ai_chat_video_jobs(file_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_chat_video_segments_file_start
      ON ai_chat_video_segments(file_id, start_ms);

    CREATE TABLE IF NOT EXISTS ai_chat_video_frames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      t_ms INTEGER NOT NULL,
      rel_path TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      FOREIGN KEY (file_id) REFERENCES ai_chat_video_jobs(file_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_chat_video_frames_file_t
      ON ai_chat_video_frames(file_id, t_ms);
  `);
}

function optionalPositiveId(value?: any) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function optionalNonNegativeInt(value?: any) {
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : null;
}

function normalizeStatus(value?: any) {
  const status = String(value || '').trim().toLowerCase();
  return JOB_STATUSES.has(status) ? status : null;
}

function mapJobRow(row?: any) {
  if (!row) return null;
  return {
    file_id: Number(row.file_id),
    ticket_id: optionalPositiveId(row.ticket_id),
    status: String(row.status || ''),
    error: row.error ? String(row.error) : null,
    duration_ms: optionalNonNegativeInt(row.duration_ms),
    model: row.model ? String(row.model) : null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function mapSegmentRow(row?: any) {
  if (!row) return null;
  return {
    id: Number(row.id),
    file_id: Number(row.file_id),
    start_ms: Number(row.start_ms) || 0,
    end_ms: Number(row.end_ms) || 0,
    text: String(row.text || ''),
  };
}

function mapFrameRow(row?: any) {
  if (!row) return null;
  return {
    id: Number(row.id),
    file_id: Number(row.file_id),
    t_ms: Number(row.t_ms) || 0,
    rel_path: String(row.rel_path || ''),
    width: optionalNonNegativeInt(row.width),
    height: optionalNonNegativeInt(row.height),
  };
}

function getVideoJob(db: Db, fileId?: any) {
  ensureChatVideoTimelineTables(db);
  const id = optionalPositiveId(fileId);
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT file_id, ticket_id, status, error, duration_ms, model, created_at, updated_at
       FROM ai_chat_video_jobs WHERE file_id = ?`
    )
    .get(id);
  return mapJobRow(row);
}

function listUnfinishedVideoJobs(db: Db) {
  ensureChatVideoTimelineTables(db);
  const rows = db
    .prepare(
      `SELECT file_id, ticket_id, status, error, duration_ms, model, created_at, updated_at
       FROM ai_chat_video_jobs
       WHERE status IN ('pending', 'running')
       ORDER BY updated_at ASC`
    )
    .all();
  return rows.map(mapJobRow).filter(Boolean);
}

function resetStuckRunningVideoJobs(db: Db) {
  ensureChatVideoTimelineTables(db);
  db.prepare(
    `UPDATE ai_chat_video_jobs
     SET status = 'pending', updated_at = datetime('now')
     WHERE status = 'running'`
  ).run();
}

function enqueueVideoJob(db: Db, { fileId, ticketId }: Unchecked = {}) {
  ensureChatVideoTimelineTables(db);
  const id = optionalPositiveId(fileId);
  if (!id) return null;

  const existing = getVideoJob(db, id);
  if (existing) {
    if (existing.status === 'ready' || existing.status === 'pending' || existing.status === 'running') {
      if (ticketId != null && !existing.ticket_id) {
        const tid = optionalPositiveId(ticketId);
        if (tid) {
          db.prepare(
            `UPDATE ai_chat_video_jobs
             SET ticket_id = ?, updated_at = datetime('now')
             WHERE file_id = ? AND ticket_id IS NULL`
          ).run(tid, id);
          return getVideoJob(db, id);
        }
      }
      return existing;
    }
    // failed → re-queue
    db.prepare(
      `UPDATE ai_chat_video_jobs
       SET status = 'pending', error = NULL, ticket_id = COALESCE(?, ticket_id),
           updated_at = datetime('now')
       WHERE file_id = ?`
    ).run(optionalPositiveId(ticketId), id);
    return getVideoJob(db, id);
  }

  db.prepare(
    `INSERT INTO ai_chat_video_jobs (file_id, ticket_id, status, created_at, updated_at)
     VALUES (?, ?, 'pending', datetime('now'), datetime('now'))`
  ).run(id, optionalPositiveId(ticketId));
  return getVideoJob(db, id);
}

function markVideoJobRunning(db: Db, fileId?: any) {
  ensureChatVideoTimelineTables(db);
  const id = optionalPositiveId(fileId);
  if (!id) return null;
  db.prepare(
    `UPDATE ai_chat_video_jobs
     SET status = 'running', error = NULL, updated_at = datetime('now')
     WHERE file_id = ?`
  ).run(id);
  return getVideoJob(db, id);
}

function failVideoJob(db: Db, fileId?: any, error?: any) {
  ensureChatVideoTimelineTables(db);
  const id = optionalPositiveId(fileId);
  if (!id) return null;
  db.prepare(
    `UPDATE ai_chat_video_jobs
     SET status = 'failed', error = ?, updated_at = datetime('now')
     WHERE file_id = ?`
  ).run(String(error || 'failed').slice(0, 2000), id);
  return getVideoJob(db, id);
}

function clearVideoArtifacts(db: Db, fileId?: any) {
  const id = optionalPositiveId(fileId);
  if (!id) return;
  const job = getVideoJob(db, id);
  db.prepare('DELETE FROM ai_chat_video_segments WHERE file_id = ?').run(id);
  db.prepare('DELETE FROM ai_chat_video_frames WHERE file_id = ?').run(id);
  if (job?.ticket_id) {
    const dir = ticketVideoDir(job.ticket_id, id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function completeVideoJob(
  db: Db,
  fileId?: any,
  {
    durationMs = null,
    model = null,
    segments = [],
    frames = [],
  }: Unchecked = {}
) {
  ensureChatVideoTimelineTables(db);
  const id = optionalPositiveId(fileId);
  if (!id) return null;

  const job = getVideoJob(db, id);
  const ticketId = job?.ticket_id || null;

  db.prepare('DELETE FROM ai_chat_video_segments WHERE file_id = ?').run(id);
  db.prepare('DELETE FROM ai_chat_video_frames WHERE file_id = ?').run(id);

  const insertSegment = db.prepare(
    `INSERT INTO ai_chat_video_segments (file_id, start_ms, end_ms, text)
     VALUES (?, ?, ?, ?)`
  );
  for (const segment of segments || []) {
    const text = String(segment?.text || '').trim();
    if (!text) continue;
    const startMs = Math.max(0, Math.round(Number(segment.start_ms) || 0));
    const endMs = Math.max(startMs, Math.round(Number(segment.end_ms) || startMs));
    insertSegment.run(id, startMs, endMs, text);
  }

  const insertFrame = db.prepare(
    `INSERT INTO ai_chat_video_frames (file_id, t_ms, rel_path, width, height)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const frame of frames || []) {
    const relPath = String(frame?.rel_path || '').trim();
    if (!relPath) continue;
    insertFrame.run(
      id,
      Math.max(0, Math.round(Number(frame.t_ms) || 0)),
      relPath,
      optionalNonNegativeInt(frame.width),
      optionalNonNegativeInt(frame.height)
    );
  }

  db.prepare(
    `UPDATE ai_chat_video_jobs
     SET status = 'ready', error = NULL, duration_ms = ?, model = ?,
         updated_at = datetime('now')
     WHERE file_id = ?`
  ).run(optionalNonNegativeInt(durationMs), model != null ? String(model) : null, id);

  return {
    job: getVideoJob(db, id),
    ticket_id: ticketId,
  };
}

function listVideoSegments(db: Db, fileId?: any, { startMs = null, endMs = null }: Unchecked = {}) {
  ensureChatVideoTimelineTables(db);
  const id = optionalPositiveId(fileId);
  if (!id) return [];

  const start = optionalNonNegativeInt(startMs);
  const end = optionalNonNegativeInt(endMs);

  if (start != null && end != null) {
    const rows = db
      .prepare(
        `SELECT id, file_id, start_ms, end_ms, text
         FROM ai_chat_video_segments
         WHERE file_id = ?
           AND end_ms >= ?
           AND start_ms <= ?
         ORDER BY start_ms ASC, id ASC`
      )
      .all(id, start, end);
    return rows.map(mapSegmentRow).filter(Boolean);
  }

  const rows = db
    .prepare(
      `SELECT id, file_id, start_ms, end_ms, text
       FROM ai_chat_video_segments
       WHERE file_id = ?
       ORDER BY start_ms ASC, id ASC`
    )
    .all(id);
  return rows.map(mapSegmentRow).filter(Boolean);
}

function searchVideoSegments(db: Db, fileId?: any, query?: any, { limit = 20 }: Unchecked = {}) {
  ensureChatVideoTimelineTables(db);
  const id = optionalPositiveId(fileId);
  const q = String(query || '').trim().toLowerCase();
  if (!id || !q) return [];
  const max = Math.min(100, Math.max(1, Number(limit) || 20));
  const rows = db
    .prepare(
      `SELECT id, file_id, start_ms, end_ms, text
       FROM ai_chat_video_segments
       WHERE file_id = ?
       ORDER BY start_ms ASC, id ASC`
    )
    .all(id);
  return rows
    .map(mapSegmentRow)
    .filter((row?: any) => row && String(row.text || '').toLowerCase().includes(q))
    .slice(0, max);
}

function listVideoFrames(db: Db, fileId?: any, { startMs = null, endMs = null }: Unchecked = {}) {
  ensureChatVideoTimelineTables(db);
  const id = optionalPositiveId(fileId);
  if (!id) return [];

  const start = optionalNonNegativeInt(startMs);
  const end = optionalNonNegativeInt(endMs);

  if (start != null && end != null) {
    const rows = db
      .prepare(
        `SELECT id, file_id, t_ms, rel_path, width, height
         FROM ai_chat_video_frames
         WHERE file_id = ?
           AND t_ms >= ?
           AND t_ms <= ?
         ORDER BY t_ms ASC, id ASC`
      )
      .all(id, start, end);
    return rows.map(mapFrameRow).filter(Boolean);
  }

  const rows = db
    .prepare(
      `SELECT id, file_id, t_ms, rel_path, width, height
       FROM ai_chat_video_frames
       WHERE file_id = ?
       ORDER BY t_ms ASC, id ASC`
    )
    .all(id);
  return rows.map(mapFrameRow).filter(Boolean);
}

function getVideoFrame(db: Db, fileId?: any, { frameId = null, tMs = null }: Unchecked = {}) {
  ensureChatVideoTimelineTables(db);
  const id = optionalPositiveId(fileId);
  if (!id) return null;

  const fid = optionalPositiveId(frameId);
  if (fid) {
    const row = db
      .prepare(
        `SELECT id, file_id, t_ms, rel_path, width, height
         FROM ai_chat_video_frames
         WHERE file_id = ? AND id = ?`
      )
      .get(id, fid);
    return mapFrameRow(row);
  }

  const t = optionalNonNegativeInt(tMs);
  if (t == null) return null;

  const row = db
    .prepare(
      `SELECT id, file_id, t_ms, rel_path, width, height
       FROM ai_chat_video_frames
       WHERE file_id = ?
       ORDER BY ABS(t_ms - ?) ASC, id ASC
       LIMIT 1`
    )
    .get(id, t);
  return mapFrameRow(row);
}

function countVideoSegments(db: Db, fileId?: any) {
  const id = optionalPositiveId(fileId);
  if (!id) return 0;
  ensureChatVideoTimelineTables(db);
  const row = db.prepare('SELECT COUNT(*) AS n FROM ai_chat_video_segments WHERE file_id = ?').get(id);
  return Number(row?.n) || 0;
}

function countVideoFrames(db: Db, fileId?: any) {
  const id = optionalPositiveId(fileId);
  if (!id) return 0;
  ensureChatVideoTimelineTables(db);
  const row = db.prepare('SELECT COUNT(*) AS n FROM ai_chat_video_frames WHERE file_id = ?').get(id);
  return Number(row?.n) || 0;
}

function resolveFrameAbsolutePath(db: Db, frame?: any) {
  if (!frame?.rel_path) return null;
  const job = getVideoJob(db, frame.file_id);
  if (!job?.ticket_id) {
    if (path.isAbsolute(frame.rel_path)) return frame.rel_path;
    return path.join(dataDir(), frame.rel_path);
  }
  return ticketVideoFramePath(job.ticket_id, frame.file_id, path.basename(frame.rel_path));
}

function videoTimelineStatusStub(job?: any) {
  if (!job) return null;
  if (job.status === 'ready') return 'timeline ready';
  if (job.status === 'pending' || job.status === 'running') return 'processing';
  if (job.status === 'failed') {
    const err = String(job.error || '').trim();
    return err ? `failed: ${err.slice(0, 120)}` : 'failed';
  }
  return null;
}

export {
  ensureChatVideoTimelineTables,
  getVideoJob,
  listUnfinishedVideoJobs,
  resetStuckRunningVideoJobs,
  enqueueVideoJob,
  markVideoJobRunning,
  failVideoJob,
  clearVideoArtifacts,
  completeVideoJob,
  listVideoSegments,
  searchVideoSegments,
  listVideoFrames,
  getVideoFrame,
  countVideoSegments,
  countVideoFrames,
  resolveFrameAbsolutePath,
  videoTimelineStatusStub,
};
