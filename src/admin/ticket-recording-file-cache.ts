import type { Unchecked } from '../types/unchecked';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
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
 * Write the full upstream body to disk while best-effort streaming the same
 * chunks to the HTTP client. Client disconnect must NOT abort the file write —
 * duration probes and modal closes used to kill the shared pipeline and crash
 * the process via unhandled inflight rejections (ERR_STREAM_PREMATURE_CLOSE).
 */
function pipeUpstreamToCacheAndClient(
  upstreamBody: any,
  tmpPath: string,
  res: Response
): Promise<{ bytesWritten: number; clientAborted: boolean }> {
  return new Promise((resolve, reject) => {
    const upstream = Readable.fromWeb(upstreamBody as any);
    const fileOut = fs.createWriteStream(tmpPath);
    let bytesWritten = 0;
    let clientAlive = !res.writableEnded && !res.destroyed;
    let settled = false;

    const onClientClose = () => {
      clientAlive = false;
    };
    res.on('close', onClientClose);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      res.off('close', onClientClose);
      upstream.removeAllListeners();
      fileOut.removeAllListeners();
      if (error) {
        try {
          upstream.destroy();
        } catch {
          // ignore
        }
        try {
          fileOut.destroy();
        } catch {
          // ignore
        }
        reject(error);
        return;
      }
      resolve({ bytesWritten, clientAborted: !clientAlive });
    };

    upstream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesWritten += buf.length;
      const fileOk = fileOut.write(buf);
      if (clientAlive && !res.writableEnded && !res.destroyed) {
        try {
          const resOk = res.write(buf);
          if (!resOk) {
            upstream.pause();
            res.once('drain', () => upstream.resume());
          }
        } catch {
          clientAlive = false;
        }
      }
      if (!fileOk) {
        upstream.pause();
        fileOut.once('drain', () => upstream.resume());
      }
    });

    upstream.on('end', () => {
      fileOut.end(() => {
        if (clientAlive && !res.writableEnded && !res.destroyed) {
          try {
            res.end();
          } catch {
            clientAlive = false;
          }
        }
        finish();
      });
    });

    upstream.on('error', (error: Error) => finish(error));
    fileOut.on('error', (error: Error) => finish(error));
  });
}

/**
 * Serve a ticket recording, caching the WAV on disk.
 * Cache hit: fast local sendFile (Range-aware).
 * Cache miss: stream upstream to the client while writing the cache,
 * so nginx/browser are not stuck waiting for the whole slow remote file.
 * Cache fill continues even if the browser aborts the HTTP response.
 */
async function serveTicketRecordingCached(
  ticketId: string | number,
  recordingUrl: URL,
  res: Response,
  {
    fetchUpstream,
    signal: _signal,
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
    try {
      await pending;
    } catch {
      // Prior fill failed (often an old client abort); fall through and retry.
    }
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
  // Prevent unhandledRejection crash when a probe/modal aborts and nobody awaits.
  void done.catch(() => undefined);
  inflight.set(key, done);

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    // Do not pass the client abort signal to upstream — browser cancel must not
    // kill the shared cache fill that other listeners may be waiting on.
    const upstream = await fetchUpstream(recordingUrl, {});
    if (![200, 206].includes(upstream.status) || !upstream.body) {
      throw new Error(`Upstream recording returned ${upstream.status}`);
    }

    const contentLength = upstream.headers.get('content-length');
    if (!res.headersSent) {
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
    }

    await pipeUpstreamToCacheAndClient(upstream.body, tmpPath, res);
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
