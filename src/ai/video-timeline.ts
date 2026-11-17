import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import {
  MAX_AUDIO_FILE_BYTES,
  MAX_VIDEO_DURATION_MS,
  MAX_VIDEO_FILE_BYTES,
  MAX_VIDEO_FRAMES,
  VIDEO_DOWNLOAD_TIMEOUT_MS,
  downloadChatFileBytes,
  fileDisplayName,
  isChatVideo,
} from './chat-media';
import { transcribeAudioBufferTimed } from './transcribe';
import { DEFAULT_TRANSCRIBE_MODEL, loadAiSettings } from './settings';
import {
  clearVideoArtifacts,
  completeVideoJob,
  failVideoJob,
  getVideoJob,
  markVideoJobRunning,
} from '../db/chat-video-timelines';
import { ensureParentDir, ticketVideoDir, ticketVideoFramePath } from '../paths';

const SCENE_THRESHOLD = 0.25;
const HEARTBEAT_SEC = 15;
const NEAR_BLACK_MEAN_MAX = 12;

function runCommand(
  command: string,
  args: string[],
  { timeoutMs = 120_000 }: Unchecked = {}
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      if (!settled) {
        settled = true;
        reject(Object.assign(new Error(`${command} timed out`), { code: 'TIMEOUT' }));
      }
    }, Math.max(1000, Number(timeoutMs) || 120_000));

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error?.code === 'ENOENT') {
        reject(Object.assign(new Error(`${command} not found on PATH`), { code: 'ENOENT' }));
        return;
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

async function probeDurationMs(videoPath: string, { ffprobe = 'ffprobe' }: Unchecked = {}) {
  const result = await runCommand(
    ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ],
    { timeoutMs: 60_000 }
  );
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr.trim() || 'ffprobe failed'), { code: 'FFPROBE' });
  }
  const seconds = Number(String(result.stdout || '').trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw Object.assign(new Error('ffprobe returned invalid duration'), { code: 'FFPROBE' });
  }
  return Math.round(seconds * 1000);
}

async function extractAudioWav(
  videoPath: string,
  audioPath: string,
  { ffmpeg = 'ffmpeg' }: Unchecked = {}
) {
  const result = await runCommand(
    ffmpeg,
    ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', audioPath],
    { timeoutMs: 180_000 }
  );
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr.trim() || 'ffmpeg audio extract failed'), {
      code: 'FFMPEG',
    });
  }
  const stat = fs.statSync(audioPath);
  if (!stat.size) throw Object.assign(new Error('extracted audio is empty'), { code: 'FFMPEG' });
  if (stat.size > MAX_AUDIO_FILE_BYTES) {
    throw Object.assign(new Error('extracted audio too large'), { code: 'too_large' });
  }
}

