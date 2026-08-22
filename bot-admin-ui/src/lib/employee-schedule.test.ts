import { describe, expect, it } from "vitest";
import {
  formatScheduleSummary,
  inspectFinishAgainstSchedule,
  normalizeSchedule,
  technicianFinishWarning,
} from "./employee-schedule";

const WEEKDAY_HOURS = {
  mon: { start: "09:00", end: "18:00" },
  tue: { start: "09:00", end: "18:00" },
  wed: { start: "09:00", end: "18:00" },
  thu: { start: "09:00", end: "18:00" },
  fri: { start: "09:00", end: "18:00" },
  sat: null,
  sun: null,
};

function atLocal(year: number, month: number, day: number, hour: number, minute: number) {
  return new Date(year, month - 1, day, hour, minute, 0);
}

describe("employee schedule helper", () => {
  it("treats empty schedule as no constraint", () => {
    expect(inspectFinishAgainstSchedule(atLocal(2026, 8, 24, 22, 0), null).outside).toBe(false);
  });

  it("rejects overnight hours", () => {
    expect(() => normalizeSchedule({ mon: { start: "18:00", end: "09:00" } })).toThrow(
      "INVALID_EMPLOYEE_SCHEDULE",
    );
  });

  it("flags finish outside hours and on a day off", () => {
    expect(inspectFinishAgainstSchedule(atLocal(2026, 8, 24, 18, 1), WEEKDAY_HOURS).reason).toBe(
      "outside_hours",
    );
    expect(inspectFinishAgainstSchedule(atLocal(2026, 8, 23, 12, 0), WEEKDAY_HOURS).reason).toBe("day_off");
    expect(inspectFinishAgainstSchedule(atLocal(2026, 8, 24, 18, 0), WEEKDAY_HOURS).outside).toBe(false);
  });

  it("formats a technician warning and schedule summary", () => {
    expect(technicianFinishWarning("Иванов", atLocal(2026, 8, 24, 19, 0), WEEKDAY_HOURS)).toMatch(
      /пн 09:00–18:00/,
    );
    expect(formatScheduleSummary(WEEKDAY_HOURS)).toBe("Пн–Пт 09:00–18:00");
  });
});
