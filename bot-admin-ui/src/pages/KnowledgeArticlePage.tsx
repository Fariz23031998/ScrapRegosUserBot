import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BadgeCheck,
  BadgeX,
  Lock,
  Pencil,
  Trash2,
  Unlock,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  confirmKnowledgeArticle,
  deleteKnowledgeArticle,
  getKnowledgeArticle,
  listKnowledgeCategories,
  lockKnowledgeArticle,
  unconfirmKnowledgeArticle,
  unlockKnowledgeArticle,
  updateKnowledgeArticle,
  uploadKnowledgeImages,
} from "../api/ai";
import KnowledgeArticleEditor from "../components/KnowledgeArticleEditor";
import LoadingState from "../components/LoadingState";
import MarkdownPreview from "../components/MarkdownPreview";
import Modal from "../components/Modal";
import { useAuth } from "../hooks/useAuth";
import { useConfirm } from "../contexts/ConfirmContext";
import type { KnowledgeArticle } from "../lib/types";

function IconAction({
  label,
  icon: Icon,
  onClick,
  variant = "secondary",
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  variant?: "secondary" | "primary" | "danger";
}) {
  return (
    <button
      type="button"
      className={`btn-${variant} btn-icon btn-sm`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon size={15} aria-hidden="true" />
    </button>
  );
}

export default function KnowledgeArticlePage() {
  const { id } = useParams();
  const articleId = Number(id);
  const validId = Number.isFinite(articleId) && articleId > 0;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("knowledge_edit");
  const canLock = hasPermission("knowledge_lock");
  const canUnlock = hasPermission("knowledge_unlock");
  const canConfirm = hasPermission("knowledge_confirm");
  const [editor, setEditor] = useState<Partial<KnowledgeArticle> | null>(null);
  const [editorPreview, setEditorPreview] = useState(false);
  const [formError, setFormError] = useState("");
  const [uploading, setUploading] = useState(false);

  const articleQuery = useQuery({
    queryKey: ["knowledge-article", articleId],
    queryFn: () => getKnowledgeArticle(articleId),
    enabled: validId,
  });
  const categoriesQuery = useQuery({
    queryKey: ["knowledge-categories"],
    queryFn: listKnowledgeCategories,
  });

  const article = articleQuery.data?.article;
  const categories = categoriesQuery.data?.categories || [];
  const locked = Boolean(article?.locked);
  const confirmed = Boolean(article?.is_confirmed);

  function invalidateArticle() {
    void queryClient.invalidateQueries({ queryKey: ["knowledge-article", articleId] });
    void queryClient.invalidateQueries({ queryKey: ["knowledge-articles"] });
  }

  const saveArticle = useMutation({
    mutationFn: async () => {
      const title = String(editor?.title || "").trim();
      const body = String(editor?.body || "").trim();
      const tags = String(editor?.tags || "").trim();
      const category_id = editor?.category_id == null ? null : Number(editor.category_id);
      if (!title || !body) throw new Error("Укажите заголовок и текст.");
      if (editor?.locked) throw new Error("Статья заблокирована. Изменение недоступно.");
      return updateKnowledgeArticle(articleId, {
        title,
        body,
        tags,
        category_id: category_id != null && Number.isFinite(category_id) && category_id > 0 ? category_id : null,
      });
    },
    onSuccess: (data) => {
      setEditor(null);
      setEditorPreview(false);
      queryClient.setQueryData(["knowledge-article", articleId], data);
      invalidateArticle();
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const removeArticle = useMutation({
    mutationFn: deleteKnowledgeArticle,
    onSuccess: () => {
      invalidateArticle();
      navigate("/knowledge");
    },
  });

  const lockArticle = useMutation({
    mutationFn: lockKnowledgeArticle,
    onSuccess: invalidateArticle,
  });
  const unlockArticle = useMutation({
    mutationFn: unlockKnowledgeArticle,
    onSuccess: invalidateArticle,
  });
  const confirmArticle = useMutation({
    mutationFn: confirmKnowledgeArticle,
    onSuccess: invalidateArticle,
  });
  const unconfirmArticle = useMutation({
    mutationFn: unconfirmKnowledgeArticle,
    onSuccess: invalidateArticle,
  });

  async function handleUpload(files: File[]) {
    if (!article || locked) return;
    setFormError("");
    setUploading(true);
    try {
      const data = await uploadKnowledgeImages(article.id, files);
      setEditor(data.article);
      queryClient.setQueryData(["knowledge-article", articleId], data);
      invalidateArticle();
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete() {
    if (!article || locked) return;
    const ok = await confirm({
      message: `Удалить статью «${article.title}»?`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) removeArticle.mutate(article.id);
  }

  async function handleLock() {
    if (!article) return;
    const ok = await confirm({
      message: `Заблокировать статью «${article.title}»? После этого её нельзя будет изменить или удалить.`,
      confirmLabel: "Заблокировать",
    });
    if (ok) lockArticle.mutate(article.id);
  }

  async function handleUnlock() {
    if (!article) return;
    const ok = await confirm({
      message: `Разблокировать статью «${article.title}»?`,
      confirmLabel: "Разблокировать",
    });
    if (ok) unlockArticle.mutate(article.id);
  }

  async function handleConfirm() {
    if (!article) return;
    const ok = await confirm({
      message: `Подтвердить статью «${article.title}»? После этого её увидят агенты.`,
      confirmLabel: "Подтвердить",
    });
    if (ok) confirmArticle.mutate(article.id);
  }

  async function handleUnconfirm() {
    if (!article) return;
    const ok = await confirm({
      message: `Снять подтверждение со статьи «${article.title}»? Агенты перестанут её видеть.`,
      confirmLabel: "Снять подтверждение",
    });
    if (ok) unconfirmArticle.mutate(article.id);
  }

  if (!validId) {
    return (
      <section className="page page--knowledge-article">
        <p className="message error">Статья не найдена.</p>
        <Link to="/knowledge">К списку статей</Link>
      </section>
    );
  }

  if (articleQuery.isPending) {
    return (
      <section className="page page--knowledge-article">
        <LoadingState />
      </section>
    );
  }

  if (!article) {
    return (
      <section className="page page--knowledge-article">
        <p className="message error">{articleQuery.error instanceof Error ? articleQuery.error.message : "Статья не найдена."}</p>
        <Link to="/knowledge">К списку статей</Link>
      </section>
    );
  }

  return (
    <section className="page page--knowledge-article">
      <div className="ticket-detail-header">
        <div className="ticket-detail-header__title-row">
          <Link to="/knowledge" className="ticket-detail-header__back" aria-label="К списку статей" title="К списку статей">
            <ArrowLeft size={18} aria-hidden="true" />
          </Link>
          <div className="ticket-detail-header__heading">
            <h1>{article.title}</h1>
            <div className="ticket-detail-header__actions">
              {canEdit && !locked ? (
                <IconAction
                  label="Изменить"
                  icon={Pencil}
                  onClick={() => {
                    setFormError("");
                    setEditorPreview(false);
                    setEditor(article);
                  }}
                />
              ) : null}
              {canConfirm && !confirmed ? (
                <IconAction label="Подтвердить" icon={BadgeCheck} variant="primary" onClick={() => void handleConfirm()} />
              ) : null}
              {canConfirm && confirmed ? (
                <IconAction label="Снять подтверждение" icon={BadgeX} onClick={() => void handleUnconfirm()} />
              ) : null}
              {canLock && !locked ? (
                <IconAction label="Заблокировать" icon={Lock} onClick={() => void handleLock()} />
              ) : null}
              {canUnlock && locked ? (
                <IconAction label="Разблокировать" icon={Unlock} onClick={() => void handleUnlock()} />
              ) : null}
              {canEdit && !locked ? (
                <IconAction label="Удалить" icon={Trash2} variant="danger" onClick={() => void handleDelete()} />
              ) : null}
            </div>
          </div>
        </div>
      </div>
      <div className="knowledge-article-meta">
        {article.category?.name ? <span className="badge badge--muted">{article.category.name}</span> : null}
        {locked ? <span className="badge badge--warn">Заблокирована</span> : null}
        {confirmed ? null : <span className="badge badge--warn">Не подтверждена</span>}
        {article.tags ? <small>{article.tags}</small> : null}
        {article.creator ? <small>Создал: {article.creator}</small> : null}
      </div>
      <div className="card knowledge-article-body">
        <MarkdownPreview source={article.body} className="markdown-preview--article" />
      </div>

      <Modal
        open={editor != null}
        title="Редактирование статьи"
        onClose={() => {
          setEditor(null);
          setEditorPreview(false);
        }}
        size="workspace"
      >
        {editor ? (
          <KnowledgeArticleEditor
            editor={editor}
            categories={categories}
            formError={formError}
            saving={saveArticle.isPending}
            uploading={uploading}
            pendingFiles={[]}
            editorPreview={editorPreview}
            onChange={(updater) => setEditor((prev) => (prev ? updater(prev) : prev))}
            onPreviewToggle={() => setEditorPreview((prev) => !prev)}
            onPendingFilesChange={() => undefined}
            onUpload={(files) => void handleUpload(files)}
            onClose={() => {
              setEditor(null);
              setEditorPreview(false);
            }}
            onSubmit={() => {
              setFormError("");
              saveArticle.mutate();
            }}
          />
        ) : null}
      </Modal>
    </section>
  );
}
