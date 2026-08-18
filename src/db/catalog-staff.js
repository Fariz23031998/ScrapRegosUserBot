function roundStaff(value) {
  return Math.round(value * 10000) / 10000;
}

function parseStaffAmount(value, { max = null, errorCode } = {}) {
  if (value == null || value === '') return 0;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(errorCode);
  if (max != null && amount > max) throw new Error(errorCode);
  return roundStaff(amount);
}

function normalizeCatalogStaffInput(input = {}) {
  return {
    manager_sale_percent: parseStaffAmount(input.manager_sale_percent, {
      max: 100,
      errorCode: 'INVALID_MANAGER_SALE_PERCENT',
    }),
    technician_score: parseStaffAmount(input.technician_score, {
      errorCode: 'INVALID_TECHNICIAN_SCORE',
    }),
  };
}

function presentCatalogStaffFields(row = {}) {
  return {
    manager_sale_percent: Number(row.manager_sale_percent) || 0,
    technician_score: Number(row.technician_score) || 0,
  };
}

module.exports = {
  normalizeCatalogStaffInput,
  presentCatalogStaffFields,
};
