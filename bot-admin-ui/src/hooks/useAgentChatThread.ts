import { useCallback, useMemo, useState } from "react";
import type { ChatComposeUpload } from "../components/ChatCompose";
import type { AgentChatMessageItem } from "../components/AgentChatMessages";
import { makePendingUserMessage, makeStreamingAssistantMessage } from "../lib/agent-chat";

export function useAgentChatThread(serverMessages: AgentChatMessageItem[]) {
  const [pendingUser, setPendingUser] = useState<AgentChatMessageItem | null>(null);
  const [streamingAssistant, setStreamingAssistant] = useState<AgentChatMessageItem | null>(null);

  const messages = useMemo(() => {
    const list = [...serverMessages];
    if (pendingUser) list.push(pendingUser);
    if (streamingAssistant) list.push(streamingAssistant);
    return list;
  }, [serverMessages, pendingUser, streamingAssistant]);

  const beginUserTurn = useCallback(
    (text: string, files: ChatComposeUpload[], { stream = false } = {}) => {
      setPendingUser(makePendingUserMessage(text, files));
      setStreamingAssistant(stream ? makeStreamingAssistantMessage() : null);
    },
    [],
  );

  const appendDelta = useCallback((text: string) => {
    const chunk = String(text || "");
    if (!chunk) return;
    setStreamingAssistant((prev) => makeStreamingAssistantMessage(`${prev?.content || ""}${chunk}`));
  }, []);

  const finishTurn = useCallback(() => {
    setPendingUser(null);
    setStreamingAssistant(null);
  }, []);

  const failTurn = useCallback(() => {
    setStreamingAssistant(null);
  }, []);

  return {
    messages,
    pendingUser,
    streamingAssistant,
    beginUserTurn,
    appendDelta,
    finishTurn,
    failTurn,
  };
}

