import type { Request, Response, NextFunction } from 'express';

function getAllowedCorsOrigins() {
  const fromEnv = String(process.env.BOT_ADMIN_CORS_ORIGINS || '')
    .split(',')
    .map((value?: any) => value.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;

  const origins: Set<any> = new Set(['http://localhost:5301', 'http://127.0.0.1:5301']);
  const publicBase = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (publicBase) {
    try {
      const url = new URL(publicBase);
      origins.add(`${url.protocol}//${url.hostname}:5301`);
      origins.add(`${url.protocol}//${url.host}`);
    } catch {
      // ignore invalid PUBLIC_BASE_URL
    }
  }
  return [...origins];
}

function applyCors(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (!origin) return next();
  if (!getAllowedCorsOrigins().includes(origin)) return next();

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Session-Id'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  return next();
}

export { getAllowedCorsOrigins, applyCors };
