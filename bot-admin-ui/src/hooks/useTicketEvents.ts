import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ticketEventsUrl } from "../api/tickets";

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

    source.addEventListener("ticket", refresh);
    source.addEventListener("heartbeat", () => {});

    return () => {
      if (debounce) clearTimeout(debounce);
      source.close();
    };
  }, [enabled, queryClient]);
}
