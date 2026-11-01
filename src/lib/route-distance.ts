import type { Unchecked } from '../types/unchecked';
import { roundMoney } from '../db/money';

const EARTH_RADIUS_KM = 6371;
const OSRM_TIMEOUT_MS = 5000;
const USER_AGENT = 'ScrapRegosUserBot/1.0';
const DEFAULT_OSRM_URL = 'https://router.project-osrm.org';

function toRad(value?: any) {
  return (value * Math.PI) / 180;
}

function samePoint(from?: any, to?: any) {
  return Math.abs(from.lat - to.lat) < 1e-6 && Math.abs(from.lon - to.lon) < 1e-6;
}

function roundKm(value?: any) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 10) / 10;
}

function haversineKm(from?: any, to?: any) {
  const dLat = toRad(to.lat - from.lat);
  const dLon = toRad(to.lon - from.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLon / 2) ** 2;
  return roundKm(2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a))));
}

function suggestedDistanceScore(distanceKm?: any, scorePerKm?: any) {
  const km = Number(distanceKm) || 0;
  const perKm = Number(scorePerKm) || 0;
  if (km <= 0 || perKm <= 0) return roundMoney(0);
  return roundMoney(km * perKm);
}

function getOsrmBaseUrl() {
  return String(process.env.OSRM_URL || DEFAULT_OSRM_URL).replace(/\/$/, '');
}

function osrmRouteUrl(from?: any, to?: any) {
  return `${getOsrmBaseUrl()}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
}

async function drivingDistanceKm(from: any, to: any, { fetchImpl = fetch }: Unchecked = {}) {
  if (!from || !to) return null;
  if (samePoint(from, to)) return 0;
  try {
    const response = await fetchImpl(osrmRouteUrl(from, to), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(OSRM_TIMEOUT_MS),
    });
    if (response?.ok) {
      const body = await response.json();
      const meters = Number(body?.routes?.[0]?.distance);
      if (Number.isFinite(meters) && meters >= 0) return roundKm(meters / 1000);
    }
  } catch {
    // Fall back to straight-line distance when OSRM is unavailable.
  }
  return haversineKm(from, to);
}

export {
  haversineKm,
  suggestedDistanceScore,
  drivingDistanceKm,
  roundKm,
};
