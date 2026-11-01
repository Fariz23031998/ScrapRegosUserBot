import type { Db } from '../types/db';
import { getSetting, setSetting } from './app-settings';
import { roundMoney } from './money';

const KEY_REQUIRE_SERIALS = 'repair_return_require_serials';
const KEY_SCORE_PER_KM = 'technician_score_per_km';

function parseBooleanSetting(value: any, fallback: any = false) {
  if (value == null || String(value).trim() === '') return fallback;
  const raw = String(value).trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return fallback;
}

function isRepairReturnRequireSerials(db: Db) {
  return parseBooleanSetting(getSetting(db, KEY_REQUIRE_SERIALS, null), false);
}

function getTechnicianScorePerKm(db: Db) {
  const raw = getSetting(db, KEY_SCORE_PER_KM, null);
  if (raw == null || String(raw).trim() === '') return 0;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return roundMoney(amount);
}

function saveTechnicianScorePerKm(db: Db, value?: any) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('INVALID_SCORE_PER_KM');
  setSetting(db, KEY_SCORE_PER_KM, String(roundMoney(amount)));
  return getTechnicianScorePerKm(db);
}

function getRepairReturnSettingsPublic(db: Db) {
  return {
    require_serials: isRepairReturnRequireSerials(db),
    score_per_km: getTechnicianScorePerKm(db),
  };
}

function saveRepairReturnSettings(db: Db, input: any = {}) {
  if (Object.prototype.hasOwnProperty.call(input, 'require_serials') && input.require_serials != null) {
    setSetting(db, KEY_REQUIRE_SERIALS, input.require_serials ? '1' : '0');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'score_per_km') && input.score_per_km != null && input.score_per_km !== '') {
    saveTechnicianScorePerKm(db, input.score_per_km);
  }
  return getRepairReturnSettingsPublic(db);
}

export {
  KEY_REQUIRE_SERIALS,
  KEY_SCORE_PER_KM,
  isRepairReturnRequireSerials,
  getTechnicianScorePerKm,
  saveTechnicianScorePerKm,
  getRepairReturnSettingsPublic,
  saveRepairReturnSettings,
};
