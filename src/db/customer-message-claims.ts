import type { Db } from '../types/db';

const CHAT_LOCK_TTL_MINUTES = 3;

function ensureCustomerMessageClaimsTable(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_customer_message_claims (
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS ai_customer_chat_locks (
      chat_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function normalizeClaimKey(chatId?: any, messageId?: any) {
  const chat = String(chatId || '').trim();
  const id = String(messageId || '').trim();
  if (!chat || !id) return null;
  return { chat, id };
}

function isCustomerMessageClaimed(db: Db, chatId?: any, messageId?: any) {
  if (!db) return false;
  const key = normalizeClaimKey(chatId, messageId);
  if (!key) return false;
  ensureCustomerMessageClaimsTable(db);
  const row = db
    .prepare(
      `SELECT 1 AS ok
       FROM ai_customer_message_claims
       WHERE chat_id = ? AND message_id = ?`
    )
    .get(key.chat, key.id);
  return Boolean(row);
}

function claimCustomerMessage(db: Db, chatId?: any, messageId?: any) {
  if (!db) return false;
  const key = normalizeClaimKey(chatId, messageId);
  if (!key) return false;
  ensureCustomerMessageClaimsTable(db);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO ai_customer_message_claims (chat_id, message_id)
       VALUES (?, ?)`
    )
    .run(key.chat, key.id);
  return result.changes > 0;
}

function releaseCustomerMessageClaim(db: Db, chatId?: any, messageId?: any) {
  if (!db) return false;
  const key = normalizeClaimKey(chatId, messageId);
  if (!key) return false;
  ensureCustomerMessageClaimsTable(db);
  const result = db
    .prepare(
      `DELETE FROM ai_customer_message_claims
       WHERE chat_id = ? AND message_id = ?`
    )
    .run(key.chat, key.id);
  return result.changes > 0;
}

function claimCustomerChat(db: Db, chatId?: any) {
  if (!db) return false;
  const chat = String(chatId || '').trim();
  if (!chat) return false;
  ensureCustomerMessageClaimsTable(db);
  db.prepare(
    `DELETE FROM ai_customer_chat_locks
     WHERE created_at < datetime('now', ?)`
  ).run(`-${CHAT_LOCK_TTL_MINUTES} minutes`);
  const result = db
    .prepare(`INSERT OR IGNORE INTO ai_customer_chat_locks (chat_id) VALUES (?)`)
    .run(chat);
  return result.changes > 0;
}

function releaseCustomerChat(db: Db, chatId?: any) {
  if (!db) return false;
  const chat = String(chatId || '').trim();
  if (!chat) return false;
  ensureCustomerMessageClaimsTable(db);
  const result = db.prepare(`DELETE FROM ai_customer_chat_locks WHERE chat_id = ?`).run(chat);
  return result.changes > 0;
}

export {
  CHAT_LOCK_TTL_MINUTES,
  ensureCustomerMessageClaimsTable,
  isCustomerMessageClaimed,
  claimCustomerMessage,
  releaseCustomerMessageClaim,
  claimCustomerChat,
  releaseCustomerChat,
};
