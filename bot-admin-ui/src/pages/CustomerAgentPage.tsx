import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { getCustomerTestSession, saveCustomerTestSession, sendCustomerTestChat } from "../api/ai";
import AgentChatFiles from "../components/AgentChatFiles";
import ChatCompose, { type ChatComposeHandle } from "../components/ChatCompose";
import LoadingState from "../components/LoadingState";
import { useConfirm } from "../contexts/ConfirmContext";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { filesFromDataTransfer, isFileDrag } from "../lib/ticket-chat";
import type { CustomerTestSession } from "../lib/types";

type WorkspaceView = "chat" | "content";

const SESSION_KEY = ["customer-agent-session"];

function textOrDash(value?: string | number | null) {
  const text = String(value ?? "").trim();
  return text || "—";
}

export default function CustomerAgentPage() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const isMobile = useMediaQuery("(max-width: 960px)");
  const [view, setView] = useState<WorkspaceView>("chat");
  const [ticketId, setTicketId] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState<number | undefined>();
  const [dropActive, setDropActive] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<ChatComposeHandle>(null);

  const sessionQuery = useQuery({
    queryKey: SESSION_KEY,
    queryFn: async () => {
      const data = await getCustomerTestSession();
      setSessionId(data.session_id);
      setTicketId(data.ticket_id != null ? String(data.ticket_id) : "");
      setClientPhone(data.client_phone || data.ticket?.client?.phone || "");
      return data;
    },
  });

  function applySession(data: CustomerTestSession) {
    setSessionId(data.session_id);
    setTicketId(data.ticket_id != null ? String(data.ticket_id) : "");
    setClientPhone(data.client_phone || data.ticket?.client?.phone || "");
    queryClient.setQueryData(SESSION_KEY, data);
  }

  const contextMutation = useMutation({
    mutationFn: () =>
      saveCustomerTestSession({
        session_id: sessionId,
        ticket_id: ticketId.trim() || null,
        client_phone: clientPhone.trim() || null,
      }),
    onSuccess: applySession,
  });

  const resetMutation = useMutation({
    mutationFn: () =>
      saveCustomerTestSession({
        session_id: sessionId,
        ticket_id: ticketId.trim() || null,
        client_phone: clientPhone.trim() || null,
        reset: true,
      }),
    onSuccess: applySession,
  });

  const chatMutation = useMutation({
    mutationFn: (payload: { message: string; files?: Array<{ name: string; extension: string; data: string }> }) =>
      sendCustomerTestChat({
        session_id: sessionId,
        message: payload.message,
        files: payload.files,
        ticket_id: ticketId.trim() || null,
        client_phone: clientPhone.trim() || null,
      }),
    onSuccess: (data) => {
      setMessage("");
      applySession(data);
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
  }, [messages.length, chatMutation.isPending, view]);

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
    <section className="page page--knowledge page--customer-agent">
      {isMobile ? (
        <div className="knowledge-view-header">
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
        </div>
      ) : null}
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
          Песочница агента поддержки. Ответы не уходят в REGOS, уведомления сотрудникам и назначение
          ответственного только имитируются.
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
          <h2>Агент поддержки</h2>
        </div>
        <div
          className={`ticket-chat__messages${dropActive ? " ticket-chat__messages--drop" : ""}`}
          ref={listRef}
        >
          {sessionQuery.isLoading ? <LoadingState /> : null}
          {!sessionQuery.isLoading && messages.length === 0 ? (
            <p className="empty-state">Напишите сообщение от имени клиента.</p>
          ) : null}
          {messages.map((item) => (
            <div
              key={item.id}
              className={`ticket-chat__msg ticket-chat__msg--${item.role === "user" ? "client" : "staff"}`}
            >
              <div className="ticket-chat__meta">
                <span className="ticket-chat__author">{item.role === "user" ? "Клиент" : "Агент"}</span>
              </div>
              {item.content.trim() ? <p className="ticket-chat__text">{item.content}</p> : null}
              <AgentChatFiles files={item.files} />
            </div>
          ))}
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
