import type { AgentRunUsage, AgentTraceStep, AgentTraceToolCall } from "../lib/types";

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolRoundTitle(calls: AgentTraceToolCall[]) {
  const names = calls.map((call) => call.name).filter(Boolean);
  if (!names.length) return "Вызов инструментов";
  return names.join(", ");
}

function usageSummary(usage?: AgentRunUsage | null) {
  if (!usage) return null;
  const parts = [
    usage.prompt_tokens != null ? `prompt ${usage.prompt_tokens}` : null,
    usage.completion_tokens != null ? `completion ${usage.completion_tokens}` : null,
    usage.total_tokens != null ? `total ${usage.total_tokens}` : null,
    usage.cached_tokens != null ? `cached ${usage.cached_tokens}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export type AgentRunTraceProps = {
  trace?: AgentTraceStep[] | null;
  steps?: number | null;
  usage?: AgentRunUsage | null;
  stopped?: string | null;
  defaultOpen?: boolean;
};

export default function AgentRunTrace({
  trace,
  steps,
  usage,
  stopped,
  defaultOpen = false,
}: AgentRunTraceProps) {
  const items = Array.isArray(trace) ? trace : [];
  if (!items.length && steps == null && !usage && !stopped) return null;

  const tokens = usageSummary(usage);
  const summaryParts = [
    steps != null ? `${steps} шаг.` : null,
    tokens,
    stopped === "max_steps" ? "остановлено: max_steps" : stopped ? `остановлено: ${stopped}` : null,
  ].filter(Boolean);

  return (
    <details className="agent-run-trace" open={defaultOpen}>
      <summary className="agent-run-trace__summary">
        <span className="agent-run-trace__title">Ход выполнения</span>
        {summaryParts.length ? <span className="agent-run-trace__meta">{summaryParts.join(" · ")}</span> : null}
      </summary>
      <div className="agent-run-trace__body">
        {items.map((item, index) => {
          if (item.type === "tool_round") {
            const calls = item.tool_calls || [];
            const failed = calls.some((call) => !call.ok);
            return (
              <details key={`tool-${item.step}-${index}`} className="agent-run-trace__step">
                <summary>
                  <span className="agent-run-trace__step-index">Шаг {item.step}</span>
                  <span className="agent-run-trace__step-label">{toolRoundTitle(calls)}</span>
                  <span className={`badge${failed ? " badge--warn" : " badge--ok"}`}>
                    {failed ? "ошибка" : "ok"}
                  </span>
                </summary>
                {item.assistant_content ? (
                  <p className="agent-run-trace__note">{item.assistant_content}</p>
                ) : null}
                <div className="agent-run-trace__calls">
                  {calls.map((call, callIndex) => (
                    <details
                      key={call.id || `${call.name}-${callIndex}`}
                      className={`agent-run-trace__call${call.ok ? "" : " agent-run-trace__call--error"}`}
                    >
                      <summary>
                        <span className="agent-run-trace__tool">{call.name}</span>
                        <span className={`badge${call.ok ? " badge--ok" : " badge--warn"}`}>
                          {call.ok ? "ok" : "ошибка"}
                        </span>
                      </summary>
                      {call.error ? <p className="message error">{call.error}</p> : null}
                      <div className="agent-run-trace__block">
                        <strong>Аргументы</strong>
                        <pre>{formatJson(call.arguments ?? {})}</pre>
                      </div>
                      <div className="agent-run-trace__block">
                        <strong>Результат</strong>
                        <pre>{formatJson(call.result)}</pre>
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            );
          }

          return (
            <details key={`final-${item.step}-${index}`} className="agent-run-trace__step agent-run-trace__step--final">
              <summary>
                <span className="agent-run-trace__step-index">Шаг {item.step}</span>
                <span className="agent-run-trace__step-label">финальный ответ</span>
                {item.stopped ? <span className="badge badge--muted">{item.stopped}</span> : null}
              </summary>
              <pre className="agent-run-trace__final">{item.content || "—"}</pre>
            </details>
          );
        })}
      </div>
    </details>
  );
}
