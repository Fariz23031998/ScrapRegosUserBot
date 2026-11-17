import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../src/db/partners-db';
import {
  completeVideoJob,
  enqueueVideoJob,
  failVideoJob,
  getVideoFrame,
  getVideoJob,
  listVideoFrames,
  listVideoSegments,
  searchVideoSegments,
  videoTimelineStatusStub,
} from '../src/db/chat-video-timelines';
import { createVideoTimelineWorker } from '../src/ai/video-timeline-worker';
import { processVideoTimelineJob } from '../src/ai/video-timeline';
import { customerVideoTools } from '../src/ai/tools/customer-video-tools';
import { ticketVideoDir } from '../src/paths';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-video-tl-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath?: any) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
}

let db: any = null;
let dbPath: any = null;

function createDb() {
  dbPath = makeTempDbPath();
  db = openDb(dbPath);
  return db;
}

afterEach(() => {
  db?.close();
  db = null;
  if (dbPath) removeDbFiles(dbPath);
  dbPath = null;
});

describe('chat video timelines db', () => {
  it('stores segments and frames and supports window/search queries', () => {
    createDb();
    const job = enqueueVideoJob(db, { fileId: 55, ticketId: 7 });
    assert.equal(job.status, 'pending');

    const dir = ticketVideoDir(7, 55);
    fs.mkdirSync(dir, { recursive: true });
    const frameName = 'frame_001_00-05.jpg';
    fs.writeFileSync(path.join(dir, frameName), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    completeVideoJob(db, 55, {
      durationMs: 30_000,
      model: 'whisper-1',
      segments: [
        { start_ms: 0, end_ms: 4000, text: 'Ошибка на кассе' },
        { start_ms: 5000, end_ms: 9000, text: 'Не печатает чек' },
        { start_ms: 12000, end_ms: 15000, text: 'Помогите' },
      ],
      frames: [{ t_ms: 5000, rel_path: frameName, width: 640, height: 360 }],
    });

    const ready = getVideoJob(db, 55);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.duration_ms, 30_000);
    assert.equal(videoTimelineStatusStub(ready), 'timeline ready');

    const windowSegments = listVideoSegments(db, 55, { startMs: 4500, endMs: 10000 });
    assert.equal(windowSegments.length, 1);
    assert.match(windowSegments[0].text, /чек/);

    const found = searchVideoSegments(db, 55, 'кассе');
    assert.equal(found.length, 1);
    assert.equal(found[0].start_ms, 0);

    const frames = listVideoFrames(db, 55, { startMs: 0, endMs: 10000 });
    assert.equal(frames.length, 1);
    const nearest = getVideoFrame(db, 55, { tMs: 4800 });
    assert.equal(nearest.id, frames[0].id);
  });

  it('re-queues failed jobs', () => {
    createDb();
    enqueueVideoJob(db, { fileId: 9, ticketId: 1 });
    failVideoJob(db, 9, 'ffmpeg_missing');
    assert.equal(getVideoJob(db, 9).status, 'failed');
    const again = enqueueVideoJob(db, { fileId: 9, ticketId: 1 });
    assert.equal(again.status, 'pending');
    assert.equal(again.error, null);
  });
});

describe('video timeline worker', () => {
  it('fails clearly when ffmpeg is missing', async () => {
    createDb();
    const worker = createVideoTimelineWorker(db, {
      schedule: (task?: any) => task(),
      ffmpeg: 'ffmpeg-definitely-missing-binary',
      ffprobe: 'ffprobe-definitely-missing-binary',
      resolveFile: async () => ({
        id: 77,
        name: 'clip.mp4',
        mime_type: 'video/mp4',
        media_type: 'video',
        data: Buffer.from('not-a-real-video').toString('base64'),
      }),
    });

    worker.enqueue(77, { ticketId: 3 });
    // Allow the scheduled pump to run (schedule invokes immediately above).
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const job = getVideoJob(db, 77);
    assert.ok(job);
    assert.equal(job.status, 'failed');
    assert.match(String(job.error || ''), /ffmpeg_missing|not found|FFPROBE|process_failed|ffprobe/i);
  });

  it('processVideoTimelineJob marks ffmpeg_missing', async () => {
    createDb();
    enqueueVideoJob(db, { fileId: 78, ticketId: 4 });
    const result = await processVideoTimelineJob(
      db,
      {
        id: 78,
        name: 'clip.mp4',
        mime_type: 'video/mp4',
        media_type: 'video',
        data: Buffer.from('x').toString('base64'),
      },
      {
        ticketId: 4,
        ffmpeg: 'ffmpeg-definitely-missing-binary',
        ffprobe: 'ffprobe-definitely-missing-binary',
      }
    );
    assert.equal(result.ok, false);
    assert.equal(getVideoJob(db, 78).status, 'failed');
  });
});

describe('customer video tools', () => {
  it('returns window transcript and frame vision parts', async () => {
    createDb();
    enqueueVideoJob(db, { fileId: 12, ticketId: 2 });
    const dir = ticketVideoDir(2, 12);
    fs.mkdirSync(dir, { recursive: true });
    const frameName = 'frame_001_00-01.jpg';
    // Minimal JPEG so tools can read bytes
    fs.writeFileSync(
      path.join(dir, frameName),
      Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x10, 0x20, 0x30])
    );
    completeVideoJob(db, 12, {
      durationMs: 10_000,
      model: 'whisper-1',
      segments: [{ start_ms: 1000, end_ms: 3000, text: 'касса зависла' }],
      frames: [{ t_ms: 1500, rel_path: frameName }],
    });

    const filesById = new Map([
      [
        12,
        {
          id: 12,
          name: 'demo.mp4',
          mime_type: 'video/mp4',
          media_type: 'video',
        },
      ],
    ]);
    const tools = customerVideoTools({
      db,
      ticket: { id: 2 },
      chatId: 'chat-2',
      filesById,
      deps: {
        getVideoTimelineWorker: () => ({ enqueue: () => ({ status: 'ready' }) }),
      },
    });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    const timeline = await byName.get_video_timeline.execute({ file_id: 12 });
    assert.equal(timeline.ok, true);
    assert.equal(timeline.status, 'ready');
    assert.equal(timeline.segment_count, 1);
    assert.equal(timeline.frame_count, 1);

    const window = await byName.get_video_window.execute({
      file_id: 12,
      start_ms: 0,
      end_ms: 5000,
    });
    assert.equal(window.ok, true);
    assert.equal(window.segments.length, 1);
    assert.equal(window.frames.length, 1);

    const search = await byName.search_video_transcript.execute({
      file_id: 12,
      query: 'касса',
    });
    assert.equal(search.ok, true);
    assert.equal(search.segments.length, 1);

    const frame = await byName.get_video_frame.execute({
      file_id: 12,
      frame_id: window.frames[0].id,
    });
    assert.equal(frame.ok, true);
    assert.ok(frame._visionParts?.length);
    assert.match(frame._visionLabel, /get_video_frame/);
  });
});
