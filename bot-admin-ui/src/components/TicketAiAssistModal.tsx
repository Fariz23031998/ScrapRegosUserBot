import { Sparkles } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  confirmTicketAiAssistReply,
  getTicketAiAssistPrompt,
  getTicketAiAssistSession,
  resetTicketAiAssistSession,
  sendTicketAiAssistChat,
} from "../api/ai";
import { useAuth } from "../hooks/useAuth";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAgentChatThread } from "../hooks/useAgentChatThread";
import { filesFromDataTransfer, isFileDrag } from "../lib/ticket-chat";
import {
  loadAiAssistConfirmReply,
  saveAiAssistConfirmReply,
} from "../lib/ui-preferences";
import type { TicketAiAssistSession } from "../lib/types";
import AgentChatMessages from "./AgentChatMessages";
import AgentPromptModal from "./AgentPromptModal";
import ChatCompose, { type ChatComposeHandle } from "./ChatCompose";
import LoadingState from "./LoadingState";
import Modal from "./Modal";
import QuickTextPicker from "./QuickTextPicker";

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
  const { hasPermission } = useAuth();
  const canViewAiPrompt = hasPermission("tickets_ai_prompt");
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState<number | undefined>();
  const [dropActive, setDropActive] = useState(false);
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [confirmBeforeSend, setConfirmBeforeSend] = useState(() => loadAiAssistConfirmReply());
  const [pendingReply, setPendingReply] = useState<string | null>(null);
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

  const thread = useAgentChatThread(sessionQuery.data?.messages || []);

  const resetMutation = useMutation({
    mutationFn: () => resetTicketAiAssistSession(ticketId, { session_id: sessionId }),
    onSuccess: (data) => {
      setMessage("");
      setSentNotice(null);
      setPendingReply(null);
      thread.finishTurn();
      applySession(data);
    },
  });

  const chatMutation = useMutation({
    mutationFn: (payload: { message: string; files?: Array<{ name: string; extension: string; data: string }> }) =>
      sendTicketAiAssistChat(
        ticketId,
        {
          session_id: sessionId,
          message: payload.message,
          files: payload.files,
          confirm_before_send: confirmBeforeSend,
        },
        { onDelta: thread.appendDelta },
      ),
    onSuccess: (data) => {
      thread.finishTurn();
      applySession(data);
      if (data.pending_customer_reply) {
        setPendingReply(data.pending_customer_reply);
        setSentNotice(null);
        return;
      }
      setPendingReply(null);
      if (data.replied_to_customer) {
        setSentNotice("Ответ отправлен клиенту.");
        onCustomerReply?.();
      }
    },
    onError: () => {
      thread.failTurn();
    },
  });

  const confirmMutation = useMutation({
    mutationFn: (text: string) =>
      confirmTicketAiAssistReply(ticketId, {
        session_id: sessionId,
        text,
      }),
    onSuccess: (data) => {
      applySession(data);
      setPendingReply(null);
      if (data.replied_to_customer) {
        setSentNotice("Ответ отправлен клиенту.");
        onCustomerReply?.();
      }
    },
  });

  const messages = thread.messages;
  const chatError = (chatMutation.error || resetMutation.error || sessionQuery.error || confirmMutation.error) as Error | null;
  const busy = chatMutation.isPending || confirmMutation.isPending;
  const composerEnabled = !busy;

  useEffect(() => {
    if (!open) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [open, messages.length, thread.streamingAssistant?.content, chatMutation.isPending, pendingReply]);

  async function handleReset() {
    const ok = await confirm({
      message: "Начать новый чат с агентом? Текущая переписка в этом окне будет скрыта.",
      confirmLabel: "Новый чат",
    });
    if (ok) resetMutation.mutate();
  }

  function handleConfirmToggle(checked: boolean) {
    setConfirmBeforeSend(checked);
    saveAiAssistConfirmReply(checked);
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
    <>
    <Modal
      open={open}
      title="Агент поддержки"
      size="wide"
      className="modal--ai-assist"
      onClose={() => {
        setPromptOpen(false);
        onClose();
      }}
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
          <div className="ticket-ai-assist__toolbar-actions">
            <label className="ticket-ai-assist__confirm-toggle">
              <input
                type="checkbox"
                checked={confirmBeforeSend}
                disabled={busy}
                onChange={(event) => handleConfirmToggle(event.target.checked)}
              />
              <span>Подтверждать ответ клиенту</span>
            </label>
            {canViewAiPrompt ? (
              <button
                type="button"
                className="btn-secondary btn-icon"
                aria-label="Промпт ИИ"
                title="Промпт ИИ"
                onClick={() => setPromptOpen(true)}
              >
                <Sparkles size={18} aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => void handleReset()}
              disabled={resetMutation.isPending || !sessionQuery.data || busy}
            >
              Новый чат
            </button>
          </div>
        </div>
        <div
          className={`ticket-chat__messages${dropActive ? " ticket-chat__messages--drop" : ""}`}
          ref={listRef}
        >
          {sessionQuery.isLoading ? <LoadingState /> : null}
          {!sessionQuery.isLoading && messages.length === 0 ? (
            <p className="empty-state">Напишите подсказку агенту, например какую цену назвать клиенту.</p>
          ) : null}
          <AgentChatMessages messages={messages} />
        </div>
        {pendingReply != null ? (
          <div className="ticket-ai-assist__pending">
            <p className="ticket-ai-assist__pending-title">Ответ клиенту (черновик)</p>
            <textarea
              className="ticket-ai-assist__pending-text"
              value={pendingReply}
              rows={4}
              disabled={confirmMutation.isPending}
              onChange={(event) => setPendingReply(event.target.value)}
            />
            <div className="ticket-ai-assist__pending-actions">
              <button
                type="button"
                className="btn-primary btn-sm"
                disabled={confirmMutation.isPending || !pendingReply.trim()}
                onClick={() => confirmMutation.mutate(pendingReply.trim())}
              >
                Отправить клиенту
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={confirmMutation.isPending}
                onClick={() => {
                  setPendingReply(null);
                  confirmMutation.reset();
                }}
              >
                Отменить
              </button>
            </div>
          </div>
        ) : null}
        {sentNotice ? <p className="message success">{sentNotice}</p> : null}
        <ChatCompose
          ref={composeRef}
          value={message}
          onChange={setMessage}
          allowFiles
          className={dropActive ? "ticket-chat__compose--drop" : ""}
          onSubmit={async ({ text, files }) => {
            if (!text.trim() && !files.length) return;
            setMessage("");
            thread.beginUserTurn(text, files, { stream: true });
            await chatMutation.mutateAsync({ message: text.trim(), files });
          }}
          placeholder="Подсказка агенту или перетащите файл…"
          busy={busy}
          extraActions={
            <QuickTextPicker
              kind="ai_assist_prompt"
              value={message}
              onChange={setMessage}
              disabled={busy}
              label="Промпты"
              manageLabel="Управление"
              emptyLabel="Пока нет сохранённых промптов."
            />
          }
          footer={chatError ? <p className="message error">{chatError.message}</p> : null}
        />
      </div>
    </Modal>
      {canViewAiPrompt ? (
        <AgentPromptModal
          open={open && promptOpen}
          onClose={() => setPromptOpen(false)}
          queryKey={["ticket-ai-assist-prompt", ticketId, sessionId ?? "latest"]}
          queryFn={() => getTicketAiAssistPrompt(ticketId, sessionId)}
        />
      ) : null}
    </>
  );
}
