import type { Unchecked } from '../types/unchecked';
import http from 'http';
import type { IncomingMessage } from 'http';
import https from 'https';
import { cookieHeaderForUrl, mergeSetCookieHeaders } from './cookie-jar';

const DEFAULT_TIMEOUT_MS = 30000;

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function encodeForm(form?: any) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form || {})) {
    if (value == null) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

function createHttpResponse(status?: any, bodyText?: any, finalUrl?: any, headers?: any) {
  return {
    status: () => status,
    ok: () => status >= 200 && status < 300,
    async text() {
      return bodyText;
    },
    async json() {
      return JSON.parse(bodyText);
    },
    url: () => finalUrl,
    headers: () => headers,
  };
}

function getSetCookieFromNodeHeaders(headers?: any) {
  const raw = headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function requestOnce(method: any, url: any, { headers = {}, body, timeout = DEFAULT_TIMEOUT_MS }: Unchecked = {}) {
  return new Promise<any>((resolve?: any, reject?: any) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        agent: isHttps ? insecureAgent : undefined,
        timeout,
      },
      (res: IncomingMessage) => {
        const chunks: any[] = [];
        res.on('data', (chunk?: any) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            url: target.toString(),
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeout}ms`));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * Playwright-compatible request facade backed by http(s) + mutable cookie jar.
 * Supports request.post(url, { form, headers, timeout }) and request.get(url, { headers, timeout }).
 */
function createHttpRequest(stateRef?: any) {
  async function send(method: any, url: any, { form, headers = {}, timeout = DEFAULT_TIMEOUT_MS, body }: Unchecked = {}) {
    let payload = body;
    const finalHeaders = { ...headers };
    if (form) {
      payload = encodeForm(form);
      if (!finalHeaders['Content-Type'] && !finalHeaders['content-type']) {
        finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }
    if (payload != null && !finalHeaders['Content-Length'] && !finalHeaders['content-length']) {
      finalHeaders['Content-Length'] = Buffer.byteLength(String(payload));
    }

    let currentMethod = method;
    let currentUrl = url;
    let hops = 0;

    while (hops < 9) {
      const cookie = cookieHeaderForUrl(stateRef.cookies, currentUrl);
      const reqHeaders = { ...finalHeaders };
      if (cookie) reqHeaders.Cookie = cookie;

      const response = await requestOnce(currentMethod, currentUrl, {
        headers: reqHeaders,
        body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : payload,
        timeout,
      });

      stateRef.cookies = mergeSetCookieHeaders(
        stateRef.cookies,
        getSetCookieFromNodeHeaders(response.headers),
        response.url || currentUrl
      );

      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
        const nextUrl = new URL(response.headers.location, response.url || currentUrl).toString();
        currentMethod = response.status === 303 ? 'GET' : currentMethod;
        currentUrl = nextUrl;
        hops += 1;
        continue;
      }

      const flatHeaders: Unchecked = {};
      for (const [key, value] of Object.entries(response.headers)) {
        flatHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
      }

      return createHttpResponse(response.status, response.body, response.url || currentUrl, flatHeaders);
    }

    throw new Error(`Too many redirects for ${url}`);
  }

  return {
    post: (url?: any, options?: any) => send('POST', url, options),
    get: (url?: any, options?: any) => send('GET', url, options),
  };
}

export { DEFAULT_TIMEOUT_MS, createHttpRequest, encodeForm };
