const { getSetting, setSetting } = require('./app-settings');

const KEY_REQUIRE_SERIALS = 'repair_return_require_serials';

function parseBooleanSetting(value, fallback = false) {
  if (value == null || String(value).trim() === '') return fallback;
  const raw = String(value).trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return fallback;
}

function isRepairReturnRequireSerials(db) {
  return parseBooleanSetting(getSetting(db, KEY_REQUIRE_SERIALS, null), false);
}

function getRepairReturnSettingsPublic(db) {
  return { require_serials: isRepairReturnRequireSerials(db) };
}

function saveRepairReturnSettings(db, input = {}) {
  if (Object.prototype.hasOwnProperty.call(input, 'require_serials') && input.require_serials != null) {
    setSetting(db, KEY_REQUIRE_SERIALS, input.require_serials ? '1' : '0');
  }
  return getRepairReturnSettingsPublic(db);
}

module.exports = {
  KEY_REQUIRE_SERIALS,
  isRepairReturnRequireSerials,
  getRepairReturnSettingsPublic,
  saveRepairReturnSettings,
};
