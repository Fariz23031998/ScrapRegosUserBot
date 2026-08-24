const { parseMapCoords } = require('../lib/map-coords');
const { drivingDistanceKm, suggestedDistanceScore } = require('../lib/route-distance');
const { getLocation } = require('./locations');
const { getTechnicianScorePerKm } = require('./repair-return-settings');

async function previewTaskDistance(db, input = {}, options = {}) {
  const destination = parseMapCoords(input.address);
  const locationId = Number(input.location_id);
  const location =
    Number.isFinite(locationId) && locationId > 0 ? getLocation(db, locationId) : null;
  const origin = parseMapCoords(location?.address);
  const has_origin = Boolean(origin);
  const has_destination = Boolean(destination);
  if (!origin || !destination) {
    return {
      distance_km: null,
      suggested_score: null,
      has_origin,
      has_destination,
    };
  }
  const distance_km = await drivingDistanceKm(origin, destination, options);
  return {
    distance_km,
    suggested_score: suggestedDistanceScore(distance_km, getTechnicianScorePerKm(db)),
    has_origin,
    has_destination,
  };
}

module.exports = {
  previewTaskDistance,
};