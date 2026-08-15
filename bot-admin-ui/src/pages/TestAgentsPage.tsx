import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  getCustomerTestSession,
  getEmployeeTestSession,
  saveCustomerTestSession,
  saveEmployeeTestSession,
  sendCustomerTestChat,
  sendEmployeeTestChat,
} from "../api/ai";
import AgentChatFiles from "../components/AgentChatFiles";
import AgentRunTrace from "../components/AgentRunTrace";
import ChatCompose, { type ChatComposeHandle } from "../components/ChatCompose";
import LoadingState from "../components/LoadingState";
import { useConfirm } from "../contexts/ConfirmContext";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { filesFromDataTransfer, isFileDrag } from "../lib/ticket-chat";
import type { AgentTraceStep, AgentRunUsage, CustomerTestSession } from "../lib/types";

type AgentKind = "customer" | "employee";
type WorkspaceView = "chat" | "content";

type TurnTrace = {
  trace: AgentTraceStep[];
  steps?: number | null;
  usage?: AgentRunUsage | null;
  stopped?: string | null;
  replied_to_customer?: boolean;
  customer_reply?: string | null;
};

function textOrDash(value?: string | number | null) {
  const text = String(value ?? "").trim();
  return text || "—";
}

function sessionKey(kind: AgentKind) {
  return ["test-agents-session", kind] as const;
}

export default function TestAgentsPage() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const isMobile = useMediaQuery("(max-width: 960px)");
  const [agentKind, setAgentKind] = useState<AgentKind>("customer");
  const [view, setView] = useState<WorkspaceView>("chat");
  const [ticketId, setTicketId] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState<number | undefined>();
  const [dropActive, setDropActive] = useState(false);
  const [tracesByMessageId, setTracesByMessageId] = useState<Record<string, TurnTrace>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<ChatComposeHandle>(null);
  const isEmployee = agentKind === "employee";

  const sessionQuery = useQuery({
    queryKey: sessionKey(agentKind),
    queryFn: async () => {
      const data = isEmployee ? await getEmployeeTestSession() : await getCustomerTestSession();
      setSessionId(data.session_id);
      setTicketId(data.ticket_id != null ? String(data.ticket_id) : "");
      setClientPhone(data.client_phone || data.ticket?.client?.phone || "");
      return data;
    },
  });

  useEffect(() => {
    setMessage("");
    setDropActive(false);
    setTracesByMessageId({});
    const cached = queryClient.getQueryData<CustomerTestSession>(sessionKey(agentKind));
    if (cached) {
      setSessionId(cached.session_id);
      setTicketId(cached.ticket_id != null ? String(cached.ticket_id) : "");
      setClientPhone(cached.client_phone || cached.ticket?.client?.phone || "");
    } else {
      setSessionId(undefined);
      setTicketId("");
      setClientPhone("");
    }
  }, [agentKind, queryClient]);

  function applySession(data: CustomerTestSession) {
    setSessionId(data.session_id);
    setTicketId(data.ticket_id != null ? String(data.ticket_id) : "");
    setClientPhone(data.client_phone || data.ticket?.client?.phone || "");
    queryClient.setQueryData(sessionKey(agentKind), data);
  }

  function rememberTrace(data: CustomerTestSession) {
    const messages = data.messages || [];
    const lastAssistant = [...messages].reverse().find((item) => item.role === "assistant");
    if (!lastAssistant || !Array.isArray(data.trace)) return;
    setTracesByMessageId((prev) => ({
      ...prev,
      [String(lastAssistant.id)]: {
        trace: data.trace || [],
        steps: data.steps,
        usage: data.usage,
        stopped: data.stopped,
        replied_to_customer: data.replied_to_customer,
        customer_reply: data.customer_reply,
      },
    }));
  }

  const contextMutation = useMutation({
    mutationFn: () => {
      const payload = {
        session_id: sessionId,
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
        session_id: sessionId,
        ticket_id: ticketId.trim() || null,
        client_phone: clientPhone.trim() || null,
        reset: true,
      };
      return isEmployee ? saveEmployeeTestSession(payload) : saveCustomerTestSession(payload);
    },
    onSuccess: (data) => {
      setTracesByMessageId({});
      applySession(data);
    },
  });

  const chatMutation = useMutation({
    mutationFn: (payload: { message: string; files?: Array<{ name: string; extension: string; data: string }> }) => {
      const body = {
        session_id: sessionId,
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
      rememberTrace(data);
    },
  });

  const session = sessionQuery.data;
  const messages = session?.messages || [];
  const ticket = session?.ticket;
  const contextError = (contextMutation.error || resetMutation.error) as Error | null;
  const chatError = chatMutation.error as Error | null;

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, chatMutation.isPending, view, agentKind]);

  async function handleReset() {
    const ok = await confirm({
      message: "Начать новый тестовый чат? Текущая переписка останется только в истории сессий.",
      confirmLabel: "Новый чат",
    });
    if (ok) resetMutation.mutate();
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
              const turn = tracesByMessageId[String(item.id)];
              const isUser = item.role === "user";
              const userLabel = isEmployee ? "Сотрудник" : "Клиент";
              const msgSide = isUser ? (isEmployee ? "staff" : "client") : "staff";
              return (
                <div
                  key={item.id}
                  className="test-agents-turn"
                >
                  <div className={`ticket-chat__msg ticket-chat__msg--${msgSide}`}>
                    <div className="ticket-chat__bubble">
                      <div className="ticket-chat__meta">
                        <span className="ticket-chat__author">{isUser ? userLabel : "Агент"}</span>
                      </div>
                      {item.content.trim() ? <p className="ticket-chat__text">{item.content}</p> : null}
                      <AgentChatFiles files={item.files} />
                    </div>
                  </div>
                  {item.role === "assistant" && turn ? (
                    <div className="test-agents-turn__trace">
                      {turn.replied_to_customer ? (
                        <p className="muted-copy agent-run-trace__sim">
                          reply_to_customer (имитация): {turn.customer_reply || "—"}
                        </p>
                      ) : null}
                      <AgentRunTrace
                        trace={turn.trace}
                        steps={turn.steps}
                        usage={turn.usage}
                        stopped={turn.stopped}
                      />
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
