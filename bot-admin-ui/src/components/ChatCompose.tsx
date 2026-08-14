import { Paperclip, Send } from "lucide-react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  fileExtension,
  fileToBase64,
  filesFromDataTransfer,
  formatFileSize,
  isChatImage,
  isFileDrag,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_FILES,
} from "../lib/ticket-chat";

export type ChatComposeUpload = {
  name: string;
  extension: string;
  data: string;
};

export type ChatComposeSubmitPayload = {
  text: string;
  files: ChatComposeUpload[];
};

export type ChatComposeHandle = {
  addFiles: (files: File[] | FileList | null | undefined) => void;
};

type PendingChatFile = {
  id: string;
  file: File;
  previewUrl: string;
};

export type ChatComposeProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (payload: ChatComposeSubmitPayload) => void | Promise<void>;
  placeholder?: string;
  disabled?: boolean;
  busy?: boolean;
  maxLength?: number;
  className?: string;
  allowFiles?: boolean;
  extraActions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onFileError?: (message: string) => void;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  ref?: Ref<ChatComposeHandle>;
};

export default function ChatCompose({
  value,
  onChange,
  onSubmit,
  placeholder = "Введите сообщение…",
  disabled = false,
  busy = false,
  maxLength = 4000,
  className = "",
  allowFiles = false,
  extraActions,
  children,
  footer,
  onFileError,
  onPaste,
  ref,
}: ChatComposeProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingSeqRef = useRef(0);
  const [pendingFiles, setPendingFiles] = useState<PendingChatFile[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const enabled = !disabled && !busy;

  const reportFileError = useCallback(
    (message: string) => {
      setFileError(message);
      onFileError?.(message);
    },
    [onFileError],
  );

  const clearPendingFiles = useCallback(() => {
    setPendingFiles((prev) => {
      for (const item of prev) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      return [];
    });
  }, []);

  useEffect(() => () => clearPendingFiles(), [clearPendingFiles]);

  const addFiles = useCallback(
    (fileList: File[] | FileList | null | undefined) => {
      const incoming = [...(fileList || [])].filter((file) => file && file.size > 0);
      if (!incoming.length) return;

      setPendingFiles((prev) => {
        const remaining = MAX_CHAT_FILES - prev.length;
        if (remaining <= 0) {
          reportFileError(`Можно прикрепить не больше ${MAX_CHAT_FILES} файлов.`);
          return prev;
        }
        const accepted: PendingChatFile[] = [];
        for (const file of incoming.slice(0, remaining)) {
          if (file.size > MAX_CHAT_FILE_BYTES) {
            reportFileError("Файл слишком большой (максимум 10 МБ).");
            continue;
          }
          if (!fileExtension(file.name)) {
            reportFileError("У файла должно быть расширение.");
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
          reportFileError(`Можно прикрепить не больше ${MAX_CHAT_FILES} файлов.`);
        } else {
          setFileError(null);
        }
        return [...prev, ...accepted];
      });
    },
    [reportFileError],
  );

  useImperativeHandle(ref, () => ({ addFiles }), [addFiles]);

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

  const resize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    if (!value.trim()) {
      el.style.height = "";
      return;
    }
    el.style.height = "0px";
    const next = Math.min(Math.max(el.scrollHeight, 36), 128);
    el.style.height = `${next}px`;
  }, [value]);

  useEffect(() => {
    resize();
  }, [value, resize]);

  async function submit() {
    if (!enabled) return;
    const snapshot = pendingFiles;
    const files = allowFiles
      ? await Promise.all(
          snapshot.map(async (item) => ({
            name: item.file.name,
            extension: fileExtension(item.file.name),
            data: await fileToBase64(item.file),
          })),
        )
      : [];
    await onSubmit({ text: value, files });
    setPendingFiles((prev) => {
      const sent = new Set(snapshot.map((item) => item.id));
      const next: PendingChatFile[] = [];
      for (const item of prev) {
        if (sent.has(item.id)) {
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
          continue;
        }
        next.push(item);
      }
      return next;
    });
    setFileError(null);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submit().catch(() => {});
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void submit().catch(() => {});
  }

  function handleFormDrop(event: DragEvent<HTMLFormElement>) {
    if (!allowFiles || !isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    if (!enabled) return;
    addFiles(filesFromDataTransfer(event.dataTransfer));
  }

  return (
    <form
      className={`ticket-chat__compose${dropActive ? " ticket-chat__compose--drop" : ""}${className ? ` ${className}` : ""}`}
      onSubmit={handleSubmit}
      onDragEnter={(event) => {
        if (!allowFiles || !isFileDrag(event) || !enabled) return;
        event.preventDefault();
        event.stopPropagation();
        setDropActive(true);
      }}
      onDragOver={(event) => {
        if (!allowFiles || !isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!enabled) return;
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!allowFiles || !isFileDrag(event)) return;
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        setDropActive(false);
      }}
      onDrop={handleFormDrop}
    >
      {children}
      {allowFiles && pendingFiles.length ? (
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
            ref={inputRef}
            rows={1}
            placeholder={placeholder}
            maxLength={maxLength}
            value={value}
            disabled={!enabled}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={(event) => {
              onPaste?.(event);
              if (event.defaultPrevented) return;
              if (!allowFiles || !enabled) return;
              const files = [...(event.clipboardData?.files || [])].filter((file) => isChatImage(file));
              if (!files.length) return;
              event.preventDefault();
              addFiles(files);
            }}
          />
        </label>
        {allowFiles ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              className="visually-hidden"
              multiple
              disabled={!enabled}
              onChange={(event) => {
                addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="btn-secondary btn-icon ticket-chat__action-btn"
              disabled={!enabled}
              aria-label="Файл"
              title="Файл"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={18} aria-hidden="true" />
            </button>
          </>
        ) : null}
        {extraActions}
        <button
          type="submit"
          className="btn-primary btn-icon ticket-chat__action-btn"
          disabled={!enabled}
          aria-label="Отправить"
          title="Отправить"
        >
          {busy ? (
            <span className="process-spinner process-spinner--inline" aria-hidden="true" />
          ) : (
            <Send size={18} aria-hidden="true" />
          )}
        </button>
      </div>
      {fileError && !onFileError ? <p className="message error">{fileError}</p> : null}
      {footer}
    </form>
  );
}
