import type { Unchecked } from '../types/unchecked';
import fs from 'fs';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { Response } from 'express';
import { fromRoot } from '../paths';

const RECORDING_CACHE_DIR = fromRoot('data', 'recording-cache');
const inflight = new Map<string, Promise<string>>();

function cachePathForTicket(ticketId: string | number) {
  const id = String(ticketId).replace(/[^\d]/g, '');
  if (!id) throw new Error('Invalid ticket id for recording cache');
  return path.join(RECORDING_CACHE_DIR, `${id}.wav`);
}

function ensureCacheDir() {
  fs.mkdirSync(RECORDING_CACHE_DIR, { recursive: true });
}

function isUsableCacheFile(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 64;
  } catch {
    return false;
  }
}

function createTeeToFile(fileWritable: fs.WriteStream) {
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!fileWritable.write(chunk)) {
        fileWritable.once('drain', () => cb(null, chunk));
        return;
      }
      cb(null, chunk);
    },
    flush(cb) {
      fileWritable.end(() => cb());
    },
  });
}

async function sendCachedRecordingFile(res: Response, filePath: string) {
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Accel-Buffering', 'no');
  await new Promise<void>((resolve, reject) => {
    res.sendFile(filePath, (error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Serve a ticket recording, caching the WAV on disk.
 * Cache hit: fast local sendFile (Range-aware).
 * Cache miss: stream upstream to the client while writing the cache (tee),
 * so nginx/browser are not stuck waiting for the whole slow remote file.
 */
async function serveTicketRecordingCached(
  ticketId: string | number,
  recordingUrl: URL,
  res: Response,
  {
    fetchUpstream,
    signal,
  }: {
    fetchUpstream: (url: URL, opts?: Unchecked) => Promise<Response>;
    signal?: AbortSignal;
  }
) {
  ensureCacheDir();
  const filePath = cachePathForTicket(ticketId);
  const key = String(ticketId);

  if (isUsableCacheFile(filePath)) {
    await sendCachedRecordingFile(res, filePath);
    return { mode: 'cache-hit' as const, filePath };
  }

  const pending = inflight.get(key);
  if (pending) {
    await pending;
    if (isUsableCacheFile(filePath)) {
      await sendCachedRecordingFile(res, filePath);
      return { mode: 'cache-wait' as const, filePath };
    }
  }

  let resolveInflight: (value: string) => void = () => undefined;
  let rejectInflight: (error: Error) => void = () => undefined;
  const done = new Promise<string>((resolve, reject) => {
    resolveInflight = resolve;
    rejectInflight = reject;
  });
  inflight.set(key, done);

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const upstream = await fetchUpstream(recordingUrl, { signal });
    if (![200, 206].includes(upstream.status) || !upstream.body) {
      throw new Error(`Upstream recording returned ${upstream.status}`);
    }

    const contentLength = upstream.headers.get('content-length');
    res.status(200);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Accel-Buffering', 'no');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (typeof (res as any).flushHeaders === 'function') {
      (res as any).flushHeaders();
    }

    const fileOut = fs.createWriteStream(tmpPath);
    const tee = createTeeToFile(fileOut);
    await pipeline(Readable.fromWeb(upstream.body as any), tee, res);
    fs.renameSync(tmpPath, filePath);
    resolveInflight(filePath);
    return { mode: 'cache-fill' as const, filePath };
  } catch (error: any) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    rejectInflight(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    inflight.delete(key);
  }
}

export {
  RECORDING_CACHE_DIR,
  cachePathForTicket,
  isUsableCacheFile,
  serveTicketRecordingCached,
};
