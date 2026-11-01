import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, suggestedDistanceScore, drivingDistanceKm } from '../src/lib/route-distance';

const FROM = { lat: 39.612391, lon: 67.006493 };
const TO = { lat: 39.6439259, lon: 66.9154065 };

describe('route distance', () => {
  it('rounds suggested score like other staff scores', () => {
    assert.equal(suggestedDistanceScore(12.4, 2), 24.8);
    assert.equal(suggestedDistanceScore(12.4, 0), 0);
    assert.equal(suggestedDistanceScore(0, 5), 0);
  });

  it('uses OSRM meters when the request succeeds', async () => {
    const km = await drivingDistanceKm(FROM, TO, {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ routes: [{ distance: 12400 }] }),
      }),
    });
    assert.equal(km, 12.4);
  });

  it('falls back to haversine when OSRM fails', async () => {
    const km = await drivingDistanceKm(FROM, TO, {
      fetchImpl: async () => {
        throw new Error('network');
      },
    });
    assert.equal(km, haversineKm(FROM, TO));
    assert.ok(km > 0);
  });

  it('returns 0 for the same point', async () => {
    assert.equal(await drivingDistanceKm(FROM, FROM), 0);
  });
});
