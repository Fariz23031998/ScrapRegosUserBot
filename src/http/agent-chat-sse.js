function wantsAgentSse(req) {
  return String(req.headers?.accept || '').includes('text/event-stream');
}

function writeSseEvent(res, event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  const ok = res.write(frame);
  if (typeof res.flush === 'function') res.flush();
  if (ok) return Promise.resolve();
  return new Promise((resolve, reject) => {
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
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

function beginAgentSse(res) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

async function respondAgentChat(req, res, run, { mapError } = {}) {
  if (!wantsAgentSse(req)) {
    return res.json(await run({}));
  }

  beginAgentSse(res);
  try {
    const result = await run({
      onDelta: (text) => {
        const chunk = String(text || '');
        if (!chunk) return Promise.resolve();
        return writeSseEvent(res, { type: 'delta', text: chunk });
      },
    });
    await writeSseEvent(res, { type: 'done', ...result });
  } catch (error) {
    const message =
      typeof mapError === 'function'
        ? mapError(error)
        : error?.message || 'Не удалось получить ответ агента.';
    await writeSseEvent(res, { type: 'error', message: String(message || 'agent_failed') }).catch(() => {});
  }
  if (!res.writableEnded) res.end();
  return res;
}

module.exports = {
  wantsAgentSse,
  writeSseEvent,
  beginAgentSse,
  respondAgentChat,
};
