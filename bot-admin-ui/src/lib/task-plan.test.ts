import { describe, expect, it } from "vitest";
import {
  addMinutesToDatetimeLocal,
  datetimeLocalDiffMinutes,
  formatDurationParts,
  parseDurationMinutes,
  sanitizeDurationHours,
  sanitizeDurationMinutes,
  toDatetimeLocalMinutes,
} from "./task-plan";

describe("task plan duration", () => {
  it("stores datetime-local values without seconds", () => {
    const local = toDatetimeLocalMinutes(new Date(2026, 7, 24, 9, 30, 45));
    expect(local).toBe("2026-08-24T09:30");
  });

  it("adds duration to start and keeps the reverse diff in sync", () => {
    const finish = addMinutesToDatetimeLocal("2026-08-24T09:00", 150);
    expect(finish).toBe("2026-08-24T11:30");
    expect(datetimeLocalDiffMinutes("2026-08-24T09:00", finish)).toBe(150);
    expect(addMinutesToDatetimeLocal("2026-08-24T23:00", 120)).toBe("2026-08-25T01:00");
  });

  it("parses and formats hours and minutes", () => {
    expect(parseDurationMinutes("", "")).toBeNull();
    expect(parseDurationMinutes("2", "30")).toBe(150);
    expect(parseDurationMinutes("", "45")).toBe(45);
    expect(formatDurationParts(150)).toEqual({ hours: "2", minutes: "30" });
    expect(formatDurationParts(-10)).toEqual({ hours: "", minutes: "" });
  });

  it("clamps duration inputs", () => {
    expect(sanitizeDurationHours("")).toBe("");
    expect(sanitizeDurationHours("2")).toBe("2");
    expect(sanitizeDurationHours("1200")).toBe("999");
    expect(sanitizeDurationMinutes("90")).toBe("59");
    expect(sanitizeDurationMinutes("-1")).toBe("");
  });
});
