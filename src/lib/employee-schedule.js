const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY_FROM_JS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS_SHORT = {
  mon: 'пн',
  tue: 'вт',
  wed: 'ср',
  thu: 'чт',
  fri: 'пт',
  sat: 'сб',
  sun: 'вс',
};
const DAY_LABELS_RU = {
  mon: 'Пн',
  tue: 'Вт',
  wed: 'Ср',
  thu: 'Чт',
  fri: 'Пт',
  sat: 'Сб',
  sun: 'Вс',
};

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseClock(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(String(value || '').trim());
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]), text: `${match[1]}:${match[2]}` };
}

function minutesOf(clock) {
  return clock.hours * 60 + clock.minutes;
}

function sameHours(left, right) {
  return Boolean(left && right && left.start === right.start && left.end === right.end);
}

function normalizeDayHours(value) {
  if (value == null || value === false || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_EMPLOYEE_SCHEDULE');
  }
  const start = parseClock(value.start);
  const end = parseClock(value.end);
  if (!start || !end) throw new Error('INVALID_EMPLOYEE_SCHEDULE');
  if (minutesOf(end) <= minutesOf(start)) throw new Error('INVALID_EMPLOYEE_SCHEDULE');
  return { start: start.text, end: end.text };
}

function normalizeSchedule(input) {
  if (input == null || input === '') return null;
  let raw = input;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '{}') return null;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      throw new Error('INVALID_EMPLOYEE_SCHEDULE');
    }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('INVALID_EMPLOYEE_SCHEDULE');
  }
  const next = {};
  let hasHours = false;
  for (const day of WEEKDAYS) {
    const hours = Object.prototype.hasOwnProperty.call(raw, day) ? normalizeDayHours(raw[day]) : null;
    next[day] = hours;
    if (hours) hasHours = true;
  }
  return hasHours ? next : null;
}

function parseSchedule(input) {
  try {
    return normalizeSchedule(input);
  } catch {
    return null;
  }
}

function serializeSchedule(input) {
  const normalized = normalizeSchedule(input);
  return normalized ? JSON.stringify(normalized) : null;
}

function hasScheduleConstraint(schedule) {
  return Boolean(parseSchedule(schedule));
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatClockFromDate(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function inspectFinishAgainstSchedule(finishAt, schedule) {
  const normalized = parseSchedule(schedule);
  if (!normalized) return { outside: false };
  const date = toDate(finishAt);
  if (!date) return { outside: false };
  const dayKey = WEEKDAY_FROM_JS[date.getDay()];
  const hours = normalized[dayKey] || null;
  const finishTime = formatClockFromDate(date);
  if (!hours) {
    return {
      outside: true,
      reason: 'day_off',
      dayKey,
      dayLabel: DAY_LABELS_SHORT[dayKey],
      hours: null,
      finishTime,
    };
  }
  const finishMinutes = date.getHours() * 60 + date.getMinutes();
  const startMinutes = minutesOf(parseClock(hours.start));
  const endMinutes = minutesOf(parseClock(hours.end));
  if (finishMinutes < startMinutes || finishMinutes > endMinutes) {
    return {
      outside: true,
      reason: 'outside_hours',
      dayKey,
      dayLabel: DAY_LABELS_SHORT[dayKey],
      hours,
      finishTime,
    };
  }
  return {
    outside: false,
    reason: 'inside',
    dayKey,
    dayLabel: DAY_LABELS_SHORT[dayKey],
    hours,
    finishTime,
  };
}

function technicianFinishWarning(employeeName, finishAt, schedule) {
  const inspection = inspectFinishAgainstSchedule(finishAt, schedule);
  if (!inspection.outside) return null;
  const name = String(employeeName || '').trim() || 'сотрудника';
  if (inspection.reason === 'day_off') {
    return `Ориентировочное окончание выпадает на выходной техника ${name} (${inspection.dayLabel}).`;
  }
  return `Ориентировочное окончание выходит за график техника ${name} (${inspection.dayLabel} ${inspection.hours.start}–${inspection.hours.end}).`;
}

function formatScheduleSummary(schedule) {
  const normalized = parseSchedule(schedule);
  if (!normalized) return '—';
  const parts = [];
  let index = 0;
  while (index < WEEKDAYS.length) {
    const hours = normalized[WEEKDAYS[index]];
    if (!hours) {
      index += 1;
      continue;
    }
    let end = index;
    while (end + 1 < WEEKDAYS.length && sameHours(normalized[WEEKDAYS[end + 1]], hours)) {
      end += 1;
    }
    const label =
      index === end
        ? DAY_LABELS_RU[WEEKDAYS[index]]
        : `${DAY_LABELS_RU[WEEKDAYS[index]]}–${DAY_LABELS_RU[WEEKDAYS[end]]}`;
    parts.push(`${label} ${hours.start}–${hours.end}`);
    index = end + 1;
  }
  return parts.join(', ') || '—';
}

module.exports = {
  WEEKDAYS,
  WEEKDAY_FROM_JS,
  DAY_LABELS_SHORT,
  DAY_LABELS_RU,
  normalizeSchedule,
  parseSchedule,
  serializeSchedule,
  hasScheduleConstraint,
  inspectFinishAgainstSchedule,
  technicianFinishWarning,
  formatScheduleSummary,
};
