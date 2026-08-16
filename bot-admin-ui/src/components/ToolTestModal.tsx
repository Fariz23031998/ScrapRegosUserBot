import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { testAiTool } from "../api/ai";
import type { AiToolSchema, AiToolTestResult } from "../lib/types";
import Modal from "./Modal";

const SIDE_EFFECT_TOOLS = new Set([
  "notify_employee",
  "send_group_topic_message",
  "assign_responsible",
  "close_ticket",
  "delete_article",
  "create_article",
  "update_article",
  "create_category",
  "update_category",
  "delete_category",
  "reply_to_customer",
]);

type ToolTestModalProps = {
  open: boolean;
  tool: AiToolSchema | null;
  onClose: () => void;
};

function formatResult(data: AiToolTestResult) {
  if (data.result !== undefined) {
    return JSON.stringify(data.result, null, 2);
  }
  return JSON.stringify(data, null, 2);
}

export default function ToolTestModal({ open, tool, onClose }: ToolTestModalProps) {
  const [ticketId, setTicketId] = useState("");
  const [argsText, setArgsText] = useState("{}");
  const [parseError, setParseError] = useState("");
  const [result, setResult] = useState<{ text: string; type: "success" | "error"; body?: string } | null>(
    null,
  );

  useEffect(() => {
    if (!open || !tool) return;
    setTicketId("");
    setArgsText("{}");
    setParseError("");
    setResult(null);
  }, [open, tool?.name]);

  const runMutation = useMutation({
    mutationFn: (args: Record<string, unknown>) =>
      testAiTool({
        tool_name: tool!.name,
        arguments: args,
        ticket_id: tool?.requires_ticket || ticketId.trim() ? ticketId.trim() || null : null,
      }),
    onSuccess: (data) => {
      if (!data.ok) {
        setResult({
          text: data.message || data.error || "Ошибка выполнения.",
          type: "error",
          body: formatResult(data),
        });
        return;
      }
      const timing = data.duration_ms != null ? ` (${data.duration_ms} мс)` : "";
      setResult({
        text: `Выполнено${timing}.`,
        type: "success",
        body: formatResult(data),
      });
    },
    onError: (error: Error) => setResult({ text: error.message, type: "error" }),
  });

  if (!tool) return null;

  const hasSideEffects = SIDE_EFFECT_TOOLS.has(tool.name);
  const parametersJson = JSON.stringify(tool.parameters || { type: "object", properties: {} }, null, 2);

  return (
    <Modal title={`Проверка: ${tool.title || tool.name}`} open={open} onClose={onClose} size="wide">
      <form
        className="stack-form tool-test-modal"
        onSubmit={(event) => {
          event.preventDefault();
          setParseError("");
          setResult(null);
          let args: Record<string, unknown>;
          try {
            const parsed = JSON.parse(argsText || "{}") as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              setParseError("Аргументы должны быть JSON-объектом.");
              return;
            }
            args = parsed as Record<string, unknown>;
          } catch {
            setParseError("Некорректный JSON в аргументах.");
            return;
          }
          if (tool.requires_ticket && !ticketId.trim()) {
            setParseError("Укажите ID обращения.");
            return;
          }
          runMutation.mutate(args);
        }}
      >
        <p className="muted-copy">{tool.description}</p>
        <p className="muted-copy">
          Имя: <code>{tool.name}</code>
        </p>
        {hasSideEffects ? (
          <p className="message warn">
            Этот инструмент может менять данные или отправлять сообщения. Запуск выполнит реальное действие.
          </p>
        ) : null}
        <label>
          Схема параметров
          <pre className="tool-test-modal__schema">{parametersJson}</pre>
        </label>
        <label>
          ID обращения{tool.requires_ticket ? "" : " (необязательно)"}
          <input
            type="text"
            inputMode="numeric"
            value={ticketId}
            disabled={runMutation.isPending}
            onChange={(event) => setTicketId(event.target.value)}
            placeholder={tool.requires_ticket ? "Обязательно" : "Если нужен контекст тикета"}
          />
        </label>
        <label>
          Аргументы (JSON)
          <textarea
            rows={8}
            value={argsText}
            disabled={runMutation.isPending}
            onChange={(event) => setArgsText(event.target.value)}
            spellCheck={false}
          />
        </label>
        {parseError ? <p className="message error">{parseError}</p> : null}
        {result ? (
          <div className="tool-test-modal__result">
            <p className={`message ${result.type}`}>{result.text}</p>
            {result.body ? <pre className="tool-test-modal__output">{result.body}</pre> : null}
          </div>
        ) : null}
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={runMutation.isPending}>
            Закрыть
          </button>
          <button type="submit" className="btn-primary" disabled={runMutation.isPending}>
            {runMutation.isPending ? "Выполнение…" : "Запустить"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
