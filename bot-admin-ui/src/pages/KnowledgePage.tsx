import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  createKnowledgeArticle,
  deleteKnowledgeArticle,
  getKbSession,
  listKnowledgeArticles,
  lockKnowledgeArticle,
  resetKbSession,
  sendKbChat,
  unlockKnowledgeArticle,
  updateKnowledgeArticle,
} from "../api/ai";
import AgentChatFiles from "../components/AgentChatFiles";
import ChatCompose, { type ChatComposeHandle } from "../components/ChatCompose";
import LoadingState from "../components/LoadingState";
import Modal from "../components/Modal";
import SearchField from "../components/SearchField";
import { useAuth } from "../hooks/useAuth";
import { useConfirm } from "../contexts/ConfirmContext";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { filesFromDataTransfer, isFileDrag } from "../lib/ticket-chat";
import type { KnowledgeArticle } from "../lib/types";

type WorkspaceView = "chat" | "content";

export default function KnowledgePage() {
  const { hasPermission } = useAuth();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const isMobile = useMediaQuery("(max-width: 960px)");
  const canEdit = hasPermission("knowledge_edit");
  const canLock = hasPermission("knowledge_lock");
  const canUnlock = hasPermission("knowledge_unlock");
  const [view, setView] = useState<WorkspaceView>("chat");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState<number | undefined>();
  const [editor, setEditor] = useState<Partial<KnowledgeArticle> | null>(null);
  const [formError, setFormError] = useState("");
  const [dropActive, setDropActive] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<ChatComposeHandle>(null);

  const articlesQuery = useQuery({
    queryKey: ["knowledge-articles", query],
    queryFn: () => listKnowledgeArticles(query),
  });

  const sessionQuery = useQuery({
    queryKey: ["knowledge-session"],
    queryFn: async () => {
      const data = await getKbSession();
      setSessionId(data.session_id);
      return data;
    },
  });

  const saveArticle = useMutation({
    mutationFn: async () => {
      const title = String(editor?.title || "").trim();
      const body = String(editor?.body || "").trim();
      const tags = String(editor?.tags || "").trim();
      if (!title || !body) throw new Error("Укажите заголовок и текст.");
      if (editor?.locked) throw new Error("Статья заблокирована. Изменение недоступно.");
      if (editor?.id) return updateKnowledgeArticle(editor.id, { title, body, tags });
      return createKnowledgeArticle({ title, body, tags });
    },
    onSuccess: () => {
      setEditor(null);
      void queryClient.invalidateQueries({ queryKey: ["knowledge-articles"] });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const removeArticle = useMutation({
    mutationFn: deleteKnowledgeArticle,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["knowledge-articles"] }),
  });

  const lockArticle = useMutation({
    mutationFn: lockKnowledgeArticle,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["knowledge-articles"] }),
  });

  const unlockArticle = useMutation({
    mutationFn: unlockKnowledgeArticle,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["knowledge-articles"] }),
  });

  const chatMutation = useMutation({
    mutationFn: (payload: { message: string; files?: Array<{ name: string; extension: string; data: string }> }) =>
      sendKbChat({ session_id: sessionId, message: payload.message, files: payload.files }),
    onSuccess: (data) => {
      setSessionId(data.session_id);
      setMessage("");
      queryClient.setQueryData(["knowledge-session"], data);
    },
  });

  const clearChatMutation = useMutation({
    mutationFn: () => resetKbSession({ session_id: sessionId }),
    onSuccess: (data) => {
      setSessionId(data.session_id);
      setMessage("");
      queryClient.setQueryData(["knowledge-session"], data);
    },
  });

  const messages = sessionQuery.data?.messages || [];
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, chatMutation.isPending, view]);

  async function handleDelete(article: KnowledgeArticle) {
    if (article.locked) return;
    const ok = await confirm({
      message: `Удалить статью «${article.title}»?`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) removeArticle.mutate(article.id);
  }

  async function handleLock(article: KnowledgeArticle) {
    const ok = await confirm({
      message: `Заблокировать статью «${article.title}»? После этого её нельзя будет изменить или удалить.`,
      confirmLabel: "Заблокировать",
    });
    if (ok) lockArticle.mutate(article.id);
  }

  async function handleUnlock(article: KnowledgeArticle) {
    const ok = await confirm({
      message: `Разблокировать статью «${article.title}»?`,
      confirmLabel: "Разблокировать",
    });
    if (ok) unlockArticle.mutate(article.id);
  }

  async function handleClearChat() {
    const ok = await confirm({
      message: "Удалить историю чата агента базы знаний?",
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) clearChatMutation.mutate();
  }

  const composerEnabled = canEdit && !chatMutation.isPending;

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
    <section className="page page--knowledge">
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
              Статьи
            </button>
          </div>
          {canEdit && view === "content" ? (
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={() => setEditor({ title: "", body: "", tags: "" })}
            >
              Новая статья
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="knowledge-workspace" data-active-view={isMobile ? view : "both"}>
      <section
        className={`card knowledge-workspace__panel knowledge-workspace__panel--articles${
          isMobile && view !== "content" ? " knowledge-workspace__panel--hidden" : ""
        }`}
      >
        {isMobile ? null : (
          <div className="card-toolbar">
            <h2>Статьи</h2>
            {canEdit ? (
              <button type="button" className="btn-primary" onClick={() => setEditor({ title: "", body: "", tags: "" })}>
                Новая статья
              </button>
            ) : null}
          </div>
        )}
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Найти в базе знаний"
          className="knowledge-search"
        />
        {articlesQuery.isLoading ? (
          <LoadingState />
        ) : !(articlesQuery.data?.articles || []).length ? (
          <p className="empty-state">Статей нет.</p>
        ) : (
          <ul className="knowledge-list">
            {(articlesQuery.data?.articles || []).map((article) => {
              const locked = Boolean(article.locked);
              const showActions = (canEdit && !locked) || (canLock && !locked) || (canUnlock && locked);
              return (
                <li key={article.id} className="knowledge-list__item">
                  <div className="knowledge-list__title">
                    <strong>{article.title}</strong>
                    {locked ? <span className="badge badge--warn">Заблокирована</span> : null}
                  </div>
                  {article.tags ? <small>{article.tags}</small> : null}
                  <p>
                    {article.body.slice(0, 180)}
                    {article.body.length > 180 ? "…" : ""}
                  </p>
                  {showActions ? (
                    <div className="cell-actions">
                      {canEdit && !locked ? (
                        <button type="button" className="btn-secondary btn-sm" onClick={() => setEditor(article)}>
                          Изменить
                        </button>
                      ) : null}
                      {canLock && !locked ? (
                        <button type="button" className="btn-secondary btn-sm" onClick={() => void handleLock(article)}>
                          Заблокировать
                        </button>
                      ) : null}
                      {canUnlock && locked ? (
                        <button type="button" className="btn-secondary btn-sm" onClick={() => void handleUnlock(article)}>
                          Разблокировать
                        </button>
                      ) : null}
                      {canEdit && !locked ? (
                        <button type="button" className="btn-danger btn-sm" onClick={() => void handleDelete(article)}>
                          Удалить
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
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
          <h2>Агент базы знаний</h2>
          {canEdit ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleClearChat()}
              disabled={clearChatMutation.isPending || chatMutation.isPending || messages.length === 0}
            >
              Очистить чат
            </button>
          ) : null}
        </div>
        <div
          className={`ticket-chat__messages${dropActive ? " ticket-chat__messages--drop" : ""}`}
          ref={listRef}
        >
          {sessionQuery.isLoading ? <LoadingState /> : null}
          {messages.map((item) => (
            <div
              key={item.id}
              className={`ticket-chat__msg ticket-chat__msg--${item.role === "user" ? "staff" : "client"}`}
            >
              <div className="ticket-chat__meta">
                <span className="ticket-chat__author">{item.role === "user" ? "Вы" : "Агент"}</span>
              </div>
              {item.content.trim() ? <p className="ticket-chat__text">{item.content}</p> : null}
              <AgentChatFiles files={item.files} />
            </div>
          ))}
        </div>
        {canEdit ? (
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
            footer={
              chatMutation.isError || clearChatMutation.isError ? (
                <p className="message error">
                  {((chatMutation.error || clearChatMutation.error) as Error).message}
                </p>
              ) : null
            }
          />
        ) : (
          <p className="empty-state">Нет права изменять базу знаний.</p>
        )}
      </section>
      </div>

      <Modal
        open={editor != null}
        title={editor?.id ? "Редактирование статьи" : "Новая статья"}
        onClose={() => setEditor(null)}
        size="workspace"
      >
        <form
          className="stack-form knowledge-article-form"
          onSubmit={(event) => {
            event.preventDefault();
            setFormError("");
            saveArticle.mutate();
          }}
        >
          <label>
            Заголовок
            <input
              value={editor?.title || ""}
              onChange={(event) => setEditor((prev) => ({ ...prev, title: event.target.value }))}
              required
            />
          </label>
          <label className="knowledge-article-form__body">
            Текст
            <textarea
              rows={8}
              value={editor?.body || ""}
              onChange={(event) => setEditor((prev) => ({ ...prev, body: event.target.value }))}
              required
            />
          </label>
          <label>
            Теги
            <input
              value={editor?.tags || ""}
              onChange={(event) => setEditor((prev) => ({ ...prev, tags: event.target.value }))}
            />
          </label>
          {formError ? <p className="message error">{formError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setEditor(null)}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={saveArticle.isPending || Boolean(editor?.locked)}>
              Сохранить
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
