import { describe, expect, it } from "vitest";
import { buildDurationsByTicketId, summarizeByDuration } from "./ticket-summary";

describe("ticket-summary", () => {
  it("summarizes call tickets above duration threshold", () => {
    const durationSummary = {
      base: { count: 2, slaBreached: 0, rated: 1 },
      calls: [
        { id: 1, hasRecording: true, duration_seconds: 30, slaBreached: false, rated: false },
        { id: 2, hasRecording: true, duration_seconds: 120, slaBreached: true, rated: true },
      ],
    };
    const durations = buildDurationsByTicketId(durationSummary);
    const result = summarizeByDuration(durationSummary, durations, 60);
    expect(result.count).toBe(3);
    expect(result.slaBreached).toBe(1);
    expect(result.rated).toBe(2);
  });
});
