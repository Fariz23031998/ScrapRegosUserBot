import type { Unchecked } from '../../types/unchecked';
import type { Db } from '../../types/db';
import fs from 'fs';
import { factoryToolDescription } from './descriptions';
import { classifyChatFile, compactChatFile, isChatVideo, toImageUrlPart } from '../chat-media';
import {
  countVideoFrames,
  countVideoSegments,
  getVideoFrame,
  getVideoJob,
  listVideoFrames,
  listVideoSegments,
  resolveFrameAbsolutePath,
  searchVideoSegments,
} from '../../db/chat-video-timelines';
import { getVideoTimelineWorker } from '../video-timeline-worker';

function optionalMs(value?: any) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

async function resolveChatFile({
  file_id,
  filesById,
  chatId,
  getChatFilesByIds,
}: Unchecked = {}) {
  const id = Number(file_id);
  if (!Number.isFinite(id) || id <= 0) {
    return { error: 'invalid_file_id' as const };
  }
  let file = filesById?.get?.(id);
  if (!file && chatId && typeof getChatFilesByIds === 'function') {
    const fetched = await getChatFilesByIds(chatId, [id]);
    file = fetched?.[0] || null;
    if (file && filesById?.set) filesById.set(Number(file.id), file);
  }
  if (!file) return { error: 'not_found' as const, id };
  if (!isChatVideo(file)) {
    return {
      error: 'not_a_video' as const,
      id,
      kind: classifyChatFile(file),
      file: compactChatFile(file),
    };
  }
  return { file, id };
}

function jobNotReadyPayload(job?: any, file?: any) {
  if (!job) {
    return {
      ok: false,
      error: 'timeline_missing',
      status: 'missing',
      file: compactChatFile(file),
    };
  }
  if (job.status === 'ready') return null;
  return {
    ok: false,
    error: job.status === 'failed' ? 'timeline_failed' : 'timeline_processing',
    status: job.status,
    error_detail: job.error || null,
    file: compactChatFile(file),
  };
}

