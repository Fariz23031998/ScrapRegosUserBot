function partnerFromApiRow(row) {
  return {
    id: row.id,
    name: row.name ?? '',
    legal_status: row.legal_status ?? null,
    phone: row.phone ?? null,
    contacts: row.contacts ?? null,
    description: row.description ?? null,
    moderation_status: row.status ?? null,
    balance: row.balance ?? null,
    registered_at: row.create_date ?? null,
    sale_partner: row.sale_partner ? 1 : 0,
    sale_partner_accept: row.sale_partner_accept ? 1 : 0,
    sale_partner_accept_date: row.sale_partner_accept_date ?? null,
    sale_partner_status: row.sale_partner_status ?? null,
    sale_partner_status_until: row.sale_partner_status_until ?? null,
  };
}

function partnerAccountFromApiRow(row) {
  return {
    id: row.id,
    partner: row.partner ?? '',
    status: row.status ?? null,
    status_id: row.status_id ?? null,
    api_server: row.api_server ?? null,
    api_login: row.api_login ?? null,
    tariff: row.tariff ?? null,
    paid_until: row.paid_until ?? null,
    dealer_create: row.dealer_create ?? null,
    date_create: row.date_create ?? null,
    dealer: row.dealer ?? null,
    last_update: row.last_update ?? null,
    balance: row.balance ?? null,
  };
}

function licenseFromApiRow(row) {
  return {
    id: row.id,
    fio: row.fio ?? '',
    phone: row.phone ?? null,
    generated: row.generated ?? null,
    code: row.code ?? null,
    type: row.type ?? null,
    contract: row.contract ?? null,
    license_key: row.key ?? null,
    objects: row.objects ?? null,
    cashes: row.cashes ?? null,
    adr: row.adr ?? null,
    note: row.note ?? null,
    active: row.active ?? null,
    server: row.server ?? null,
    support: row.support ?? null,
    partner: row.partner ?? null,
    partner_phone: row.partner_phone ?? null,
  };
}

function vcr1PartnerFromApiRow(row) {
  return {
    id: row.id,
    name: row.name ?? '',
    inn: row.inn ?? null,
    legal_status: row.legal_status ?? null,
    phone: row.phone ?? null,
    contacts: row.contacts ?? null,
    company: row.company ?? null,
    balance: row.balance ?? null,
    registered_at: row.create_date ?? row.created_at ?? row.registered_at ?? null,
  };
}

function vcr1LicenseFromApiRow(row) {
  return {
    id: row.id,
    partner: row.partner ?? null,
    contract: row.contract ?? null,
    created_at: row.create ?? null,
    status: row.status ?? null,
    fm: row.fm ?? null,
    serial: row.serial ?? null,
    license: row.license ?? null,
    fda_version: row.fda_version ?? null,
    app_build_time: row.app_build_time ?? null,
    db_version: row.db_version ?? null,
    last_receipt_date: row.last_receipt_date ?? null,
    last_check_attempt: row.last_check_attempt ?? null,
    last_sync: row.last_sync ?? null,
  };
}

function partnerFromTableRow(cells) {
  return {
    id: Number(cells[0]),
    name: cells[1] ?? '',
    legal_status: cells[2] || null,
    phone: cells[3] || null,
    contacts: cells[4] || null,
    description: cells[5] || null,
    moderation_status: cells[6] || null,
    balance: cells[7] || null,
    registered_at: cells[8] || null,
    sale_partner: null,
    sale_partner_accept: null,
    sale_partner_accept_date: null,
    sale_partner_status: null,
    sale_partner_status_until: null,
  };
}

function partnerAccountFromTableRow(cells) {
  const id = Number(cells[9]);
  return {
    id: Number.isFinite(id) ? id : null,
    partner: cells[0] ?? '',
    status: cells[1] || null,
    status_id: null,
    api_server: cells[2] || null,
    api_login: cells[3] || null,
    tariff: cells[4] || null,
    paid_until: cells[5] || null,
    dealer_create: cells[6] || null,
    date_create: cells[7] || null,
    dealer: cells[8] || null,
    last_update: null,
    balance: null,
  };
}

function licenseFromTableRow(cells) {
  const id = Number(cells[9]);
  return {
    id: Number.isFinite(id) ? id : null,
    fio: cells[0] ?? '',
    phone: cells[1] || null,
    generated: cells[2] || null,
    code: cells[3] || null,
    type: cells[4] || null,
    contract: null,
    license_key: null,
    objects: null,
    cashes: null,
    adr: null,
    note: cells[7] || null,
    active: null,
    server: cells[6] || null,
    support: cells[5] || null,
    partner: cells[8] || null,
    partner_phone: null,
  };
}

function rposClientFromRow(cells, sourceAccount) {
  return {
    id: Number(cells[0]),
    name: cells[1] ?? '',
    phone: cells[2] || null,
    created_at: cells[4] || null,
    source_account: sourceAccount,
  };
}

function rposAccountFromRow(cells, sourceAccount) {
  return {
    id: Number(cells[0]),
    code: cells[1] || null,
    client_name: cells[2] || null,
    created_at: cells[5] || null,
    source_account: sourceAccount,
  };
}

module.exports = {
  partnerFromApiRow,
  partnerAccountFromApiRow,
  licenseFromApiRow,
  vcr1PartnerFromApiRow,
  vcr1LicenseFromApiRow,
  partnerFromTableRow,
  partnerAccountFromTableRow,
  licenseFromTableRow,
  rposClientFromRow,
  rposAccountFromRow,
};
