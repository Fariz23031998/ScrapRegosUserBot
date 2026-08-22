export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const WEEKDAY_FROM_JS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export type DayHours = {
  start: string;
  end: string;
};

export type WeekSchedule = Partial<Record<Weekday, DayHours | null>>;

export type ScheduleInspection = {
  outside: boolean;
  reason?: "day_off" | "outside_hours" | "inside";
  dayKey?: Weekday;
  dayLabel?: string;
  hours?: DayHours | null;
  finishTime?: string;
};

export const DAY_LABELS_SHORT: Record<Weekday, string> = {
  mon: "пн",
  tue: "вт",
  wed: "ср",
  thu: "чт",
  fri: "пт",
  sat: "сб",
  sun: "вс",
};

export const DAY_LABELS_RU: Record<Weekday, string> = {
  mon: "Пн",
  tue: "Вт",
  wed: "Ср",
  thu: "Чт",
  fri: "Пт",
  sat: "Сб",
  sun: "Вс",
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function parseClock(value: unknown): { hours: number; minutes: number; text: string } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(String(value || "").trim());
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]), text: `${match[1]}:${match[2]}` };
}

function minutesOf(clock: { hours: number; minutes: number }): number {
  return clock.hours * 60 + clock.minutes;
}

function sameHours(left: DayHours | null | undefined, right: DayHours | null | undefined): boolean {
  return Boolean(left && right && left.start === right.start && left.end === right.end);
}

function normalizeDayHours(value: unknown): DayHours | null {
  if (value == null || value === false || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_EMPLOYEE_SCHEDULE");
  }
  const record = value as { start?: unknown; end?: unknown };
  const start = parseClock(record.start);
  const end = parseClock(record.end);
  if (!start || !end) throw new Error("INVALID_EMPLOYEE_SCHEDULE");
  if (minutesOf(end) <= minutesOf(start)) throw new Error("INVALID_EMPLOYEE_SCHEDULE");
  return { start: start.text, end: end.text };
}

export function normalizeSchedule(input: unknown): WeekSchedule | null {
  if (input == null || input === "") return null;
  let raw: unknown = input;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "{}") return null;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      throw new Error("INVALID_EMPLOYEE_SCHEDULE");
    }
  }
  if (typeof raw !== "object" || raw == null || Array.isArray(raw)) {
    throw new Error("INVALID_EMPLOYEE_SCHEDULE");
  }
  const source = raw as Record<string, unknown>;
  const next: WeekSchedule = {};
  let hasHours = false;
  for (const day of WEEKDAYS) {
    const hours = Object.prototype.hasOwnProperty.call(source, day) ? normalizeDayHours(source[day]) : null;
    next[day] = hours;
    if (hours) hasHours = true;
  }
  return hasHours ? next : null;
}

export function parseSchedule(input: unknown): WeekSchedule | null {
  try {
    return normalizeSchedule(input);
  } catch {
    return null;
  }
}

export function serializeSchedule(input: unknown): string | null {
  const normalized = normalizeSchedule(input);
  return normalized ? JSON.stringify(normalized) : null;
}

export function hasScheduleConstraint(schedule: unknown): boolean {
  return Boolean(parseSchedule(schedule));
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatClockFromDate(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function inspectFinishAgainstSchedule(finishAt: unknown, schedule: unknown): ScheduleInspection {
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
      reason: "day_off",
      dayKey,
      dayLabel: DAY_LABELS_SHORT[dayKey],
      hours: null,
      finishTime,
    };
  }
  const finishMinutes = date.getHours() * 60 + date.getMinutes();
  const start = parseClock(hours.start);
  const end = parseClock(hours.end);
  if (!start || !end) return { outside: false };
  if (finishMinutes < minutesOf(start) || finishMinutes > minutesOf(end)) {
    return {
      outside: true,
      reason: "outside_hours",
      dayKey,
      dayLabel: DAY_LABELS_SHORT[dayKey],
      hours,
      finishTime,
    };
  }
  return {
    outside: false,
    reason: "inside",
    dayKey,
    dayLabel: DAY_LABELS_SHORT[dayKey],
    hours,
    finishTime,
  };
}

export function technicianFinishWarning(employeeName: unknown, finishAt: unknown, schedule: unknown): string | null {
  const inspection = inspectFinishAgainstSchedule(finishAt, schedule);
  if (!inspection.outside) return null;
  const name = String(employeeName || "").trim() || "сотрудника";
  if (inspection.reason === "day_off") {
    return `Ориентировочное окончание выпадает на выходной техника ${name} (${inspection.dayLabel}).`;
  }
  return `Ориентировочное окончание выходит за график техника ${name} (${inspection.dayLabel} ${inspection.hours?.start}–${inspection.hours?.end}).`;
}

export function formatScheduleSummary(schedule: unknown): string {
  const normalized = parseSchedule(schedule);
  if (!normalized) return "—";
  const parts: string[] = [];
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
  return parts.join(", ") || "—";
}

export type ScheduleEditorDay = {
  key: Weekday;
  label: string;
  enabled: boolean;
  start: string;
  end: string;
};

export function scheduleToEditorDays(schedule: WeekSchedule | null | undefined): ScheduleEditorDay[] {
  return WEEKDAYS.map((day) => {
    const hours = schedule?.[day] || null;
    return {
      key: day,
      label: DAY_LABELS_RU[day],
      enabled: Boolean(hours),
      start: hours?.start || "09:00",
      end: hours?.end || "18:00",
    };
  });
}

export function editorDaysToSchedule(days: ScheduleEditorDay[]): WeekSchedule | null {
  const next: WeekSchedule = {};
  let hasHours = false;
  for (const day of days) {
    next[day.key] = day.enabled ? { start: day.start, end: day.end } : null;
    if (day.enabled) hasHours = true;
  }
  return hasHours ? next : null;
}
