function ensureAppSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function getSetting(db, key, fallback = null) {
  ensureAppSettingsTable(db);
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(String(key));
  return row ? row.value : fallback;
}

function getSettings(db, keys) {
  ensureAppSettingsTable(db);
  const result = {};
  const stmt = db.prepare('SELECT value FROM app_settings WHERE key = ?');
  for (const key of keys) {
    const row = stmt.get(String(key));
    result[key] = row ? row.value : null;
  }
  return result;
}

function setSetting(db, key, value) {
  ensureAppSettingsTable(db);
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(String(key), value == null ? null : String(value));
}

function setSettings(db, entries) {
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
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

module.exports = {
  ensureAppSettingsTable,
  getSetting,
  getSettings,
  setSetting,
  setSettings,
};
