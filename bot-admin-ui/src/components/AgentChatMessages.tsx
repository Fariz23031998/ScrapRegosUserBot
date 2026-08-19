import type { ReactNode } from "react";
import type { AgentChatFile, AgentTestRun } from "../lib/types";
import AgentChatFiles from "./AgentChatFiles";

export type AgentChatMessageItem = {
  id: number | string;
  role: "user" | "assistant";
  content: string;
  files?: AgentChatFile[] | null;
  streaming?: boolean;
  run?: AgentTestRun | null;
};

export type AgentChatSide = "staff" | "bot" | "client";

type AgentChatMessagesProps = {
  messages: AgentChatMessageItem[];
  userSide?: AgentChatSide;
  agentSide?: AgentChatSide;
  renderAfter?: (item: AgentChatMessageItem) => ReactNode;
};

export default function AgentChatMessages({
  messages,
  userSide = "staff",
  agentSide = "bot",
  renderAfter,
}: AgentChatMessagesProps) {
  return (
    <>
      {messages.map((item) => {
        const isUser = item.role === "user";
        const side = isUser ? userSide : agentSide;
        const showText = Boolean(item.content.trim()) || Boolean(item.streaming);
        const bubble = (
          <div
            key={item.id}
            className={`ticket-chat__msg ticket-chat__msg--${side} agent-chat-thread__msg agent-chat-thread__msg--${isUser ? "user" : "agent"}`}
          >
            <div className="ticket-chat__bubble">
              {showText ? (
                <p className={`ticket-chat__text${item.streaming ? " ticket-chat__text--streaming" : ""}`}>
                  {item.content}
                </p>
              ) : null}
              <AgentChatFiles files={item.files} />
            </div>
          </div>
        );
        const after = renderAfter?.(item);
        if (!after) return bubble;
        return (
          <div key={item.id} className="test-agents-turn">
            {bubble}
            {after}
          </div>
        );
      })}
    </>
  );
}
