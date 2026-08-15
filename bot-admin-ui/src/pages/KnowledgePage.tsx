import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  createKnowledgeArticle,
  createKnowledgeCategory,
  deleteKnowledgeArticle,
  deleteKnowledgeCategory,
  getKbSession,
  listKnowledgeArticles,
  listKnowledgeCategories,
  lockKnowledgeArticle,
  resetKbSession,
  sendKbChat,
  unlockKnowledgeArticle,
  updateKnowledgeArticle,
  updateKnowledgeCategory,
} from "../api/ai";
import AgentChatFiles from "../components/AgentChatFiles";
import ChatCompose, { type ChatComposeHandle } from "../components/ChatCompose";
import InfiniteScrollSentinel from "../components/InfiniteScrollSentinel";
import LoadingState from "../components/LoadingState";
import Modal from "../components/Modal";
import SearchField from "../components/SearchField";
import { useAuth } from "../hooks/useAuth";
import { useConfirm } from "../contexts/ConfirmContext";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePagedInfiniteQuery } from "../hooks/usePagedInfiniteQuery";
import { filesFromDataTransfer, isFileDrag } from "../lib/ticket-chat";
import type { KnowledgeArticle, KnowledgeCategory } from "../lib/types";

type WorkspaceView = "chat" | "content";
type CategoryFilter = "all" | "none" | number;

