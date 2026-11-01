import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMapCoords } from '../src/lib/map-coords';

const YANDEX_URL =
  'https://yandex.uz/maps/10334/samarkand/?ll=67.006493%2C39.612391&z=12.4';
const GOOGLE_URL =
  'https://www.google.com/maps/@39.6439259,66.9154065,13z?entry=ttu&g_ep=EgoyMDI2MDgxOS4wIKXMDSoASAFQAw%3D%3D';

describe('map coords', () => {
  it('parses Yandex ll=lon,lat including encoded comma', () => {
    const coords = parseMapCoords(YANDEX_URL);
    assert.ok(coords);
    assert.equal(coords.lon, 67.006493);
    assert.equal(coords.lat, 39.612391);
  });

  it('parses Google @lat,lng', () => {
    const coords = parseMapCoords(GOOGLE_URL);
    assert.ok(coords);
    assert.equal(coords.lat, 39.6439259);
    assert.equal(coords.lon, 66.9154065);
  });

  it('parses Google q=lat,lng', () => {
    const coords = parseMapCoords('https://www.google.com/maps?q=39.65,66.96');
    assert.ok(coords);
    assert.equal(coords.lat, 39.65);
    assert.equal(coords.lon, 66.96);
  });

  it('returns null when there are no coordinates', () => {
    assert.equal(parseMapCoords('Самарканд, улица Регистан'), null);
    assert.equal(parseMapCoords(''), null);
    assert.equal(parseMapCoords(null), null);
  });
});
