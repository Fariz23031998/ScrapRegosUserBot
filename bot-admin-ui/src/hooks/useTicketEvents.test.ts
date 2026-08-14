import { describe, expect, it } from "vitest";
import { isTicketListRefreshEvent } from "./useTicketEvents";

describe("isTicketListRefreshEvent", () => {
  it("refreshes the tickets list on ticket_changed SSE payloads", () => {
    expect(isTicketListRefreshEvent({ type: "ticket_changed" })).toBe(true);
  });

  it("ignores heartbeats and chat frames", () => {
    expect(isTicketListRefreshEvent({ type: "heartbeat" })).toBe(false);
    expect(isTicketListRefreshEvent({ type: "chat_changed" })).toBe(false);
    expect(isTicketListRefreshEvent({ type: "ticket" })).toBe(false);
    expect(isTicketListRefreshEvent(null)).toBe(false);
  });
});
