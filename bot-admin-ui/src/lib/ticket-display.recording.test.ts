import { describe, expect, it } from "vitest";
import { shouldProbeRecordingDuration } from "./ticket-display";
import type { Ticket } from "./types";

function ticket(partial: Partial<Ticket> & Pick<Ticket, "id">): Ticket {
  return partial as Ticket;
}

describe("shouldProbeRecordingDuration", () => {
  it("does not probe when server already attached local.recording", () => {
    expect(
      shouldProbeRecordingDuration(
        ticket({
          id: 1,
          local: {
            recording: {
              url: "http://rofeev.7x.uz/recordings/a.wav",
              duration_seconds: null,
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("does not probe when duration is already known", () => {
    expect(
      shouldProbeRecordingDuration(
        ticket({
          id: 2,
          local: {
            recording: {
              url: "http://rofeev.7x.uz/recordings/a.wav",
              duration_seconds: 12.5,
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("probes only when a field URL exists without local.recording", () => {
    expect(
      shouldProbeRecordingDuration(
        ticket({
          id: 3,
          fields: [
            {
              key: "field_recording_link",
              value: "http://rofeev.7x.uz/recordings/a.wav",
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("does not probe when there is no recording URL", () => {
    expect(shouldProbeRecordingDuration(ticket({ id: 4 }))).toBe(false);
  });
});
