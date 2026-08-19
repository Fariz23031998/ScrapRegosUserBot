import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";

export type ToastTone = "success" | "error";

export type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
  href?: string;
};

type ToastContextValue = {
  toasts: ToastItem[];
  pushToast: (toast: Omit<ToastItem, "id">) => void;
  dismissToast: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

function ToastStack({
  toasts,
  dismissToast,
}: {
  toasts: ToastItem[];
  dismissToast: (id: string) => void;
}) {
  const navigate = useNavigate();
  if (!toasts.length) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`toast toast--${toast.tone}${toast.href ? " toast--link" : ""}`}
          onClick={() => {
            if (toast.href) navigate(toast.href);
            dismissToast(toast.id);
          }}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (toast: Omit<ToastItem, "id">) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setToasts((current) => [...current, { ...toast, id }]);
      window.setTimeout(() => dismissToast(id), 8000);
    },
    [dismissToast],
  );

  const value = useMemo(
    () => ({ toasts, pushToast, dismissToast }),
    [toasts, pushToast, dismissToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} dismissToast={dismissToast} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
