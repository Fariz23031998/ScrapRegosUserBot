import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, MessageSquare, Paperclip, Send } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useParams } from "react-router-dom";
import { createOrder } from "../api/admin";
import {
  getClient,
  getTicket,
  getTicketMessages,
  listTicketUsers,
  searchFirms,
  sendTicketMessage,
  ticketFileUrl,
  ticketRecordingUrl,
  updateTicket,
} from "../api/tickets";
import LoadingState from "../components/LoadingState";
import Modal from "../components/Modal";
import { useAuth } from "../hooks/useAuth";
import { useChatEvents, type ChatStreamEvent } from "../hooks/useChatEvents";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useUiPreferences } from "../hooks/useUiPreferences";
import {
  CHAT_PAGE_LIMIT,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_FILES,
  chatAuthorBadge,
  chatFileDisplayName,
  chatFileHasMetadata,
  chatFileMimeType,
  chatMessageClass,
  fileExtension,
  fileToBase64,
  filesFromDataTransfer,
  formatFileSize,
  isChatAudio,
  isChatImage,
  isChatVideo,
  mergeMessages,
} from "../lib/ticket-chat";
import {
  directionLabel,
  firmTypeLabel,
  formatUnix,
  getTicketClientId,
  statusBadgeClass,
  statusLabel,
  userDisplayName,
} from "../lib/ticket-display";
import type {
  ChatFile,
  ChatMessage,
  FirmSearchResult,
  TicketDetail,
  TicketField,
} from "../lib/types";

type PendingChatFile = {
  id: string;
  file: File;
  previewUrl: string;
};

type ChatViewMode = "chat" | "detail";

