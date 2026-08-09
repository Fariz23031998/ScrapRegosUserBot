const { describe, it, afterEach, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const {
  getTicketRecording,
  ensureTicketRecordingsTable,
} = require('../src/db/ticket-recordings');
const {
  getTicketRecordingUrl,
  resolveTicketRecordingCache,
  fetchRecordingDurationSeconds,
} = require('../src/admin/ticket-recording');
const {
  enrichTicketsWithLocalData,
  resolveMissingTicketRecordings,
} = require('../src/admin/ticket-local-enrichment');

const originalAllowedHosts = process.env.REGOS_RECORDING_ALLOWED_HOSTS;

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-ticket-recording-resolve-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.db`
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

function ticketWithRecording(id, href) {
  return {
    id,
    fields: [
      {
        key: 'field_recording_link',
        name: 'Ссылка на запись',
        value: href,
      },
    ],
  };
}

afterEach(() => {
  if (originalAllowedHosts === undefined) {
    delete process.env.REGOS_RECORDING_ALLOWED_HOSTS;
  } else {
    process.env.REGOS_RECORDING_ALLOWED_HOSTS = originalAllowedHosts;
  }
});

describe('resolveTicketRecordingCache', () => {
  let dbPath;
  let db;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    ensureTicketRecordingsTable(db);
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
    db.exec('DELETE FROM ticket_recordings');
  });

  it('stores field URL in SQL and fetches duration when missing', async () => {
    const ticket = ticketWithRecording(7, 'http://rofeev.7x.uz/call.wav');
    const resolved = await resolveTicketRecordingCache(db, ticket, {
      fetchDurationFn: async () => 42.25,
    });

    assert.deepEqual(resolved, {
      recording_url: 'http://rofeev.7x.uz/call.wav',
      duration_seconds: 42.25,
    });
    assert.equal(getTicketRecording(db, 7)?.duration_seconds, 42.25);
  });

  it('does not wipe existing duration when URL is unchanged', async () => {
    const ticket = ticketWithRecording(8, 'http://rofeev.7x.uz/same.wav');
    await resolveTicketRecordingCache(db, ticket, {
      fetchDurationFn: async () => 11,
    });
    const again = await resolveTicketRecordingCache(db, ticket, {
      fetchDurationFn: async () => {
        throw new Error('should not fetch again');
      },
    });
    assert.equal(again.duration_seconds, 11);
  });

  it('rejects disallowed hosts before fetching duration', async () => {
    assert.equal(
      await fetchRecordingDurationSeconds('http://evil.example/a.wav', {
        parseBuffer: async () => {
          throw new Error('should not parse');
        },
      }),
      null
    );
    assert.equal(
      getTicketRecordingUrl({
        fields: [{ key: 'field_recording_link', value: 'http://evil.example/a.wav' }],
      }),
      null
    );
  });

  it('does not persist zero duration and retries later', async () => {
    const ticket = ticketWithRecording(9, 'http://rofeev.7x.uz/zero.wav');
    const first = await resolveTicketRecordingCache(db, ticket, {
      fetchDurationFn: async () => 0,
    });
    assert.equal(first.duration_seconds, null);
    assert.equal(getTicketRecording(db, 9)?.duration_seconds, null);
    assert.ok(getTicketRecording(db, 9)?.duration_checked_at);

    db.prepare(
      `UPDATE ticket_recordings
       SET duration_seconds = 0
       WHERE ticket_id = 9`
    ).run();
    assert.equal(getTicketRecording(db, 9)?.duration_seconds, null);

    // Cooldown blocks immediate retry after a failed parse.
    let fetchCount = 0;
    const blocked = await resolveTicketRecordingCache(db, ticket, {
      fetchDurationFn: async () => {
        fetchCount += 1;
        return 15.5;
      },
    });
    assert.equal(fetchCount, 0);
    assert.equal(blocked.duration_seconds, null);

    const retried = await resolveTicketRecordingCache(db, ticket, {
      forceDurationFetch: true,
      fetchDurationFn: async () => 15.5,
    });
    assert.equal(retried.duration_seconds, 15.5);
  });
});

describe('list recording resolve stays off the hot path', () => {
  let dbPath;
  let db;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    ensureTicketRecordingsTable(db);
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
    db.exec('DELETE FROM ticket_recordings');
  });

  it('syncs URL without fetching duration when fetchDuration is false', async () => {
    const ticket = ticketWithRecording(70, 'http://rofeev.7x.uz/fast.wav');
    const [enriched] = enrichTicketsWithLocalData(db, [ticket]);
    let fetches = 0;
    await resolveMissingTicketRecordings(db, [enriched], {
      fetchDuration: false,
      resolveCache: async (_db, row, options = {}) => {
        assert.equal(options.fetchDuration, false);
        fetches += 1;
        const { upsertTicketRecording } = require('../src/db/ticket-recordings');
        upsertTicketRecording(_db, {
          ticketId: row.id,
          recordingUrl: 'http://rofeev.7x.uz/fast.wav',
        });
        return {
          recording_url: 'http://rofeev.7x.uz/fast.wav',
          duration_seconds: null,
        };
      },
    });
    assert.equal(fetches, 1);
    assert.equal(getTicketRecording(db, 70)?.recording_url, 'http://rofeev.7x.uz/fast.wav');
    assert.equal(getTicketRecording(db, 70)?.duration_seconds, null);
  });
});

describe('list enrichment recording cache', () => {
  let dbPath;
  let db;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    ensureTicketRecordingsTable(db);
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
    db.exec('DELETE FROM ticket_recordings');
  });

  it('attaches SQL recording and fills duration misses', async () => {
    const ticket = ticketWithRecording(55, 'http://rofeev.7x.uz/page.wav');
    const [enriched] = enrichTicketsWithLocalData(db, [ticket]);
    assert.equal(enriched.local.recording.url, 'http://rofeev.7x.uz/page.wav');
    assert.equal(enriched.local.recording.duration_seconds, null);

    await resolveMissingTicketRecordings(db, [enriched], {
      resolveCache: async (_db, row) => {
        assert.equal(row.id, 55);
        return {
          recording_url: 'http://rofeev.7x.uz/page.wav',
          duration_seconds: 18,
        };
      },
    });

    assert.deepEqual(enriched.local.recording, {
      url: 'http://rofeev.7x.uz/page.wav',
      duration_seconds: 18,
    });
  });
});
