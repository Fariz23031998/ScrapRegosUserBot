import { describe, expect, it } from "vitest";
import { isReportStatusEvent } from "./useReportEvents";

describe("isReportStatusEvent", () => {
  it("accepts ready and failed report events", () => {
    expect(isReportStatusEvent({ type: "report_ready" })).toBe(true);
    expect(isReportStatusEvent({ type: "report_failed" })).toBe(true);
  });

  it("ignores heartbeats and unrelated frames", () => {
    expect(isReportStatusEvent({ type: "heartbeat" })).toBe(false);
    expect(isReportStatusEvent({ type: "ticket_changed" })).toBe(false);
    expect(isReportStatusEvent(null)).toBe(false);
  });
});
