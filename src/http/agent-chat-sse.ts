import type { Unchecked } from '../types/unchecked';
import type { Request, Response } from 'express';

function wantsAgentSse(req: Request) {
  return String(req.headers?.accept || '').includes('text/event-stream');
}

function writeSseEvent(res: Response, event?: any) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  const ok = res.write(frame);
  const flushable = res as Response & { flush?: () => void };
  if (typeof flushable.flush === 'function') flushable.flush();
  if (ok) return Promise.resolve();
  return new Promise<any>((resolve?: any, reject?: any) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('SSE connection closed'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

function beginAgentSse(res: Response) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

async function respondAgentChat(req: Request, res: Response, run: any, { mapError }: Unchecked = {}) {
  if (!wantsAgentSse(req)) {
    return res.json(await run({}));
  }

  beginAgentSse(res);
  try {
    const result = await run({
      onDelta: (text?: any) => {
        const chunk = String(text || '');
        if (!chunk) return Promise.resolve();
        return writeSseEvent(res, { type: 'delta', text: chunk });
      },
    });
    await writeSseEvent(res, { type: 'done', ...result });
  } catch (error: any) {
    console.error('Agent chat error:', error);
    const message =
      typeof mapError === 'function'
        ? mapError(error)
        : error?.message || 'Не удалось получить ответ агента.';
    await writeSseEvent(res, { type: 'error', message: String(message || 'agent_failed') }).catch(() => {});
  }
  if (!res.writableEnded) res.end();
  return res;
}

export {
  wantsAgentSse,
  writeSseEvent,
  beginAgentSse,
  respondAgentChat,
};
