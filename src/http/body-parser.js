const express = require('express');

function isBotAdminPath(req) {
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
  return function appBodyParsers(req, res, next) {
    if (isBotAdminPath(req)) return next();
    urlencoded(req, res, (err) => {
      if (err) return next(err);
      json(req, res, next);
    });
  };
}

function payloadTooLargeHandler(err, req, res, next) {
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    return res.status(413).json({
      message: 'Слишком большой запрос. Сократите голосовое или файл.',
    });
  }
  return next(err);
}

module.exports = {
  isBotAdminPath,
  createAppBodyParsers,
  payloadTooLargeHandler,
};
