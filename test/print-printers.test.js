const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePrinters,
  matchesJob,
  listEnabledPrintersFromStations,
  findEnabledPrinter,
} = require('../src/print/print-station-match');

function station(overrides = {}) {
  return {
    stationId: 'station-1',
    stationName: 'Warehouse PC',
    locationId: '12',
    printers: [
      { name: 'Warehouse labels', kind: 'label', enabled: true },
      { name: 'Office invoice', kind: 'invoice', enabled: false },
    ],
    ...overrides,
  };
}

describe('named print station matching', () => {
  it('keeps only named printers with a valid kind', () => {
    const printers = normalizePrinters([
      { name: 'Warehouse labels', kind: 'label', enabled: true },
      { name: '  ', kind: 'label' },
      { name: 'Bad', kind: 'other' },
      { name: 'Front desk', kind: 'RECEIPT' },
    ]);
    assert.deepEqual(
      printers.map((item) => ({ name: item.name, kind: item.kind, enabled: item.enabled })),
      [
        { name: 'Warehouse labels', kind: 'label', enabled: true },
        { name: 'Front desk', kind: 'receipt', enabled: true },
      ]
    );
  });

  it('delivers only to a station with that enabled printer', () => {
    const online = station();
    const job = {
      printerName: 'Warehouse labels',
      kind: 'label',
      locationId: '12',
    };
    assert.equal(matchesJob(online, job), true);
    assert.equal(matchesJob(station({ printers: [{ name: 'Warehouse labels', kind: 'label', enabled: false }] }), job), false);
    assert.equal(matchesJob(station({ printers: [{ name: 'Other', kind: 'label', enabled: true }] }), job), false);
    assert.equal(matchesJob(online, { ...job, kind: 'receipt' }), false);
    assert.equal(matchesJob(online, { ...job, stationId: 'station-2' }), false);
    assert.equal(matchesJob(online, { ...job, stationId: 'station-1' }), true);
  });

  it('lists enabled printers and can pin a station', () => {
    const stations = [
      station(),
      station({
        stationId: 'station-2',
        stationName: 'Front PC',
        locationId: '12',
        printers: [{ name: 'Warehouse labels', kind: 'label', enabled: true }],
      }),
    ];
    const listed = listEnabledPrintersFromStations(stations, { kind: 'label', locationId: 12 });
    assert.equal(listed.length, 2);
    assert.equal(
      findEnabledPrinter(stations, { name: 'Warehouse labels', kind: 'label', stationId: 'station-2' }).station_id,
      'station-2'
    );
    assert.equal(findEnabledPrinter(stations, { name: 'Office invoice', kind: 'invoice' }), null);
  });
});