export function customerVideoTools({
  db,
  ticket,
  chatId,
  filesById = new Map(),
  deps = {},
}: Unchecked = {}) {
  const getChatFilesByIds =
    deps.getChatFilesByIds ||
    ((id?: any, fileIds?: any) =>
      (require('../../integrations/regos-crm') as typeof import('../../integrations/regos-crm')).getChatFilesByIds(
        id,
        fileIds
      ));

  async function ensureEnqueued(file: any) {
    try {
      const worker = deps.getVideoTimelineWorker
        ? deps.getVideoTimelineWorker(db)
        : getVideoTimelineWorker(db);
      worker.enqueue(file.id, {
        ticketId: ticket?.id ?? null,
        chatId,
        file,
      });
    } catch (error: any) {
      console.warn('[ai] video tool enqueue failed:', error?.message || error);
    }
  }

  return [
    {
      name: 'get_video_timeline',
      description: factoryToolDescription('get_video_timeline'),
      parameters: {
        type: 'object',
        properties: {
          file_id: {
            type: ['integer', 'number', 'string'],
            description: 'Chat video file id from history ([видео: … #id])',
          },
        },
        required: ['file_id'],
      },
      execute: async ({ file_id }: Unchecked = {}) => {
        const resolved = await resolveChatFile({ file_id, filesById, chatId, getChatFilesByIds });
        if (resolved.error) {
          return {
            ok: false,
            error: resolved.error,
            kind: resolved.kind,
            file: resolved.file || null,
          };
        }
        await ensureEnqueued(resolved.file);
        const job = getVideoJob(db, resolved.id);
        if (!job || job.status !== 'ready') {
          return {
            ok: true,
            status: job?.status || 'pending',
            error: job?.error || null,
            duration_ms: job?.duration_ms ?? null,
            segment_count: 0,
            frame_count: 0,
            file: compactChatFile(resolved.file),
          };
        }
        return {
          ok: true,
          status: 'ready',
          duration_ms: job.duration_ms,
          segment_count: countVideoSegments(db, resolved.id),
          frame_count: countVideoFrames(db, resolved.id),
          model: job.model,
          file: compactChatFile(resolved.file),
        };
      },
    },
    {
      name: 'search_video_transcript',
      description: factoryToolDescription('search_video_transcript'),
      parameters: {
        type: 'object',
        properties: {
          file_id: {
            type: ['integer', 'number', 'string'],
            description: 'Chat video file id',
          },
          query: {
            type: 'string',
            description: 'Substring to find in the timed transcript',
          },
        },
        required: ['file_id', 'query'],
      },
      execute: async ({ file_id, query }: Unchecked = {}) => {
        const resolved = await resolveChatFile({ file_id, filesById, chatId, getChatFilesByIds });
        if (resolved.error) {
          return { ok: false, error: resolved.error, file: resolved.file || null };
        }
        await ensureEnqueued(resolved.file);
        const job = getVideoJob(db, resolved.id);
        const notReady = jobNotReadyPayload(job, resolved.file);
        if (notReady) return notReady;
        const segments = searchVideoSegments(db, resolved.id, query, { limit: 20 });
        return {
          ok: true,
          query: String(query || '').trim(),
          segments,
          file: compactChatFile(resolved.file),
        };
      },
    },
    {
      name: 'get_video_window',
      description: factoryToolDescription('get_video_window'),
      parameters: {
        type: 'object',
        properties: {
          file_id: {
            type: ['integer', 'number', 'string'],
            description: 'Chat video file id',
          },
          start_ms: {
            type: ['integer', 'number', 'string'],
            description: 'Window start in milliseconds (inclusive)',
          },
          end_ms: {
            type: ['integer', 'number', 'string'],
            description: 'Window end in milliseconds (inclusive)',
          },
        },
        required: ['file_id', 'start_ms', 'end_ms'],
      },
      execute: async ({ file_id, start_ms, end_ms }: Unchecked = {}) => {
        const resolved = await resolveChatFile({ file_id, filesById, chatId, getChatFilesByIds });
        if (resolved.error) {
          return { ok: false, error: resolved.error, file: resolved.file || null };
        }
        const startMs = optionalMs(start_ms);
        const endMs = optionalMs(end_ms);
        if (startMs == null || endMs == null || endMs < startMs) {
          return { ok: false, error: 'invalid_window', file: compactChatFile(resolved.file) };
        }
        await ensureEnqueued(resolved.file);
        const job = getVideoJob(db, resolved.id);
        const notReady = jobNotReadyPayload(job, resolved.file);
        if (notReady) return notReady;

        const pad = 2000;
        const segments = listVideoSegments(db, resolved.id, { startMs, endMs });
        const frames = listVideoFrames(db, resolved.id, {
          startMs: Math.max(0, startMs - pad),
          endMs: endMs + pad,
        }).map((frame?: any) => ({
          id: frame.id,
          t_ms: frame.t_ms,
          width: frame.width,
          height: frame.height,
        }));

        return {
          ok: true,
          start_ms: startMs,
          end_ms: endMs,
          duration_ms: job?.duration_ms ?? null,
          segments,
          frames,
          file: compactChatFile(resolved.file),
        };
      },
    },
    {
      name: 'get_video_frame',
      description: factoryToolDescription('get_video_frame'),
      parameters: {
        type: 'object',
        properties: {
          file_id: {
            type: ['integer', 'number', 'string'],
            description: 'Chat video file id',
          },
          frame_id: {
            type: ['integer', 'number', 'string'],
            description: 'Frame id from get_video_window / get_video_timeline',
          },
          t_ms: {
            type: ['integer', 'number', 'string'],
            description: 'Pick the unique frame nearest to this timestamp (ms)',
          },
        },
        required: ['file_id'],
      },
      execute: async ({ file_id, frame_id, t_ms }: Unchecked = {}) => {
        const resolved = await resolveChatFile({ file_id, filesById, chatId, getChatFilesByIds });
        if (resolved.error) {
          return { ok: false, error: resolved.error, file: resolved.file || null };
        }
        if (frame_id == null && t_ms == null) {
          return { ok: false, error: 'frame_id_or_t_ms_required', file: compactChatFile(resolved.file) };
        }
        await ensureEnqueued(resolved.file);
        const job = getVideoJob(db, resolved.id);
        const notReady = jobNotReadyPayload(job, resolved.file);
        if (notReady) return notReady;

        const frame = getVideoFrame(db, resolved.id, { frameId: frame_id, tMs: t_ms });
        if (!frame) {
          return { ok: false, error: 'frame_not_found', file: compactChatFile(resolved.file) };
        }
        const abs = resolveFrameAbsolutePath(db, frame);
        if (!abs || !fs.existsSync(abs)) {
          return {
            ok: false,
            error: 'frame_file_missing',
            frame: { id: frame.id, t_ms: frame.t_ms },
            file: compactChatFile(resolved.file),
          };
        }
        const buffer = fs.readFileSync(abs);
        const part = toImageUrlPart({ mime: 'image/jpeg', base64: buffer.toString('base64') });
        return {
          ok: true,
          frame: {
            id: frame.id,
            t_ms: frame.t_ms,
            width: frame.width,
            height: frame.height,
          },
          file: compactChatFile(resolved.file),
          _visionParts: part ? [part] : [],
          _visionLabel: 'Изображение из get_video_frame.',
        };
      },
    },
  ];
}
