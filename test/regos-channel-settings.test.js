const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const {
  listRegosChannelSettings,
  replaceRegosChannelSettings,
  mergeRegosChannelsWithSettings,
} = require('../src/db/regos-channel-settings');
const { buildDurationSummary } = require('../src/admin/bot-admin');
const { summarizeByDuration } = require('../public/bot-admin/admin-ticket-summary');

let db = null;
let dbPath = null;

function removeDbFiles(filePath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${filePath}${suffix}`);
    } catch {
      // Ignore missing temporary files.
    }
  }
}

function createDb() {
  dbPath = path.join(
    os.tmpdir(),
    `scrapregos-channel-settings-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
  db = openDb(dbPath);
  return db;
}

afterEach(() => {
  db?.close();
  db = null;
  if (dbPath) removeDbFiles(dbPath);
  dbPath = null;
});

describe('REGOS channel settings', () => {
  it('persists channel classifications across database reopen', () => {
    createDb();
    replaceRegosChannelSettings(db, [
      { channel_id: '10', channel_name: 'Телефония', interaction_mode: 'call' },
      { channel_id: 'chat', channel_name: 'Telegram', interaction_mode: 'message_only' },
    ]);
    db.close();
    db = openDb(dbPath);

    assert.deepEqual(
      listRegosChannelSettings(db).map(({ channel_id, interaction_mode, channel_name }) => ({
        channel_id,
        interaction_mode,
        channel_name,
      })),
      [
        { channel_id: 'chat', interaction_mode: 'message_only', channel_name: 'Telegram' },
        { channel_id: '10', interaction_mode: 'call', channel_name: 'Телефония' },
      ]
    );
  });

  it('validates modes and leaves prior settings intact on invalid replacement', () => {
    createDb();
    replaceRegosChannelSettings(db, [
      { channel_id: '10', channel_name: 'Телефония', interaction_mode: 'call' },
    ]);

    assert.throws(
      () =>
        replaceRegosChannelSettings(db, [
          { channel_id: '10', channel_name: 'Телефония', interaction_mode: 'video' },
        ]),
      /INVALID_CHANNEL_MODE/
    );
    assert.equal(listRegosChannelSettings(db)[0].interaction_mode, 'call');
  });

  it('defaults live unconfigured channels to messages and retains removed saved channels', () => {
    const merged = mergeRegosChannelsWithSettings(
      [{ id: 1, name: 'Телефония', active: true }],
      [
        { channel_id: '1', channel_name: 'Старое имя', interaction_mode: 'call' },
        { channel_id: 'removed', channel_name: 'Архив', interaction_mode: 'message_only' },
      ]
    );

    assert.deepEqual(merged, [
      {
        id: 'removed',
        name: 'Архив',
        active: false,
        interaction_mode: 'message_only',
        available: false,
      },
      {
        id: '1',
        name: 'Телефония',
        active: true,
        interaction_mode: 'call',
        available: true,
      },
    ]);
    assert.equal(
      mergeRegosChannelsWithSettings([{ id: 2, name: 'Telegram' }], [])[0].interaction_mode,
      'message_only'
    );
  });
});

describe('channel-aware duration totals', () => {
  it('keeps message channels in the base and evaluates only configured call channels', () => {
    const tickets = [
      { id: 1, channel_id: 'phone', sla_breached: true, rating: 5, fields: [] },
      {
        id: 2,
        channel_id: 'phone',
        sla_breached: false,
        rating: null,
        fields: [
          {
            key: 'field_recording_link',
            value: 'http://rofeev.7x.uz/recordings/2.wav',
          },
        ],
      },
      { id: 3, channel_id: 'chat', sla_breached: true, rating: null, fields: [] },
      { id: 4, channel_id: 'unconfigured', sla_breached: false, rating: 4, fields: [] },
    ];
    const durationSummary = buildDurationSummary(tickets, [
      { channel_id: 'phone', interaction_mode: 'call' },
    ]);

    assert.deepEqual(durationSummary, {
      base: { count: 2, slaBreached: 1, rated: 1 },
      calls: [
        { id: 1, slaBreached: true, rated: true, hasRecording: false },
        { id: 2, slaBreached: false, rated: false, hasRecording: true },
      ],
    });
  });

  it('uses a strict duration threshold and excludes missing durations', () => {
    const durationSummary = {
      base: { count: 2, slaBreached: 1, rated: 1 },
      calls: [
        { id: 1, slaBreached: true, rated: true, hasRecording: true },
        { id: 2, slaBreached: false, rated: true, hasRecording: true },
        { id: 3, slaBreached: true, rated: false, hasRecording: false },
      ],
    };

    assert.deepEqual(summarizeByDuration(durationSummary, { 1: 10, 2: 11 }, 10), {
      count: 3,
      slaBreached: 1,
      rated: 2,
    });
  });
});
