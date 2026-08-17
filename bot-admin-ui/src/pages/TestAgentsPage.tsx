import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  clearTestAgentSessions,
  deleteTestAgentSession,
  getCustomerTestSession,
  getEmployeeTestSession,
  listTestAgentSessions,
  saveCustomerTestSession,
  saveEmployeeTestSession,
  sendCustomerTestChat,
  sendEmployeeTestChat,
} from "../api/ai";
import AgentChatFiles from "../components/AgentChatFiles";
import AgentRunTrace from "../components/AgentRunTrace";
import ChatCompose, { type ChatComposeHandle } from "../components/ChatCompose";
import LoadingState from "../components/LoadingState";
import TestAgentModelPrompt from "../components/TestAgentModelPrompt";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { filesFromDataTransfer, isFileDrag } from "../lib/ticket-chat";
import type { CustomerTestSession, TestAgentSessionSummary } from "../lib/types";

type AgentKind = "customer" | "employee";
type WorkspaceView = "chat" | "content";

function textOrDash(value?: string | number | null) {
  const text = String(value ?? "").trim();
  return text || "—";
}

function sessionKey(kind: AgentKind, sessionId?: number | null) {
  return ["test-agents-session", kind, sessionId ?? "latest"] as const;
}

function historyKey(kind: AgentKind, allUsers: boolean) {
  return ["test-agents-history", kind, allUsers ? "all" : "own"] as const;
}

