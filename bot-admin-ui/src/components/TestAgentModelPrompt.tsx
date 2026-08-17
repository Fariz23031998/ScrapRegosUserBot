import type { AgentTestPrompt, AgentTestPromptMessage } from "../lib/types";

function formatPromptContent(content: AgentTestPromptMessage["content"]) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part?.type === "text") return String(part.text || "");
      if (part?.type === "image_url") {
        const name = part.image_url?.name || "изображение";
        return `[изображение: ${name}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

type TestAgentModelPromptProps = {
  prompt?: AgentTestPrompt | null;
  title?: string;
  defaultOpen?: boolean;
};

export default function TestAgentModelPrompt({
  prompt,
  title = "Что получила модель",
  defaultOpen = false,
}: TestAgentModelPromptProps) {
  if (!prompt) return null;
  const tools = prompt.tools || [];
  const messages = prompt.messages || [];
  const hasBody = Boolean(prompt.system) || tools.length > 0 || messages.length > 0;
  if (!hasBody) return null;

  return (
    <details className="agent-run-trace test-agent-prompt" open={defaultOpen}>
      <summary className="agent-run-trace__summary">
        <span className="agent-run-trace__title">{title}</span>
        {prompt.model ? <span className="agent-run-trace__meta">{prompt.model}</span> : null}
      </summary>
      <div className="agent-run-trace__body ticket-ai-prompt">
        {prompt.system ? (
          <div className="ticket-ai-prompt__block">
            <h5>Системный промпт</h5>
            <pre className="ticket-ai-prompt__pre">{prompt.system}</pre>
          </div>
        ) : null}
        {tools.length ? (
          <div className="ticket-ai-prompt__block">
            <h5>Инструменты</h5>
            <ul className="ticket-ai-prompt__tools">
              {tools.map((tool) => (
                <li key={tool.name}>
                  <strong>{tool.name}</strong>
                  {tool.description ? <span> — {tool.description}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {messages.length ? (
          <div className="ticket-ai-prompt__block">
            <h5>Сообщения</h5>
            <div className="ticket-ai-prompt__turns">
              {messages.map((message, index) => (
                <article key={`${message.role}-${index}`} className="ticket-ai-prompt__turn">
                  <span className="ticket-ai-prompt__role">{message.role}</span>
                  <pre className="ticket-ai-prompt__pre">{formatPromptContent(message.content) || "—"}</pre>
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </details>
  );
}
