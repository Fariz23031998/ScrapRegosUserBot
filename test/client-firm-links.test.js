const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const {
  ensureClientFirmLinksTable,
  listLinksByClient,
  listLinksByFirm,
  addLink,
  removeLink,
  getLinkById,
} = require('../src/db/client-firm-links');
const { ADMIN_PERMISSION_KEYS, RIGHTS } = require('../src/db/user-rights');
const { DEFAULT_RIGHTS } = require('../src/db/bot-users-db');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-client-firms-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = `${dbPath}${suffix}`;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
}

describe('client_firm_links many-to-many', () => {
  let dbPath;
  let db;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    ensureClientFirmLinksTable(db);
  });

  after(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    removeDbFiles(dbPath);
  });

  beforeEach(() => {
    db.exec('DELETE FROM client_firm_links');
  });

  it('exposes clients_edit and clients_link_firm permissions', () => {
    assert.ok(RIGHTS.clients_edit);
    assert.ok(RIGHTS.clients_link_firm);
    assert.equal(DEFAULT_RIGHTS.clients_edit, 0);
    assert.equal(DEFAULT_RIGHTS.clients_link_firm, 0);
    assert.ok(ADMIN_PERMISSION_KEYS.includes('clients_edit'));
    assert.ok(ADMIN_PERMISSION_KEYS.includes('clients_link_firm'));

    const cols = db.prepare('PRAGMA table_info(user_rights)').all();
    assert.ok(cols.some((col) => col.name === 'clients_edit'));
    assert.ok(cols.some((col) => col.name === 'clients_link_firm'));
  });

  it('allows multiple firms per client and multiple clients per firm', () => {
    const first = addLink(db, {
      regos_client_id: 10,
      type: 'partner',
      recordId: 100,
      clientName: 'Firm A',
      phone: '998901112233',
    });
    const second = addLink(db, {
      regos_client_id: 10,
      type: 'license',
      recordId: 200,
      clientName: 'Firm B',
    });
    const third = addLink(db, {
      regos_client_id: 20,
      type: 'partner',
      recordId: 100,
      clientName: 'Firm A',
    });

    assert.equal(listLinksByClient(db, 10).length, 2);
    assert.equal(listLinksByFirm(db, 'partner', 100).length, 2);
    assert.equal(getLinkById(db, first.id).firm_name, 'Firm A');
    assert.equal(second.firm_type, 'license');
    assert.equal(third.regos_client_id, 20);

    assert.equal(removeLink(db, second.id, { regosClientId: 10 }), true);
    assert.equal(listLinksByClient(db, 10).length, 1);
    assert.equal(listLinksByFirm(db, 'partner', 100).length, 2);
  });

  it('rejects duplicate client-firm pairs', () => {
    addLink(db, {
      regos_client_id: 11,
      type: 'rpos_client',
      recordId: '55',
      clientName: 'RPOS',
    });
    assert.throws(
      () =>
        addLink(db, {
          regos_client_id: 11,
          type: 'rpos_client',
          recordId: 55,
          clientName: 'RPOS again',
        }),
      (error) => error.code === 'DUPLICATE_LINK'
    );
  });
});
