const { getDefaultPrompt, isPromptSlug, listPromptSlots, PROMPT_SLOTS } = require('../ai/default-prompts');

const MAX_BODY = 20000;
const MAX_NAME = 120;
const PROMPT_SLUGS = Object.keys(PROMPT_SLOTS);
const DEFAULT_PROMPT_NAME = 'По умолчанию';
const SAVED_PROMPT_NAME = 'Сохранённый';
const PROMPT_COLUMNS = 'id, type, name, body, updated_by, created_at, updated_at';

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function isLegacyAiPromptsTable(db) {
  if (!tableExists(db, 'ai_prompts')) return false;
  const cols = db.prepare('PRAGMA table_info(ai_prompts)').all();
  return cols.some((col) => col.name === 'slug') && !cols.some((col) => col.name === 'type');
}

function migrateLegacyAiPrompts(db) {
  if (!isLegacyAiPromptsTable(db)) return;

  db.exec('ALTER TABLE ai_prompts RENAME TO ai_prompts_legacy');
  createAiPromptTables(db);

  const legacyRows = db
    .prepare('SELECT slug, body, updated_by, updated_at FROM ai_prompts_legacy')
    .all();
  const insert = db.prepare(
    `INSERT INTO ai_prompts (type, name, body, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`
  );
  const activate = db.prepare(
    `INSERT INTO ai_prompt_active (type, prompt_id) VALUES (?, ?)`
  );

  for (const row of legacyRows) {
    if (!isPromptSlug(row.slug)) continue;
    const body = String(row.body || '').trim();
    if (!body) continue;
    const result = insert.run(
      row.slug,
      SAVED_PROMPT_NAME,
      body,
      row.updated_by ?? null,
      row.updated_at || null,
      row.updated_at || null
    );
    activate.run(row.slug, Number(result.lastInsertRowid));
  }

  db.exec('DROP TABLE ai_prompts_legacy');
}

function createAiPromptTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_prompt_active (
      type TEXT PRIMARY KEY,
      prompt_id INTEGER NOT NULL,
      FOREIGN KEY (prompt_id) REFERENCES ai_prompts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_prompts_type ON ai_prompts(type);
  `);
}

function ensureAiPromptsTable(db) {
  migrateLegacyAiPrompts(db);
  createAiPromptTables(db);
}

function normalizeSlug(slug) {
  const value = String(slug || '').trim();
  if (!isPromptSlug(value)) throw new Error('INVALID_PROMPT_SLUG');
  return value;
}

function normalizeName(name) {
  const text = String(name || '').trim();
  if (!text || text.length > MAX_NAME) throw new Error('INVALID_PROMPT_NAME');
  return text;
}

function normalizeBody(body) {
  const text = String(body || '').trim();
  if (!text || text.length > MAX_BODY) throw new Error('INVALID_PROMPT_BODY');
  return text;
}

function normalizePromptId(id) {
  const value = Number(id);
  if (!Number.isInteger(value) || value <= 0) throw new Error('PROMPT_NOT_FOUND');
  return value;
}

function getStoredPrompt(db, id) {
  ensureAiPromptsTable(db);
  return (
    db.prepare(`SELECT ${PROMPT_COLUMNS} FROM ai_prompts WHERE id = ?`).get(normalizePromptId(id)) || null
  );
}

function getActivePromptId(db, type) {
  const key = normalizeSlug(type);
  ensureAiPromptsTable(db);
  const row = db.prepare('SELECT prompt_id FROM ai_prompt_active WHERE type = ?').get(key);
  if (!row) return null;
  const stored = db
    .prepare('SELECT id FROM ai_prompts WHERE id = ? AND type = ?')
    .get(row.prompt_id, key);
  if (stored) return stored.id;
  db.prepare('DELETE FROM ai_prompt_active WHERE type = ?').run(key);
  return null;
}

function serializeDefaultPrompt(type, { isActive = false } = {}) {
  const key = normalizeSlug(type);
  const slot = PROMPT_SLOTS[key];
  return {
    id: null,
    type: key,
    name: DEFAULT_PROMPT_NAME,
    body: slot.defaultBody,
    is_default: true,
    is_active: Boolean(isActive),
    updated_at: null,
    updated_by: null,
  };
}

function serializeStoredPrompt(row, { isActive = false } = {}) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    body: row.body,
    is_default: false,
    is_active: Boolean(isActive),
    updated_at: row.updated_at || null,
    updated_by: row.updated_by ?? null,
  };
}

function serializePromptRow(row, activeId) {
  return serializeStoredPrompt(row, { isActive: Number(row.id) === Number(activeId) });
}

function listPromptsForType(db, type) {
  const key = normalizeSlug(type);
  ensureAiPromptsTable(db);
  const activeId = getActivePromptId(db, key);
  const rows = db
    .prepare(
      `SELECT ${PROMPT_COLUMNS} FROM ai_prompts WHERE type = ? ORDER BY datetime(updated_at) DESC, id DESC`
    )
    .all(key);
  return [serializeDefaultPrompt(key, { isActive: activeId == null }), ...rows.map((row) => serializePromptRow(row, activeId))];
}

function listPromptTypes(db) {
  ensureAiPromptsTable(db);
  return listPromptSlots().map((slot) => {
    const prompts = listPromptsForType(db, slot.slug);
    const active = prompts.find((item) => item.is_active);
    return {
      slug: slot.slug,
      title: slot.title,
      active_id: active?.id ?? null,
      prompts,
    };
  });
}

function listPrompts(db) {
  return listPromptTypes(db);
}

function getPrompt(db, id) {
  const stored = getStoredPrompt(db, id);
  if (!stored) throw new Error('PROMPT_NOT_FOUND');
  const activeId = getActivePromptId(db, stored.type);
  return serializePromptRow(stored, activeId);
}

function getResolvedPrompt(db, slug) {
  const key = normalizeSlug(slug);
  const activeId = getActivePromptId(db, key);
  if (activeId) {
    const storedBody = String(getStoredPrompt(db, activeId)?.body || '').trim();
    if (storedBody) return storedBody;
  }
  return getDefaultPrompt(key);
}

function createPrompt(db, input = {}, { updatedBy } = {}) {
  const key = normalizeSlug(input.type);
  const name = normalizeName(input.name);
  const body = normalizeBody(input.body);
  ensureAiPromptsTable(db);
  const result = db
    .prepare(
      `INSERT INTO ai_prompts (type, name, body, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(key, name, body, updatedBy ?? null);
  return getPrompt(db, Number(result.lastInsertRowid));
}

function updatePrompt(db, id, input = {}, { updatedBy } = {}) {
  const stored = getStoredPrompt(db, id);
  if (!stored) throw new Error('PROMPT_NOT_FOUND');
  const name = normalizeName(input.name ?? stored.name);
  const body = normalizeBody(input.body ?? stored.body);
  db.prepare(
    `UPDATE ai_prompts
     SET name = ?, body = ?, updated_by = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(name, body, updatedBy ?? null, stored.id);
  return getPrompt(db, stored.id);
}

function setActivePrompt(db, type, promptId) {
  const key = normalizeSlug(type);
  ensureAiPromptsTable(db);
  if (promptId == null || promptId === '') {
    db.prepare('DELETE FROM ai_prompt_active WHERE type = ?').run(key);
    return serializeDefaultPrompt(key, { isActive: true });
  }
  const stored = getStoredPrompt(db, promptId);
  if (!stored || stored.type !== key) throw new Error('PROMPT_NOT_FOUND');
  db.prepare(
    `INSERT INTO ai_prompt_active (type, prompt_id)
     VALUES (?, ?)
     ON CONFLICT(type) DO UPDATE SET prompt_id = excluded.prompt_id`
  ).run(key, stored.id);
  return serializeStoredPrompt(stored, { isActive: true });
}

function deletePrompt(db, id) {
  const stored = getStoredPrompt(db, id);
  if (!stored) throw new Error('PROMPT_NOT_FOUND');
  const wasActive = Number(getActivePromptId(db, stored.type)) === Number(stored.id);
  if (wasActive) {
    db.prepare('DELETE FROM ai_prompt_active WHERE type = ?').run(stored.type);
  }
  db.prepare('DELETE FROM ai_prompts WHERE id = ?').run(stored.id);
  return {
    ok: true,
    prompt: serializeStoredPrompt(stored, { isActive: wasActive }),
    active: serializeDefaultPrompt(stored.type, { isActive: wasActive || getActivePromptId(db, stored.type) == null }),
  };
}

function savePrompt(db, slug, body, { updatedBy, name } = {}) {
  const key = normalizeSlug(slug);
  const text = normalizeBody(body);
  ensureAiPromptsTable(db);
  const activeId = getActivePromptId(db, key);
  if (activeId) {
    return updatePrompt(db, activeId, { body: text }, { updatedBy });
  }
  const created = createPrompt(db, { type: key, name: name || SAVED_PROMPT_NAME, body: text }, { updatedBy });
  return setActivePrompt(db, key, created.id);
}

function resetPrompt(db, slug) {
  return setActivePrompt(db, slug, null);
}

module.exports = {
  MAX_BODY,
  MAX_NAME,
  PROMPT_SLUGS,
  DEFAULT_PROMPT_NAME,
  SAVED_PROMPT_NAME,
  ensureAiPromptsTable,
  getResolvedPrompt,
  listPromptTypes,
  listPrompts,
  listPromptsForType,
  getPrompt,
  createPrompt,
  updatePrompt,
  setActivePrompt,
  deletePrompt,
  savePrompt,
  resetPrompt,
};
