import type { Db } from '../types/db';
import { parseMapCoords } from '../lib/map-coords';
import { drivingDistanceKm, suggestedDistanceScore } from '../lib/route-distance';
import { getLocation } from './locations';
import { getTechnicianScorePerKm } from './repair-return-settings';

async function previewTaskDistance(db: Db, input: any = {}, options: any = {}) {
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

export { previewTaskDistance };