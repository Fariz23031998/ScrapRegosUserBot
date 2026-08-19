import { Sparkles } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  getTicketAiAssistPrompt,
  getTicketAiAssistSession,
  resetTicketAiAssistSession,
  sendTicketAiAssistChat,
} from "../api/ai";
import { useAuth } from "../hooks/useAuth";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAgentChatThread } from "../hooks/useAgentChatThread";
import { filesFromDataTransfer, isFileDrag } from "../lib/ticket-chat";
import type { TicketAiAssistSession } from "../lib/types";
import AgentChatMessages from "./AgentChatMessages";
import AgentPromptModal from "./AgentPromptModal";
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
  const { hasPermission } = useAuth();
  const canViewAiPrompt = hasPermission("tickets_ai_prompt");
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState<number | undefined>();
  const [dropActive, setDropActive] = useState(false);
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
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
        },
        { onDelta: thread.appendDelta },
      ),
    onSuccess: (data) => {
      thread.finishTurn();
      applySession(data);
      if (data.replied_to_customer) {
        setSentNotice("Ответ отправлен клиенту.");
        onCustomerReply?.();
      }
    },
    onError: () => {
      thread.failTurn();
    },
  });

  const messages = thread.messages;
  const chatError = (chatMutation.error || resetMutation.error || sessionQuery.error) as Error | null;
  const composerEnabled = !chatMutation.isPending;

  useEffect(() => {
    if (!open) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [open, messages.length, thread.streamingAssistant?.content, chatMutation.isPending]);

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
              disabled={resetMutation.isPending || !sessionQuery.data}
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
          busy={chatMutation.isPending}
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
