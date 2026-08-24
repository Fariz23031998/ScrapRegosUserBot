const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createEmployeeUser } = require('../src/db/bot-users-db');
const { createLocation } = require('../src/db/locations');
const { openDb } = require('../src/db/partners-db');
const { saveRepairReturnSettings } = require('../src/db/repair-return-settings');
const { previewTaskDistance } = require('../src/db/task-distance');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-task-distance-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
}

describe('task distance preview', () => {
  let dbPath;
  let db;
  let location;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    const alice = createEmployeeUser(db, { phone: '+998901000101', displayName: 'Алиса' });
    saveRepairReturnSettings(db, { score_per_km: 2 });
    location = createLocation(db, {
      name: 'Самарканд',
      address: 'https://yandex.uz/maps/10334/samarkand/?ll=67.006493%2C39.612391&z=12.4',
      allowed_user_ids: [alice.id],
    });
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('returns suggested score from OSRM distance', async () => {
    const preview = await previewTaskDistance(
      db,
      {
        address: 'https://www.google.com/maps/@39.6439259,66.9154065,13z',
        location_id: location.id,
      },
      {
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ routes: [{ distance: 12400 }] }),
        }),
      }
    );
    assert.equal(preview.has_origin, true);
    assert.equal(preview.has_destination, true);
    assert.equal(preview.distance_km, 12.4);
    assert.equal(preview.suggested_score, 24.8);
  });

  it('skips routing when a map link has no coordinates', async () => {
    const preview = await previewTaskDistance(db, {
      address: 'Регистан, Самарканд',
      location_id: location.id,
    });
    assert.equal(preview.has_origin, true);
    assert.equal(preview.has_destination, false);
    assert.equal(preview.distance_km, null);
    assert.equal(preview.suggested_score, null);
  });
});
