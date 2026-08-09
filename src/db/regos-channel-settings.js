const CHANNEL_MODES = new Set(['call', 'message_only']);
const MAX_CHANNEL_ID_LENGTH = 100;
const MAX_CHANNEL_NAME_LENGTH = 300;

function ensureRegosChannelSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS regos_channel_settings (
      channel_id TEXT PRIMARY KEY,
      interaction_mode TEXT NOT NULL
        CHECK (interaction_mode IN ('call', 'message_only')),
      channel_name TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function normalizeChannelSetting(input = {}) {
  const channelId = String(input.channel_id ?? input.id ?? '').trim();
  const interactionMode = String(input.interaction_mode ?? input.mode ?? '').trim();
  const channelName = String(input.channel_name ?? input.name ?? '').trim();

  if (!channelId || channelId.length > MAX_CHANNEL_ID_LENGTH) {
    throw new Error('INVALID_CHANNEL_ID');
  }
  if (!CHANNEL_MODES.has(interactionMode)) {
    throw new Error('INVALID_CHANNEL_MODE');
  }
  if (channelName.length > MAX_CHANNEL_NAME_LENGTH) {
    throw new Error('INVALID_CHANNEL_NAME');
  }

  return {
    channel_id: channelId,
    interaction_mode: interactionMode,
    channel_name: channelName || null,
  };
}

function listRegosChannelSettings(db) {
  ensureRegosChannelSettingsTable(db);
  return db
    .prepare(
      `SELECT channel_id, interaction_mode, channel_name, updated_at
       FROM regos_channel_settings
       ORDER BY channel_name COLLATE NOCASE ASC, channel_id ASC`
    )
    .all();
}

function replaceRegosChannelSettings(db, input) {
  if (!Array.isArray(input)) {
    throw new Error('INVALID_CHANNEL_SETTINGS');
  }

  const rows = input.map(normalizeChannelSetting);
  const channelIds = new Set();
  for (const row of rows) {
    if (channelIds.has(row.channel_id)) {
      throw new Error('DUPLICATE_CHANNEL_ID');
    }
    channelIds.add(row.channel_id);
  }

  ensureRegosChannelSettingsTable(db);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM regos_channel_settings').run();
    const insert = db.prepare(
      `INSERT INTO regos_channel_settings (
         channel_id, interaction_mode, channel_name, updated_at
       ) VALUES (?, ?, ?, datetime('now'))`
    );
    for (const row of rows) {
      insert.run(row.channel_id, row.interaction_mode, row.channel_name);
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

  return listRegosChannelSettings(db);
}

function mergeRegosChannelsWithSettings(channels, settings) {
  const savedById = new Map(
    (settings || []).map((setting) => [String(setting.channel_id), setting])
  );
  const merged = [];

  for (const channel of channels || []) {
    const id = String(channel?.id ?? '').trim();
    if (!id) continue;
    const saved = savedById.get(id);
    merged.push({
      id,
      name: String(channel?.name || saved?.channel_name || `Канал #${id}`),
      active: channel?.active !== false,
      interaction_mode: saved?.interaction_mode || 'message_only',
      available: true,
    });
    savedById.delete(id);
  }

  for (const saved of savedById.values()) {
    merged.push({
      id: String(saved.channel_id),
      name: saved.channel_name || `Канал #${saved.channel_id}`,
      active: false,
      interaction_mode: saved.interaction_mode,
      available: false,
    });
  }

  return merged.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

module.exports = {
  CHANNEL_MODES,
  ensureRegosChannelSettingsTable,
  normalizeChannelSetting,
  listRegosChannelSettings,
  replaceRegosChannelSettings,
  mergeRegosChannelsWithSettings,
};
