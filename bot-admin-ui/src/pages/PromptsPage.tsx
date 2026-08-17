import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import {
  activateAiPrompt,
  createAiPrompt,
  createAiPromptVariable,
  deleteAiPrompt,
  deleteAiPromptVariable,
  getAiPromptVariables,
  getAiPrompts,
  getAiToolDescriptions,
  resetAiToolDescription,
  saveAiPrompt,
  saveAiPromptVariable,
  saveAiToolDescription,
  testAiPromptVariable,
} from "../api/ai";
import LoadingState from "../components/LoadingState";
import Modal from "../components/Modal";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import type {
  AiPrompt,
  AiPromptSlug,
  AiPromptType,
  AiPromptVariable,
  AiToolAgentSlug,
  AiToolDescription,
} from "../lib/types";

const PROMPT_TABS: Array<{ slug: AiPromptSlug; title: string }> = [
  { slug: "customer", title: "Агент поддержки" },
  { slug: "customer_assist", title: "Агент поддержки (сотрудник)" },
  { slug: "kb", title: "База знаний" },
  { slug: "ticket_summary", title: "Сводка обращения" },
];

const TOOL_AGENT_TITLES: Record<AiToolAgentSlug, string> = {
  customer: "Агент поддержки",
  customer_assist: "Агент поддержки (сотрудник)",
  kb: "База знаний",
};

type PageTab = "prompts" | "tools";

type PromptEditor = {
  id: number | null;
  type: AiPromptSlug;
  name: string;
  body: string;
};

type VariableEditor = {
  id: number | null;
  key: string;
  name: string;
  source: string;
};

type ToolEditor = {
  name: string;
  title: string;
  body: string;
  default_body: string;
};

