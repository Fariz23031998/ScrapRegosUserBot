import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { AgentPromptPreview, TicketAiPromptMessage } from "../lib/types";
import LoadingState from "./LoadingState";
import Modal from "./Modal";

function formatPromptContent(content: TicketAiPromptMessage["content"]) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part?.type === "text") return String(part.text || "");
      if (part?.type === "image_url") {
        const name = part.image_url?.name || part.image_url?.file_id || "изображение";
        return `[изображение: ${name}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

type AgentPromptModalProps = {
  open: boolean;
  onClose: () => void;
  queryKey: unknown[];
  queryFn: () => Promise<AgentPromptPreview>;
};

export default function AgentPromptModal({ open, onClose, queryKey, queryFn }: AgentPromptModalProps) {
  const [copied, setCopied] = useState(false);
  const query = useQuery({
    queryKey,
    queryFn,
    enabled: open,
    retry: false,
  });
  const prompt = query.data;

  async function handleCopy() {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            system: prompt.system,
            messages: prompt.messages,
            tools: prompt.tools,
            settings: prompt.settings,
          },
          null,
          2,
        ),
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Modal open={open} title="Промпт ИИ" size="wide" onClose={onClose}>
      <div className="ticket-ai-prompt">
        <div className="ticket-ai-prompt__actions">
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            {query.isFetching ? "Загрузка…" : "Обновить"}
          </button>
          {prompt ? (
            <button type="button" className="btn-secondary btn-sm" onClick={() => void handleCopy()}>
              {copied ? "Скопировано" : "Копировать JSON"}
            </button>
          ) : null}
        </div>
        {query.isLoading ? <LoadingState /> : null}
        {query.isError ? (
          <p className="message error">
            {query.error instanceof Error ? query.error.message : "Не удалось загрузить промпт ИИ."}
          </p>
        ) : null}
        {prompt ? (
          <>
            <dl className="ticket-detail">
              <div className="ticket-detail__row">
                <dt>Модель</dt>
                <dd>{[prompt.settings?.provider, prompt.settings?.model].filter(Boolean).join(" · ") || "—"}</dd>
              </div>
              {prompt.settings?.history_limit != null ? (
                <div className="ticket-detail__row">
                  <dt>Сообщений</dt>
                  <dd>{prompt.settings.history_limit}</dd>
                </div>
              ) : null}
            </dl>
            <div className="ticket-ai-prompt__block">
              <h5>Системный промпт</h5>
              <pre className="ticket-ai-prompt__pre">{prompt.system || "—"}</pre>
            </div>
            <div className="ticket-ai-prompt__block">
              <h5>Сообщения</h5>
              {prompt.messages.length ? (
                <div className="ticket-ai-prompt__turns">
                  {prompt.messages.map((message, index) => (
                    <article key={`${message.role}-${index}`} className="ticket-ai-prompt__turn">
                      <span className="ticket-ai-prompt__role">{message.role}</span>
                      <pre className="ticket-ai-prompt__pre">{formatPromptContent(message.content) || "—"}</pre>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="muted-copy">Нет сообщений для модели.</p>
              )}
            </div>
            <div className="ticket-ai-prompt__block">
              <h5>Инструменты</h5>
              {prompt.tools.length ? (
                <ul className="ticket-ai-prompt__tools">
                  {prompt.tools.map((tool) => (
                    <li key={tool.name}>
                      <strong>{tool.name}</strong>
                      {tool.description ? <span> — {tool.description}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted-copy">Инструменты недоступны.</p>
              )}
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
