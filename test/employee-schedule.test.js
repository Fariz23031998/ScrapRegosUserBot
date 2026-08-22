const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSchedule,
  parseSchedule,
  serializeSchedule,
  inspectFinishAgainstSchedule,
  technicianFinishWarning,
  formatScheduleSummary,
} = require('../src/lib/employee-schedule');

const WEEKDAY_HOURS = {
  mon: { start: '09:00', end: '18:00' },
  tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' },
  thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' },
  sat: null,
  sun: null,
};

function atLocal(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute, 0);
}

describe('employee schedule helper', () => {
  it('treats empty schedule as no constraint', () => {
    assert.equal(parseSchedule(null), null);
    assert.equal(parseSchedule({}), null);
    assert.equal(parseSchedule('{}'), null);
    assert.equal(inspectFinishAgainstSchedule(atLocal(2026, 8, 24, 22, 0), null).outside, false);
    assert.equal(inspectFinishAgainstSchedule(atLocal(2026, 8, 24, 22, 0), {}).outside, false);
  });

  it('rejects overnight and inverted day hours', () => {
    assert.throws(
      () => normalizeSchedule({ mon: { start: '18:00', end: '09:00' } }),
      /INVALID_EMPLOYEE_SCHEDULE/
    );
    assert.throws(
      () => normalizeSchedule({ mon: { start: '09:00', end: '09:00' } }),
      /INVALID_EMPLOYEE_SCHEDULE/
    );
    assert.throws(
      () => normalizeSchedule({ mon: { start: '9:00', end: '18:00' } }),
      /INVALID_EMPLOYEE_SCHEDULE/
    );
  });

  it('accepts time values with seconds and stores HH:MM', () => {
    const normalized = normalizeSchedule({ mon: { start: '09:00:00', end: '18:00:30' } });
    assert.equal(normalized.mon.start, '09:00');
    assert.equal(normalized.mon.end, '18:00');
  });

  it('serializes working days and drops empty weeks', () => {
    const stored = serializeSchedule({ mon: { start: '09:00', end: '18:00' } });
    assert.equal(JSON.parse(stored).mon.start, '09:00');
    assert.equal(JSON.parse(stored).sun, null);
    assert.equal(serializeSchedule({ mon: null, tue: null }), null);
  });

  it('allows finish inside weekday hours, including the end minute', () => {
    const mondayMorning = atLocal(2026, 8, 24, 9, 0);
    const mondayEnd = atLocal(2026, 8, 24, 18, 0);
    const mondayNoon = atLocal(2026, 8, 24, 12, 30);
    assert.equal(inspectFinishAgainstSchedule(mondayMorning, WEEKDAY_HOURS).outside, false);
    assert.equal(inspectFinishAgainstSchedule(mondayEnd, WEEKDAY_HOURS).outside, false);
    assert.equal(inspectFinishAgainstSchedule(mondayNoon, WEEKDAY_HOURS).outside, false);
  });

  it('flags finish before start and after end', () => {
    const before = inspectFinishAgainstSchedule(atLocal(2026, 8, 24, 8, 59), WEEKDAY_HOURS);
    const after = inspectFinishAgainstSchedule(atLocal(2026, 8, 24, 18, 1), WEEKDAY_HOURS);
    assert.equal(before.outside, true);
    assert.equal(before.reason, 'outside_hours');
    assert.equal(after.outside, true);
    assert.equal(after.reason, 'outside_hours');
  });

  it('flags finish on a day off', () => {
    const sunday = inspectFinishAgainstSchedule(atLocal(2026, 8, 23, 12, 0), WEEKDAY_HOURS);
    assert.equal(sunday.outside, true);
    assert.equal(sunday.reason, 'day_off');
    assert.equal(sunday.dayKey, 'sun');
  });

  it('builds technician warning text', () => {
    const outside = technicianFinishWarning('Иванов', atLocal(2026, 8, 24, 19, 0), WEEKDAY_HOURS);
    assert.match(outside, /Иванов/);
    assert.match(outside, /пн 09:00–18:00/);
    const dayOff = technicianFinishWarning('Иванов', atLocal(2026, 8, 23, 12, 0), WEEKDAY_HOURS);
    assert.match(dayOff, /выходной/);
    assert.equal(technicianFinishWarning('Иванов', atLocal(2026, 8, 24, 12, 0), WEEKDAY_HOURS), null);
    assert.equal(technicianFinishWarning('Иванов', atLocal(2026, 8, 24, 19, 0), null), null);
  });

  it('summarizes consecutive days with the same hours', () => {
    assert.equal(formatScheduleSummary(WEEKDAY_HOURS), 'Пн–Пт 09:00–18:00');
    assert.equal(
      formatScheduleSummary({
        ...WEEKDAY_HOURS,
        sat: { start: '10:00', end: '15:00' },
      }),
      'Пн–Пт 09:00–18:00, Сб 10:00–15:00'
    );
    assert.equal(formatScheduleSummary(null), '—');
  });
});
