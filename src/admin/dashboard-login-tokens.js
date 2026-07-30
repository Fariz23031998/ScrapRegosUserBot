const crypto = require('crypto');

const TOKEN_TTL_MS = 5 * 60 * 1000;
const TOKEN_BYTES = 32;

function ensureDashboardLoginTokensTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_login_tokens (
      token_hash TEXT PRIMARY KEY,
      telegram_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_dashboard_login_tokens_expires_at ON dashboard_login_tokens(expires_at)'
  );
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

function cleanupDashboardLoginTokens(db) {
  ensureDashboardLoginTokensTable(db);
  db.prepare(
    `DELETE FROM dashboard_login_tokens
     WHERE used_at IS NOT NULL
        OR datetime(expires_at) <= datetime('now')`
  ).run();
}

function createDashboardLoginToken(db, telegramId, { ttlMs = TOKEN_TTL_MS } = {}) {
  if (!telegramId) {
    throw new Error('TELEGRAM_ID_REQUIRED');
  }

  ensureDashboardLoginTokensTable(db);
  cleanupDashboardLoginTokens(db);

  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  db.prepare(
    `INSERT INTO dashboard_login_tokens (token_hash, telegram_id, expires_at)
     VALUES (?, ?, ?)`
  ).run(tokenHash, Number(telegramId), expiresAt);

  return { rawToken, expiresAt, ttlMs };
}

/**
 * Atomically consume a one-time token.
 * Returns { telegramId } on success, or null if invalid/expired/already used.
 */
function consumeDashboardLoginToken(db, rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return null;

  ensureDashboardLoginTokensTable(db);
  const tokenHash = hashToken(token);

  db.exec('BEGIN');
  try {
    const row = db
      .prepare(
        `SELECT token_hash, telegram_id, expires_at, used_at
         FROM dashboard_login_tokens
         WHERE token_hash = ?`
      )
      .get(tokenHash);

    if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) {
      db.exec('COMMIT');
      cleanupDashboardLoginTokens(db);
      return null;
    }

    const result = db
      .prepare(
        `UPDATE dashboard_login_tokens
         SET used_at = datetime('now')
         WHERE token_hash = ? AND used_at IS NULL`
      )
      .run(tokenHash);

    db.exec('COMMIT');
    cleanupDashboardLoginTokens(db);

    if (!result.changes) return null;
    return { telegramId: Number(row.telegram_id) };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors when no transaction is open
    }
    throw error;
  }
}

module.exports = {
  TOKEN_TTL_MS,
  ensureDashboardLoginTokensTable,
  createDashboardLoginToken,
  consumeDashboardLoginToken,
  cleanupDashboardLoginTokens,
  hashToken,
};
