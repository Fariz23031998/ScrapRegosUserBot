const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  getAllowedRecordingHosts,
  getTicketRecordingUrl,
} = require('../src/admin/ticket-recording');

const originalAllowedHosts = process.env.REGOS_RECORDING_ALLOWED_HOSTS;

afterEach(() => {
  if (originalAllowedHosts === undefined) {
    delete process.env.REGOS_RECORDING_ALLOWED_HOSTS;
  } else {
    process.env.REGOS_RECORDING_ALLOWED_HOSTS = originalAllowedHosts;
  }
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
