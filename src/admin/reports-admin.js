const express = require('express');
const { getSessionActor, requireRight } = require('./bot-admin-auth');
const {
  REPORT_JOB_TYPES,
  actorKey,
  actorOwnsReportJob,
  getReportJob,
  presentReportJob,
} = require('../db/report-jobs');
const { reportEventHub } = require('./report-events');
const { createOrReuseReportJob, createReportWorker } = require('./report-worker');
const { RegosCrmError } = require('../integrations/regos-crm');

function writeSseEvent(res, event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  if (res.write(frame)) {
    return Promise.resolve();
  }
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

function readReportInput(req) {
  return { ...(req.query || {}), ...(req.body || {}) };
}

function sendReportError(res, error, label) {
  if (error instanceof RegosCrmError) {
    return res.status(error.status).json({ message: error.message });
  }
  if (error.status === 400) {
    return res.status(400).json({ message: error.message });
  }
  if (error.status === 404) {
    return res.status(404).json({ message: error.message || 'Не найдено.' });
  }
  console.error(`${label}:`, error);
  return res.status(500).json({ message: 'Не удалось построить отчёт.' });
}

function registerReportRoutes(router, db, deps = {}) {
  const worker = deps.worker || createReportWorker(db, deps);
  worker.resume();

  router.post(
    '/api/reports/:type',
    requireRight(db, 'see_all_report'),
    express.json(),
    (req, res) => {
      try {
        const type = String(req.params.type || '').trim();
        if (!REPORT_JOB_TYPES.includes(type)) {
          return res.status(404).json({ message: 'Неизвестный тип отчёта.' });
        }
        const actor = getSessionActor(req);
        const { job, created } = createOrReuseReportJob(db, {
          type,
          input: readReportInput(req),
          actor,
        });
        if (created) {
          worker.enqueue(job.id);
        } else if (job.status === 'pending' || job.status === 'running') {
          worker.enqueue(job.id);
        }
        return res.status(created ? 202 : 200).json(presentReportJob(job));
      } catch (error) {
        return sendReportError(res, error, 'Create report job error');
      }
    }
  );

  router.get('/api/reports/jobs/:id', requireRight(db, 'see_all_report'), (req, res) => {
    const job = getReportJob(db, req.params.id);
    const actor = getSessionActor(req);
    if (!job || !actorOwnsReportJob(db, job, actor)) {
      return res.status(404).json({ message: 'Отчёт не найден.' });
    }
    return res.json(presentReportJob(job));
  });

  router.get('/api/reports/events', requireRight(db, 'see_all_report'), (req, res) => {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const key = actorKey(getSessionActor(req));
    const unsubscribe = reportEventHub.subscribe(key, (event) => writeSseEvent(res, event));
    const heartbeat = setInterval(() => {
      writeSseEvent(res, {
        type: 'heartbeat',
        occurred_at: new Date().toISOString(),
      }).catch(() => {});
    }, 30_000);

    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}

module.exports = {
  registerReportRoutes,
};
