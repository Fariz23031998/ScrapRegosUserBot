import type { ReactNode } from "react";
import LoadingState from "./LoadingState";

export type EntityCardField = {
  label: string;
  value: ReactNode;
};

export type EntityCardsProps<T> = {
  items: T[];
  isLoading?: boolean;
  emptyMessage: string;
  getKey: (item: T) => string;
  getTitle: (item: T) => ReactNode;
  getSubtitle?: (item: T) => ReactNode;
  getFields?: (item: T) => EntityCardField[];
  getBadges?: (item: T) => ReactNode;
  getFooter?: (item: T) => ReactNode;
  getActions?: (item: T) => ReactNode;
  onOpen?: (item: T) => void;
};

export default function EntityCards<T>({
  items,
  isLoading,
  emptyMessage,
  getKey,
  getTitle,
  getSubtitle,
  getFields,
  getBadges,
  getFooter,
  getActions,
  onOpen,
}: EntityCardsProps<T>) {
  if (isLoading) return <LoadingState />;
  if (!items.length) return <p className="empty-state">{emptyMessage}</p>;

  return (
    <div className="ticket-cards">
      {items.map((item) => {
        const fields = getFields?.(item) || [];
        const badges = getBadges?.(item);
        const footer = getFooter?.(item);
        const actions = getActions?.(item);
        const interactive = Boolean(onOpen);

        return (
          <article
            key={getKey(item)}
            className={`ticket-card${interactive ? "" : " ticket-card--static"}`}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
            onClick={interactive ? () => onOpen?.(item) : undefined}
            onKeyDown={
              interactive
                ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpen?.(item);
                    }
                  }
                : undefined
            }
          >
            <header className="ticket-card__head">
              <h2 className="ticket-card__subject">{getTitle(item)}</h2>
              {getSubtitle ? <div className="ticket-card__client">{getSubtitle(item)}</div> : null}
            </header>

            {fields.length ? (
              <dl className="ticket-card__meta">
                {fields.map((field) => (
                  <div key={field.label}>
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {badges ? <div className="ticket-card__badges">{badges}</div> : null}

            {actions ? (
              <div
                className="ticket-card__actions cell-actions"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                {actions}
              </div>
            ) : null}

            {footer ? <footer className="ticket-card__foot">{footer}</footer> : null}
          </article>
        );
      })}
    </div>
  );
}
