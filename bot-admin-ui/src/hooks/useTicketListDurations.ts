import { useEffect, useMemo, useRef, useState } from "react";
import type { Ticket } from "../lib/types";
import {
  getCachedRecordingDuration,
  loadRecordingDuration,
  mapWithConcurrency,
  seedRecordingDurationCache,
  shouldProbeRecordingDuration,
} from "../lib/ticket-display";

/** Keep client Audio() probes tiny — each one hits the multi‑MB WAV proxy. */
const RECORDING_DURATION_PROBE_CONCURRENCY = 2;

export function useTicketRecordingDurations(tickets: Ticket[]) {
  const [probedDurations, setProbedDurations] = useState<Record<string, number>>({});
  const ticketsRef = useRef(tickets);
  ticketsRef.current = tickets;

  const ticketsKey = useMemo(
    () => tickets.map((ticket) => ticket.id).join(","),
    [tickets],
  );

  const serverDurationsKey = useMemo(
    () =>
      tickets
        .map((ticket) => `${ticket.id}:${getCachedRecordingDuration(ticket) ?? ""}`)
        .join(","),
    [tickets],
  );

  const serverDurations = useMemo(() => {
    const map: Record<string, number> = {};
    for (const ticket of tickets) {
      const cached = getCachedRecordingDuration(ticket);
      if (cached == null) continue;
      seedRecordingDurationCache(ticket.id, cached);
      map[String(ticket.id)] = cached;
    }
    return map;
    // tickets content for durations is captured by serverDurationsKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverDurationsKey]);

  useEffect(() => {
    let cancelled = false;
    const missing = ticketsRef.current.filter(shouldProbeRecordingDuration);
    if (!missing.length) return () => undefined;

    void mapWithConcurrency(missing, RECORDING_DURATION_PROBE_CONCURRENCY, async (ticket) => {
      const duration = await loadRecordingDuration(ticket.id);
      if (cancelled || duration == null) return;
      setProbedDurations((prev) =>
        prev[String(ticket.id)] === duration ? prev : { ...prev, [String(ticket.id)]: duration },
      );
    });

    return () => {
      cancelled = true;
    };
  }, [ticketsKey]);

  return useMemo(
    () => ({ ...probedDurations, ...serverDurations }),
    [probedDurations, serverDurations],
  );
}
