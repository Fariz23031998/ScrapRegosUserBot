import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import {
  enqueueVideoJob,
  failVideoJob,
  getVideoJob,
  listUnfinishedVideoJobs,
  resetStuckRunningVideoJobs,
} from '../db/chat-video-timelines';
import { processVideoTimelineJob } from './video-timeline';
import { isChatVideo } from './chat-media';

type WorkerDeps = {
  getChatFilesByIds?: (chatId?: any, fileIds?: any) => Promise<any>;
  downloadBytes?: any;
  transcribeImpl?: any;
  ffmpeg?: string;
  ffprobe?: string;
  schedule?: (task: () => void) => void;
  resolveFile?: (fileId: number) => Promise<any>;
};

function createVideoTimelineWorker(db: Db, deps: WorkerDeps = {}) {
  const schedule = deps.schedule || ((task?: any) => setImmediate(task));
  const queue: number[] = [];
  const pendingMeta: Map<number, any> = new Map();
  let busy = false;
  let activeFileId: number | null = null;

  async function resolveFile(fileId: number, meta?: { chatId?: any; file?: any }) {
    if (typeof deps.resolveFile === 'function') {
      return deps.resolveFile(fileId);
    }
    if (meta?.file && Number(meta.file.id) === fileId) return meta.file;
    if (meta?.chatId && typeof deps.getChatFilesByIds === 'function') {
      const files = await deps.getChatFilesByIds(meta.chatId, [fileId]);
      return files?.[0] || null;
    }
    return null;
  }

  async function processFileId(fileId: number, meta: Unchecked = {}) {
    const job = getVideoJob(db, fileId);
    if (!job || (job.status !== 'pending' && job.status !== 'running')) return job;

    const file = await resolveFile(fileId, meta);
    if (!file) {
      return failVideoJob(db, fileId, 'file_not_found');
    }

    await processVideoTimelineJob(db, file, {
      ticketId: meta.ticketId ?? job.ticket_id,
      downloadBytes: deps.downloadBytes,
      transcribeImpl: deps.transcribeImpl,
      ffmpeg: deps.ffmpeg,
      ffprobe: deps.ffprobe,
    });
    return getVideoJob(db, fileId);
  }

  async function pump() {
    if (busy) return;
    const fileId = queue.shift();
    if (fileId == null) return;
    busy = true;
    activeFileId = fileId;
    const hint = pendingMeta.get(fileId) || {};
    pendingMeta.delete(fileId);
    try {
      await processFileId(fileId, hint);
    } catch (error: any) {
      console.error('[ai] video timeline worker error:', error?.message || error);
    } finally {
      activeFileId = null;
      busy = false;
      if (queue.length) schedule(pump);
    }
  }

  function enqueue(fileId?: any, meta: Unchecked = {}) {
    const id = Number(fileId);
    if (!Number.isInteger(id) || id <= 0) return null;

    const job = enqueueVideoJob(db, {
      fileId: id,
      ticketId: meta.ticketId ?? meta.ticket_id ?? null,
    });
    if (!job) return null;
    if (job.status === 'ready') return job;

    if (meta.file || meta.chatId || meta.ticketId != null || meta.ticket_id != null) {
      pendingMeta.set(id, {
        chatId: meta.chatId ?? pendingMeta.get(id)?.chatId ?? null,
        file: meta.file || pendingMeta.get(id)?.file || null,
        ticketId: meta.ticketId ?? meta.ticket_id ?? pendingMeta.get(id)?.ticketId ?? null,
      });
    }

    if (activeFileId !== id && !queue.includes(id)) {
      queue.push(id);
      schedule(pump);
    }
    return job;
  }

  function resume() {
    resetStuckRunningVideoJobs(db);
    for (const job of listUnfinishedVideoJobs(db)) {
      if (job?.file_id) enqueue(job.file_id, { ticketId: job.ticket_id });
    }
  }

  return {
    enqueue,
    resume,
    processFileId,
  };
}

let singleton: ReturnType<typeof createVideoTimelineWorker> | null = null;
let singletonDb: Db | null = null;

function getVideoTimelineWorker(db: Db, deps: WorkerDeps = {}) {
  if (!singleton || singletonDb !== db) {
    singleton = createVideoTimelineWorker(db, deps);
    singletonDb = db;
  }
  return singleton;
}

function enqueueTicketVideos(
  db: Db,
  {
    ticketId,
    chatId,
    files = [],
    filesById = null,
    worker = null,
  }: Unchecked = {}
) {
  const w = worker || getVideoTimelineWorker(db);
  const list: any[] = [];
  if (filesById instanceof Map) {
    for (const file of filesById.values()) list.push(file);
  }
  for (const file of files || []) list.push(file);

  const seen: Set<number> = new Set();
  const jobs: any[] = [];
  for (const file of list) {
    if (!isChatVideo(file)) continue;
    const id = Number(file?.id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    const job = w.enqueue(id, { ticketId, chatId, file });
    if (job) jobs.push(job);
  }
  return jobs;
}

export {
  createVideoTimelineWorker,
  getVideoTimelineWorker,
  enqueueTicketVideos,
};
