import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ticketEventsUrl } from "../api/tickets";

export function isTicketListRefreshEvent(event: { type?: string } | null | undefined): boolean {
  return event?.type === "ticket_changed";
}

export function useTicketEvents(enabled: boolean) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(ticketEventsUrl(), { withCredentials: true });
    let debounce: ReturnType<typeof setTimeout> | null = null;

    function refresh() {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      }, 400);
    }

    function onFrame(messageEvent: MessageEvent) {
      let event: { type?: string };
      try {
        event = JSON.parse(String(messageEvent.data || "")) as { type?: string };
      } catch {
        return;
      }
      if (isTicketListRefreshEvent(event)) refresh();
    }

    // Server writes unnamed SSE frames (`data: {...type:"ticket_changed"}`),
    // which EventSource delivers as the default `message` event.
    source.onmessage = onFrame;
    source.addEventListener("ticket_changed", onFrame);

    return () => {
      if (debounce) clearTimeout(debounce);
      source.close();
    };
  }, [enabled, queryClient]);
}
