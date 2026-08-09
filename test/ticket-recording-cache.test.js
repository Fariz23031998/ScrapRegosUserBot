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
