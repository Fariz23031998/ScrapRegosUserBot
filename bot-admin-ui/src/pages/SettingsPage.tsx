import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { getAiSettings, saveAiSettings } from "../api/ai";
import { getChannelSettings, saveChannelSettings } from "../api/tickets";
import EntityCards from "../components/EntityCards";
import GroupTopicTestModal from "../components/GroupTopicTestModal";
import LoadingState from "../components/LoadingState";
import { useAuth } from "../hooks/useAuth";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import type { AiGroupTopic, AiPromptSlug, AiSettings, ChannelSetting } from "../lib/types";

const CUSTOM_MODEL = "__custom__";
const DEFAULT_AGENT_MODEL = "__default__";

type SettingsTab = "ai" | "tools" | "channels";

const SETTINGS_TABS: Array<{ id: SettingsTab; title: string }> = [
  { id: "ai", title: "AI" },
  { id: "tools", title: "Инструменты" },
  { id: "channels", title: "Каналы" },
];

const AGENT_TITLES: Record<AiPromptSlug, string> = {
  customer: "Агент поддержки",
  customer_assist: "Агент поддержки (сотрудник)",
  kb: "База знаний",
  ticket_summary: "Сводка обращения",
};

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

function formatAgentLabels(agents: AiPromptSlug[] | undefined) {
  if (!agents?.length) return "";
  return agents.map((slug) => AGENT_TITLES[slug] || slug).join(", ");
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
  const [groupTestOpen, setGroupTestOpen] = useState(false);

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
      const known = settings.models || [];
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
        group_chat_id: settings.group_chat_id || "",
        group_topics: settings.group_topics || [],
        disabled_tools: settings.disabled_tools || [],
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

  const channels = draft.length ? draft : query.data?.channels || [];
  const canEdit = hasPermission("settings_edit");
  const ai = aiDraft || aiQuery.data;
  const savedTopics = (aiQuery.data?.group_topics || []).filter((topic) => String(topic.key || "").trim());
  const canTestGroup = Boolean(canEdit && aiQuery.data?.group_chat_id && savedTopics.length);
  const suggestedModels = ai?.models || ["gpt-4.1", "gpt-4o", "gpt-4o-mini"];
  const transcribeModels = ai?.transcribe_models || ["gpt-4o-transcribe", "gpt-transcribe", "whisper-1"];
  const agentSlugs = ai?.agent_model_slugs || (Object.keys(AGENT_TITLES) as AiPromptSlug[]);
  const modelValue = ai && suggestedModels.includes(ai.model) ? ai.model : CUSTOM_MODEL;
  const transcribeValue =
    ai && transcribeModels.includes(ai.transcribe_model || "") ? ai.transcribe_model || "" : CUSTOM_MODEL;
  const agentTools = ai?.agent_tools || [];
  const disabledTools = new Set(ai?.disabled_tools || []);
  const showAiSave = tab === "ai" || tab === "tools";

  function updateMode(channelId: number, value: ChannelSetting["interaction_mode"]) {
    setDraft((prev) =>
      prev.map((item) => (item.id === channelId ? { ...item, interaction_mode: value } : item)),
    );
  }

  function setToolEnabled(toolName: string, enabled: boolean) {
    if (!ai) return;
    const nextDisabled = new Set(ai.disabled_tools || []);
    if (enabled) nextDisabled.delete(toolName);
    else nextDisabled.add(toolName);
    const disabled_tools = [...nextDisabled];
    setAiDraft({
      ...ai,
      disabled_tools,
      agent_tools: (ai.agent_tools || []).map((tool) =>
        tool.name === toolName ? { ...tool, enabled } : tool,
      ),
    });
  }

  function setAllToolsEnabled(enabled: boolean) {
    if (!ai) return;
    const disabled_tools = enabled ? [] : agentTools.map((tool) => tool.name);
    setAiDraft({
      ...ai,
      disabled_tools,
      agent_tools: (ai.agent_tools || []).map((tool) => ({ ...tool, enabled })),
    });
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
                  <Link to="/customer-agent">Открыть тестовый чат агента поддержки</Link>
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
                <p className="muted-copy">
                  Отключённые инструменты не передаются агентам и недоступны для вызова.
                </p>
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
                    const enabled = !disabledTools.has(tool.name);
                    return (
                      <label key={tool.name} className="settings-tool-row field-checkbox">
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={!canEdit}
                          onChange={(event) => setToolEnabled(tool.name, event.target.checked)}
                        />
                        <span className="settings-tool-row__body">
                          <strong>{tool.title}</strong>
                          <small className="settings-tool-row__name">{tool.name}</small>
                          <span className="muted-copy">{tool.description}</span>
                          <span className="settings-tool-row__agents">
                            {formatAgentLabels(tool.agents)}
                          </span>
                        </span>
                      </label>
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
      </section>

      <GroupTopicTestModal
        open={groupTestOpen}
        topics={savedTopics}
        onClose={() => setGroupTestOpen(false)}
      />
    </>
  );
}
