import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';

function ensureAppSettingsTable(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function getSetting(db: Db, key: any, fallback: any = null) {
  ensureAppSettingsTable(db);
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(String(key));
  return row ? row.value : fallback;
}

function getSettings(db: Db, keys?: any) {
  ensureAppSettingsTable(db);
  const result: Unchecked = {};
  const stmt = db.prepare('SELECT value FROM app_settings WHERE key = ?');
  for (const key of keys) {
    const row = stmt.get(String(key));
    result[key] = row ? row.value : null;
  }
  return result;
}

function setSetting(db: Db, key?: any, value?: any) {
  ensureAppSettingsTable(db);
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(String(key), value == null ? null : String(value));
}

function setSettings(db: Db, entries?: any) {
  ensureAppSettingsTable(db);
  const upsert = db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  );
  db.exec('BEGIN');
  try {
    for (const [key, value] of Object.entries(entries || {})) {
      upsert.run(String(key), value == null ? null : String(value));
    }
    db.exec('COMMIT');
  } catch (error: any) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

export {
  ensureAppSettingsTable,
  getSetting,
  getSettings,
  setSetting,
  setSettings,
};
