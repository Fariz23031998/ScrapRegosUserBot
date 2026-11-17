import type { Db } from '../types/db';

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 4000;

export type EmployeeQuickTextKind = 'ai_assist_prompt' | 'chat_snippet';

const TABLES: Record<EmployeeQuickTextKind, string> = {
  ai_assist_prompt: 'employee_ai_assist_prompts',
  chat_snippet: 'employee_chat_snippets',
};

function ensureEmployeeQuickTextTables(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS employee_ai_assist_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT,
      body TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS employee_chat_snippets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT,
      body TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_employee_ai_assist_prompts_owner
      ON employee_ai_assist_prompts (user_id, sort_order, id);

    CREATE INDEX IF NOT EXISTS idx_employee_chat_snippets_owner
      ON employee_chat_snippets (user_id, sort_order, id);
  `);
}

function normalizeOwnerUserId(value: unknown): number | null {
  if (value == null || value === '') return null;
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function normalizeTitle(value: unknown): string | null {
  if (value == null) return null;
  const title = String(value).trim();
  if (!title) return null;
  if (title.length > MAX_TITLE_LENGTH) {
    const error = new Error('INVALID_QUICK_TEXT_TITLE');
    throw error;
  }
  return title;
}

function normalizeBody(value: unknown): string {
  const body = String(value ?? '').trim();
  if (!body || body.length > MAX_BODY_LENGTH) {
    const error = new Error('INVALID_QUICK_TEXT_BODY');
    throw error;
  }
  return body;
}

function mapQuickText(row: any) {
  if (!row) return null;
  return {
    id: Number(row.id),
    user_id: row.user_id != null ? Number(row.user_id) : null,
    title: row.title != null && String(row.title).trim() ? String(row.title) : null,
    body: String(row.body || ''),
    sort_order: Number(row.sort_order) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function ownerClause(userId: number | null): { sql: string; params: Array<number | null> } {
  if (userId == null) {
    return { sql: 'user_id IS NULL', params: [] };
  }
  return { sql: 'user_id = ?', params: [userId] };
}

function listEmployeeQuickTexts(db: Db, kind: EmployeeQuickTextKind, userId: unknown) {
  ensureEmployeeQuickTextTables(db);
  const table = TABLES[kind];
  const owner = ownerClause(normalizeOwnerUserId(userId));
  return db
    .prepare(
      `SELECT * FROM ${table}
       WHERE ${owner.sql}
       ORDER BY sort_order ASC, id ASC`,
    )
    .all(...owner.params)
    .map(mapQuickText);
}

function getEmployeeQuickText(db: Db, kind: EmployeeQuickTextKind, id: unknown, userId: unknown) {
  ensureEmployeeQuickTextTables(db);
  const table = TABLES[kind];
  const itemId = Number(id);
  if (!Number.isFinite(itemId) || itemId <= 0) return null;
  const owner = ownerClause(normalizeOwnerUserId(userId));
  const row = db
    .prepare(`SELECT * FROM ${table} WHERE id = ? AND ${owner.sql}`)
    .get(itemId, ...owner.params);
  return mapQuickText(row);
}

function nextSortOrder(db: Db, table: string, userId: number | null) {
  const owner = ownerClause(userId);
  const row = db
    .prepare(`SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM ${table} WHERE ${owner.sql}`)
    .get(...owner.params) as { max_order?: number } | undefined;
  return (Number(row?.max_order) || 0) + 1;
}

function createEmployeeQuickText(
  db: Db,
  kind: EmployeeQuickTextKind,
  userId: unknown,
  payload: { title?: unknown; body?: unknown },
) {
  ensureEmployeeQuickTextTables(db);
  const table = TABLES[kind];
  const ownerId = normalizeOwnerUserId(userId);
  const title = normalizeTitle(payload?.title);
  const body = normalizeBody(payload?.body);
  const sortOrder = nextSortOrder(db, table, ownerId);
  const result = db
    .prepare(
      `INSERT INTO ${table} (user_id, title, body, sort_order, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .run(ownerId, title, body, sortOrder);
  return getEmployeeQuickText(db, kind, result.lastInsertRowid, ownerId);
}

function updateEmployeeQuickText(
  db: Db,
  kind: EmployeeQuickTextKind,
  id: unknown,
  userId: unknown,
  payload: { title?: unknown; body?: unknown },
) {
  ensureEmployeeQuickTextTables(db);
  const existing = getEmployeeQuickText(db, kind, id, userId);
  if (!existing) return null;
  const table = TABLES[kind];
  const title = Object.prototype.hasOwnProperty.call(payload || {}, 'title')
    ? normalizeTitle(payload.title)
    : existing.title;
  const body = Object.prototype.hasOwnProperty.call(payload || {}, 'body')
    ? normalizeBody(payload.body)
    : existing.body;
  db.prepare(
    `UPDATE ${table}
     SET title = ?, body = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(title, body, existing.id);
  return getEmployeeQuickText(db, kind, existing.id, userId);
}

function deleteEmployeeQuickText(db: Db, kind: EmployeeQuickTextKind, id: unknown, userId: unknown) {
  ensureEmployeeQuickTextTables(db);
  const existing = getEmployeeQuickText(db, kind, id, userId);
  if (!existing) return false;
  const table = TABLES[kind];
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(existing.id);
  return true;
}

export {
  MAX_TITLE_LENGTH,
  MAX_BODY_LENGTH,
  ensureEmployeeQuickTextTables,
  listEmployeeQuickTexts,
  getEmployeeQuickText,
  createEmployeeQuickText,
  updateEmployeeQuickText,
  deleteEmployeeQuickText,
};
