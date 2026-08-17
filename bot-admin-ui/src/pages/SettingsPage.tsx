import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getAiSettings, listAiTools, saveAiSettings } from "../api/ai";
import {
  getChannelSettings,
  getTelegramTicketSettings,
  saveChannelSettings,
  saveTelegramTicketSettings,
  searchTelegramTicketClients,
} from "../api/tickets";
import EntityCards from "../components/EntityCards";
import GroupTopicTestModal from "../components/GroupTopicTestModal";
import LoadingState from "../components/LoadingState";
import TicketParticipantsPicker from "../components/TicketParticipantsPicker";
import ToolTestModal from "../components/ToolTestModal";
import { useAuth } from "../hooks/useAuth";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import type {
  AiAgentTool,
  AiGroupTopic,
  AiPromptSlug,
  AiSettings,
  AiToolAgentSlug,
  AiToolSchema,
  ChannelSetting,
  TelegramTicketSettings,
} from "../lib/types";

const CUSTOM_MODEL = "__custom__";
const DEFAULT_AGENT_MODEL = "__default__";

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
};

type SettingsTab = "ai" | "tools" | "channels" | "telegram";

const SETTINGS_TABS: Array<{ id: SettingsTab; title: string }> = [
  { id: "ai", title: "AI" },
  { id: "tools", title: "Инструменты" },
  { id: "channels", title: "Каналы" },
  { id: "telegram", title: "Telegram" },
];

function emptyTelegramTicketSettings(): TelegramTicketSettings {
  return {
    enabled: false,
    channel_id: null,
    direction: "Inbound",
    responsible_user_id: null,
    participant_user_ids: [],
    subject: "Вопрос из Telegram",
    fallback_client_id: null,
  };
}

const AGENT_TITLES: Record<AiPromptSlug, string> = {
  customer: "Агент поддержки",
  customer_assist: "Агент поддержки (сотрудник)",
  kb: "База знаний",
  ticket_summary: "Сводка обращения",
};

const TOOL_AGENT_SLUGS: AiToolAgentSlug[] = ["customer", "customer_assist", "kb"];

