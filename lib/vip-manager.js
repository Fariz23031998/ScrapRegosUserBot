const { phonesMatch } = require('./search-user');

function getVipManagerPhone() {
  const phone = process.env.VIP_MANAGER_PHONE?.trim();
  return phone || null;
}

function isVipManagerConfigured() {
  return getVipManagerPhone() !== null;
}

function isVipManager(botUserPhone) {
  const managerPhone = getVipManagerPhone();
  if (!managerPhone || !botUserPhone) return false;
  return phonesMatch(managerPhone, botUserPhone);
}

module.exports = {
  getVipManagerPhone,
  isVipManagerConfigured,
  isVipManager,
};
