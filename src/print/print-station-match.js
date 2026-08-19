function normalizePrinters(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      name: String(item?.name || '').trim(),
      kind: String(item?.kind || '').trim().toLowerCase(),
      enabled: item?.enabled !== false,
    }))
    .filter((item) => item.name && ['label', 'receipt', 'invoice'].includes(item.kind));
}

function matchesLocation(station, job) {
  if (!job) return false;
  if (station.locationId == null || station.locationId === '') return true;
  if (job.locationId == null || job.locationId === '') return true;
  return String(station.locationId) === String(job.locationId);
}

function stationHasEnabledPrinter(station, printerName, kind) {
  const name = String(printerName || '').trim().toLowerCase();
  if (!name) return false;
  const wantKind = String(kind || '').trim().toLowerCase();
  return (station.printers || []).some(
    (printer) =>
      printer.enabled &&
      String(printer.name || '').trim().toLowerCase() === name &&
      (!wantKind || printer.kind === wantKind)
  );
}

function matchesJob(station, job) {
  if (!job) return false;
  if (job.stationId && String(job.stationId) !== String(station.stationId)) return false;
  if (!matchesLocation(station, job)) return false;
  if (!job.printerName) return true;
  return stationHasEnabledPrinter(station, job.printerName, job.kind);
}

function listEnabledPrintersFromStations(stations, { kind, locationId } = {}) {
  const wantKind = kind ? String(kind).trim().toLowerCase() : '';
  const result = [];
  for (const station of stations) {
    if (!matchesLocation(station, { locationId: locationId == null ? '' : String(locationId) })) continue;
    for (const printer of station.printers || []) {
      if (!printer.enabled) continue;
      if (wantKind && printer.kind !== wantKind) continue;
      result.push({
        name: printer.name,
        kind: printer.kind,
        enabled: true,
        station_id: station.stationId,
        station_name: station.stationName || '',
        location_id: station.locationId || '',
      });
    }
  }
  return result;
}

function findEnabledPrinter(stations, { name, kind, stationId, locationId } = {}) {
  const wantName = String(name || '').trim().toLowerCase();
  if (!wantName) return null;
  const wantStation = stationId == null || stationId === '' ? '' : String(stationId);
  return (
    listEnabledPrintersFromStations(stations, { kind, locationId }).find((printer) => {
      if (printer.name.toLowerCase() !== wantName) return false;
      if (wantStation && printer.station_id !== wantStation) return false;
      return true;
    }) || null
  );
}

module.exports = {
  normalizePrinters,
  matchesLocation,
  stationHasEnabledPrinter,
  matchesJob,
  listEnabledPrintersFromStations,
  findEnabledPrinter,
};