function formatSessionTime(value?: string) {
  if (!value) return "—";
  const iso = /Z$|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

export default function TestAgentsPage() {
  const confirm = useConfirm();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const isMobile = useMediaQuery("(max-width: 960px)");
  const canSeeAllHistory = hasPermission("ai_customer_test_history");
  const [agentKind, setAgentKind] = useState<AgentKind>("customer");
  const [view, setView] = useState<WorkspaceView>("chat");
  const [ticketId, setTicketId] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [message, setMessage] = useState("");
  const [openedSessionId, setOpenedSessionId] = useState<number | null>(null);
  const [allUsers, setAllUsers] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<ChatComposeHandle>(null);
  const isEmployee = agentKind === "employee";
  const showAllUsers = canSeeAllHistory && allUsers;

  const sessionQuery = useQuery({
    queryKey: sessionKey(agentKind, openedSessionId),
    queryFn: async () => {
      const data = isEmployee
        ? await getEmployeeTestSession(openedSessionId ?? undefined)
        : await getCustomerTestSession(openedSessionId ?? undefined);
      setTicketId(data.ticket_id != null ? String(data.ticket_id) : "");
      setClientPhone(data.client_phone || data.ticket?.client?.phone || "");
      return data;
    },
  });

  const historyQuery = useQuery({
    queryKey: historyKey(agentKind, showAllUsers),
    queryFn: () => listTestAgentSessions(agentKind, showAllUsers),
  });

  useEffect(() => {
    setMessage("");
    setDropActive(false);
    setOpenedSessionId(null);
    setTicketId("");
    setClientPhone("");
  }, [agentKind]);

  function applySession(data: CustomerTestSession) {
    setOpenedSessionId(data.session_id);
    setTicketId(data.ticket_id != null ? String(data.ticket_id) : "");
    setClientPhone(data.client_phone || data.ticket?.client?.phone || "");
    queryClient.setQueryData(sessionKey(agentKind, data.session_id), data);
  }

  function invalidateHistory() {
    void queryClient.invalidateQueries({ queryKey: ["test-agents-history", agentKind] });
  }

  const contextMutation = useMutation({
    mutationFn: () => {
      const payload = {
        session_id: sessionQuery.data?.session_id,
        ticket_id: ticketId.trim() || null,
        client_phone: clientPhone.trim() || null,
      };
      return isEmployee ? saveEmployeeTestSession(payload) : saveCustomerTestSession(payload);
    },
    onSuccess: applySession,
  });

  const resetMutation = useMutation({
    mutationFn: () => {
      const payload = {
        session_id: sessionQuery.data?.session_id,
        ticket_id: ticketId.trim() || null,
        client_phone: clientPhone.trim() || null,
        reset: true,
      };
      return isEmployee ? saveEmployeeTestSession(payload) : saveCustomerTestSession(payload);
    },
    onSuccess: (data) => {
      applySession(data);
      invalidateHistory();
    },
  });

  const chatMutation = useMutation({
    mutationFn: (payload: { message: string; files?: Array<{ name: string; extension: string; data: string }> }) => {
      const body = {
        session_id: sessionQuery.data?.session_id,
        message: payload.message,
        files: payload.files,
        ticket_id: ticketId.trim() || null,
        client_phone: clientPhone.trim() || null,
      };
      return isEmployee ? sendEmployeeTestChat(body) : sendCustomerTestChat(body);
    },
    onSuccess: (data) => {
      setMessage("");
      applySession(data);
      invalidateHistory();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteTestAgentSession(id),
    onSuccess: (_data, id) => {
      invalidateHistory();
      if (sessionQuery.data?.session_id === id) {
        setOpenedSessionId(null);
        void queryClient.invalidateQueries({ queryKey: ["test-agents-session", agentKind] });
      }
    },
  });

  const clearMutation = useMutation({
    mutationFn: () => clearTestAgentSessions({ agent_kind: agentKind, all: showAllUsers }),
    onSuccess: () => {
      setOpenedSessionId(null);
      invalidateHistory();
      void queryClient.invalidateQueries({ queryKey: ["test-agents-session", agentKind] });
    },
  });

  const session = sessionQuery.data;
  const messages = session?.messages || [];
  const ticket = session?.ticket;
  const history = historyQuery.data?.sessions || [];
  const contextError = (contextMutation.error || resetMutation.error || clearMutation.error || deleteMutation.error) as
    | Error
    | null;
  const chatError = chatMutation.error as Error | null;

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, chatMutation.isPending, view, agentKind]);

  async function handleReset() {
    const ok = await confirm({
      message: "Начать новый тестовый чат? Текущая переписка останется в истории сессий.",
      confirmLabel: "Новый чат",
    });
    if (ok) resetMutation.mutate();
  }

  async function handleClearHistory() {
    const ok = await confirm({
      message: showAllUsers
        ? "Удалить историю тестовых чатов всех пользователей для этого агента?"
        : "Удалить всю свою историю тестовых чатов для этого агента?",
      confirmLabel: "Очистить",
    });
    if (ok) clearMutation.mutate();
  }

  async function handleDeleteSession(item: TestAgentSessionSummary) {
    const ok = await confirm({
      message: `Удалить чат «${item.title}»?`,
      confirmLabel: "Удалить",
    });
    if (ok) deleteMutation.mutate(item.id);
  }

  const composerEnabled = !chatMutation.isPending;

  function handlePanelDragEnter(event: DragEvent<HTMLElement>) {
    if (!isFileDrag(event) || !composerEnabled) return;
    event.preventDefault();
    setDropActive(true);
  }

  function handlePanelDragOver(event: DragEvent<HTMLElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (!composerEnabled) return;
    event.dataTransfer.dropEffect = "copy";
  }

  function handlePanelDragLeave(event: DragEvent<HTMLElement>) {
    if (!isFileDrag(event)) return;
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setDropActive(false);
  }

  function handlePanelDrop(event: DragEvent<HTMLElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setDropActive(false);
    if (!composerEnabled) return;
    composeRef.current?.addFiles(filesFromDataTransfer(event.dataTransfer));
  }

  return (
    <section className="page page--knowledge page--test-agents">
      <div className="knowledge-view-header test-agents-header">
        <div className="knowledge-view-tabs role-tabs" role="tablist" aria-label="Тип агента">
          <button
            type="button"
            className={`role-tab${agentKind === "customer" ? " role-tab--active" : ""}`}
            role="tab"
            aria-selected={agentKind === "customer"}
            onClick={() => setAgentKind("customer")}
          >
            Агент клиента
          </button>
          <button
            type="button"
            className={`role-tab${agentKind === "employee" ? " role-tab--active" : ""}`}
            role="tab"
            aria-selected={agentKind === "employee"}
            onClick={() => setAgentKind("employee")}
          >
            Агент сотрудника
          </button>
        </div>
        {isMobile ? (
          <div className="knowledge-view-tabs role-tabs" role="tablist" aria-label="Разделы">
            <button
              type="button"
              className={`role-tab${view === "chat" ? " role-tab--active" : ""}`}
              role="tab"
              aria-selected={view === "chat"}
              onClick={() => setView("chat")}
            >
              Чат
            </button>
            <button
              type="button"
              className={`role-tab${view === "content" ? " role-tab--active" : ""}`}
              role="tab"
              aria-selected={view === "content"}
              onClick={() => setView("content")}
            >
              Контекст
            </button>
          </div>
        ) : null}
      </div>

      <div className="knowledge-workspace" data-active-view={isMobile ? view : "both"}>
        <section
          className={`card knowledge-workspace__panel${
            isMobile && view !== "content" ? " knowledge-workspace__panel--hidden" : ""
          }`}
        >
          <div className="card-toolbar">
            <h2>Контекст</h2>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleReset()}
              disabled={resetMutation.isPending}
            >
              Новый чат
            </button>
          </div>
          <p className="muted-copy">
            {isEmployee
              ? "Песочница агента сотрудника. reply_to_customer, уведомления и назначение ответственного только имитируются и не уходят клиенту."
              : "Песочница агента клиента. Ответы не уходят в REGOS, уведомления сотрудникам и назначение ответственного только имитируются."}
          </p>
          <form
            className="stack-form"
            onSubmit={(event) => {
              event.preventDefault();
              contextMutation.mutate();
            }}
          >
            <label>
              ID тикета
              <input
                value={ticketId}
                onChange={(event) => setTicketId(event.target.value)}
                placeholder="Необязательно"
                inputMode="numeric"
              />
            </label>
            <label>
              Телефон клиента
              <input
                value={clientPhone}
                onChange={(event) => setClientPhone(event.target.value)}
                placeholder="+998…"
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn-primary" disabled={contextMutation.isPending}>
                Применить
              </button>
            </div>
          </form>
          {contextError ? <p className="message error">{contextError.message}</p> : null}
          {ticket?.id ? (
            <dl className="customer-agent-context">
              <div>
                <dt>Тикет</dt>
                <dd>#{ticket.id}</dd>
              </div>
              <div>
                <dt>Статус</dt>
                <dd>{textOrDash(ticket.status)}</dd>
              </div>
              <div>
                <dt>Тема</dt>
                <dd>{textOrDash(ticket.subject)}</dd>
              </div>
              <div>
                <dt>Клиент</dt>
                <dd>{textOrDash(ticket.client?.name)}</dd>
              </div>
              <div>
                <dt>Телефон</dt>
                <dd>{textOrDash(ticket.client?.phone || clientPhone)}</dd>
              </div>
            </dl>
          ) : (
            <p className="empty-state">
              Без тикета агент работает с тестовым клиентом
              {clientPhone.trim() ? ` (${clientPhone.trim()})` : ""}. Можно указать телефон, чтобы
              искать заказы и техподдержку.
            </p>
          )}
          <TestAgentModelPrompt prompt={session?.prompt} title="Промпт модели" />

          <div className="test-agents-history">
            <div className="card-toolbar">
              <h3>История</h3>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void handleClearHistory()}
                disabled={clearMutation.isPending || history.length === 0}
              >
                Очистить
              </button>
            </div>
            {canSeeAllHistory ? (
              <label className="test-agents-history__all">
                <input
                  type="checkbox"
                  checked={allUsers}
                  onChange={(event) => setAllUsers(event.target.checked)}
                />
                Все пользователи
              </label>
            ) : null}
            {historyQuery.isLoading ? <LoadingState /> : null}
            {!historyQuery.isLoading && history.length === 0 ? (
              <p className="empty-state">Нет сохранённых чатов.</p>
            ) : null}
            <ul className="test-agents-history__list">
              {history.map((item) => {
                const active = session?.session_id === item.id;
                return (
                  <li key={item.id} className={`test-agents-history__item${active ? " is-active" : ""}`}>
                    <button
                      type="button"
                      className="test-agents-history__open"
                      onClick={() => setOpenedSessionId(item.id)}
                    >
                      <span className="test-agents-history__title">{item.title}</span>
                      <span className="test-agents-history__meta">
                        {showAllUsers ? `${item.user_name || "—"} · ` : ""}
                        {item.ticket_id ? `#${item.ticket_id} · ` : ""}
                        {formatSessionTime(item.updated_at)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn-secondary test-agents-history__delete"
                      onClick={() => void handleDeleteSession(item)}
                      disabled={deleteMutation.isPending}
                      aria-label="Удалить чат"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        <section
          className={`card knowledge-workspace__panel knowledge-workspace__panel--chat${
            isMobile && view !== "chat" ? " knowledge-workspace__panel--hidden" : ""
          }`}
          onDragEnter={handlePanelDragEnter}
          onDragOver={handlePanelDragOver}
          onDragLeave={handlePanelDragLeave}
          onDrop={handlePanelDrop}
        >
          <div className="card-toolbar">
            <h2>{isEmployee ? "Агент сотрудника" : "Агент клиента"}</h2>
          </div>
          <div
            className={`ticket-chat__messages${dropActive ? " ticket-chat__messages--drop" : ""}`}
            ref={listRef}
          >
            {sessionQuery.isLoading ? <LoadingState /> : null}
            {!sessionQuery.isLoading && messages.length === 0 ? (
              <p className="empty-state">
                {isEmployee
                  ? "Напишите сообщение от имени сотрудника."
                  : "Напишите сообщение от имени клиента."}
              </p>
            ) : null}
            {messages.map((item) => {
              const run = item.run;
              const isUser = item.role === "user";
              const userLabel = isEmployee ? "Сотрудник" : "Клиент";
              const msgSide = isUser ? (isEmployee ? "staff" : "client") : "staff";
              return (
                <div key={item.id} className="test-agents-turn">
                  <div className={`ticket-chat__msg ticket-chat__msg--${msgSide}`}>
                    <div className="ticket-chat__bubble">
                      <div className="ticket-chat__meta">
                        <span className="ticket-chat__author">{isUser ? userLabel : "Агент"}</span>
                      </div>
                      {item.content.trim() ? <p className="ticket-chat__text">{item.content}</p> : null}
                      <AgentChatFiles files={item.files} />
                    </div>
                  </div>
                  {item.role === "assistant" && run ? (
                    <div className="test-agents-turn__trace">
                      {run.replied_to_customer ? (
                        <p className="muted-copy agent-run-trace__sim">
                          reply_to_customer (имитация): {run.customer_reply || "—"}
                        </p>
                      ) : null}
                      <AgentRunTrace
                        trace={run.trace}
                        steps={run.steps}
                        usage={run.usage}
                        stopped={run.stopped}
                      />
                      <TestAgentModelPrompt prompt={run} />
                    </div>
                  ) : null}
                </div>
              );
            })}
            {chatMutation.isPending ? (
              <p className="empty-state agent-run-trace__pending">Агент выполняется…</p>
            ) : null}
          </div>
          <ChatCompose
            ref={composeRef}
            value={message}
            onChange={setMessage}
            allowFiles
            className={dropActive ? "ticket-chat__compose--drop" : ""}
            onSubmit={async ({ text, files }) => {
              if (!text.trim() && !files.length) return;
              await chatMutation.mutateAsync({ message: text.trim(), files });
            }}
            placeholder="Введите сообщение или перетащите файл…"
            busy={chatMutation.isPending}
            footer={chatError ? <p className="message error">{chatError.message}</p> : null}
          />
        </section>
      </div>
    </section>
  );
}