function formatTimecodeForName(tMs: number) {
  const totalSec = Math.max(0, Math.floor(tMs / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}-${ss}`;
}

function isNearBlackJpeg(filePath: string) {
  try {
    const buf = fs.readFileSync(filePath);
    // Sample every Nth byte after header as a cheap brightness proxy.
    if (buf.length < 500) return true;
    let sum = 0;
    let count = 0;
    for (let i = 100; i < buf.length; i += 97) {
      sum += buf[i];
      count += 1;
      if (count >= 400) break;
    }
    if (!count) return true;
    return sum / count < NEAR_BLACK_MEAN_MAX;
  } catch {
    return true;
  }
}

async function extractUniqueFrames(
  videoPath: string,
  {
    ticketId,
    fileId,
    durationMs,
    ffmpeg = 'ffmpeg',
    maxFrames = MAX_VIDEO_FRAMES,
  }: Unchecked = {}
) {
  const outDir = ticketVideoDir(ticketId, fileId);
  fs.mkdirSync(outDir, { recursive: true });

  const scenePattern = path.join(outDir, 'scene_%04d.jpg');
  const sceneFilter = `select='gt(scene\\,${SCENE_THRESHOLD})',showinfo`;
  await runCommand(
    ffmpeg,
    [
      '-y',
      '-i',
      videoPath,
      '-vf',
      sceneFilter,
      '-vsync',
      'vfr',
      '-q:v',
      '3',
      scenePattern,
    ],
    { timeoutMs: 300_000 }
  );

  const candidates: { tMs: number; path: string }[] = [];
  const sceneFiles = fs
    .readdirSync(outDir)
    .filter((name) => /^scene_\d+\.jpg$/i.test(name))
    .sort();

  // showinfo pts is hard to parse reliably across builds; assign evenly then refine with heartbeat.
  const sceneStep =
    sceneFiles.length > 1 ? Math.max(1, Math.floor((durationMs || 0) / (sceneFiles.length + 1))) : 0;
  sceneFiles.forEach((name, index) => {
    candidates.push({
      tMs: Math.min(durationMs || 0, (index + 1) * sceneStep),
      path: path.join(outDir, name),
    });
  });

  const heartbeatDir = path.join(outDir, '_heartbeat');
  fs.mkdirSync(heartbeatDir, { recursive: true });
  const hbPattern = path.join(heartbeatDir, 'hb_%04d.jpg');
  await runCommand(
    ffmpeg,
    [
      '-y',
      '-i',
      videoPath,
      '-vf',
      `fps=1/${HEARTBEAT_SEC}`,
      '-q:v',
      '3',
      hbPattern,
    ],
    { timeoutMs: 300_000 }
  );
  const hbFiles = fs
    .readdirSync(heartbeatDir)
    .filter((name) => /^hb_\d+\.jpg$/i.test(name))
    .sort();
  hbFiles.forEach((name, index) => {
    candidates.push({
      tMs: Math.min(durationMs || 0, index * HEARTBEAT_SEC * 1000),
      path: path.join(heartbeatDir, name),
    });
  });

  candidates.sort((a, b) => a.tMs - b.tMs);

  const kept: { t_ms: number; rel_path: string }[] = [];
  const minGapMs = 1500;
  for (const candidate of candidates) {
    if (kept.length >= maxFrames) break;
    if (isNearBlackJpeg(candidate.path)) {
      try {
        fs.unlinkSync(candidate.path);
      } catch {
        // ignore
      }
      continue;
    }
    const last = kept[kept.length - 1];
    if (last && Math.abs(candidate.tMs - last.t_ms) < minGapMs) {
      try {
        fs.unlinkSync(candidate.path);
      } catch {
        // ignore
      }
      continue;
    }
    const filename = `frame_${String(kept.length + 1).padStart(3, '0')}_${formatTimecodeForName(candidate.tMs)}.jpg`;
    const dest = ticketVideoFramePath(ticketId, fileId, filename);
    ensureParentDir(dest);
    fs.renameSync(candidate.path, dest);
    kept.push({
      t_ms: candidate.tMs,
      rel_path: path.relative(ticketVideoDir(ticketId, fileId), dest).replace(/\\/g, '/') || filename,
    });
  }

  // Cleanup leftover scene/heartbeat files
  for (const name of fs.readdirSync(outDir)) {
    if (/^scene_/i.test(name) || name === '_heartbeat') {
      try {
        fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  return kept;
}

function writeTempFile(prefix: string, ext: string, buffer: Buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, `input${ext}`);
  fs.writeFileSync(filePath, buffer);
  return { dir, filePath };
}

function extensionForVideo(file?: any) {
  const name = fileDisplayName(file);
  const dot = name.lastIndexOf('.');
  if (dot > 0) return name.slice(dot).toLowerCase();
  const mime = String(file?.mime_type || file?.mime || '').toLowerCase();
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('quicktime') || mime.includes('mov')) return '.mov';
  return '.mp4';
}

async function processVideoTimelineJob(
  db: Db,
  file: any,
  {
    ticketId = null,
    model = null,
    downloadBytes = downloadChatFileBytes,
    transcribeImpl = null,
    ffmpeg = 'ffmpeg',
    ffprobe = 'ffprobe',
  }: Unchecked = {}
) {
  const fileId = Number(file?.id);
  if (!Number.isInteger(fileId) || fileId <= 0) {
    return { ok: false, reason: 'invalid_file_id' };
  }
  if (!isChatVideo(file)) {
    failVideoJob(db, fileId, 'not_a_video');
    return { ok: false, reason: 'not_a_video' };
  }

  markVideoJobRunning(db, fileId);
  clearVideoArtifacts(db, fileId);

  let temp: { dir: string; filePath: string } | null = null;
  try {
    let buffer: Buffer | null = null;
    if (file?.data) {
      try {
        buffer = Buffer.from(String(file.data), 'base64');
      } catch {
        buffer = null;
      }
    }
    if (!buffer?.length) {
      const downloaded = await downloadBytes(file, {
        maxBytes: MAX_VIDEO_FILE_BYTES,
        timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS,
      });
      if (downloaded?.skipped || !downloaded?.buffer) {
        const reason = downloaded?.reason || 'download_failed';
        failVideoJob(db, fileId, reason);
        return { ok: false, reason };
      }
      buffer = downloaded.buffer;
    }
    if (buffer.length > MAX_VIDEO_FILE_BYTES) {
      failVideoJob(db, fileId, 'too_large');
      return { ok: false, reason: 'too_large' };
    }

    temp = writeTempFile('ticket-video-', extensionForVideo(file), buffer);
    const durationMs = await probeDurationMs(temp.filePath, { ffprobe });
    if (durationMs > MAX_VIDEO_DURATION_MS) {
      failVideoJob(db, fileId, 'too_long');
      return { ok: false, reason: 'too_long', duration_ms: durationMs };
    }

    const resolvedTicketId =
      Number(ticketId) > 0
        ? Number(ticketId)
        : Number(getVideoJob(db, fileId)?.ticket_id) > 0
          ? Number(getVideoJob(db, fileId)?.ticket_id)
          : 0;
    if (!resolvedTicketId) {
      failVideoJob(db, fileId, 'missing_ticket_id');
      return { ok: false, reason: 'missing_ticket_id' };
    }

    const audioPath = path.join(temp.dir, 'audio.wav');
    await extractAudioWav(temp.filePath, audioPath, { ffmpeg });
    const audioBuffer = fs.readFileSync(audioPath);

    let settingsModel = model;
    if (!settingsModel && db) {
      try {
        settingsModel = loadAiSettings(db).transcribeModel || DEFAULT_TRANSCRIBE_MODEL;
      } catch {
        settingsModel = DEFAULT_TRANSCRIBE_MODEL;
      }
    }
    const selectedModel = settingsModel || DEFAULT_TRANSCRIBE_MODEL;

    const transcript = await transcribeAudioBufferTimed(audioBuffer, {
      filename: 'audio.wav',
      model: selectedModel,
      durationMs,
      transcribeImpl,
    });
    if (transcript?.skipped) {
      failVideoJob(db, fileId, transcript.reason || 'transcribe_failed');
      return { ok: false, reason: transcript.reason || 'transcribe_failed' };
    }

    const frames = await extractUniqueFrames(temp.filePath, {
      ticketId: resolvedTicketId,
      fileId,
      durationMs,
      ffmpeg,
      maxFrames: MAX_VIDEO_FRAMES,
    });

    completeVideoJob(db, fileId, {
      durationMs,
      model: selectedModel,
      segments: transcript.segments || [],
      frames,
    });
    return {
      ok: true,
      duration_ms: durationMs,
      segments: (transcript.segments || []).length,
      frames: frames.length,
    };
  } catch (error: any) {
    const reason =
      error?.code === 'ENOENT'
        ? 'ffmpeg_missing'
        : error?.code === 'too_large'
          ? 'too_large'
          : error?.message || 'process_failed';
    console.warn('[ai] video timeline failed:', reason);
    failVideoJob(db, fileId, reason);
    return { ok: false, reason };
  } finally {
    if (temp?.dir) {
      try {
        fs.rmSync(temp.dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

export {
  processVideoTimelineJob,
  probeDurationMs,
  extractAudioWav,
  extractUniqueFrames,
  runCommand,
};