function parseCategoryFilter(value: string): CategoryFilter {
  if (value === "none") return "none";
  if (value === "all" || value === "") return "all";
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : "all";
}

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
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState<number | undefined>();
  const [editor, setEditor] = useState<Partial<KnowledgeArticle> | null>(null);
  const [formError, setFormError] = useState("");
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [categoryEditor, setCategoryEditor] = useState<Partial<KnowledgeCategory> | null>(null);
  const [categoryFormError, setCategoryFormError] = useState("");
  const [dropActive, setDropActive] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<ChatComposeHandle>(null);

  const categoriesQuery = useQuery({
    queryKey: ["knowledge-categories"],
    queryFn: listKnowledgeCategories,
  });
  const categories = categoriesQuery.data?.categories || [];

  const articlesQuery = usePagedInfiniteQuery({
    queryKey: ["knowledge-articles", query, categoryFilter],
    queryFn: (page, pageSize) =>
      listKnowledgeArticles({
        page,
        limit: pageSize,
        q: query || undefined,
        categoryId: categoryFilter === "all" ? undefined : categoryFilter,
      }),
    getItems: (data) => data.articles || [],
    getItemId: (article) => article.id,
  });

  const sessionQuery = useQuery({
    queryKey: ["knowledge-session"],
    queryFn: async () => {
      const data = await getKbSession();
      setSessionId(data.session_id);
      return data;
    },
  });

  function invalidateKnowledge() {
    void queryClient.invalidateQueries({ queryKey: ["knowledge-articles"] });
    void queryClient.invalidateQueries({ queryKey: ["knowledge-categories"] });
  }

  const saveArticle = useMutation({
    mutationFn: async () => {
      const title = String(editor?.title || "").trim();
      const body = String(editor?.body || "").trim();
      const tags = String(editor?.tags || "").trim();
      const category_id = editor?.category_id == null ? null : Number(editor.category_id);
      if (!title || !body) throw new Error("Укажите заголовок и текст.");
      if (editor?.locked) throw new Error("Статья заблокирована. Изменение недоступно.");
      const payload = {
        title,
        body,
        tags,
        category_id: category_id != null && Number.isFinite(category_id) && category_id > 0 ? category_id : null,
      };
      if (editor?.id) return updateKnowledgeArticle(editor.id, payload);
      return createKnowledgeArticle(payload);
    },
    onSuccess: () => {
      setEditor(null);
      invalidateKnowledge();
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const saveCategory = useMutation({
    mutationFn: async () => {
      const name = String(categoryEditor?.name || "").trim();
      const tags = String(categoryEditor?.tags || "").trim();
      if (!name) throw new Error("Укажите название категории.");
      if (categoryEditor?.id) return updateKnowledgeCategory(categoryEditor.id, { name, tags });
      return createKnowledgeCategory({ name, tags });
    },
    onSuccess: () => {
      setCategoryEditor(null);
      setCategoryFormError("");
      invalidateKnowledge();
    },
    onError: (error: Error) => setCategoryFormError(error.message),
  });

  const removeArticle = useMutation({
    mutationFn: deleteKnowledgeArticle,
    onSuccess: () => invalidateKnowledge(),
  });

  const removeCategory = useMutation({
    mutationFn: deleteKnowledgeCategory,
    onSuccess: (_ok, id) => {
      setCategoryFilter((prev) => (prev === id ? "all" : prev));
      invalidateKnowledge();
    },
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

  const articles = articlesQuery.items;
  const total = articlesQuery.total;
  const messages = sessionQuery.data?.messages || [];
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, chatMutation.isPending, view]);

  function openNewArticle() {
    setFormError("");
    setEditor({
      title: "",
      body: "",
      tags: "",
      category_id: typeof categoryFilter === "number" ? categoryFilter : null,
    });
  }

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

  async function handleDeleteCategory(category: KnowledgeCategory) {
    const ok = await confirm({
      message: `Удалить категорию «${category.name}»? Статьи останутся без категории.`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) removeCategory.mutate(category.id);
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

  function articleActions(sizeClass = "") {
    const extra = sizeClass ? ` ${sizeClass}` : "";
    return (
      <>
        <button type="button" className={`btn-secondary${extra}`} onClick={() => setCategoryManagerOpen(true)}>
          Категории
        </button>
        <button type="button" className={`btn-primary${extra}`} onClick={openNewArticle}>
          Новая статья
        </button>
      </>
    );
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
          {canEdit && view === "content" ? <div className="card-toolbar-right">{articleActions("btn-sm")}</div> : null}
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
            {canEdit ? <div className="card-toolbar-right">{articleActions()}</div> : null}
          </div>
        )}
        <label className="knowledge-category-filter">
          <span>Категория</span>
          <select
            value={categoryFilter === "all" ? "all" : String(categoryFilter)}
            onChange={(event) => setCategoryFilter(parseCategoryFilter(event.target.value))}
          >
            <option value="all">Все</option>
            <option value="none">Без категории</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Найти в базе знаний"
          className="knowledge-search"
        />
        <div className="knowledge-list-scroll">
          {articlesQuery.isPending ? (
            <LoadingState />
          ) : !articles.length ? (
            <p className="empty-state">{query || categoryFilter !== "all" ? "Ничего не найдено." : "Статей нет."}</p>
          ) : (
            <ul className="knowledge-list">
              {articles.map((article) => {
                const locked = Boolean(article.locked);
                const showActions = (canEdit && !locked) || (canLock && !locked) || (canUnlock && locked);
                return (
                  <li key={article.id} className="knowledge-list__item">
                    <div className="knowledge-list__title">
                      <strong>{article.title}</strong>
                      {article.category?.name ? <span className="badge badge--muted">{article.category.name}</span> : null}
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
          <InfiniteScrollSentinel
            loaded={articles.length}
            total={total}
            hasNextPage={Boolean(articlesQuery.hasNextPage)}
            isFetchingNextPage={articlesQuery.isFetchingNextPage}
            fetchNextPage={articlesQuery.fetchNextPage}
          />
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
          <label>
            Категория
            <select
              value={editor?.category_id ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setEditor((prev) => ({ ...prev, category_id: value ? Number(value) : null }));
              }}
            >
              <option value="">Без категории</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
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

      <Modal
        open={categoryManagerOpen}
        title="Категории"
        onClose={() => setCategoryManagerOpen(false)}
      >
        <div className="knowledge-category-manager">
          {canEdit ? (
            <div className="form-actions">
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => {
                  setCategoryFormError("");
                  setCategoryEditor({ name: "", tags: "" });
                }}
              >
                Новая категория
              </button>
            </div>
          ) : null}
          {categoriesQuery.isPending ? (
            <LoadingState />
          ) : !categories.length ? (
            <p className="empty-state">Категорий нет.</p>
          ) : (
            <ul className="knowledge-category-list">
              {categories.map((category) => (
                <li key={category.id} className="knowledge-category-list__item">
                  <div>
                    <strong>{category.name}</strong>
                    {category.tags ? <small>{category.tags}</small> : null}
                  </div>
                  {canEdit ? (
                    <div className="cell-actions">
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => {
                          setCategoryFormError("");
                          setCategoryEditor(category);
                        }}
                      >
                        Изменить
                      </button>
                      <button
                        type="button"
                        className="btn-danger btn-sm"
                        onClick={() => void handleDeleteCategory(category)}
                      >
                        Удалить
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>

      <Modal
        open={categoryEditor != null}
        title={categoryEditor?.id ? "Редактирование категории" : "Новая категория"}
        onClose={() => setCategoryEditor(null)}
      >
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            setCategoryFormError("");
            saveCategory.mutate();
          }}
        >
          <label>
            Название
            <input
              value={categoryEditor?.name || ""}
              onChange={(event) => setCategoryEditor((prev) => ({ ...prev, name: event.target.value }))}
              required
            />
          </label>
          <label>
            Теги
            <input
              value={categoryEditor?.tags || ""}
              onChange={(event) => setCategoryEditor((prev) => ({ ...prev, tags: event.target.value }))}
            />
          </label>
          {categoryFormError ? <p className="message error">{categoryFormError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setCategoryEditor(null)}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={saveCategory.isPending}>
              Сохранить
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
