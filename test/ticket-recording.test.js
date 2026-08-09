const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  getAllowedRecordingHosts,
  getTicketRecordingUrl,
  parseWavDurationSeconds,
} = require('../src/admin/ticket-recording');

const originalAllowedHosts = process.env.REGOS_RECORDING_ALLOWED_HOSTS;

afterEach(() => {
  if (originalAllowedHosts === undefined) {
    delete process.env.REGOS_RECORDING_ALLOWED_HOSTS;
  } else {
    process.env.REGOS_RECORDING_ALLOWED_HOSTS = originalAllowedHosts;
  }
});

describe('WAV header duration parser', () => {
  it('reads duration from fmt byteRate and data chunk size', () => {
    // Minimal PCM WAV: 8kHz mono 16-bit, 16000 data bytes => 1.0s
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + 16000, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(8000, 24); // sample rate
    header.writeUInt32LE(16000, 28); // byte rate
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits
    header.write('data', 36);
    header.writeUInt32LE(16000, 40);

    assert.equal(parseWavDurationSeconds(header), 1);
  });
});

describe('ticket recording URL validation', () => {
  it('accepts the configured recording field and default host', () => {
    const url = getTicketRecordingUrl({
      fields: [
        {
          key: 'field_recording_link',
          name: 'Ссылка на запись',
          value: 'http://rofeev.7x.uz/recordings/call.wav',
        },
      ],
    });

    assert.equal(url?.href, 'http://rofeev.7x.uz/recordings/call.wav');
  });

  it('rejects unsupported protocols and hosts', () => {
    for (const value of [
      'file:///etc/passwd',
      'http://127.0.0.1/private.wav',
      'http://rofeev.7x.uz:8080/private.wav',
      'not-a-url',
    ]) {
      assert.equal(
        getTicketRecordingUrl({
          fields: [{ key: 'field_recording_link', value }],
        }),
        null
      );
    }
  });

  it('supports an explicit comma-separated host allowlist', () => {
    process.env.REGOS_RECORDING_ALLOWED_HOSTS = 'media.example.com, calls.example.uz';

    assert.deepEqual(
      [...getAllowedRecordingHosts()],
      ['media.example.com', 'calls.example.uz']
    );
    assert.equal(
      getTicketRecordingUrl({
        fields: [
          {
            name: 'Ссылка на запись',
            value: 'https://calls.example.uz/audio/42.mp3',
          },
        ],
      })?.href,
      'https://calls.example.uz/audio/42.mp3'
    );
  });
});

describe('ticket detail recording player', () => {
  it('uses the authenticated media proxy while retaining the direct link', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'bot-admin', 'admin-ticket-detail.js'),
      'utf8'
    );

    assert.match(
      source,
      /const mediaUrl = `\/bot-admin\/api\/tickets\/\$\{encodeURIComponent\(ticketId\)\}\/recording`/
    );
    assert.match(source, /<audio[^>]+src="\$\{mediaUrl\}"/);
    assert.match(source, /<a[^>]+href="\$\{safeUrl\}"/);
  });
});

describe('tickets table recording cache UI', () => {
  it('uses local.recording url and duration when present', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'bot-admin', 'admin-tickets.js'),
      'utf8'
    );

    assert.match(source, /function getCachedRecording\(ticket\)/);
    assert.match(source, /ticket\?\.local\?\.recording/);
    assert.match(source, /getCachedRecordingDuration\(ticket\)/);
    assert.match(
      source,
      /Number\.isFinite\(getCachedRecordingDuration\(ticket\)\)[\s\S]*formatCallDuration\(getCachedRecordingDuration\(ticket\)\)/
    );
    assert.match(
      source,
      /Number\.isFinite\(duration\) && duration > 0 \? duration : null/
    );
  });
});
