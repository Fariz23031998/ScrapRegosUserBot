import { useEffect, type ReactNode } from "react";

export type ModalProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: "default" | "wide" | "confirm" | "sheet" | "workspace";
  className?: string;
};

const openModalStack: Array<() => void> = [];

export default function Modal({
  open,
  title,
  onClose,
  children,
  size = "default",
  className = "",
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    openModalStack.push(onClose);
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const top = openModalStack[openModalStack.length - 1];
      if (top !== onClose) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const index = openModalStack.lastIndexOf(onClose);
      if (index >= 0) openModalStack.splice(index, 1);
    };
  }, [open, onClose]);

  if (!open) return null;

  const sheet = size === "sheet";
  const workspace = size === "workspace";

  return (
    <div
      className={`modal-overlay${sheet ? " modal-overlay--sheet" : ""}${
        workspace ? " modal-overlay--workspace" : ""
      }`}
    >
      <div
        className={`modal modal--${size}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-header">
          <h3 id="modal-title">{title}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Закрыть">
            &times;
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
