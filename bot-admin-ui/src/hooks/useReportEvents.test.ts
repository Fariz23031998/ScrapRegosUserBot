import { describe, expect, it } from "vitest";
import { reportJobPath, reportsListPath } from "../api/reports";
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

describe("report paths", () => {
  it("builds a dedicated report URL", () => {
    expect(reportJobPath(15)).toBe("/reports/15");
  });

  it("builds a tab list URL", () => {
    expect(reportsListPath()).toBe("/reports");
    expect(reportsListPath("finance")).toBe("/reports?tab=finance");
  });
});
