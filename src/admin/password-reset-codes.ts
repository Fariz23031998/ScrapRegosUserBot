import type { Db } from '../types/db';
import crypto from 'crypto';

const CODE_TTL_MS = 10 * 60 * 1000;
const MIN_SEND_INTERVAL_MS = 60 * 1000;
const SEND_WINDOW_MS = 15 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 5;
const MAX_ATTEMPTS = 5;
const CODE_RETENTION_MS = 24 * 60 * 60 * 1000;

type IssueResult =
  | { issued: true; id: number; code: string; expiresAt: string }
  | { issued: false; reason: 'cooldown' | 'rate_limited' };

type ResetCodeRow = {
  id: number;
  salt: string;
  code_hash: string;
  expires_at: string;
  attempts: number;
  used_at: string | null;
};

function ensurePasswordResetCodesTable(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      salt TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user_id ON password_reset_codes(user_id)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_password_reset_codes_expires_at ON password_reset_codes(expires_at)'
  );
}

function hashResetCode(salt: string, code: string) {
  return crypto.createHash('sha256').update(`${salt}${code}`).digest('hex');
}

function codesMatch(salt: string, code: string, expectedHash: string) {
  const actual = Buffer.from(hashResetCode(salt, code), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function normalizeResetCode(code: unknown) {
  const raw = String(code ?? '').trim();
  if (/^\d{1,6}$/.test(raw)) return raw.padStart(6, '0');
  return raw;
}

function rollbackQuietly(db: Db) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // ignore rollback errors when no transaction is open
  }
}

function purgeOldPasswordResetCodes(db: Db, now = Date.now()) {
  const cutoff = now - CODE_RETENTION_MS;
  const rows = db.prepare('SELECT id, created_at FROM password_reset_codes').all() as Array<{
    id: number;
    created_at: string;
  }>;
  const del = db.prepare('DELETE FROM password_reset_codes WHERE id = ?');
  for (const row of rows) {
    const created = Date.parse(String(row.created_at));
    if (!Number.isFinite(created) || created < cutoff) {
      del.run(row.id);
    }
  }
}

function issuePasswordResetCode(
  db: Db,
  userId: number,
  { ttlMs = CODE_TTL_MS }: { ttlMs?: number } = {}
): IssueResult {
  const id = Number(userId);
  if (!Number.isFinite(id)) {
    throw new Error('USER_ID_REQUIRED');
  }

  ensurePasswordResetCodesTable(db);
  db.exec('BEGIN');
  try {
    const now = Date.now();
    purgeOldPasswordResetCodes(db, now);
    const rows = db
      .prepare(
        `SELECT id, created_at
         FROM password_reset_codes
         WHERE user_id = ?
         ORDER BY id DESC`
      )
      .all(id) as Array<{ id: number; created_at: string }>;

    const inWindow = rows.filter((row) => {
      const created = Date.parse(String(row.created_at));
      return Number.isFinite(created) && now - created < SEND_WINDOW_MS;
    });
    if (inWindow.length >= MAX_SENDS_PER_WINDOW) {
      db.exec('COMMIT');
      return { issued: false, reason: 'rate_limited' };
    }

    const latest = rows[0];
    if (latest) {
      const created = Date.parse(String(latest.created_at));
      if (Number.isFinite(created) && now - created < MIN_SEND_INTERVAL_MS) {
        db.exec('COMMIT');
        return { issued: false, reason: 'cooldown' };
      }
    }

    const nowIso = new Date(now).toISOString();
    db.prepare(
      `UPDATE password_reset_codes
       SET used_at = ?
       WHERE user_id = ? AND used_at IS NULL`
    ).run(nowIso, id);

    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    const salt = crypto.randomBytes(16).toString('base64url');
    const expiresAt = new Date(now + ttlMs).toISOString();
    const inserted = db
      .prepare(
        `INSERT INTO password_reset_codes (
           user_id, salt, code_hash, expires_at, attempts, created_at
         ) VALUES (?, ?, ?, ?, 0, ?)`
      )
      .run(id, salt, hashResetCode(salt, code), expiresAt, nowIso);

    db.exec('COMMIT');
    return {
      issued: true,
      id: Number(inserted.lastInsertRowid),
      code,
      expiresAt,
    };
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

function consumePasswordResetCode(db: Db, userId: number, code: unknown) {
  const id = Number(userId);
  const normalized = normalizeResetCode(code);
  if (!Number.isFinite(id) || !normalized) return false;

  ensurePasswordResetCodesTable(db);
  db.exec('BEGIN');
  try {
    const row = db
      .prepare(
        `SELECT id, salt, code_hash, expires_at, attempts, used_at
         FROM password_reset_codes
         WHERE user_id = ? AND used_at IS NULL
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(id) as ResetCodeRow | undefined;

    if (!row) {
      db.exec('COMMIT');
      return false;
    }

    const nowIso = new Date().toISOString();
    const expired = Date.parse(String(row.expires_at)) <= Date.now();
    const attempts = Number(row.attempts) || 0;
    if (expired || attempts >= MAX_ATTEMPTS) {
      db.prepare(
        `UPDATE password_reset_codes
         SET used_at = ?
         WHERE id = ? AND used_at IS NULL`
      ).run(nowIso, row.id);
      db.exec('COMMIT');
      return false;
    }

    if (!codesMatch(String(row.salt), normalized, String(row.code_hash))) {
      const nextAttempts = attempts + 1;
      if (nextAttempts >= MAX_ATTEMPTS) {
        db.prepare(
          `UPDATE password_reset_codes
           SET attempts = ?, used_at = ?
           WHERE id = ? AND used_at IS NULL`
        ).run(nextAttempts, nowIso, row.id);
      } else {
        db.prepare(
          `UPDATE password_reset_codes
           SET attempts = ?
           WHERE id = ? AND used_at IS NULL`
        ).run(nextAttempts, row.id);
      }
      db.exec('COMMIT');
      return false;
    }

    const result = db
      .prepare(
        `UPDATE password_reset_codes
         SET used_at = ?
         WHERE id = ? AND used_at IS NULL AND attempts < ?`
      )
      .run(nowIso, row.id, MAX_ATTEMPTS);
    db.exec('COMMIT');
    return result.changes > 0;
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

function discardPasswordResetCode(db: Db, codeId: number) {
  ensurePasswordResetCodesTable(db);
  db.prepare('DELETE FROM password_reset_codes WHERE id = ?').run(codeId);
}

export {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  MIN_SEND_INTERVAL_MS,
  SEND_WINDOW_MS,
  MAX_SENDS_PER_WINDOW,
  ensurePasswordResetCodesTable,
  issuePasswordResetCode,
  consumePasswordResetCode,
  discardPasswordResetCode,
};
