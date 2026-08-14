import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  getTicketAiAssistSession,
  resetTicketAiAssistSession,
  sendTicketAiAssistChat,
} from "../api/ai";
import { useConfirm } from "../contexts/ConfirmContext";
import { filesFromDataTransfer, isFileDrag } from "../lib/ticket-chat";
import type { TicketAiAssistSession } from "../lib/types";
import AgentChatFiles from "./AgentChatFiles";
import ChatCompose, { type ChatComposeHandle } from "./ChatCompose";
import LoadingState from "./LoadingState";
import Modal from "./Modal";

type TicketAiAssistModalProps = {
  open: boolean;
  ticketId: number;
  onClose: () => void;
  onCustomerReply?: () => void;
};

export default function TicketAiAssistModal({
  open,
  ticketId,
  onClose,
  onCustomerReply,
}: TicketAiAssistModalProps) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState<number | undefined>();
  const [dropActive, setDropActive] = useState(false);
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<ChatComposeHandle>(null);
  const sessionKey = ["ticket-ai-assist", ticketId];

  const sessionQuery = useQuery({
    queryKey: sessionKey,
    queryFn: async () => {
      const data = await getTicketAiAssistSession(ticketId);
      setSessionId(data.session_id);
      return data;
    },
    enabled: open && Number.isFinite(ticketId),
  });

  function applySession(data: TicketAiAssistSession) {
    setSessionId(data.session_id);
    queryClient.setQueryData(sessionKey, data);
  }

  const resetMutation = useMutation({
    mutationFn: () => resetTicketAiAssistSession(ticketId, { session_id: sessionId }),
    onSuccess: (data) => {
      setMessage("");
      setSentNotice(null);
      applySession(data);
    },
  });

  const chatMutation = useMutation({
    mutationFn: (payload: { message: string; files?: Array<{ name: string; extension: string; data: string }> }) =>
      sendTicketAiAssistChat(ticketId, {
        session_id: sessionId,
        message: payload.message,
        files: payload.files,
      }),
    onSuccess: (data) => {
      setMessage("");
      applySession(data);
      if (data.replied_to_customer) {
        setSentNotice("Ответ отправлен клиенту.");
        onCustomerReply?.();
      }
    },
  });

  const messages = sessionQuery.data?.messages || [];
  const chatError = (chatMutation.error || resetMutation.error || sessionQuery.error) as Error | null;
  const composerEnabled = !chatMutation.isPending;

  useEffect(() => {
    if (!open) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [open, messages.length, chatMutation.isPending]);

  async function handleReset() {
    const ok = await confirm({
      message: "Начать новый чат с агентом? Текущая переписка в этом окне будет скрыта.",
      confirmLabel: "Новый чат",
    });
    if (ok) resetMutation.mutate();
  }

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
    <Modal
      open={open}
      title="Агент поддержки"
      size="wide"
      className="modal--ai-assist"
      onClose={onClose}
    >
      <div
        className="ticket-ai-assist"
        onDragEnter={handlePanelDragEnter}
        onDragOver={handlePanelDragOver}
        onDragLeave={handlePanelDragLeave}
        onDrop={handlePanelDrop}
      >
        <div className="ticket-ai-assist__toolbar">
          <p className="muted-copy">
            Закрытый чат с агентом поддержки. Ответы здесь клиент не видит — пока агент не отправит
            сообщение в обращение.
          </p>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => void handleReset()}
            disabled={resetMutation.isPending || !sessionQuery.data}
          >
            Новый чат
          </button>
        </div>
        <div
          className={`ticket-chat__messages${dropActive ? " ticket-chat__messages--drop" : ""}`}
          ref={listRef}
        >
          {sessionQuery.isLoading ? <LoadingState /> : null}
          {!sessionQuery.isLoading && messages.length === 0 ? (
            <p className="empty-state">Напишите подсказку агенту, например какую цену назвать клиенту.</p>
          ) : null}
          {messages.map((item) => (
            <div
              key={item.id}
              className={`ticket-chat__msg ticket-chat__msg--${item.role === "user" ? "staff" : "bot"}`}
            >
              <div className="ticket-chat__meta">
                <span className="ticket-chat__author">{item.role === "user" ? "Вы" : "Агент"}</span>
              </div>
              {item.content.trim() ? <p className="ticket-chat__text">{item.content}</p> : null}
              <AgentChatFiles files={item.files} />
            </div>
          ))}
        </div>
        {sentNotice ? <p className="message success">{sentNotice}</p> : null}
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
          placeholder="Подсказка агенту или перетащите файл…"
          busy={chatMutation.isPending}
          footer={chatError ? <p className="message error">{chatError.message}</p> : null}
        />
      </div>
    </Modal>
  );
}
