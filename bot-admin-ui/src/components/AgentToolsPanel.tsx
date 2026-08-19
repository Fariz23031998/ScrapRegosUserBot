import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getAiSettings, listAiTools, saveAiDisabledTools } from "../api/ai";
import { useAuth } from "../hooks/useAuth";
import type {
  AiAgentTool,
  AiToolAgentSlug,
  AiToolDescription,
  AiToolSchema,
} from "../lib/types";
import LoadingState from "./LoadingState";
import ToolTestModal from "./ToolTestModal";

const TOOL_AGENT_SLUGS: AiToolAgentSlug[] = ["customer", "customer_assist", "kb", "ops"];

const TOOL_AGENT_TITLES: Record<AiToolAgentSlug, string> = {
  customer: "Агент поддержки",
  customer_assist: "Агент поддержки (сотрудник)",
  kb: "База знаний",
  ops: "Задачи",
};

const TICKET_REQUIRED_TOOLS = new Set([
  "search_chat_history",
  "read_chat_image",
  "transcribe_chat_audio",
  "assign_responsible",
  "close_ticket",
  "update_ticket",
  "reply_to_customer",
]);

function emptyDisabledAgentTools(): Record<AiToolAgentSlug, string[]> {
  return { customer: [], customer_assist: [], kb: [], ops: [] };
}

function isToolAgentSlug(slug: string): slug is AiToolAgentSlug {
  return TOOL_AGENT_SLUGS.includes(slug as AiToolAgentSlug);
}

function toolAgentEnabled(tool: AiAgentTool, slug: AiToolAgentSlug) {
  if (tool.enabled_agents && slug in tool.enabled_agents) {
    return tool.enabled_agents[slug] !== false;
  }
  return tool.enabled !== false;
}

function withToolAgentStates(
  tool: AiAgentTool,
  nextStates: Partial<Record<AiToolAgentSlug, boolean>>,
): AiAgentTool {
  const enabled_agents: Partial<Record<AiToolAgentSlug, boolean>> = {
    ...(tool.enabled_agents || {}),
  };
  for (const slug of tool.agents || []) {
    if (!isToolAgentSlug(slug)) continue;
    enabled_agents[slug] = slug in nextStates ? Boolean(nextStates[slug]) : toolAgentEnabled(tool, slug);
  }
  const enabled =
    (tool.agents || []).length > 0 &&
    (tool.agents || []).every((slug) => !isToolAgentSlug(slug) || enabled_agents[slug] !== false);
  return { ...tool, enabled, enabled_agents };
}

function disabledAgentToolsFromRows(tools: AiAgentTool[]): Record<AiToolAgentSlug, string[]> {
  const next = emptyDisabledAgentTools();
  for (const tool of tools) {
    for (const slug of tool.agents || []) {
      if (!isToolAgentSlug(slug) || toolAgentEnabled(tool, slug)) continue;
      next[slug].push(tool.name);
    }
  }
  return next;
}

function fullyDisabledToolNames(tools: AiAgentTool[]): string[] {
  return tools
    .filter(
      (tool) =>
        (tool.agents || []).length > 0 &&
        (tool.agents || []).every((slug) => !isToolAgentSlug(slug) || !toolAgentEnabled(tool, slug)),
    )
    .map((tool) => tool.name);
}

