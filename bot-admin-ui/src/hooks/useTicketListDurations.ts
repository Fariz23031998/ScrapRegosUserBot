import { useEffect, useMemo, useState } from "react";
import type { Ticket } from "../lib/types";
import { buildDurationsByTicketId, hasPendingCallDurations, summarizeByDuration } from "../lib/ticket-summary";
import type { DurationSummary } from "../lib/ticket-display";
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

export function useDurationAwareSummary(
  durationSummary: DurationSummary | null | undefined,
  thresholdRaw: string,
  fallbackSummary: { count: number; slaBreached: number; rated: number },
) {
  const [summary, setSummary] = useState(fallbackSummary);
  const [calculating, setCalculating] = useState(false);

  useEffect(() => {
    if (!durationSummary) {
      setSummary(fallbackSummary);
      setCalculating(false);
      return;
    }

    const threshold = Number(thresholdRaw);
    const initialDurations = buildDurationsByTicketId(durationSummary);
    if (!hasPendingCallDurations(durationSummary)) {
      setSummary(summarizeByDuration(durationSummary, initialDurations, threshold));
      setCalculating(false);
      return;
    }

    let cancelled = false;
    setCalculating(true);
    setSummary(
      summarizeByDuration(durationSummary, initialDurations, threshold),
    );

    void (async () => {
      const durationsByTicketId = { ...initialDurations };
      const calls = Array.isArray(durationSummary.calls)
        ? durationSummary.calls.filter((call: NonNullable<DurationSummary["calls"]>[number]) => call.hasRecording)
        : [];
      const missing = calls.filter((call: NonNullable<DurationSummary["calls"]>[number]) => {
        const cached = Number(durationsByTicketId[String(call.id)]);
        return !(Number.isFinite(cached) && cached > 0);
      });

      await Promise.all(
        missing.map(async (call: NonNullable<DurationSummary["calls"]>[number]) => {
          const duration = await loadRecordingDuration(Number(call.id));
          if (duration != null) {
            durationsByTicketId[String(call.id)] = duration;
          }
        }),
      );

      if (cancelled) return;
      setSummary(summarizeByDuration(durationSummary, durationsByTicketId, threshold));
      setCalculating(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [durationSummary, thresholdRaw, fallbackSummary.count, fallbackSummary.slaBreached, fallbackSummary.rated]);

  return { summary, calculating };
}