function emptyDisabledAgentTools(): Record<AiToolAgentSlug, string[]> {
  return { customer: [], customer_assist: [], kb: [] };
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

const TICKET_REQUIRED_TOOLS = new Set([
  "search_chat_history",
  "read_chat_image",
  "transcribe_chat_audio",
  "assign_responsible",
  "close_ticket",
  "reply_to_customer",
]);

function emptyTopic(): AiGroupTopic {
  return { key: "", id: "", name: "", when: "" };
}

function knownOrCustom(value: string, known: string[]) {
  return known.includes(value) ? "" : value;
}

function resolveListedModel(value: string, known: string[], custom: string) {
  if (known.includes(value)) return value;
  return custom.trim() || value;
}

function credentialStatusLabel(configured?: boolean, hint?: string, source?: string) {
  if (!configured) return "не задан";
  const masked = hint ? `••••${hint}` : "задан";
  if (source === "database") return `${masked} (БД)`;
  if (source === "env") return `${masked} (env)`;
  return masked;
}

export default function SettingsPage() {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const [tab, setTab] = useState<SettingsTab>("ai");
  const [message, setMessage] = useState<{ text: string; type?: "success" | "error" } | null>(null);
  const [draft, setDraft] = useState<ChannelSetting[]>([]);
  const [aiDraft, setAiDraft] = useState<AiSettings | null>(null);
  const [customModel, setCustomModel] = useState("");
  const [customAgentModels, setCustomAgentModels] = useState<Partial<Record<AiPromptSlug, string>>>({});
  const [customTranscribe, setCustomTranscribe] = useState("");
  const [openaiApiKeyDraft, setOpenaiApiKeyDraft] = useState("");
  const [geminiApiKeyDraft, setGeminiApiKeyDraft] = useState("");
  const [clearOpenaiApiKey, setClearOpenaiApiKey] = useState(false);
  const [clearGeminiApiKey, setClearGeminiApiKey] = useState(false);
  const [groupTestOpen, setGroupTestOpen] = useState(false);
  const [toolTestName, setToolTestName] = useState<string | null>(null);
  const [telegramDraft, setTelegramDraft] = useState<TelegramTicketSettings | null>(null);
  const [fallbackClientQuery, setFallbackClientQuery] = useState("");
  const [fallbackClients, setFallbackClients] = useState<
    Array<{ id: number; name?: string | null; phone?: string | null; email?: string | null }>
  >([]);
  const [selectedFallbackClient, setSelectedFallbackClient] = useState<{
    id: number;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
  } | null>(null);

  function applyLoadedSettings(data: AiSettings) {
    setAiDraft(data);
    const known = data.models || [];
    setCustomModel(knownOrCustom(data.model, known));
    const nextCustom: Partial<Record<AiPromptSlug, string>> = {};
    for (const slug of data.agent_model_slugs || (Object.keys(AGENT_TITLES) as AiPromptSlug[])) {
      const value = String(data.agent_models?.[slug] || "").trim();
      if (value && !known.includes(value)) nextCustom[slug] = value;
    }
    setCustomAgentModels(nextCustom);
    const transcribeKnown = data.transcribe_models || [];
    const transcribe = data.transcribe_model || "";
    setCustomTranscribe(transcribeKnown.includes(transcribe) ? "" : transcribe);
    setOpenaiApiKeyDraft("");
    setGeminiApiKeyDraft("");
    setClearOpenaiApiKey(false);
    setClearGeminiApiKey(false);
  }

  const query = useQuery({
    queryKey: ["channel-settings"],
    queryFn: async () => {
      const data = await getChannelSettings();
      setDraft(data.channels || []);
      return data;
    },
  });

  const aiQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: async () => {
      const data = await getAiSettings();
      applyLoadedSettings(data);
      return data;
    },
  });

  const toolsSchemaQuery = useQuery({
    queryKey: ["ai-tool-schemas"],
    queryFn: listAiTools,
    enabled: tab === "tools",
  });

  const telegramQuery = useQuery({
    queryKey: ["telegram-ticket-settings"],
    queryFn: async () => {
      const data = await getTelegramTicketSettings();
      setTelegramDraft(data.settings || emptyTelegramTicketSettings());
      if (data.settings?.fallback_client_id) {
        setSelectedFallbackClient({ id: data.settings.fallback_client_id });
      } else {
        setSelectedFallbackClient(null);
      }
      return data;
    },
    enabled: tab === "telegram" || Boolean(telegramDraft),
  });

  useEffect(() => {
    const query = fallbackClientQuery.trim();
    if (query.length < 2) {
      setFallbackClients([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchTelegramTicketClients(query)
        .then((data) => {
          if (!cancelled) setFallbackClients(data.clients || []);
        })
        .catch(() => {
          if (!cancelled) setFallbackClients([]);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fallbackClientQuery]);

  const saveMutation = useMutation({
    mutationFn: () =>
      saveChannelSettings(
        draft.map((channel) => ({ id: channel.id, interaction_mode: channel.interaction_mode })),
      ),
    onSuccess: (data) => {
      setDraft(data.channels || []);
      setMessage({ text: "Настройки каналов сохранены.", type: "success" });
      void queryClient.invalidateQueries({ queryKey: ["channel-settings"] });
    },
    onError: (error: Error) => setMessage({ text: error.message, type: "error" }),
  });

  const saveAiMutation = useMutation({
    mutationFn: () => {
      const settings = aiDraft;
      if (!settings) throw new Error("Настройки AI не загружены.");
      const known =
        (settings.provider && settings.models_by_provider?.[settings.provider]) ||
        settings.models ||
        [];
      const model = resolveListedModel(settings.model, known, customModel);
      const transcribeKnown = settings.transcribe_models || [];
      const transcribeModel = resolveListedModel(
        settings.transcribe_model || "",
        transcribeKnown,
        customTranscribe,
      );
      const agentModels: Partial<Record<AiPromptSlug, string>> = {};
      for (const slug of settings.agent_model_slugs || (Object.keys(AGENT_TITLES) as AiPromptSlug[])) {
        const value = String(settings.agent_models?.[slug] || "").trim();
        agentModels[slug] = value ? resolveListedModel(value, known, customAgentModels[slug] || "") : "";
      }
      return saveAiSettings({
        enabled: settings.enabled,
        test_mode: settings.test_mode,
        provider: settings.provider,
        model,
        agent_models: agentModels,
        transcribe_model: transcribeModel,
        reasoning_effort: settings.reasoning_effort || "",
        history_limit: settings.history_limit,
        customer_replies_per_hour: settings.customer_replies_per_hour,
        customer_replies_per_ticket: settings.customer_replies_per_ticket,
        group_chat_id: settings.group_chat_id || "",
        group_topics: settings.group_topics || [],
        disabled_tools: settings.disabled_tools || [],
        disabled_agent_tools: settings.disabled_agent_tools || emptyDisabledAgentTools(),
        ignored_customer_messages: settings.ignored_customer_messages || [],
        openai_base_url: settings.openai_base_url || "",
        ...(clearOpenaiApiKey
          ? { openai_api_key: "" }
          : openaiApiKeyDraft.trim()
            ? { openai_api_key: openaiApiKeyDraft.trim() }
            : {}),
        ...(clearGeminiApiKey
          ? { gemini_api_key: "" }
          : geminiApiKeyDraft.trim()
            ? { gemini_api_key: geminiApiKeyDraft.trim() }
            : {}),
      });
    },
    onSuccess: (data) => {
      applyLoadedSettings(data);
      setMessage({ text: "Настройки AI сохранены.", type: "success" });
      queryClient.setQueryData(["ai-settings"], data);
      void queryClient.invalidateQueries({ queryKey: ["ai-settings"] });
    },
    onError: (error: Error) => setMessage({ text: error.message, type: "error" }),
  });

  const saveTelegramMutation = useMutation({
    mutationFn: () => {
      const settings = telegramDraft || emptyTelegramTicketSettings();
      return saveTelegramTicketSettings({
        enabled: settings.enabled,
        channel_id: settings.channel_id,
        direction: settings.direction,
        responsible_user_id: settings.responsible_user_id,
        participant_user_ids: settings.participant_user_ids || [],
        subject: settings.subject,
        fallback_client_id: settings.fallback_client_id,
      });
    },
    onSuccess: (data) => {
      setTelegramDraft(data.settings || emptyTelegramTicketSettings());
      setMessage({ text: "Настройки Telegram-тикетов сохранены.", type: "success" });
      void queryClient.invalidateQueries({ queryKey: ["telegram-ticket-settings"] });
    },
    onError: (error: Error) => setMessage({ text: error.message, type: "error" }),
  });

  const channels = draft.length ? draft : query.data?.channels || [];
  const canEdit = hasPermission("settings_edit");
  const ai = aiDraft || aiQuery.data;
  const telegram = telegramDraft;
  const telegramChannels = telegramQuery.data?.channels || [];
  const telegramUsers = telegramQuery.data?.users || [];
  const showAiSave = tab === "ai" || tab === "tools";
  const savedTopics = (aiQuery.data?.group_topics || []).filter((topic) => String(topic.key || "").trim());
  const canTestGroup = Boolean(canEdit && aiQuery.data?.group_chat_id && savedTopics.length);
  const suggestedModels =
    (ai?.provider && ai?.models_by_provider?.[ai.provider]) ||
    ai?.models ||
    ["gpt-4.1", "gpt-4o", "gpt-4o-mini"];
  const transcribeModels = ai?.transcribe_models || ["gpt-4o-transcribe", "gpt-transcribe", "whisper-1"];
  const agentSlugs = ai?.agent_model_slugs || (Object.keys(AGENT_TITLES) as AiPromptSlug[]);
  const modelValue = ai && suggestedModels.includes(ai.model) ? ai.model : CUSTOM_MODEL;
  const transcribeValue =
    ai && transcribeModels.includes(ai.transcribe_model || "") ? ai.transcribe_model || "" : CUSTOM_MODEL;
  const agentTools = ai?.agent_tools || [];
  const toolSchemasByName = new Map(
    (toolsSchemaQuery.data?.tools || []).map((tool) => [tool.name, tool] as const),
  );
  let toolUnderTest: AiToolSchema | null = null;
  if (toolTestName) {
    toolUnderTest = toolSchemasByName.get(toolTestName) || null;
    if (!toolUnderTest) {
      const row = agentTools.find((tool) => tool.name === toolTestName);
      if (row) {
        toolUnderTest = {
          name: row.name,
          title: row.title,
          description: row.description,
          agents: row.agents,
          parameters: { type: "object", properties: {} },
          requires_ticket: TICKET_REQUIRED_TOOLS.has(row.name),
        };
      }
    }
  }

  function updateMode(channelId: number, value: ChannelSetting["interaction_mode"]) {
    setDraft((prev) =>
      prev.map((item) => (item.id === channelId ? { ...item, interaction_mode: value } : item)),
    );
  }

  function applyToolRows(agent_tools: AiAgentTool[]) {
    if (!ai) return;
    setAiDraft({
      ...ai,
      agent_tools,
      disabled_agent_tools: disabledAgentToolsFromRows(agent_tools),
      disabled_tools: fullyDisabledToolNames(agent_tools),
    });
  }

  function setToolEnabled(toolName: string, enabled: boolean) {
    applyToolRows(
      (ai?.agent_tools || []).map((tool) => {
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
      (ai?.agent_tools || []).map((tool) =>
        tool.name === toolName ? withToolAgentStates(tool, { [slug]: enabled }) : tool,
      ),
    );
  }

  function setAllToolsEnabled(enabled: boolean) {
    applyToolRows(
      (ai?.agent_tools || []).map((tool) => {
        const nextStates = Object.fromEntries(
          (tool.agents || []).filter(isToolAgentSlug).map((slug) => [slug, enabled]),
        ) as Partial<Record<AiToolAgentSlug, boolean>>;
        return withToolAgentStates(tool, nextStates);
      }),
    );
  }

  function modeSelect(channel: ChannelSetting) {
    return (
      <select
        value={channel.interaction_mode}
        disabled={!canEdit}
        onChange={(event) => {
          updateMode(channel.id, event.target.value as ChannelSetting["interaction_mode"]);
        }}
      >
        <option value="message_only">Только сообщения</option>
        <option value="call">Звонки</option>
      </select>
    );
  }

  return (
    <>
      <section className="card page--settings">
        <div className="card-toolbar">
          <div className="role-tabs" role="tablist" aria-label="Разделы настроек">
            {SETTINGS_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`role-tab${tab === item.id ? " role-tab--active" : ""}`}
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => {
                  setTab(item.id);
                  setMessage(null);
                }}
              >
                {item.title}
              </button>
            ))}
          </div>
          {canEdit && showAiSave ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => saveAiMutation.mutate()}
              disabled={saveAiMutation.isPending || !ai}
            >
              Сохранить
            </button>
          ) : null}
          {canEdit && tab === "channels" ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              Сохранить
            </button>
          ) : null}
          {canEdit && tab === "telegram" ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => saveTelegramMutation.mutate()}
              disabled={saveTelegramMutation.isPending || !telegram}
            >
              Сохранить
            </button>
          ) : null}
        </div>

        {message ? <p className={`message ${message.type || ""}`}>{message.text}</p> : null}

        {tab === "ai" ? (
          aiQuery.isLoading ? (
            <LoadingState />
          ) : !ai ? (
            <p className="empty-state">Не удалось загрузить настройки AI.</p>
          ) : (
            <form className="stack-form settings-form" onSubmit={(event) => event.preventDefault()}>
              <div className="settings-checks">
                <label className="field-checkbox">
                  <input
                    type="checkbox"
                    checked={ai.enabled}
                    disabled={!canEdit}
                    onChange={(event) => setAiDraft({ ...ai, enabled: event.target.checked })}
                  />
                  <span>Включить ответы AI в чатах клиентов</span>
                </label>
                <label className="field-checkbox">
                  <input
                    type="checkbox"
                    checked={ai.test_mode}
                    disabled={!canEdit}
                    onChange={(event) => setAiDraft({ ...ai, test_mode: event.target.checked })}
                  />
                  <span>Тестовый режим — только клиенты с телефоном сотрудника</span>
                </label>
              </div>
              <div className="settings-topics">
                <div className="settings-topics__header">
                  <strong>Не отвечать на сообщения</strong>
                  {canEdit ? (
                    <div className="settings-topics__actions">
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        disabled={
                          (ai.ignored_customer_messages || []).length >=
                          (ai.ignored_customer_messages_max || 50)
                        }
                        onClick={() =>
                          setAiDraft({
                            ...ai,
                            ignored_customer_messages: [...(ai.ignored_customer_messages || []), ""],
                          })
                        }
                      >
                        Добавить сообщение
                      </button>
                    </div>
                  ) : null}
                </div>
                <p className="muted-copy">
                  Точный текст клиентского сообщения, на который агент не должен отвечать автоматически
                  (например <code>/start</code>). Регистр и пробелы по краям не учитываются.
                </p>
                {(ai.ignored_customer_messages || []).length === 0 ? (
                  <p className="muted-copy">Список пуст. Агент отвечает на все клиентские сообщения.</p>
                ) : (
                  (ai.ignored_customer_messages || []).map((item, index) => (
                    <div key={index} className="settings-ignore-row">
                      <input
                        value={item}
                        disabled={!canEdit}
                        placeholder="/start"
                        maxLength={200}
                        onChange={(event) => {
                          const ignored_customer_messages = [...(ai.ignored_customer_messages || [])];
                          ignored_customer_messages[index] = event.target.value;
                          setAiDraft({ ...ai, ignored_customer_messages });
                        }}
                      />
                      {canEdit ? (
                        <button
                          type="button"
                          className="btn-danger btn-sm"
                          onClick={() => {
                            const ignored_customer_messages = (ai.ignored_customer_messages || []).filter(
                              (_, itemIndex) => itemIndex !== index,
                            );
                            setAiDraft({ ...ai, ignored_customer_messages });
                          }}
                        >
                          Удалить
                        </button>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
              <label>
                Последних сообщений в промпт
                <input
                  type="number"
                  min={ai.history_limit_min || 1}
                  max={ai.history_limit_max || 100}
                  step={1}
                  value={ai.history_limit}
                  disabled={!canEdit}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setAiDraft({
                      ...ai,
                      history_limit: Number.isFinite(next) ? next : ai.history_limit,
                    });
                  }}
                />
              </label>
              <p className="muted-copy">
                Агент поддержки получит ровно столько последних сообщений чата (от {ai.history_limit_min || 1} до{" "}
                {ai.history_limit_max || 100}).
              </p>
              <label>
                Автоответов клиенту в час
                <input
                  type="number"
                  min={ai.customer_replies_per_hour_min ?? 0}
                  max={ai.customer_replies_per_hour_max || 500}
                  step={1}
                  value={ai.customer_replies_per_hour ?? 8}
                  disabled={!canEdit}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setAiDraft({
                      ...ai,
                      customer_replies_per_hour: Number.isFinite(next)
                        ? next
                        : ai.customer_replies_per_hour,
                    });
                  }}
                />
              </label>
              <p className="muted-copy">
                Максимум автоматических ответов одному клиенту за скользящий час (0 — без лимита, до{" "}
                {ai.customer_replies_per_hour_max || 500}).
              </p>
              <label>
                Автоответов клиенту в одном тикете
                <input
                  type="number"
                  min={ai.customer_replies_per_ticket_min ?? 0}
                  max={ai.customer_replies_per_ticket_max || 500}
                  step={1}
                  value={ai.customer_replies_per_ticket ?? 20}
                  disabled={!canEdit}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setAiDraft({
                      ...ai,
                      customer_replies_per_ticket: Number.isFinite(next)
                        ? next
                        : ai.customer_replies_per_ticket,
                    });
                  }}
                />
              </label>
              <p className="muted-copy">
                После этого лимита автоответы в тикете останавливаются, пока сотрудник не включит их снова (0 — без
                лимита, до {ai.customer_replies_per_ticket_max || 500}).
              </p>
              <label>
                ID группы Telegram
                <input
                  value={ai.group_chat_id || ""}
                  disabled={!canEdit}
                  placeholder="-1001234567890"
                  onChange={(event) => setAiDraft({ ...ai, group_chat_id: event.target.value })}
                />
              </label>
              <p className="muted-copy">
                Бот с <code>TELEGRAM_BOT_TOKEN</code> должен быть участником группы с правом отправки сообщений. ID
                группы и темы берутся из ссылки на сообщение:{" "}
                <code>https://t.me/c/1234567890/42/100</code> — ID группы{" "}
                <code>-1001234567890</code>, ID темы <code>42</code>. Общая тема («General») обычно имеет id{" "}
                <code>1</code>. Пустой ID или список тем отключает инструменты агента.
              </p>
              <div className="settings-topics">
                <div className="settings-topics__header">
                  <strong>Темы группы</strong>
                  {canEdit ? (
                    <div className="settings-topics__actions">
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        disabled={!canTestGroup}
                        title={
                          canTestGroup
                            ? "Отправить тестовое сообщение в сохранённую тему"
                            : "Сначала сохраните ID группы и хотя бы одну тему"
                        }
                        onClick={() => setGroupTestOpen(true)}
                      >
                        Проверить
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        disabled={(ai.group_topics || []).length >= (ai.group_topics_max || 30)}
                        onClick={() =>
                          setAiDraft({
                            ...ai,
                            group_topics: [...(ai.group_topics || []), emptyTopic()],
                          })
                        }
                      >
                        Добавить тему
                      </button>
                    </div>
                  ) : null}
                </div>
                {(ai.group_topics || []).length === 0 ? (
                  <p className="muted-copy">Темы не заданы. Агент не сможет писать в группу.</p>
                ) : (
                  (ai.group_topics || []).map((topic, index) => (
                    <div key={index} className="settings-topic-row">
                      <label>
                        Ключ
                        <input
                          value={topic.key}
                          disabled={!canEdit}
                          placeholder="urgent"
                          onChange={(event) => {
                            const group_topics = [...(ai.group_topics || [])];
                            group_topics[index] = { ...topic, key: event.target.value };
                            setAiDraft({ ...ai, group_topics });
                          }}
                        />
                      </label>
                      <label>
                        ID темы
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={topic.id}
                          disabled={!canEdit}
                          placeholder="42"
                          onChange={(event) => {
                            const group_topics = [...(ai.group_topics || [])];
                            group_topics[index] = { ...topic, id: event.target.value };
                            setAiDraft({ ...ai, group_topics });
                          }}
                        />
                      </label>
                      <label>
                        Название
                        <input
                          value={topic.name}
                          disabled={!canEdit}
                          placeholder="Срочная помощь"
                          onChange={(event) => {
                            const group_topics = [...(ai.group_topics || [])];
                            group_topics[index] = { ...topic, name: event.target.value };
                            setAiDraft({ ...ai, group_topics });
                          }}
                        />
                      </label>
                      <label className="settings-topic-row__when">
                        Когда писать
                        <input
                          value={topic.when || ""}
                          disabled={!canEdit}
                          placeholder="клиент не может работать"
                          onChange={(event) => {
                            const group_topics = [...(ai.group_topics || [])];
                            group_topics[index] = { ...topic, when: event.target.value };
                            setAiDraft({ ...ai, group_topics });
                          }}
                        />
                      </label>
                      {canEdit ? (
                        <button
                          type="button"
                          className="btn-danger btn-sm"
                          onClick={() => {
                            const group_topics = (ai.group_topics || []).filter((_, itemIndex) => itemIndex !== index);
                            setAiDraft({ ...ai, group_topics });
                          }}
                        >
                          Удалить
                        </button>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
              <label>
                Провайдер
                <select
                  value={ai.provider || "openai"}
                  disabled={!canEdit}
                  onChange={(event) => {
                    const provider = event.target.value;
                    const models = ai.models_by_provider?.[provider] || suggestedModels;
                    setAiDraft({ ...ai, provider, models });
                  }}
                >
                  {(ai.providers || ["openai", "gemini"]).map((provider) => (
                    <option key={provider} value={provider}>
                      {PROVIDER_LABELS[provider] || provider}
                    </option>
                  ))}
                </select>
              </label>
              <div className="settings-credentials">
                <strong>API-ключи</strong>
                <p className="muted-copy">
                  Ключи сохраняются в базе. Если поле в БД пустое, используется значение из env. GET никогда не
                  возвращает полный ключ.
                </p>
                <label>
                  OpenAI API key
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={clearOpenaiApiKey ? "" : openaiApiKeyDraft}
                    disabled={!canEdit || clearOpenaiApiKey}
                    placeholder={
                      clearOpenaiApiKey
                        ? "Будет очищен в БД"
                        : credentialStatusLabel(
                            ai.openai_api_key_configured,
                            ai.openai_api_key_hint,
                            ai.openai_api_key_source,
                          )
                    }
                    onChange={(event) => {
                      setClearOpenaiApiKey(false);
                      setOpenaiApiKeyDraft(event.target.value);
                    }}
                  />
                </label>
                {canEdit ? (
                  <div className="settings-credentials__actions">
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => {
                        setOpenaiApiKeyDraft("");
                        setClearOpenaiApiKey(true);
                      }}
                    >
                      Очистить ключ OpenAI в БД
                    </button>
                  </div>
                ) : null}
                <label>
                  OpenAI base URL
                  <input
                    value={ai.openai_base_url || ""}
                    disabled={!canEdit}
                    placeholder="https://api.openai.com/v1 (или из env)"
                    onChange={(event) => setAiDraft({ ...ai, openai_base_url: event.target.value })}
                  />
                </label>
                <label>
                  Gemini API key
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={clearGeminiApiKey ? "" : geminiApiKeyDraft}
                    disabled={!canEdit || clearGeminiApiKey}
                    placeholder={
                      clearGeminiApiKey
                        ? "Будет очищен в БД"
                        : credentialStatusLabel(
                            ai.gemini_api_key_configured,
                            ai.gemini_api_key_hint,
                            ai.gemini_api_key_source,
                          )
                    }
                    onChange={(event) => {
                      setClearGeminiApiKey(false);
                      setGeminiApiKeyDraft(event.target.value);
                    }}
                  />
                </label>
                {canEdit ? (
                  <div className="settings-credentials__actions">
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => {
                        setGeminiApiKeyDraft("");
                        setClearGeminiApiKey(true);
                      }}
                    >
                      Очистить ключ Gemini в БД
                    </button>
                  </div>
                ) : null}
                {ai.provider === "gemini" ? (
                  <p className="muted-copy">
                    Расшифровка голоса по-прежнему идёт через OpenAI (Whisper) — для STT нужен ключ OpenAI.
                  </p>
                ) : null}
              </div>
              <label>
                Модель по умолчанию
                <select
                  value={modelValue}
                  disabled={!canEdit}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === CUSTOM_MODEL) {
                      setAiDraft({ ...ai, model: customModel || ai.model });
                    } else {
                      setAiDraft({ ...ai, model: value });
                    }
                  }}
                >
                  {suggestedModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                  <option value={CUSTOM_MODEL}>Другая…</option>
                </select>
              </label>
              {modelValue === CUSTOM_MODEL ? (
                <label>
                  Имя модели
                  <input
                    value={customModel}
                    disabled={!canEdit}
                    onChange={(event) => {
                      setCustomModel(event.target.value);
                      setAiDraft({ ...ai, model: event.target.value });
                    }}
                  />
                </label>
              ) : null}
              <div className="settings-agent-models">
                <strong>Модели агентов</strong>
                <p className="muted-copy">Пустое значение — использовать модель по умолчанию.</p>
                {agentSlugs.map((slug) => {
                  const current = String(ai.agent_models?.[slug] || "").trim();
                  const selectValue = !current
                    ? DEFAULT_AGENT_MODEL
                    : suggestedModels.includes(current)
                      ? current
                      : CUSTOM_MODEL;
                  return (
                    <div key={slug} className="settings-agent-model">
                      <label>
                        {AGENT_TITLES[slug] || slug}
                        <select
                          value={selectValue}
                          disabled={!canEdit}
                          onChange={(event) => {
                            const value = event.target.value;
                            const agent_models = { ...(ai.agent_models || {}) };
                            if (value === DEFAULT_AGENT_MODEL) {
                              agent_models[slug] = "";
                            } else if (value === CUSTOM_MODEL) {
                              agent_models[slug] = customAgentModels[slug] || current || ai.model;
                            } else {
                              agent_models[slug] = value;
                            }
                            setAiDraft({ ...ai, agent_models });
                          }}
                        >
                          <option value={DEFAULT_AGENT_MODEL}>Как по умолчанию</option>
                          {suggestedModels.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                          <option value={CUSTOM_MODEL}>Другая…</option>
                        </select>
                      </label>
                      {selectValue === CUSTOM_MODEL ? (
                        <label>
                          Имя модели
                          <input
                            value={customAgentModels[slug] || current}
                            disabled={!canEdit}
                            onChange={(event) => {
                              const value = event.target.value;
                              setCustomAgentModels((prev) => ({ ...prev, [slug]: value }));
                              setAiDraft({
                                ...ai,
                                agent_models: { ...(ai.agent_models || {}), [slug]: value },
                              });
                            }}
                          />
                        </label>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <label>
                Модель расшифровки голоса
                <select
                  value={transcribeValue}
                  disabled={!canEdit}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === CUSTOM_MODEL) {
                      setAiDraft({ ...ai, transcribe_model: customTranscribe || ai.transcribe_model });
                    } else {
                      setAiDraft({ ...ai, transcribe_model: value });
                    }
                  }}
                >
                  {transcribeModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                  <option value={CUSTOM_MODEL}>Другая…</option>
                </select>
              </label>
              {transcribeValue === CUSTOM_MODEL ? (
                <label>
                  Имя модели расшифровки
                  <input
                    value={customTranscribe}
                    disabled={!canEdit}
                    onChange={(event) => {
                      setCustomTranscribe(event.target.value);
                      setAiDraft({ ...ai, transcribe_model: event.target.value });
                    }}
                  />
                </label>
              ) : null}
              <label>
                Reasoning effort (GPT-5)
                <select
                  value={ai.reasoning_effort || ""}
                  disabled={!canEdit}
                  onChange={(event) => setAiDraft({ ...ai, reasoning_effort: event.target.value })}
                >
                  <option value="">По умолчанию</option>
                  {(ai.reasoning_efforts || ["none", "low", "medium", "high"]).map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted-copy">
                Параметр отправляется только моделям GPT-5 / o1 / o3. Для GPT-4 не используется.
              </p>
              {hasPermission("ai_customer_test") ? (
                <p className="muted-copy">
                  <Link to="/test-agents">Открыть тест агентов</Link>
                </p>
              ) : null}
              <p className="muted-copy">
                <Link to="/prompts">Редактировать системные промпты</Link>
              </p>
            </form>
          )
        ) : null}

        {tab === "tools" ? (
          aiQuery.isLoading ? (
            <LoadingState />
          ) : !ai ? (
            <p className="empty-state">Не удалось загрузить настройки AI.</p>
          ) : (
            <div className="settings-tools">
              <div className="settings-tools__header">
                <div className="settings-tools__intro">
                  <p className="muted-copy">
                    Инструменты можно включать отдельно для каждого агента. Отключённые для агента
                    инструменты ему не передаются. Проверка ниже вызывает инструмент напрямую (в том
                    числе отключённые).
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
                    {" · "}
                    <Link to="/prompts">Описания инструментов — на странице Промпты</Link>
                  </p>
                </div>
                {canEdit && agentTools.length ? (
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
              {!agentTools.length ? (
                <p className="empty-state">Список инструментов пуст.</p>
              ) : (
                <div className="settings-tools__list">
                  {agentTools.map((tool) => {
                    const agents = (tool.agents || []).filter(isToolAgentSlug);
                    const enabledCount = agents.filter((slug) => toolAgentEnabled(tool, slug)).length;
                    const allEnabled = agents.length > 0 && enabledCount === agents.length;
                    const mixed = enabledCount > 0 && enabledCount < agents.length;
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
                              <strong>{tool.title}</strong>
                              <small className="settings-tool-row__name">{tool.name}</small>
                              <span className="muted-copy">{tool.description}</span>
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
                                  <span>{AGENT_TITLES[slug] || slug}</span>
                                </label>
                              ))}
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
              )}
            </div>
          )
        ) : null}

        {tab === "channels" ? (
          query.isLoading ? (
            <LoadingState />
          ) : !channels.length ? (
            <p className="empty-state">Каналы REGOS не найдены.</p>
          ) : compact ? (
            <EntityCards
              items={channels}
              emptyMessage="Каналы REGOS не найдены."
              getKey={(channel) => String(channel.id)}
              getTitle={(channel) => channel.name}
              getSubtitle={(channel) => `ID: ${channel.id}`}
              getFields={(channel) => [
                {
                  label: "Статус",
                  value: (
                    <span className={`badge ${channel.available ? "badge--ok" : "badge--muted"}`}>
                      {channel.available ? (channel.active ? "Активен" : "Неактивен") : "Удалён из REGOS"}
                    </span>
                  ),
                },
                { label: "Тип взаимодействия", value: modeSelect(channel) },
              ]}
            />
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Канал</th>
                    <th>Статус</th>
                    <th>Тип взаимодействия</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((channel) => (
                    <tr key={channel.id}>
                      <td>
                        <strong>{channel.name}</strong>
                        <br />
                        <small>ID: {channel.id}</small>
                      </td>
                      <td>
                        <span className={`badge ${channel.available ? "badge--ok" : "badge--muted"}`}>
                          {channel.available ? (channel.active ? "Активен" : "Неактивен") : "Удалён из REGOS"}
                        </span>
                      </td>
                      <td>{modeSelect(channel)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}

        {tab === "telegram" ? (
          telegramQuery.isLoading && !telegram ? (
            <LoadingState />
          ) : !telegram ? (
            <p className="empty-state">Не удалось загрузить настройки Telegram-тикетов.</p>
          ) : (
            <form className="stack-form settings-form" onSubmit={(event) => event.preventDefault()}>
              <label className="field-checkbox">
                <input
                  type="checkbox"
                  checked={telegram.enabled}
                  disabled={!canEdit}
                  onChange={(event) =>
                    setTelegramDraft({ ...telegram, enabled: event.target.checked })
                  }
                />
                <span>Принимать вопросы клиентов в Telegram и создавать тикеты REGOS</span>
              </label>
              <label>
                Канал REGOS
                <select
                  value={telegram.channel_id == null ? "" : String(telegram.channel_id)}
                  disabled={!canEdit}
                  required={telegram.enabled}
                  onChange={(event) =>
                    setTelegramDraft({
                      ...telegram,
                      channel_id: event.target.value ? Number(event.target.value) : null,
                    })
                  }
                >
                  <option value="">Выберите канал</option>
                  {telegramChannels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.name || `Канал #${channel.id}`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Направление
                <select
                  value={telegram.direction || "Inbound"}
                  disabled={!canEdit}
                  onChange={(event) =>
                    setTelegramDraft({ ...telegram, direction: event.target.value })
                  }
                >
                  <option value="Inbound">Входящий</option>
                  <option value="Outbound">Исходящий</option>
                </select>
              </label>
              <label>
                Ответственный
                <select
                  value={
                    telegram.responsible_user_id == null
                      ? ""
                      : String(telegram.responsible_user_id)
                  }
                  disabled={!canEdit}
                  onChange={(event) =>
                    setTelegramDraft({
                      ...telegram,
                      responsible_user_id: event.target.value
                        ? Number(event.target.value)
                        : null,
                    })
                  }
                >
                  <option value="">Автоматически</option>
                  {telegramUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.full_name || user.login || `ID ${user.id}`}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field">
                <span>Участники тикета</span>
                <TicketParticipantsPicker
                  users={telegramUsers}
                  value={telegram.participant_user_ids || []}
                  onChange={(ids) =>
                    setTelegramDraft({ ...telegram, participant_user_ids: ids })
                  }
                  disabled={!canEdit}
                />
              </div>
              <label>
                Тема тикета по умолчанию
                <input
                  value={telegram.subject || ""}
                  maxLength={300}
                  disabled={!canEdit}
                  onChange={(event) =>
                    setTelegramDraft({ ...telegram, subject: event.target.value })
                  }
                />
              </label>
              <div className="field">
                <span>Fallback-клиент REGOS</span>
                <p className="hint">
                  Используется, если клиента с телефоном из Telegram не удалось найти или создать.
                </p>
                <div className="firm-search-row">
                  <input
                    value={fallbackClientQuery}
                    disabled={!canEdit}
                    onChange={(event) => setFallbackClientQuery(event.target.value)}
                    placeholder="Имя, телефон или ID"
                  />
                </div>
                {fallbackClientQuery.trim().length >= 2 && !fallbackClients.length ? (
                  <p className="firm-search-status">Клиенты не найдены.</p>
                ) : null}
                <div className="firm-search-results">
                  {fallbackClients.map((client) => (
                    <button
                      key={client.id}
                      type="button"
                      className="firm-search-result"
                      disabled={!canEdit}
                      onClick={() => {
                        setSelectedFallbackClient(client);
                        setTelegramDraft({ ...telegram, fallback_client_id: client.id });
                        setFallbackClientQuery("");
                        setFallbackClients([]);
                      }}
                    >
                      <strong>{client.name || `Клиент #${client.id}`}</strong>
                      <span className="firm-search-result__meta">
                        {[client.phone, client.email].filter(Boolean).join(" · ") ||
                          `ID ${client.id}`}
                      </span>
                    </button>
                  ))}
                </div>
                {selectedFallbackClient || telegram.fallback_client_id ? (
                  <div className="firm-selected">
                    <div className="firm-selected__body">
                      <strong>
                        {selectedFallbackClient?.name ||
                          `Клиент #${telegram.fallback_client_id}`}
                      </strong>
                      <span>
                        {[selectedFallbackClient?.phone, selectedFallbackClient?.email]
                          .filter(Boolean)
                          .join(" · ") || `ID ${telegram.fallback_client_id}`}
                      </span>
                    </div>
                    {canEdit ? (
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => {
                          setSelectedFallbackClient(null);
                          setTelegramDraft({ ...telegram, fallback_client_id: null });
                        }}
                      >
                        Очистить
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {canEdit ? (
                  <label>
                    Или укажите ID клиента
                    <input
                      type="number"
                      min={1}
                      value={telegram.fallback_client_id ?? ""}
                      onChange={(event) => {
                        const raw = event.target.value.trim();
                        const id = raw ? Number(raw) : null;
                        setTelegramDraft({
                          ...telegram,
                          fallback_client_id:
                            id != null && Number.isInteger(id) && id > 0 ? id : null,
                        });
                        if (id != null && Number.isInteger(id) && id > 0) {
                          setSelectedFallbackClient({ id });
                        } else {
                          setSelectedFallbackClient(null);
                        }
                      }}
                    />
                  </label>
                ) : null}
              </div>
            </form>
          )
        ) : null}
      </section>

      <GroupTopicTestModal
        open={groupTestOpen}
        topics={savedTopics}
        onClose={() => setGroupTestOpen(false)}
      />
      <ToolTestModal
        open={Boolean(toolTestName)}
        tool={toolUnderTest}
        onClose={() => setToolTestName(null)}
      />
    </>
  );
}
