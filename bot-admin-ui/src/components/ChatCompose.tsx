import { Mic, Paperclip, Send, Square } from "lucide-react";
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
  isChatAudio,
  isChatImage,
  isFileDrag,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_FILES,
  recordedVoiceFile,
} from "../lib/ticket-chat";

const MAX_VOICE_RECORD_MS = 5 * 60 * 1000;

export type ChatComposeUpload = {
  name: string;
  extension: string;
  data: string;
  mime_type?: string;
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
  allowRecord?: boolean;
  extraActions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onFileError?: (message: string) => void;
  onRecordedFile?: (file: File) => void;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  ref?: Ref<ChatComposeHandle>;
};

function formatRecordTimer(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // ignore unsupported probe errors
    }
  }
  return "";
}

function pendingPreviewUrl(file: File): string {
  return isChatImage(file) || isChatAudio(file) ? URL.createObjectURL(file) : "";
}

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
  allowRecord,
  extraActions,
  children,
  footer,
  onFileError,
  onRecordedFile,
  onPaste,
  ref,
}: ChatComposeProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingSeqRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recordLimitRef = useRef<number | null>(null);
  const discardRef = useRef(false);
  const allowFilesRef = useRef(allowFiles);
  const onRecordedFileRef = useRef(onRecordedFile);
  const [pendingFiles, setPendingFiles] = useState<PendingChatFile[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const canRecord = allowRecord ?? allowFiles;
  const enabled = !disabled && !busy;

  allowFilesRef.current = allowFiles;
  onRecordedFileRef.current = onRecordedFile;

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
            previewUrl: pendingPreviewUrl(file),
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

  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

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

  const stopStream = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
  }, []);

  const clearRecordTimers = useCallback(() => {
    if (recordTimerRef.current != null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (recordLimitRef.current != null) {
      window.clearTimeout(recordLimitRef.current);
      recordLimitRef.current = null;
    }
  }, []);

  const finishRecording = useCallback(
    (discard: boolean) => {
      discardRef.current = discard;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
        return;
      }
      stopStream();
      clearRecordTimers();
      setRecording(false);
      setRecordSeconds(0);
    },
    [clearRecordTimers, stopStream],
  );

  useEffect(
    () => () => {
      discardRef.current = true;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stopStream();
      clearRecordTimers();
    },
    [clearRecordTimers, stopStream],
  );

  async function startRecording() {
    if (!enabled || recording) return;
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      reportFileError("Запись звука не поддерживается в этом браузере.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      discardRef.current = false;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        reportFileError("Не удалось записать звук.");
        finishRecording(true);
      };
      recorder.onstop = () => {
        clearRecordTimers();
        stopStream();
        recorderRef.current = null;
        setRecording(false);
        setRecordSeconds(0);
        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (discardRef.current) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (!blob.size) {
          reportFileError("Пустая запись.");
          return;
        }
        const file = recordedVoiceFile(blob);
        if (allowFilesRef.current) addFilesRef.current([file]);
        onRecordedFileRef.current?.(file);
      };
      recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      setFileError(null);
      recordTimerRef.current = window.setInterval(() => {
        setRecordSeconds((value) => value + 1);
      }, 1000);
      recordLimitRef.current = window.setTimeout(() => {
        finishRecording(false);
      }, MAX_VOICE_RECORD_MS);
    } catch {
      stopStream();
      reportFileError("Нет доступа к микрофону.");
    }
  }

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
    if (!enabled || recording) return;
    const snapshot = pendingFiles;
    const files = allowFiles
      ? await Promise.all(
          snapshot.map(async (item) => ({
            name: item.file.name,
            extension: fileExtension(item.file.name),
            data: await fileToBase64(item.file),
            mime_type: item.file.type || undefined,
          })),
        )
      : [];
    const submitted = onSubmit({ text: value, files });
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
    await submitted;
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
              {item.previewUrl && isChatImage(item.file) ? (
                <img className="ticket-chat__pending-thumb" src={item.previewUrl} alt="" />
              ) : null}
              {item.previewUrl && isChatAudio(item.file) ? (
                <audio className="ticket-chat__pending-audio" controls preload="metadata" src={item.previewUrl} />
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
              disabled={!enabled || recording}
              onChange={(event) => {
                addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="btn-secondary btn-icon ticket-chat__action-btn"
              disabled={!enabled || recording}
              aria-label="Файл"
              title="Файл"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={18} aria-hidden="true" />
            </button>
          </>
        ) : null}
        {extraActions}
        {canRecord ? (
          <>
            {recording ? (
              <>
                <span className="ticket-chat__record-timer" aria-live="polite">
                  {formatRecordTimer(recordSeconds)}
                </span>
                <button
                  type="button"
                  className="btn-secondary btn-icon ticket-chat__action-btn"
                  aria-label="Отменить запись"
                  title="Отменить запись"
                  onClick={() => finishRecording(true)}
                >
                  ×
                </button>
              </>
            ) : null}
            <button
              type="button"
              className={`btn-icon ticket-chat__action-btn${
                recording ? " btn-danger ticket-chat__action-btn--recording" : " btn-secondary"
              }`}
              disabled={!enabled && !recording}
              aria-label={recording ? "Остановить запись" : "Записать голосовое"}
              title={recording ? "Остановить запись" : "Записать голосовое"}
              onClick={() => {
                if (recording) finishRecording(false);
                else void startRecording();
              }}
            >
              {recording ? <Square size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
            </button>
          </>
        ) : null}
        <button
          type="submit"
          className="btn-primary btn-icon ticket-chat__action-btn"
          disabled={!enabled || recording}
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
