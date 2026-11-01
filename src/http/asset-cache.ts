import type { Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { publicDir } from '../paths';

const versionCache: Map<any, any> = new Map();

const LOCAL_ASSET_ATTR =
  /(href|src)=(["'])(\/[^"'?#]+\.(?:css|js))(?:\?[^"']*)?(["'])/gi;

function hashFileContents(absolutePath?: any) {
  const data = fs.readFileSync(absolutePath);
  return crypto.createHash('sha1').update(data).digest('hex').slice(0, 10);
}

function assetVersionForPublicUrl(urlPath?: any) {
  const pathname = String(urlPath || '').split('?')[0].split('#')[0];
  if (!pathname.startsWith('/')) return null;

  const absolutePath = path.join(publicDir(), pathname.replace(/^\//, ''));
  const relative = path.relative(publicDir(), absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  let stat: any;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const cached = versionCache.get(absolutePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.version;
  }

  const version = hashFileContents(absolutePath);
  versionCache.set(absolutePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    version,
  });
  return version;
}

function withAssetVersions(html?: any) {
  return String(html).replace(LOCAL_ASSET_ATTR, (match?: any, attr?: any, quote?: any, url?: any) => {
    const version = assetVersionForPublicUrl(url);
    if (!version) return match;
    return `${attr}=${quote}${url}?v=${version}${quote}`;
  });
}

function setHtmlNoStoreHeaders(res: Response) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function sendVersionedHtmlFile(res: Response, absoluteHtmlPath?: any) {
  let html: any;
  try {
    html = fs.readFileSync(absoluteHtmlPath, 'utf8');
  } catch (error: any) {
    return res.status(404).send('Not found');
  }

  setHtmlNoStoreHeaders(res);
  res.type('html');
  return res.send(withAssetVersions(html));
}

export {
  assetVersionForPublicUrl,
  withAssetVersions,
  setHtmlNoStoreHeaders,
  sendVersionedHtmlFile,
};