function preview(body: string, max = 360) {
  const text = String(body || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function copyName(name: string) {
  const base = String(name || "").trim() || "Промпт";
  const suffix = " (копия)";
  if (base.endsWith(suffix)) return base;
  return `${base}${suffix}`.slice(0, 120);
}

function variableToken(key: string) {
  return `{{${key}}}`;
}

export default function PromptsPage() {
  const { hasPermission } = useAuth();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const canEdit = hasPermission("settings_edit");
  const canCreateVariables = hasPermission("prompt_variables_create");
  const [pageTab, setPageTab] = useState<PageTab>("prompts");
  const [tab, setTab] = useState<AiPromptSlug>("customer");
  const [editor, setEditor] = useState<PromptEditor | null>(null);
  const [toolEditor, setToolEditor] = useState<ToolEditor | null>(null);
  const [formError, setFormError] = useState("");
  const [toolError, setToolError] = useState("");
  const [variableEditor, setVariableEditor] = useState<VariableEditor | null>(null);
  const [variableError, setVariableError] = useState("");
  const [variableTest, setVariableTest] = useState<{ value?: string; error?: string } | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const query = useQuery({
    queryKey: ["ai-prompts"],
    queryFn: getAiPrompts,
  });
  const variablesQuery = useQuery({
    queryKey: ["ai-prompt-variables"],
    queryFn: getAiPromptVariables,
  });
  const toolsQuery = useQuery({
    queryKey: ["ai-tool-descriptions"],
    queryFn: getAiToolDescriptions,
    enabled: pageTab === "tools" || toolEditor != null,
  });

  const types = query.data?.types || [];
  const tabs = types.length ? types : PROMPT_TABS;
  const selected: AiPromptType | undefined = useMemo(
    () => types.find((item) => item.slug === tab) || types[0],
    [tab, types],
  );
  const prompts = selected?.prompts || [];
  const variables = variablesQuery.data?.variables || [];
  const tools = toolsQuery.data?.tools || [];

  function invalidatePrompts() {
    return queryClient.invalidateQueries({ queryKey: ["ai-prompts"] });
  }

  function invalidateVariables() {
    return queryClient.invalidateQueries({ queryKey: ["ai-prompt-variables"] });
  }

  function invalidateTools() {
    return queryClient.invalidateQueries({ queryKey: ["ai-tool-descriptions"] });
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!editor) throw new Error("Промпт не выбран.");
      const name = editor.name.trim();
      const body = editor.body.trim();
      if (!name) throw new Error("Введите название промпта.");
      if (!body) throw new Error("Введите текст промпта.");
      if (editor.id) return saveAiPrompt(editor.id, { name, body });
      return createAiPrompt({ type: editor.type, name, body });
    },
    onSuccess: () => {
      setEditor(null);
      void invalidatePrompts();
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const activateMutation = useMutation({
    mutationFn: (prompt: AiPrompt) => activateAiPrompt({ type: prompt.type, prompt_id: prompt.id }),
    onSuccess: () => void invalidatePrompts(),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAiPrompt,
    onSuccess: () => void invalidatePrompts(),
  });

  const saveVariableMutation = useMutation({
    mutationFn: () => {
      if (!variableEditor) throw new Error("Переменная не выбрана.");
      const name = variableEditor.name.trim();
      const key = variableEditor.key.trim();
      const source = variableEditor.source.trim();
      if (!name) throw new Error("Введите название переменной.");
      if (!key) throw new Error("Введите ключ переменной.");
      if (!source) throw new Error("Введите тело JavaScript-функции.");
      if (variableEditor.id) return saveAiPromptVariable(variableEditor.id, { name, key, source });
      return createAiPromptVariable({ name, key, source });
    },
    onSuccess: () => {
      setVariableEditor(null);
      setVariableTest(null);
      void invalidateVariables();
    },
    onError: (error: Error) => setVariableError(error.message),
  });

  const deleteVariableMutation = useMutation({
    mutationFn: deleteAiPromptVariable,
    onSuccess: () => void invalidateVariables(),
  });

  const testVariableMutation = useMutation({
    mutationFn: () => {
      if (!variableEditor) throw new Error("Переменная не выбрана.");
      const source = variableEditor.source.trim();
      if (!source) throw new Error("Введите тело JavaScript-функции.");
      return testAiPromptVariable({
        id: variableEditor.id ?? undefined,
        source,
      });
    },
    onSuccess: (result) => setVariableTest(result),
    onError: (error: Error) => setVariableError(error.message),
  });

  const saveToolMutation = useMutation({
    mutationFn: () => {
      if (!toolEditor) throw new Error("Инструмент не выбран.");
      const body = toolEditor.body.trim();
      if (!body) throw new Error("Введите описание инструмента.");
      return saveAiToolDescription(toolEditor.name, body);
    },
    onSuccess: () => {
      setToolEditor(null);
      void invalidateTools();
    },
    onError: (error: Error) => setToolError(error.message),
  });

  const resetToolMutation = useMutation({
    mutationFn: (name: string) => resetAiToolDescription(name),
    onSuccess: () => {
      setToolEditor(null);
      void invalidateTools();
    },
  });

  function openCreate(source?: AiPrompt) {
    if (!selected) return;
    setEditor({
      id: null,
      type: selected.slug,
      name: source ? copyName(source.name) : "",
      body: source?.body || selected.prompts.find((item) => item.is_default)?.body || "",
    });
    setFormError("");
  }

  function openEdit(prompt: AiPrompt) {
    if (prompt.id == null) return;
    setEditor({
      id: prompt.id,
      type: prompt.type,
      name: prompt.name,
      body: prompt.body,
    });
    setFormError("");
  }

  function openCreateVariable() {
    setVariableEditor({ id: null, key: "", name: "", source: "return query('SELECT 1 AS ok');\n" });
    setVariableError("");
    setVariableTest(null);
  }

  function openEditVariable(variable: AiPromptVariable) {
    setVariableEditor({
      id: variable.id,
      key: variable.key,
      name: variable.name,
      source: variable.source,
    });
    setVariableError("");
    setVariableTest(null);
  }

  function openEditTool(tool: AiToolDescription) {
    setToolEditor({
      name: tool.name,
      title: tool.title,
      body: tool.body,
      default_body: tool.default_body,
    });
    setToolError("");
  }

  function insertToken(key: string, onBody: (next: string) => void, currentBody: string) {
    const token = variableToken(key);
    const el = bodyRef.current;
    if (!el) {
      onBody(`${currentBody}${token}`);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = `${currentBody.slice(0, start)}${token}${currentBody.slice(end)}`;
    onBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function insertVariable(key: string) {
    setEditor((current) => {
      if (!current) return current;
      let nextBody = current.body;
      insertToken(key, (next) => {
        nextBody = next;
      }, current.body);
      return { ...current, body: nextBody };
    });
  }

  function insertToolVariable(key: string) {
    setToolEditor((current) => {
      if (!current) return current;
      let nextBody = current.body;
      insertToken(
        key,
        (next) => {
          nextBody = next;
        },
        current.body,
      );
      return { ...current, body: nextBody };
    });
  }

  async function handleActivate(prompt: AiPrompt) {
    if (prompt.is_active) return;
    activateMutation.mutate(prompt);
  }

  async function handleDelete(prompt: AiPrompt) {
    if (prompt.id == null) return;
    const ok = await confirm({
      message: prompt.is_active
        ? `Удалить активный промпт «${prompt.name}»? Будет включён промпт по умолчанию.`
        : `Удалить промпт «${prompt.name}»?`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) deleteMutation.mutate(prompt.id);
  }

  async function handleDeleteVariable(variable: AiPromptVariable) {
    const ok = await confirm({
      message: `Удалить переменную «${variable.key}»? В промптах останется ${variableToken(variable.key)}.`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) deleteVariableMutation.mutate(variable.id);
  }

  async function handleResetTool(tool: AiToolDescription) {
    const ok = await confirm({
      message: `Сбросить описание «${tool.title}» к значению по умолчанию?`,
      confirmLabel: "Сбросить",
    });
    if (ok) resetToolMutation.mutate(tool.name);
  }

  return (
    <section className="page page--prompts">
      <div className="role-tabs" role="tablist" aria-label="Разделы промптов">
        <button
          type="button"
          className={`role-tab${pageTab === "prompts" ? " role-tab--active" : ""}`}
          role="tab"
          aria-selected={pageTab === "prompts"}
          onClick={() => setPageTab("prompts")}
        >
          Промпты
        </button>
        <button
          type="button"
          className={`role-tab${pageTab === "tools" ? " role-tab--active" : ""}`}
          role="tab"
          aria-selected={pageTab === "tools"}
          onClick={() => setPageTab("tools")}
        >
          Инструменты
        </button>
      </div>

      {pageTab === "prompts" ? (
        <>
      <section className="card">
        <div className="card-toolbar">
          <div className="role-tabs" role="tablist" aria-label="Типы промптов">
            {tabs.map((item) => (
              <button
                key={item.slug}
                type="button"
                className={`role-tab${(selected?.slug || tab) === item.slug ? " role-tab--active" : ""}`}
                role="tab"
                aria-selected={(selected?.slug || tab) === item.slug}
                onClick={() => setTab(item.slug)}
              >
                {item.title}
              </button>
            ))}
          </div>
          {canEdit && selected ? (
            <div className="card-toolbar-right">
              <button type="button" className="btn-primary" onClick={() => openCreate()}>
                Новый промпт
              </button>
            </div>
          ) : null}
        </div>

        {query.isLoading ? (
          <LoadingState />
        ) : !selected ? (
          <p className="empty-state">Промпты не найдены.</p>
        ) : !prompts.length ? (
          <p className="empty-state">Для этого типа пока нет промптов.</p>
        ) : (
          <ul className="knowledge-list">
            {prompts.map((prompt) => (
              <li
                key={prompt.id ?? `${prompt.type}:default`}
                className={`knowledge-list__item${prompt.is_active ? " knowledge-list__item--active" : ""}`}
              >
                <div className="knowledge-list__title">
                  <strong>{prompt.name}</strong>
                  {prompt.is_active ? <span className="badge badge--ok">Активный</span> : null}
                  {prompt.is_default ? <span className="badge badge--muted">По умолчанию</span> : null}
                </div>
                <p className="prompt-preview">{preview(prompt.body)}</p>
                {canEdit ? (
                  <div className="cell-actions">
                    {!prompt.is_active ? (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => void handleActivate(prompt)}
                        disabled={activateMutation.isPending}
                      >
                        Сделать активным
                      </button>
                    ) : null}
                    {prompt.id != null ? (
                      <button type="button" className="btn-secondary" onClick={() => openEdit(prompt)}>
                        Изменить
                      </button>
                    ) : null}
                    <button type="button" className="btn-secondary" onClick={() => openCreate(prompt)}>
                      Дублировать
                    </button>
                    {prompt.id != null ? (
                      <button type="button" className="btn-danger" onClick={() => void handleDelete(prompt)}>
                        Удалить
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="card-toolbar">
          <h2>Переменные</h2>
          {canCreateVariables ? (
            <div className="card-toolbar-right">
              <button type="button" className="btn-primary" onClick={openCreateVariable}>
                Новая переменная
              </button>
            </div>
          ) : null}
        </div>
        <p className="muted-copy">
          В тексте промпта используйте ключ в виде <code>{"{{price_names}}"}</code>. Функция получает{" "}
          <code>query</code> и <code>context</code> и должна вернуть значение через <code>return</code>.
        </p>
        {variablesQuery.isLoading ? (
          <LoadingState />
        ) : !variables.length ? (
          <p className="empty-state">Переменных пока нет.</p>
        ) : (
          <ul className="knowledge-list">
            {variables.map((variable) => (
              <li key={variable.id} className="knowledge-list__item">
                <div className="knowledge-list__title">
                  <strong>{variable.name}</strong>
                  <span className="badge badge--muted">{variableToken(variable.key)}</span>
                </div>
                <p className="prompt-preview prompt-var-source">{preview(variable.source)}</p>
                {canCreateVariables ? (
                  <div className="cell-actions">
                    <button type="button" className="btn-secondary" onClick={() => openEditVariable(variable)}>
                      Изменить
                    </button>
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={() => void handleDeleteVariable(variable)}
                      disabled={deleteVariableMutation.isPending}
                    >
                      Удалить
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
        </>
      ) : (
        <section className="card">
          <div className="card-toolbar">
            <h2>Описания инструментов</h2>
          </div>
          <p className="muted-copy">
            Этот текст передаётся модели как описание функции. Можно вставлять те же переменные{" "}
            <code>{"{{key}}"}</code>, что и в системных промптах.
          </p>
          {toolsQuery.isLoading ? (
            <LoadingState />
          ) : !tools.length ? (
            <p className="empty-state">Список инструментов пуст.</p>
          ) : (
            <ul className="knowledge-list">
              {tools.map((tool) => (
                <li key={tool.name} className="knowledge-list__item">
                  <div className="knowledge-list__title">
                    <strong>{tool.title}</strong>
                    <span className="badge badge--muted">{tool.name}</span>
                    {tool.is_custom ? <span className="badge badge--ok">Изменено</span> : null}
                  </div>
                  <p className="muted-copy">
                    {(tool.agents || []).map((slug) => TOOL_AGENT_TITLES[slug] || slug).join(" · ")}
                  </p>
                  <p className="prompt-preview">{preview(tool.body)}</p>
                  {canEdit ? (
                    <div className="cell-actions">
                      <button type="button" className="btn-secondary" onClick={() => openEditTool(tool)}>
                        Изменить
                      </button>
                      {tool.is_custom ? (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => void handleResetTool(tool)}
                          disabled={resetToolMutation.isPending}
                        >
                          Сбросить
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <Modal
        open={editor != null}
        title={editor?.id ? "Редактирование промпта" : "Новый промпт"}
        onClose={() => setEditor(null)}
        size="wide"
      >
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            setFormError("");
            saveMutation.mutate();
          }}
        >
          <label>
            Название
            <input
              value={editor?.name || ""}
              onChange={(event) => setEditor((current) => (current ? { ...current, name: event.target.value } : current))}
              maxLength={120}
              required
            />
          </label>
          <label>
            Текст
            <textarea
              ref={bodyRef}
              rows={14}
              value={editor?.body || ""}
              onChange={(event) => setEditor((current) => (current ? { ...current, body: event.target.value } : current))}
              required
            />
          </label>
          {variables.length ? (
            <div>
              <span className="field-hint">Вставить переменную</span>
              <div className="prompt-var-chips">
                {variables.map((variable) => (
                  <button
                    key={variable.id}
                    type="button"
                    className="btn-secondary prompt-var-chip"
                    title={variable.name}
                    onClick={() => insertVariable(variable.key)}
                    disabled={!canEdit}
                  >
                    {variableToken(variable.key)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {formError ? <p className="message error">{formError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setEditor(null)}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={saveMutation.isPending}>
              Сохранить
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={variableEditor != null}
        title={variableEditor?.id ? "Редактирование переменной" : "Новая переменная"}
        onClose={() => setVariableEditor(null)}
        size="wide"
      >
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            setVariableError("");
            saveVariableMutation.mutate();
          }}
        >
          <label>
            Название
            <input
              value={variableEditor?.name || ""}
              onChange={(event) =>
                setVariableEditor((current) => (current ? { ...current, name: event.target.value } : current))
              }
              maxLength={120}
              required
            />
          </label>
          <label>
            Ключ
            <input
              value={variableEditor?.key || ""}
              onChange={(event) =>
                setVariableEditor((current) =>
                  current ? { ...current, key: event.target.value.trim().toLowerCase() } : current,
                )
              }
              maxLength={64}
              pattern="[a-z][a-z0-9_]*"
              required
            />
            <span className="field-hint">Латиница, цифры и _. В промпте: {variableToken(variableEditor?.key || "key")}</span>
          </label>
          <label>
            JavaScript
            <textarea
              className="prompt-var-source"
              rows={12}
              value={variableEditor?.source || ""}
              onChange={(event) =>
                setVariableEditor((current) => (current ? { ...current, source: event.target.value } : current))
              }
              required
            />
            <span className="field-hint">
              Тело функции <code>(query, context)</code>. Вызовите{" "}
              <code>query(&apos;SELECT ...&apos;, params)</code> и верните значение через <code>return</code>.
            </span>
          </label>
          {variableTest?.error ? <p className="message error">{variableTest.error}</p> : null}
          {variableTest?.value != null && !variableTest.error ? (
            <pre className="prompt-var-test">{variableTest.value || "(пусто)"}</pre>
          ) : null}
          {variableError ? <p className="message error">{variableError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setVariableEditor(null)}>
              Отмена
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setVariableError("");
                testVariableMutation.mutate();
              }}
              disabled={testVariableMutation.isPending}
            >
              Проверить
            </button>
            <button type="submit" className="btn-primary" disabled={saveVariableMutation.isPending}>
              Сохранить
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={toolEditor != null}
        title={toolEditor ? `Описание: ${toolEditor.title}` : "Описание инструмента"}
        onClose={() => setToolEditor(null)}
        size="wide"
      >
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            setToolError("");
            saveToolMutation.mutate();
          }}
        >
          <p className="muted-copy">
            <code>{toolEditor?.name}</code>
          </p>
          <label>
            Описание для модели
            <textarea
              ref={bodyRef}
              rows={10}
              maxLength={8000}
              value={toolEditor?.body || ""}
              onChange={(event) =>
                setToolEditor((current) => (current ? { ...current, body: event.target.value } : current))
              }
              required
            />
          </label>
          {variables.length ? (
            <div>
              <span className="field-hint">Вставить переменную</span>
              <div className="prompt-var-chips">
                {variables.map((variable) => (
                  <button
                    key={variable.id}
                    type="button"
                    className="btn-secondary prompt-var-chip"
                    title={variable.name}
                    onClick={() => insertToolVariable(variable.key)}
                    disabled={!canEdit}
                  >
                    {variableToken(variable.key)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {toolError ? <p className="message error">{toolError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setToolEditor(null)}>
              Отмена
            </button>
            {toolEditor && toolEditor.body.trim() !== toolEditor.default_body.trim() ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() =>
                  setToolEditor((current) =>
                    current ? { ...current, body: current.default_body } : current,
                  )
                }
              >
                Сбросить
              </button>
            ) : null}
            <button type="submit" className="btn-primary" disabled={saveToolMutation.isPending || !canEdit}>
              Сохранить
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
