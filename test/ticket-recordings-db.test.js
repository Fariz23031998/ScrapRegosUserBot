const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const {
  ensureTicketRecordingsTable,
  getTicketRecording,
  getTicketRecordingsByIds,
  upsertTicketRecording,
} = require('../src/db/ticket-recordings');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-ticket-recordings-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('ticket_recordings db helpers', () => {
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

  it('upserts recording url and duration', () => {
    const row = upsertTicketRecording(db, {
      ticketId: 10,
      recordingUrl: 'http://rofeev.7x.uz/a.wav',
      durationSeconds: 12.5,
    });
    assert.equal(row.ticket_id, 10);
    assert.equal(row.recording_url, 'http://rofeev.7x.uz/a.wav');
    assert.equal(row.duration_seconds, 12.5);
    assert.equal(getTicketRecording(db, 10)?.duration_seconds, 12.5);
  });

  it('clears duration when recording url changes', () => {
    upsertTicketRecording(db, {
      ticketId: 11,
      recordingUrl: 'http://rofeev.7x.uz/old.wav',
      durationSeconds: 30,
    });
    const row = upsertTicketRecording(db, {
      ticketId: 11,
      recordingUrl: 'http://rofeev.7x.uz/new.wav',
    });
    assert.equal(row.recording_url, 'http://rofeev.7x.uz/new.wav');
    assert.equal(row.duration_seconds, null);
  });

  it('supports partial duration updates and batch get', () => {
    upsertTicketRecording(db, {
      ticketId: 21,
      recordingUrl: 'http://rofeev.7x.uz/a.wav',
    });
    upsertTicketRecording(db, {
      ticketId: 22,
      recordingUrl: 'http://rofeev.7x.uz/b.wav',
      durationSeconds: 9,
    });
    upsertTicketRecording(db, {
      ticketId: 21,
      durationSeconds: 4.2,
    });

    const byId = getTicketRecordingsByIds(db, [21, 22, 99]);
    assert.equal(byId.size, 2);
    assert.equal(byId.get(21).duration_seconds, 4.2);
    assert.equal(byId.get(22).duration_seconds, 9);
    assert.equal(byId.has(99), false);
  });
});
