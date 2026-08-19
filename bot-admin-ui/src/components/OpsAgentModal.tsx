import { Sparkles } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { getOpsAgentPrompt, getOpsSession, resetOpsSession, sendOpsChat } from "../api/ai";
import { useAuth } from "../hooks/useAuth";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAgentChatThread } from "../hooks/useAgentChatThread";
import { filesFromDataTransfer, isFileDrag } from "../lib/ticket-chat";
import type { KnowledgeChatMessage } from "../lib/types";
import AgentChatMessages from "./AgentChatMessages";
import AgentPromptModal from "./AgentPromptModal";
import ChatCompose, { type ChatComposeHandle } from "./ChatCompose";
import LoadingState from "./LoadingState";
import Modal from "./Modal";

type OpsSession = { session_id: number; messages: KnowledgeChatMessage[] };

type OpsAgentModalProps = {
  open: boolean;
  onClose: () => void;
};

export default function OpsAgentModal({ open, onClose }: OpsAgentModalProps) {
  const confirm = useConfirm();
  const { hasPermission } = useAuth();
  const canViewAiPrompt = hasPermission("tickets_ai_prompt");
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState<number | undefined>();
  const [dropActive, setDropActive] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<ChatComposeHandle>(null);
  const sessionKey = ["ops-session"];

  const sessionQuery = useQuery({
    queryKey: sessionKey,
    queryFn: async () => {
      const data = await getOpsSession();
      setSessionId(data.session_id);
      return data;
    },
    enabled: open,
  });

  function applySession(data: OpsSession) {
    setSessionId(data.session_id);
    queryClient.setQueryData(sessionKey, data);
  }

  const thread = useAgentChatThread(sessionQuery.data?.messages || []);

  const chatMutation = useMutation({
    mutationFn: (payload: { message: string; files: Array<{ name: string; extension: string; data: string }> }) =>
      sendOpsChat(
        { session_id: sessionId, message: payload.message, files: payload.files },
        { onDelta: thread.appendDelta },
      ),
    onSuccess: (data) => {
      thread.finishTurn();
      applySession(data);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      void queryClient.invalidateQueries({ queryKey: ["services"] });
      void queryClient.invalidateQueries({ queryKey: ["repair-returns"] });
    },
    onError: () => {
      thread.failTurn();
    },
  });

  const clearChatMutation = useMutation({
    mutationFn: () => resetOpsSession({ session_id: sessionId }),
    onSuccess: (data) => {
      setMessage("");
      thread.finishTurn();
      applySession(data);
    },
  });

  const messages = thread.messages;
  const chatError = (chatMutation.error || clearChatMutation.error || sessionQuery.error) as Error | null;
  const composerEnabled = !chatMutation.isPending;

  useEffect(() => {
    if (!open) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [open, messages.length, thread.streamingAssistant?.content, chatMutation.isPending]);

  async function handleClearChat() {
    const ok = await confirm({
      message: "Удалить историю чата агента задач?",
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) clearChatMutation.mutate();
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
      title="Агент задач"
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
            Поиск и изменение задач, устройств, услуг и возвратов после ремонта. Перед удалением,
            отменой проведения, оплатой или возвратом агент должен подтвердить действие.
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
              onClick={() => void handleClearChat()}
              disabled={clearChatMutation.isPending || chatMutation.isPending || messages.length === 0}
            >
              Очистить чат
            </button>
          </div>
        </div>
        <div
          className={`ticket-chat__messages${dropActive ? " ticket-chat__messages--drop" : ""}`}
          ref={listRef}
        >
          {sessionQuery.isLoading ? <LoadingState /> : null}
          {!sessionQuery.isLoading && messages.length === 0 ? (
            <p className="empty-state">Напишите, что сделать: найти задачу, добавить устройство или оформить оплату.</p>
          ) : null}
          <AgentChatMessages messages={messages} />
        </div>
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
          placeholder="Введите сообщение или перетащите файл…"
          busy={chatMutation.isPending}
          footer={chatError ? <p className="message error">{chatError.message}</p> : null}
        />
      </div>
    </Modal>
      {canViewAiPrompt ? (
        <AgentPromptModal
          open={open && promptOpen}
          onClose={() => setPromptOpen(false)}
          queryKey={["ops-agent-prompt", sessionId ?? "latest"]}
          queryFn={() => getOpsAgentPrompt(sessionId)}
        />
      ) : null}
    </>
  );
}