function preview(body: string, max = 360) {
  const text = String(body || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

type AgentToolsPanelProps = {
  descriptions: AiToolDescription[];
  onEditDescription: (tool: AiToolDescription) => void;
  onResetDescription: (tool: AiToolDescription) => void;
  resetPending?: boolean;
};

export default function AgentToolsPanel({
  descriptions,
  onEditDescription,
  onResetDescription,
  resetPending,
}: AgentToolsPanelProps) {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = hasPermission("settings_edit");
  const [agentTools, setAgentTools] = useState<AiAgentTool[] | null>(null);
  const [toolTestName, setToolTestName] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; type?: "success" | "error" } | null>(null);

  const aiQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: getAiSettings,
  });

  const toolsSchemaQuery = useQuery({
    queryKey: ["ai-tool-schemas"],
    queryFn: listAiTools,
  });

  const descriptionsByName = useMemo(
    () => new Map(descriptions.map((tool) => [tool.name, tool] as const)),
    [descriptions],
  );
  const rows = agentTools ?? aiQuery.data?.agent_tools ?? [];
  const toolSchemasByName = useMemo(
    () => new Map((toolsSchemaQuery.data?.tools || []).map((tool) => [tool.name, tool] as const)),
    [toolsSchemaQuery.data?.tools],
  );

  let toolUnderTest: AiToolSchema | null = null;
  if (toolTestName) {
    toolUnderTest = toolSchemasByName.get(toolTestName) || null;
    if (!toolUnderTest) {
      const row = rows.find((tool) => tool.name === toolTestName);
      if (row) {
        toolUnderTest = {
          name: row.name,
          title: row.title,
          description: descriptionsByName.get(row.name)?.body || row.description,
          agents: row.agents,
          parameters: { type: "object", properties: {} },
          requires_ticket: TICKET_REQUIRED_TOOLS.has(row.name),
        };
      }
    }
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      saveAiDisabledTools({
        disabled_tools: fullyDisabledToolNames(rows),
        disabled_agent_tools: disabledAgentToolsFromRows(rows),
      }),
    onSuccess: (data) => {
      setAgentTools(data.agent_tools || []);
      setMessage({ text: "Настройки инструментов сохранены.", type: "success" });
      queryClient.setQueryData(["ai-settings"], data);
      void queryClient.invalidateQueries({ queryKey: ["ai-settings"] });
    },
    onError: (error: Error) => setMessage({ text: error.message, type: "error" }),
  });

  function applyToolRows(next: AiAgentTool[]) {
    setAgentTools(next);
    setMessage(null);
  }

  function setToolEnabled(toolName: string, enabled: boolean) {
    applyToolRows(
      rows.map((tool) => {
        if (tool.name !== toolName) return tool;
        const nextStates = Object.fromEntries(
          (tool.agents || []).filter(isToolAgentSlug).map((slug) => [slug, enabled]),
        ) as Partial<Record<AiToolAgentSlug, boolean>>;
        return withToolAgentStates(tool, nextStates);
      }),
    );
  }

  function setToolAgentEnabled(toolName: string, slug: AiToolAgentSlug, enabled: boolean) {
    applyToolRows(
      rows.map((tool) =>
        tool.name === toolName ? withToolAgentStates(tool, { [slug]: enabled }) : tool,
      ),
    );
  }

  function setAllToolsEnabled(enabled: boolean) {
    applyToolRows(
      rows.map((tool) => {
        const nextStates = Object.fromEntries(
          (tool.agents || []).filter(isToolAgentSlug).map((slug) => [slug, enabled]),
        ) as Partial<Record<AiToolAgentSlug, boolean>>;
        return withToolAgentStates(tool, nextStates);
      }),
    );
  }

  return (
    <section className="card">
      <div className="card-toolbar">
        <h2>Инструменты</h2>
        {canEdit ? (
          <div className="card-toolbar-right">
            <button
              type="button"
              className="btn-primary"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || aiQuery.isLoading}
            >
              Сохранить
            </button>
          </div>
        ) : null}
      </div>
      {message ? <p className={`message ${message.type || ""}`}>{message.text}</p> : null}
      {aiQuery.isLoading ? (
        <LoadingState />
      ) : !rows.length ? (
        <p className="empty-state">Список инструментов пуст.</p>
      ) : (
        <div className="settings-tools">
          <div className="settings-tools__header">
            <div className="settings-tools__intro">
              <p className="muted-copy">
                Инструменты можно включать отдельно для каждого агента. Отключённые для агента
                инструменты ему не передаются. Описание ниже уходит в модель как описание функции;
                в него можно вставлять те же переменные <code>{"{{key}}"}</code>, что и в системных
                промптах. Проверка вызывает инструмент напрямую (в том числе отключённые).
              </p>
              <p className="settings-tools__sandboxes muted-copy">
                Песочницы агентов:{" "}
                {hasPermission("ai_customer_test") ? (
                  <>
                    <Link to="/test-agents">Тест агентов</Link>
                    {" · "}
                  </>
                ) : null}
                {hasPermission("knowledge_read") ? (
                  <Link to="/knowledge">База знаний</Link>
                ) : (
                  <span>нет доступа к базе знаний</span>
                )}
              </p>
            </div>
            {canEdit ? (
              <div className="settings-tools__actions">
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => setAllToolsEnabled(true)}
                >
                  Включить все
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => setAllToolsEnabled(false)}
                >
                  Отключить все
                </button>
              </div>
            ) : null}
          </div>
          <div className="settings-tools__list">
            {rows.map((tool) => {
              const agents = (tool.agents || []).filter(isToolAgentSlug);
              const enabledCount = agents.filter((slug) => toolAgentEnabled(tool, slug)).length;
              const allEnabled = agents.length > 0 && enabledCount === agents.length;
              const mixed = enabledCount > 0 && enabledCount < agents.length;
              const description = descriptionsByName.get(tool.name);
              return (
                <div
                  key={tool.name}
                  className={`settings-tool-row${enabledCount ? "" : " settings-tool-row--off"}`}
                >
                  <div className="settings-tool-row__main">
                    <label className="settings-tool-row__toggle field-checkbox">
                      <input
                        type="checkbox"
                        checked={allEnabled}
                        disabled={!canEdit}
                        ref={(element) => {
                          if (element) element.indeterminate = mixed;
                        }}
                        onChange={(event) => setToolEnabled(tool.name, event.target.checked)}
                      />
                      <span className="settings-tool-row__body">
                        <span className="settings-tool-row__title">
                          <strong>{tool.title}</strong>
                          {description?.is_custom ? (
                            <span className="badge badge--ok">Изменено</span>
                          ) : null}
                        </span>
                        <small className="settings-tool-row__name">{tool.name}</small>
                        <span className="muted-copy">
                          {preview(description?.body || tool.description)}
                        </span>
                      </span>
                    </label>
                    {agents.length ? (
                      <div className="settings-tool-row__agents">
                        {agents.map((slug) => (
                          <label key={slug} className="settings-tool-row__agent field-checkbox">
                            <input
                              type="checkbox"
                              checked={toolAgentEnabled(tool, slug)}
                              disabled={!canEdit}
                              onChange={(event) =>
                                setToolAgentEnabled(tool.name, slug, event.target.checked)
                              }
                            />
                            <span>{TOOL_AGENT_TITLES[slug] || slug}</span>
                          </label>
                        ))}
                      </div>
                    ) : null}
                    {canEdit && description ? (
                      <div className="settings-tool-row__desc-actions">
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() => onEditDescription(description)}
                        >
                          Описание
                        </button>
                        {description.is_custom ? (
                          <button
                            type="button"
                            className="btn-secondary btn-sm"
                            onClick={() => onResetDescription(description)}
                            disabled={resetPending}
                          >
                            Сбросить описание
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  {canEdit ? (
                    <button
                      type="button"
                      className="btn-secondary btn-sm settings-tool-row__test"
                      onClick={() => setToolTestName(tool.name)}
                    >
                      Проверить
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <ToolTestModal
        open={Boolean(toolTestName)}
        tool={toolUnderTest}
        onClose={() => setToolTestName(null)}
      />
    </section>
  );
}
