import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useEffect, useRef } from "react";

export type ChatHistorySearchProps = {
  open: boolean;
  query: string;
  matchCount: number;
  activeIndex: number;
  onOpen: () => void;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onPrev: () => void;
  onNext: () => void;
};

export default function ChatHistorySearch({
  open,
  query,
  matchCount,
  activeIndex,
  onOpen,
  onClose,
  onQueryChange,
  onPrev,
  onNext,
}: ChatHistorySearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <div className="ticket-chat__search">
        <button
          type="button"
          className="btn-secondary btn-icon ticket-chat__search-toggle"
          aria-label="Поиск по истории чата"
          title="Поиск по истории чата"
          onClick={onOpen}
        >
          <Search size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }

  const hasMatches = matchCount > 0;
  const positionLabel = hasMatches ? `${activeIndex + 1} / ${matchCount}` : query.trim() ? "0 / 0" : "";

  return (
    <div className="ticket-chat__search ticket-chat__search--open">
      <div className="ticket-chat__search-panel">
        <Search className="ticket-chat__search-icon" size={16} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          className="ticket-chat__search-input"
          value={query}
          placeholder="Поиск в чате…"
          aria-label="Поиск в истории чата"
          autoComplete="off"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey) onPrev();
              else onNext();
            }
          }}
        />
        {positionLabel ? (
          <span className="ticket-chat__search-count" aria-live="polite">
            {positionLabel}
          </span>
        ) : null}
        <button
          type="button"
          className="btn-secondary btn-icon ticket-chat__search-nav"
          aria-label="Предыдущее совпадение"
          title="Предыдущее совпадение"
          disabled={!hasMatches}
          onClick={onPrev}
        >
          <ChevronUp size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn-secondary btn-icon ticket-chat__search-nav"
          aria-label="Следующее совпадение"
          title="Следующее совпадение"
          disabled={!hasMatches}
          onClick={onNext}
        >
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn-secondary btn-icon ticket-chat__search-close"
          aria-label="Закрыть поиск"
          title="Закрыть поиск"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
