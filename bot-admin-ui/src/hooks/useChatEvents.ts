import { useEffect, useRef } from "react";
import { ticketEventsUrl } from "../api/tickets";

export type ChatStreamEvent = {
  type: string;
  chat_id?: string | null;
  message_id?: string | null;
  source_action?: string | null;
  author_entity_id?: number | string | null;
  author_entity_type?: string | null;
  occurred_at?: string | null;
};

type UseChatEventsOptions = {
  enabled: boolean;
  chatId: string | null;
  onChatChanged: (event: ChatStreamEvent) => void;
  onChatWriting: (event: ChatStreamEvent) => void;
};

export function useChatEvents({
  enabled,
  chatId,
  onChatChanged,
  onChatWriting,
}: UseChatEventsOptions) {
  const onChatChangedRef = useRef(onChatChanged);
  const onChatWritingRef = useRef(onChatWriting);
  const chatIdRef = useRef(chatId);
  onChatChangedRef.current = onChatChanged;
  onChatWritingRef.current = onChatWriting;
  chatIdRef.current = chatId;

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(ticketEventsUrl(), { withCredentials: true });

    source.onmessage = (messageEvent) => {
      let event: ChatStreamEvent;
      try {
        event = JSON.parse(messageEvent.data) as ChatStreamEvent;
      } catch {
        return;
      }
      if (!event || typeof event !== "object") return;
      const expectedChatId = String(chatIdRef.current || "");
      if (!expectedChatId || String(event.chat_id || "") !== expectedChatId) return;

      if (event.type === "chat_changed") {
        onChatChangedRef.current(event);
        return;
      }
      if (event.type === "chat_writing") {
        onChatWritingRef.current(event);
      }
    };

    return () => {
      source.close();
    };
  }, [enabled]);
}
