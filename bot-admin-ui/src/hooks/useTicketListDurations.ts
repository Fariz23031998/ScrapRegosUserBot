import { useEffect, useMemo, useState } from "react";
import type { Ticket } from "../lib/types";
import {
  getCachedRecordingDuration,
  getRecordingUrl,
  loadRecordingDuration,
  seedRecordingDurationCache,
} from "../lib/ticket-display";

export function useTicketRecordingDurations(tickets: Ticket[]) {
  const [durations, setDurations] = useState<Record<string, number>>({});

  const ticketsKey = useMemo(
    () => tickets.map((ticket) => ticket.id).join(","),
    [tickets],
  );

  useEffect(() => {
    let cancelled = false;

    for (const ticket of tickets) {
      const cached = getCachedRecordingDuration(ticket);
      if (cached != null) {
        seedRecordingDurationCache(ticket.id, cached);
        setDurations((prev) =>
          prev[String(ticket.id)] === cached ? prev : { ...prev, [String(ticket.id)]: cached },
        );
      }
    }

    const missing = tickets.filter((ticket) => getRecordingUrl(ticket) && getCachedRecordingDuration(ticket) == null);
    if (!missing.length) return () => undefined;

    void Promise.all(
      missing.map(async (ticket) => {
        const duration = await loadRecordingDuration(ticket.id);
        if (cancelled || duration == null) return;
        setDurations((prev) => ({ ...prev, [String(ticket.id)]: duration }));
      }),
    );

    return () => {
      cancelled = true;
    };
  }, [ticketsKey, tickets]);

  return durations;
}