function isHttpUrl(value: unknown): boolean {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isAudioUrl(value: unknown): boolean {
  const text = String(value || "").trim();
  if (!isHttpUrl(text)) return false;
  if (/\.(wav|mp3|ogg|oga|m4a|aac|webm)(?:\?|#|$)/i.test(text)) return true;
  if (/\/recordings\//i.test(text)) return true;
  return false;
}

function isRecordingField(field: TicketField | null | undefined): boolean {
  const key = String(field?.key || "").toLowerCase();
  const name = String(field?.name || "").toLowerCase();
  return key.includes("recording") || name.includes("запись") || name.includes("recording");
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ticket-detail__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function textOrDash(value: unknown): string {
  if (value == null || value === "") return "—";
  return String(value);
}

function FieldValue({
  value,
  field,
  ticketId,
}: {
  value: unknown;
  field?: TicketField | null;
  ticketId: number;
}) {
  if (value == null || value === "") return <>—</>;
  const text = String(value).trim();
  if (isAudioUrl(text) || (isHttpUrl(text) && isRecordingField(field))) {
    return (
      <div className="ticket-audio">
        <audio className="ticket-audio__player" controls preload="metadata" src={ticketRecordingUrl(ticketId)}>
          Ваш браузер не поддерживает воспроизведение аудио.
        </audio>
        <a className="ticket-audio__link" href={text} target="_blank" rel="noopener noreferrer">
          {text}
        </a>
      </div>
    );
  }
  if (isHttpUrl(text)) {
    return (
      <a href={text} target="_blank" rel="noopener noreferrer">
        {text}
      </a>
    );
  }
  return <>{text}</>;
}

function ProbeMedia({ url, name }: { url: string; name: string }) {
  const [mode, setMode] = useState<"image" | "video" | "audio" | "link">("image");

  if (mode === "link") {
    return (
      <a className="ticket-chat__file-link" href={url} target="_blank" rel="noopener noreferrer">
        {name}
      </a>
    );
  }
  if (mode === "audio") {
    return (
      <div className="ticket-chat__media ticket-chat__media--audio">
        <audio className="ticket-chat__audio" controls preload="metadata" src={url} onError={() => setMode("link")} />
        <a className="ticket-chat__media-link" href={url} target="_blank" rel="noopener noreferrer">
          {name}
        </a>
      </div>
    );
  }
  if (mode === "video") {
    return (
      <div className="ticket-chat__media ticket-chat__media--video">
        <video
          className="ticket-chat__video"
          controls
          preload="metadata"
          playsInline
          src={url}
          onError={() => setMode("audio")}
        />
        <a className="ticket-chat__media-link" href={url} target="_blank" rel="noopener noreferrer">
          {name}
        </a>
      </div>
    );
  }
  return (
    <div className="ticket-chat__media ticket-chat__media--probe">
      <img
        className="ticket-chat__image ticket-chat__media-probe"
        src={url}
        alt={name}
        loading="lazy"
        onError={() => setMode("video")}
      />
    </div>
  );
}

function ChatFileAttachment({ ticketId, file }: { ticketId: number; file: ChatFile }) {
  const id = file?.id;
  if (id == null || id === "") return null;
  const name = chatFileDisplayName(file);
  const url = ticketFileUrl(ticketId, Number(id));
  const mimeType = chatFileMimeType(file);

  if (isChatImage(file)) {
    return (
      <a className="ticket-chat__image-link" href={url} target="_blank" rel="noopener noreferrer">
        <img className="ticket-chat__image" src={url} alt={name} loading="lazy" />
      </a>
    );
  }
  if (isChatAudio(file)) {
    return (
      <div className="ticket-chat__media ticket-chat__media--audio">
        <audio className="ticket-chat__audio" controls preload="metadata">
          <source src={url} type={mimeType || undefined} />
        </audio>
        <a className="ticket-chat__media-link" href={url} target="_blank" rel="noopener noreferrer">
          {name}
        </a>
      </div>
    );
  }
  if (isChatVideo(file)) {
    return (
      <div className="ticket-chat__media ticket-chat__media--video">
        <video className="ticket-chat__video" controls preload="metadata" playsInline>
          <source src={url} type={mimeType || undefined} />
        </video>
        <a className="ticket-chat__media-link" href={url} target="_blank" rel="noopener noreferrer">
          {name}
        </a>
      </div>
    );
  }
  if (!chatFileHasMetadata(file)) {
    return <ProbeMedia url={url} name={name} />;
  }
  return (
    <a className="ticket-chat__file-link" href={url} target="_blank" rel="noopener noreferrer">
      {name}
    </a>
  );
}

function messageCreatedUnix(message: ChatMessage): number | null {
  const created = Number(message.created_date);
  if (Number.isFinite(created) && created > 0) return created;
  if (message.created_at) {
    const ms = new Date(message.created_at).getTime();
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

function formatMessageDayLabel(message: ChatMessage): string {
  const seconds = messageCreatedUnix(message);
  if (seconds == null) return "";
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

function ChatMessageItem({ ticketId, message }: { ticketId: number; message: ChatMessage }) {
  const messageType = String(message.message_type || "");
  const isSystem = messageType === "System" || Boolean(message.is_system);
  const badge = chatAuthorBadge(message);
  const author =
    message.author_entity_name ||
    message.author_name ||
    (message.author_entity_id != null ? `ID ${message.author_entity_id}` : "Неизвестный");
  const files =
    Array.isArray(message.files) && message.files.length
      ? message.files
      : (Array.isArray(message.file_ids) ? message.file_ids : []).map((fid) => ({ id: fid }));
  const bodyText = String(message.display_text || message.text || "").trim();
  const replyText = message.replay_text || (message.reply_id != null ? `Ответ на ${message.reply_id}` : "");
  const dayLabel = formatMessageDayLabel(message);

  return (
    <article
      className={chatMessageClass(message)}
      data-message-id={String(message.id || "")}
      data-message-day={dayLabel || undefined}
    >
      <div className={`ticket-chat__meta${isSystem ? " ticket-chat__meta--system" : ""}`}>
        {!isSystem ? <span className="ticket-chat__author">{author}</span> : null}
        <span className={badge.className}>{badge.label}</span>
        <time dateTime={String(message.created_date || message.created_at || "")}>
          {formatUnix(message.created_date) !== "—"
            ? formatUnix(message.created_date)
            : message.created_at
              ? formatUnix(Math.floor(new Date(message.created_at).getTime() / 1000))
              : "—"}
        </time>
      </div>
      {replyText ? <div className="ticket-chat__reply">{replyText}</div> : null}
      {bodyText ? (
        <p className="ticket-chat__text">{bodyText}</p>
      ) : files.length || isSystem ? null : (
        <p className="ticket-chat__text ticket-chat__text--empty">—</p>
      )}
      {files.length ? (
        <div className="ticket-chat__files">
          {files.map((file) => (
            <ChatFileAttachment key={String(file.id)} ticketId={ticketId} file={file} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function TicketDetailsBody({
  ticket,
  userNames,
}: {
  ticket: TicketDetail;
  userNames: Record<string, string>;
}) {
  const participantIds = Array.isArray(ticket.participant_user_ids) ? ticket.participant_user_ids : [];
  const participants =
    participantIds.length > 0
      ? participantIds.map((uid) => userDisplayName(uid, userNames)).join(", ")
      : "—";
  const fields = Array.isArray(ticket.fields) ? ticket.fields : [];

  return (
    <div className="ticket-detail-body">
      <section className="ticket-detail__section">
        <h4>Основное</h4>
        <dl className="ticket-detail">
          <DetailRow label="Тема">{textOrDash(ticket.subject)}</DetailRow>
          <DetailRow label="Статус">
            <span className={statusBadgeClass(ticket.status)}>{statusLabel(ticket.status)}</span>
          </DetailRow>
          <DetailRow label="Направление">{directionLabel(ticket.direction)}</DetailRow>
          <DetailRow label="Создан">{formatUnix(ticket.created_date)}</DetailRow>
          <DetailRow label="Обновлён">{formatUnix(ticket.last_update)}</DetailRow>
          <DetailRow label="Описание">
            {ticket.description ? (
              <div className="ticket-detail__description">{ticket.description}</div>
            ) : (
              "—"
            )}
          </DetailRow>
        </dl>
      </section>

      <section className="ticket-detail__section">
        <h4>Клиент</h4>
        <dl className="ticket-detail">
          <DetailRow label="Имя">{textOrDash(ticket.client?.name || ticket.client_name)}</DetailRow>
          <DetailRow label="Телефон">{textOrDash(ticket.client?.phone || ticket.client_phone)}</DetailRow>
          <DetailRow label="Email">{textOrDash(ticket.client?.email)}</DetailRow>
          <DetailRow label="ID клиента">{textOrDash(ticket.client_id ?? ticket.client?.id)}</DetailRow>
        </dl>
      </section>

      <section className="ticket-detail__section">
        <h4>Ответственные</h4>
        <dl className="ticket-detail">
          <DetailRow label="Ответственный">
            {ticket.responsible_name || userDisplayName(ticket.responsible_user_id, userNames)}
          </DetailRow>
          <DetailRow label="Участники">{participants}</DetailRow>
        </dl>
      </section>

      <section className="ticket-detail__section">
        <h4>SLA</h4>
        <dl className="ticket-detail">
          <DetailRow label="Нарушен">{ticket.sla_breached ? "Да" : "Нет"}</DetailRow>
          <DetailRow label="Дата нарушения">{formatUnix(ticket.sla_breached_date)}</DetailRow>
          <DetailRow label="Первый ответ">{formatUnix(ticket.first_response_date)}</DetailRow>
          <DetailRow label="Срок первого ответа">{formatUnix(ticket.first_response_due_date)}</DetailRow>
          <DetailRow label="Срок решения">{formatUnix(ticket.resolve_due_date)}</DetailRow>
          <DetailRow label="Решён">{formatUnix(ticket.resolved_date)}</DetailRow>
          <DetailRow label="Пропущен">{ticket.missed ? "Да" : "Нет"}</DetailRow>
        </dl>
      </section>

      <section className="ticket-detail__section">
        <h4>Оценка</h4>
        <dl className="ticket-detail">
          <DetailRow label="Оценка">{textOrDash(ticket.rating)}</DetailRow>
          <DetailRow label="Комментарий">{textOrDash(ticket.rating_comment)}</DetailRow>
        </dl>
      </section>

      <section className="ticket-detail__section">
        <h4>Настроение клиента</h4>
        <dl className="ticket-detail">
          <DetailRow label="Оценка">{textOrDash(ticket.client_sentiment_score)}</DetailRow>
          <DetailRow label="Комментарий">{textOrDash(ticket.client_sentiment_comment)}</DetailRow>
          <DetailRow label="Кто оценил">
            {userDisplayName(ticket.client_sentiment_user_id, userNames)}
          </DetailRow>
          <DetailRow label="Дата">{formatUnix(ticket.client_sentiment_date)}</DetailRow>
        </dl>
      </section>

      <section className="ticket-detail__section">
        <h4>Проверка супервайзера</h4>
        <dl className="ticket-detail">
          <DetailRow label="Оценка">{textOrDash(ticket.supervisor_review_score)}</DetailRow>
          <DetailRow label="Комментарий">{textOrDash(ticket.supervisor_review_comment)}</DetailRow>
          <DetailRow label="Кто проверил">
            {userDisplayName(ticket.supervisor_review_user_id, userNames)}
          </DetailRow>
          <DetailRow label="Дата">{formatUnix(ticket.supervisor_review_date)}</DetailRow>
        </dl>
      </section>

      <section className="ticket-detail__section">
        <h4>Ссылки</h4>
        <dl className="ticket-detail">
          <DetailRow label="chat_id">{textOrDash(ticket.chat_id)}</DetailRow>
          <DetailRow label="external_dialog_id">{textOrDash(ticket.external_dialog_id)}</DetailRow>
          <DetailRow label="audio_recording_file_id">{textOrDash(ticket.audio_recording_file_id)}</DetailRow>
        </dl>
      </section>

      <section className="ticket-detail__section">
        <h4>Дополнительные поля</h4>
        <dl className="ticket-detail">
          {fields.length ? (
            fields.map((field, index) => (
              <DetailRow key={`${field.key || field.name || "field"}-${index}`} label={field.name || field.key || "Поле"}>
                <FieldValue value={field.value} field={field} ticketId={ticket.id} />
              </DetailRow>
            ))
          ) : (
            <DetailRow label="Нет данных">—</DetailRow>
          )}
        </dl>
      </section>
    </div>
  );
}

function EditTicketModal({
  ticket,
  open,
  users,
  onClose,
  onSaved,
}: {
  ticket: TicketDetail;
  open: boolean;
  users: Array<{ id: number; full_name?: string | null; login?: string | null }>;
  onClose: () => void;
  onSaved: (ticket: TicketDetail) => void;
}) {
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => updateTicket(ticket.id, payload),
    onSuccess: (data) => {
      onSaved(data.ticket);
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  useEffect(() => {
    if (open) setError("");
  }, [open]);

  return (
    <Modal title="Изменить тикет" open={open} onClose={onClose} size="wide">
      {error ? <p className="message error">{error}</p> : null}
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const payload: Record<string, unknown> = {
            subject: String(form.get("subject") || "").trim(),
            description: String(form.get("description") || "").trim(),
            direction: form.get("direction"),
            status: form.get("status"),
          };
          const responsible = String(form.get("responsible_user_id") || "");
          if (responsible) payload.responsible_user_id = Number(responsible);
          mutation.mutate(payload);
        }}
      >
        <label>
          Тема
          <input name="subject" maxLength={300} defaultValue={ticket.subject || ""} />
        </label>
        <label>
          Направление
          <select name="direction" defaultValue={ticket.direction || "Inbound"}>
            <option value="Inbound">Входящий</option>
            <option value="Outbound">Исходящий</option>
          </select>
        </label>
        <label>
          Статус
          <select name="status" defaultValue={ticket.status || "Open"}>
            <option value="Open">Открыт</option>
            <option value="WaitingClient">Ожидание клиента</option>
            <option value="WaitingStaff">Ожидание сотрудника</option>
            <option value="Closed">Закрыт</option>
          </select>
        </label>
        <label>
          Ответственный
          <select
            name="responsible_user_id"
            defaultValue={ticket.responsible_user_id != null ? String(ticket.responsible_user_id) : ""}
          >
            <option value="">Не менять</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.full_name || user.login || `Пользователь #${user.id}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Описание
          <textarea name="description" rows={6} defaultValue={ticket.description || ""} />
        </label>
        <p className="field-hint">Клиент и канал задаются при создании и не изменяются методом Ticket/Edit.</p>
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={mutation.isPending}>
            Отмена
          </button>
          <button type="submit" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CreateOrderModal({
  ticket,
  open,
  onClose,
  onSuccess,
}: {
  ticket: TicketDetail;
  open: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const [error, setError] = useState("");
  const [firmQuery, setFirmQuery] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [selectedFirm, setSelectedFirm] = useState<FirmSearchResult | null>(null);
  const defaultPhone = ticket.client?.phone || ticket.client_phone || "";
  const clientId = getTicketClientId(ticket);

  const linkedClientQuery = useQuery({
    queryKey: ["order-linked-firms", clientId],
    queryFn: () => getClient(clientId!),
    enabled: open && clientId != null,
  });

  const firmSearchQuery = useQuery({
    queryKey: ["order-firm-search", searchQ],
    queryFn: () => searchFirms(searchQ),
    enabled: open && searchQ.trim().length > 0,
  });

  useEffect(() => {
    if (!open) {
      setFirmQuery("");
      setSearchQ("");
      setSelectedFirm(null);
      setError("");
    }
  }, [open]);

  useEffect(() => {
    if (!open || selectedFirm) return;
    const link = linkedClientQuery.data?.firms?.[0];
    if (!link) return;
    setSelectedFirm({
      type: link.firm_type,
      recordId: link.firm_record_id,
      clientName: link.firm_name,
      phone: link.firm_phone,
      message: link.firm_message,
    });
  }, [linkedClientQuery.data?.firms, open, selectedFirm]);

  const orderMutation = useMutation({
    mutationFn: createOrder,
    onSuccess: (data) => {
      onSuccess(
        data.payment_page_url
          ? `Заказ ${data.order.id} создан. Страница оплаты: ${data.payment_page_url}`
          : `Заказ ${data.order.id} создан.`,
      );
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal title="Создать заказ услуги" open={open} onClose={onClose} size="wide">
      {error ? <p className="message error">{error}</p> : null}
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const payload: Record<string, unknown> = {
            amount: form.get("amount"),
            client_phone: String(form.get("client_phone") || "").trim(),
            additional_phone: String(form.get("additional_phone") || "").trim() || undefined,
            ticket_id: ticket.id,
            client_id: clientId,
          };
          if (selectedFirm) {
            payload.client_name = selectedFirm.clientName || undefined;
            payload.client_type = selectedFirm.type || undefined;
            payload.record_id = selectedFirm.recordId ?? undefined;
            payload.firm_message = selectedFirm.message || undefined;
            payload.firm_phone = selectedFirm.phone || undefined;
          } else {
            payload.client_name = ticket.client?.name || ticket.client_name || undefined;
          }
          orderMutation.mutate(payload);
        }}
      >
        <div className="field">
          <span>
            Данные фирмы <span className="field-hint">(необязательно)</span>
          </span>
          <div className="firm-search-row">
            <input
              value={firmQuery}
              onChange={(e) => setFirmQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setSearchQ(firmQuery.trim());
                }
              }}
              placeholder="Имя, компания, телефон, лицензия…"
            />
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => setSearchQ(firmQuery.trim())}
              disabled={firmSearchQuery.isFetching}
            >
              Найти
            </button>
          </div>
          {firmSearchQuery.isFetching ? <p className="firm-search-status">Поиск…</p> : null}
          {!firmSearchQuery.isFetching && searchQ && !(firmSearchQuery.data?.results || []).length ? (
            <p className="firm-search-status">Ничего не найдено.</p>
          ) : null}
          {(firmSearchQuery.data?.results || []).map((firm, index) => (
            <button
              key={`${firm.type}-${firm.recordId}-${index}`}
              type="button"
              className="firm-search-result"
              onClick={() => setSelectedFirm(firm)}
            >
              <strong>{firm.clientName || "Без названия"}</strong>
              <span className="firm-search-result__meta">
                {[firmTypeLabel(firm.type), firm.phone].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
          {selectedFirm ? (
            <div className="firm-selected">
              <div className="firm-selected__body">
                <strong>{selectedFirm.clientName || "Без названия"}</strong>
                <span>
                  {firmTypeLabel(selectedFirm.type)}
                  {selectedFirm.phone ? ` · ${selectedFirm.phone}` : ""}
                </span>
              </div>
              <button type="button" className="btn-secondary btn-sm" onClick={() => setSelectedFirm(null)}>
                Сбросить
              </button>
            </div>
          ) : null}
        </div>
        <label>
          Сумма (сум)
          <input name="amount" type="number" min={1} step={1} required placeholder="Например, 150000" />
        </label>
        <label>
          Телефон клиента
          <input
            name="client_phone"
            type="tel"
            required
            defaultValue={selectedFirm?.phone || defaultPhone}
            key={selectedFirm?.phone || defaultPhone}
          />
        </label>
        <label>
          Дополнительный телефон <span className="field-hint">(необязательно)</span>
          <input name="additional_phone" type="tel" placeholder="Оставьте пустым, чтобы пропустить" />
        </label>
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={orderMutation.isPending}>
            Отмена
          </button>
          <button type="submit" className="btn-primary" disabled={orderMutation.isPending}>
            {orderMutation.isPending ? "Создание…" : "Создать"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function TicketDetailPage() {
  const { id } = useParams();
  const ticketId = Number(id);
  const { hasPermission } = useAuth();
  useUiPreferences();
  const queryClient = useQueryClient();
  const isMobile = useMediaQuery("(max-width: 960px)");
  const [view, setView] = useState<ChatViewMode>("chat");
  const [editOpen, setEditOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatOffset, setChatOffset] = useState(0);
  const [chatTotal, setChatTotal] = useState(0);
  const [chatHasOlder, setChatHasOlder] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const [chatStatus, setChatStatus] = useState<{ message: string; isError?: boolean; loading?: boolean } | null>(
    null,
  );
  const [scrollDateLabel, setScrollDateLabel] = useState("");
  const [scrollDateVisible, setScrollDateVisible] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingChatFile[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [typingLabel, setTypingLabel] = useState<string | null>(null);

  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const pendingSeqRef = useRef(0);
  const chatRequestIdRef = useRef(0);
  const chatIdRef = useRef<string | null>(null);
  const chatMessagesStateRef = useRef<ChatMessage[]>([]);
  const chatOffsetRef = useRef(0);
  const chatHasOlderRef = useRef(false);
  const chatBusyRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const loadOlderChatMessagesRef = useRef<() => Promise<void>>(async () => {});
  const chatRefreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollDateHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressScrollDateRef = useRef(false);
  const scrollDateLabelRef = useRef("");

  useEffect(() => {
    chatIdRef.current = chatId;
  }, [chatId]);
  useEffect(() => {
    chatMessagesStateRef.current = chatMessages;
  }, [chatMessages]);
  useEffect(() => {
    chatOffsetRef.current = chatOffset;
  }, [chatOffset]);
  useEffect(() => {
    chatHasOlderRef.current = chatHasOlder;
  }, [chatHasOlder]);
  useEffect(() => {
    chatBusyRef.current = chatBusy;
  }, [chatBusy]);
  useEffect(() => {
    loadingOlderRef.current = loadingOlder;
  }, [loadingOlder]);

  const ticketQuery = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: () => getTicket(ticketId),
    enabled: Number.isFinite(ticketId),
  });

  const usersQuery = useQuery({
    queryKey: ["ticket-users"],
    queryFn: listTicketUsers,
    enabled: Number.isFinite(ticketId),
  });

  const ticket = ticketQuery.data?.ticket;
  const userNames: Record<string, string> = {};
  for (const user of usersQuery.data?.users || []) {
    userNames[String(user.id)] = user.full_name || user.login || `Пользователь #${user.id}`;
  }

  const canEditTickets = hasPermission("tickets_edit");
  const canEditClosedTickets = hasPermission("tickets_edit_closed");
  const canShowEdit =
    canEditTickets && !(ticket && String(ticket.status || "") === "Closed" && !canEditClosedTickets);

  const clearPendingFiles = useCallback(() => {
    setPendingFiles((prev) => {
      for (const item of prev) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      return [];
    });
  }, []);

  useEffect(() => () => clearPendingFiles(), [clearPendingFiles]);

  const addPendingFiles = useCallback((fileList: File[] | FileList | null | undefined) => {
    const incoming = [...(fileList || [])].filter((file) => file && file.size > 0);
    if (!incoming.length) return;

    setPendingFiles((prev) => {
      const remaining = MAX_CHAT_FILES - prev.length;
      if (remaining <= 0) {
        setChatStatus({ message: `Можно прикрепить не больше ${MAX_CHAT_FILES} файлов.`, isError: true });
        return prev;
      }
      const accepted: PendingChatFile[] = [];
      for (const file of incoming.slice(0, remaining)) {
        if (file.size > MAX_CHAT_FILE_BYTES) {
          setChatStatus({ message: "Файл слишком большой (максимум 10 МБ).", isError: true });
          continue;
        }
        if (!fileExtension(file.name)) {
          setChatStatus({ message: "У файла должно быть расширение.", isError: true });
          continue;
        }
        pendingSeqRef.current += 1;
        accepted.push({
          id: `pending-${pendingSeqRef.current}`,
          file,
          previewUrl: isChatImage(file) ? URL.createObjectURL(file) : "",
        });
      }
      if (!accepted.length) return prev;
      if (incoming.length > remaining) {
        setChatStatus({ message: `Можно прикрепить не больше ${MAX_CHAT_FILES} файлов.`, isError: true });
      }
      return [...prev, ...accepted];
    });
  }, []);

  const removePendingFile = useCallback((pendingId: string) => {
    setPendingFiles((prev) => {
      const next: PendingChatFile[] = [];
      for (const item of prev) {
        if (item.id === pendingId) {
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
          continue;
        }
        next.push(item);
      }
      return next;
    });
  }, []);

  const scrollChat = useCallback(
    ({
      stickToBottom = false,
      preserveOffset,
    }: {
      stickToBottom?: boolean;
      preserveOffset?: { height: number; top: number };
    } = {}) => {
      const el = chatMessagesRef.current;
      if (!el) return;
      suppressScrollDateRef.current = true;
      if (stickToBottom) {
        el.scrollTop = el.scrollHeight;
      } else if (preserveOffset) {
        el.scrollTop = el.scrollHeight - preserveOffset.height + preserveOffset.top;
      }
      requestAnimationFrame(() => {
        suppressScrollDateRef.current = false;
      });
    },
    [],
  );

  const renderChatIntoState = useCallback(
    (
      nextMessages: ChatMessage[],
      meta: { offset: number; total: number; hasOlder: boolean; chatIdValue: string | null },
      opts: { stickToBottom?: boolean; preserveOffset?: { height: number; top: number } } = {},
    ) => {
      const el = chatMessagesRef.current;
      const wasNearBottom = el != null && el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      setChatMessages(nextMessages);
      setChatOffset(meta.offset);
      setChatTotal(meta.total);
      setChatHasOlder(meta.hasOlder);
      setChatId(meta.chatIdValue);
      requestAnimationFrame(() => {
        scrollChat({
          stickToBottom: opts.stickToBottom || wasNearBottom,
          preserveOffset: opts.preserveOffset,
        });
      });
    },
    [scrollChat],
  );

  const loadChatMessages = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!Number.isFinite(ticketId)) return;
      const requestId = ++chatRequestIdRef.current;
      if (!silent) setChatStatus({ message: "Загрузка сообщений…", loading: true });
      setChatBusy(true);
      try {
        const data = await getTicketMessages(ticketId, { from_end: true, limit: CHAT_PAGE_LIMIT });
        if (requestId !== chatRequestIdRef.current) return;
        if (!data.chat_id) {
          setChatMessages([]);
          setChatOffset(0);
          setChatTotal(0);
          setChatHasOlder(false);
          setChatId(null);
          setChatStatus(null);
          return;
        }
        const messages = data.messages || [];
        const total = data.total || messages.length;
        renderChatIntoState(
          messages,
          {
            offset: data.offset || 0,
            total,
            hasOlder: Boolean(data.has_older),
            chatIdValue: data.chat_id,
          },
          { stickToBottom: true },
        );
        setChatStatus(null);
      } catch (err) {
        if (requestId !== chatRequestIdRef.current) return;
        setChatStatus({
          message: err instanceof Error ? err.message : "Не удалось загрузить сообщения.",
          isError: true,
        });
      } finally {
        if (requestId === chatRequestIdRef.current) setChatBusy(false);
      }
    },
    [renderChatIntoState, ticketId],
  );

  const loadOlderChatMessages = useCallback(async () => {
    if (!chatHasOlder || chatOffset <= 0 || !Number.isFinite(ticketId) || loadingOlderRef.current) return;
    const requestId = ++chatRequestIdRef.current;
    const el = chatMessagesRef.current;
    const preserveOffset = el ? { height: el.scrollHeight, top: el.scrollTop } : undefined;
    setLoadingOlder(true);
    setChatBusy(true);
    setChatStatus({ message: "Загрузка предыдущих сообщений…", loading: true });
    try {
      const nextOffset = Math.max(0, chatOffset - CHAT_PAGE_LIMIT);
      const limit = chatOffset - nextOffset;
      const data = await getTicketMessages(ticketId, { limit, offset: nextOffset });
      if (requestId !== chatRequestIdRef.current) return;
      const merged = mergeMessages(chatMessages, data.messages || [], { prepend: true });
      const total = data.total ?? chatTotal;
      renderChatIntoState(
        merged,
        {
          offset: data.offset ?? nextOffset,
          total,
          hasOlder: Boolean(data.has_older),
          chatIdValue: data.chat_id || chatId,
        },
        { preserveOffset },
      );
      setChatStatus(null);
    } catch (err) {
      if (requestId !== chatRequestIdRef.current) return;
      setChatStatus({
        message: err instanceof Error ? err.message : "Не удалось загрузить сообщения.",
        isError: true,
      });
    } finally {
      if (requestId === chatRequestIdRef.current) {
        setChatBusy(false);
        setLoadingOlder(false);
      }
    }
  }, [chatHasOlder, chatOffset, chatMessages, chatTotal, chatId, renderChatIntoState, ticketId]);

  loadOlderChatMessagesRef.current = loadOlderChatMessages;

  useEffect(() => {
    const el = chatMessagesRef.current;
    if (!el || !chatId) return;

    function clearScrollDateHideTimer() {
      if (scrollDateHideTimerRef.current) {
        clearTimeout(scrollDateHideTimerRef.current);
        scrollDateHideTimerRef.current = null;
      }
    }

    function updateVisibleScrollDate() {
      if (!el) return;
      const articles = el.querySelectorAll<HTMLElement>("article[data-message-day]");
      if (!articles.length) return;
      const probeY = el.getBoundingClientRect().top + 28;
      let dayLabel = "";
      for (const article of articles) {
        if (article.getBoundingClientRect().top <= probeY) {
          dayLabel = article.dataset.messageDay || "";
        } else {
          break;
        }
      }
      if (!dayLabel) {
        dayLabel = articles[0]?.dataset.messageDay || "";
      }
      if (dayLabel && dayLabel !== scrollDateLabelRef.current) {
        scrollDateLabelRef.current = dayLabel;
        setScrollDateLabel(dayLabel);
      }
    }

    function onScroll() {
      if (!el) return;
      if (el.scrollTop <= 72 && chatHasOlderRef.current && !chatBusyRef.current && !loadingOlderRef.current) {
        void loadOlderChatMessagesRef.current();
      }
      if (suppressScrollDateRef.current) return;

      updateVisibleScrollDate();
      setScrollDateVisible(true);
      clearScrollDateHideTimer();
      scrollDateHideTimerRef.current = setTimeout(() => {
        scrollDateHideTimerRef.current = null;
        setScrollDateVisible(false);
      }, 1000);
    }

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      clearScrollDateHideTimer();
    };
  }, [chatId]);

  const refreshChatTail = useCallback(async () => {
    if (!chatIdRef.current || !Number.isFinite(ticketId)) return;
    const data = await getTicketMessages(ticketId, { from_end: true, limit: CHAT_PAGE_LIMIT });
    if (!data.chat_id) return;
    const incoming = data.messages || [];
    const existing = chatMessagesStateRef.current;
    const knownIds = new Set(existing.map((m) => String(m.id)));
    const hasNew = incoming.some((m) => m?.id != null && !knownIds.has(String(m.id)));
    if (!hasNew && incoming.length <= existing.length) {
      if (data.total != null) setChatTotal(data.total);
      return;
    }
    const merged = mergeMessages(existing, incoming);
    const total = data.total ?? chatTotal;
    let nextOffset = chatOffsetRef.current;
    let nextHasOlder = chatHasOlder;
    if (typeof data.offset === "number" && data.offset < chatOffsetRef.current) {
      nextOffset = data.offset;
      nextHasOlder = Boolean(data.has_older);
    }
    renderChatIntoState(
      merged,
      {
        offset: nextOffset,
        total,
        hasOlder: nextHasOlder,
        chatIdValue: data.chat_id,
      },
      { stickToBottom: true },
    );
    setChatStatus(null);
  }, [chatHasOlder, chatTotal, renderChatIntoState, ticketId]);

  useEffect(() => {
    if (!Number.isFinite(ticketId)) return;
    setChatMessages([]);
    setChatOffset(0);
    setChatTotal(0);
    setChatHasOlder(false);
    setChatId(null);
    setMessageText("");
    setScrollDateLabel("");
    setScrollDateVisible(false);
    scrollDateLabelRef.current = "";
    clearPendingFiles();
    void loadChatMessages();
  }, [ticketId, loadChatMessages, clearPendingFiles]);

  useEffect(() => {
    setTypingLabel(null);
    if (chatRefreshDebounceRef.current) {
      clearTimeout(chatRefreshDebounceRef.current);
      chatRefreshDebounceRef.current = null;
    }
    if (typingClearTimerRef.current) {
      clearTimeout(typingClearTimerRef.current);
      typingClearTimerRef.current = null;
    }
    if (scrollDateHideTimerRef.current) {
      clearTimeout(scrollDateHideTimerRef.current);
      scrollDateHideTimerRef.current = null;
    }
  }, [ticketId, chatId]);

  useEffect(() => {
    return () => {
      if (chatRefreshDebounceRef.current) clearTimeout(chatRefreshDebounceRef.current);
      if (typingClearTimerRef.current) clearTimeout(typingClearTimerRef.current);
      if (scrollDateHideTimerRef.current) clearTimeout(scrollDateHideTimerRef.current);
    };
  }, []);

  const scheduleChatRefresh = useCallback(() => {
    if (chatRefreshDebounceRef.current) clearTimeout(chatRefreshDebounceRef.current);
    chatRefreshDebounceRef.current = setTimeout(() => {
      chatRefreshDebounceRef.current = null;
      void refreshChatTail().catch(() => {});
    }, 350);
  }, [refreshChatTail]);

  const handleChatChanged = useCallback(
    (event: ChatStreamEvent) => {
      if (event.source_action === "ChatMessageDeleted" && event.message_id) {
        const deletedId = String(event.message_id);
        setChatMessages((prev) => prev.filter((message) => String(message.id) !== deletedId));
      }
      if (event.source_action === "ChatMessageAdded") {
        setTypingLabel(null);
        if (typingClearTimerRef.current) {
          clearTimeout(typingClearTimerRef.current);
          typingClearTimerRef.current = null;
        }
      }
      scheduleChatRefresh();
    },
    [scheduleChatRefresh],
  );

  const handleChatWriting = useCallback((_event: ChatStreamEvent) => {
    setTypingLabel("Печатает…");
    if (typingClearTimerRef.current) clearTimeout(typingClearTimerRef.current);
    typingClearTimerRef.current = setTimeout(() => {
      typingClearTimerRef.current = null;
      setTypingLabel(null);
    }, 3000);
  }, []);

  useChatEvents({
    enabled: Number.isFinite(ticketId),
    chatId,
    onChatChanged: handleChatChanged,
    onChatWriting: handleChatWriting,
  });

  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "visible" && chatIdRef.current) {
        void refreshChatTail().catch(() => {});
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refreshChatTail]);

  const resizeMessageInput = useCallback(() => {
    const el = messageInputRef.current;
    if (!el) return;
    if (!messageText.trim()) {
      el.style.height = "";
      return;
    }
    el.style.height = "0px";
    const next = Math.min(Math.max(el.scrollHeight, 36), 128);
    el.style.height = `${next}px`;
  }, [messageText]);

  useEffect(() => {
    resizeMessageInput();
  }, [messageText, resizeMessageInput]);

  async function handleSend(event?: FormEvent) {
    event?.preventDefault();
    const text = messageText.trim();
    if (!text && !pendingFiles.length) {
      setChatStatus({ message: "Введите текст сообщения или прикрепите файл.", isError: true });
      return;
    }
    if (!chatId) {
      setChatStatus({ message: "Чат не привязан к этому тикету.", isError: true });
      return;
    }
    setSendBusy(true);
    setChatStatus({ message: "Отправка…", loading: true });
    try {
      const files = await Promise.all(
        pendingFiles.map(async (item) => ({
          name: item.file.name,
          extension: fileExtension(item.file.name),
          data: await fileToBase64(item.file),
        })),
      );
      await sendTicketMessage(ticketId, { text, files });
      setMessageText("");
      clearPendingFiles();
      requestAnimationFrame(() => {
        if (messageInputRef.current) messageInputRef.current.style.height = "";
      });
      await refreshChatTail();
      setChatStatus(null);
    } catch (err) {
      setChatStatus({
        message: err instanceof Error ? err.message : "Не удалось отправить сообщение.",
        isError: true,
      });
    } finally {
      setSendBusy(false);
    }
  }

  function isFileDrag(event: DragEvent) {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    return [...types].includes("Files");
  }

  if (!Number.isFinite(ticketId)) {
    return <p className="message error">Некорректный идентификатор тикета.</p>;
  }
  if (ticketQuery.isLoading) return <LoadingState message="Загрузка тикета…" />;
  if (!ticket) return <p className="message error">Тикет не найден.</p>;

  const composerEnabled = Boolean(chatId) && !sendBusy;

  return (
    <div className="page page--ticket-detail">
      <div className="ticket-detail-header">
        <div className="ticket-detail-header__title-row">
          <Link
            to="/tickets"
            className="ticket-detail-header__back"
            aria-label="К списку тикетов"
            title="К списку тикетов"
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </Link>
          <h1>
            Тикет #{ticket.id}
            {ticket.subject ? <span className="header-top__sub"> ({ticket.subject})</span> : null}
          </h1>
          {isMobile ? (
            <div className="ticket-view-tabs role-tabs" role="tablist" aria-label="Разделы тикета">
              <button
                type="button"
                className={`role-tab role-tab--icon${view === "chat" ? " role-tab--active" : ""}`}
                role="tab"
                aria-selected={view === "chat"}
                aria-label="Чат"
                title="Чат"
                onClick={() => setView("chat")}
              >
                <MessageSquare size={18} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`role-tab role-tab--icon${view === "detail" ? " role-tab--active" : ""}`}
                role="tab"
                aria-selected={view === "detail"}
                aria-label="Детали"
                title="Детали"
                onClick={() => setView("detail")}
              >
                <FileText size={18} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {error ? <p className="message error">{error}</p> : null}
      {success ? <p className="message success">{success}</p> : null}

      <div className="ticket-workspace" data-active-view={isMobile ? view : "both"}>
        <section
          className={`card ticket-workspace__panel ticket-workspace__panel--chat${
            isMobile && view !== "chat" ? " ticket-workspace__panel--hidden" : ""
          }`}
          onDragEnter={(event) => {
            if (!isFileDrag(event) || !composerEnabled) return;
            event.preventDefault();
            setDropActive(true);
          }}
          onDragOver={(event) => {
            if (!isFileDrag(event)) return;
            event.preventDefault();
            if (!composerEnabled) return;
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            if (!isFileDrag(event)) return;
            const next = event.relatedTarget as Node | null;
            if (next && event.currentTarget.contains(next)) return;
            setDropActive(false);
          }}
          onDrop={(event) => {
            if (!isFileDrag(event)) return;
            event.preventDefault();
            setDropActive(false);
            if (!composerEnabled) return;
            addPendingFiles(filesFromDataTransfer(event.dataTransfer));
          }}
        >
          <div
            ref={chatMessagesRef}
            className={`ticket-chat__messages${dropActive ? " ticket-chat__messages--drop" : ""}`}
            aria-live="polite"
          >
            <div className="ticket-chat__status-row" aria-live="polite">
              {chatStatus?.isError || chatStatus?.loading ? (
                <p
                  className={`ticket-chat__status${
                    chatStatus.isError
                      ? " ticket-chat__status--error"
                      : " ticket-chat__status--loading"
                  }`}
                >
                  {chatStatus.loading && !chatStatus.isError ? (
                    <span className="process-spinner process-spinner--inline" aria-hidden="true" />
                  ) : null}
                  <span>{chatStatus.message}</span>
                </p>
              ) : scrollDateVisible && scrollDateLabel ? (
                <p className="ticket-chat__status ticket-chat__status--scroll-date">{scrollDateLabel}</p>
              ) : (
                <span className="ticket-chat__status ticket-chat__status--placeholder" aria-hidden="true">
                  &nbsp;
                </span>
              )}
              {typingLabel ? <p className="ticket-chat__typing">{typingLabel}</p> : null}
            </div>

            {loadingOlder ? (
              <div className="ticket-chat__load-older" aria-hidden="true">
                <span className="process-spinner process-spinner--inline" />
              </div>
            ) : null}
            {!chatId && !chatBusy ? (
              <p className="ticket-chat__empty">Чат не привязан к этому тикету.</p>
            ) : chatMessages.length === 0 && !chatBusy ? (
              <p className="ticket-chat__empty">Сообщений пока нет.</p>
            ) : (
              chatMessages.map((message) => (
                <ChatMessageItem key={String(message.id)} ticketId={ticketId} message={message} />
              ))
            )}
          </div>

          {chatId ? (
            <form
              className={`ticket-chat__compose${dropActive ? " ticket-chat__compose--drop" : ""}`}
              onSubmit={(event) => void handleSend(event)}
            >
              {pendingFiles.length ? (
                <div className="ticket-chat__pending">
                  {pendingFiles.map((item) => (
                    <div key={item.id} className="ticket-chat__pending-item">
                      {item.previewUrl ? (
                        <img className="ticket-chat__pending-thumb" src={item.previewUrl} alt="" />
                      ) : null}
                      <span className="ticket-chat__pending-name" title={item.file.name}>
                        {item.file.name}
                      </span>
                      <span className="ticket-chat__pending-size">{formatFileSize(item.file.size)}</span>
                      <button
                        type="button"
                        className="ticket-chat__pending-remove"
                        aria-label="Удалить файл"
                        onClick={() => removePendingFile(item.id)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="ticket-chat__compose-row">
                <label className="ticket-chat__compose-field">
                  <span className="visually-hidden">Сообщение</span>
                  <textarea
                    ref={messageInputRef}
                    rows={1}
                    placeholder="Введите сообщение или перетащите файл…"
                    maxLength={4000}
                    value={messageText}
                    disabled={!composerEnabled}
                    onChange={(e) => setMessageText(e.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.shiftKey) return;
                      event.preventDefault();
                      if (!composerEnabled) return;
                      void handleSend();
                    }}
                    onPaste={(event) => {
                      const files = [...(event.clipboardData?.files || [])].filter((file) => isChatImage(file));
                      if (!files.length) return;
                      event.preventDefault();
                      addPendingFiles(files);
                    }}
                  />
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="visually-hidden"
                  multiple
                  disabled={!composerEnabled}
                  onChange={(event) => {
                    addPendingFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="btn-secondary btn-icon ticket-chat__action-btn"
                  disabled={!composerEnabled}
                  aria-label="Файл"
                  title="Файл"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip size={18} aria-hidden="true" />
                </button>
                <button
                  type="submit"
                  className="btn-primary btn-icon ticket-chat__action-btn"
                  disabled={!composerEnabled}
                  aria-label="Отправить"
                  title="Отправить"
                >
                  {sendBusy ? (
                    <span className="process-spinner process-spinner--inline" aria-hidden="true" />
                  ) : (
                    <Send size={18} aria-hidden="true" />
                  )}
                </button>
              </div>
            </form>
          ) : null}
        </section>

        <section
          className={`card ticket-workspace__panel ticket-workspace__panel--detail${
            isMobile && view !== "detail" ? " ticket-workspace__panel--hidden" : ""
          }`}
        >
          <div className="card-toolbar">
            <h2>Детали</h2>
            <div className="card-toolbar-right">
              {canShowEdit ? (
                <button type="button" className="btn-secondary btn-sm" onClick={() => setEditOpen(true)}>
                  Изменить
                </button>
              ) : null}
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => {
                  setError("");
                  setOrderOpen(true);
                }}
              >
                Создать заказ
              </button>
            </div>
          </div>
          <TicketDetailsBody ticket={ticket} userNames={userNames} />
        </section>
      </div>

      <EditTicketModal
        ticket={ticket}
        open={editOpen}
        users={usersQuery.data?.users || []}
        onClose={() => setEditOpen(false)}
        onSaved={(next) => {
          setSuccess("Тикет обновлён.");
          setError("");
          void queryClient.setQueryData(["ticket", ticketId], { ticket: next });
          void queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] });
        }}
      />

      <CreateOrderModal
        ticket={ticket}
        open={orderOpen}
        onClose={() => setOrderOpen(false)}
        onSuccess={(message) => {
          setSuccess(message);
          setError("");
        }}
      />
    </div>
  );
}
