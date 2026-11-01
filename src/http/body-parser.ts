import type { Request, Response, NextFunction } from 'express';
import express from 'express';

function isBotAdminPath(req: Request) {
  const path = req.path || '';
  return path === '/bot-admin' || path.startsWith('/bot-admin/');
}

/**
 * App-level JSON/urlencoded parsers for Click, Payme, and public APIs.
 * `/bot-admin` routes parse their own bodies (chat uploads allow up to 16mb).
 * A global `express.json()` would reject those at the default 100kb limit.
 */
function createAppBodyParsers() {
  const urlencoded = express.urlencoded({ extended: false });
  const json = express.json();
  return function appBodyParsers(req: Request, res: Response, next: NextFunction) {
    if (isBotAdminPath(req)) return next();
    urlencoded(req, res, (err: Error) => {
      if (err) return next(err);
      json(req, res, next);
    });
  };
}

function payloadTooLargeHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  const error = err as Error & { type?: string };
  if (error?.type === 'entity.too.large' || error?.status === 413) {
    return res.status(413).json({
      message: 'Слишком большой запрос. Сократите голосовое или файл.',
    });
  }
  return next(err);
}

export { isBotAdminPath, createAppBodyParsers, payloadTooLargeHandler };
