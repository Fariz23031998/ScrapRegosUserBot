import { Pencil } from "lucide-react";
import { Link } from "react-router-dom";
import LoadingState from "./LoadingState";
import {
  channelDisplayName,
  directionLabel,
  firmButtonLabel,
  formatCallDuration,
  formatUnix,
  getCachedRecordingDuration,
  getTicketClientId,
  hasLookupPhone,
  hasTicketRecording,
  statusBadgeClass,
  statusLabel,
  technicalSupportDisplay,
  unpaidOrdersHref,
  unpaidOrdersLabel,
  userDisplayName,
} from "../lib/ticket-display";
import type { Ticket, TicketFirmLink } from "../lib/types";

export type TicketCardsProps = {
  tickets: Ticket[];
  isLoading?: boolean;
  emptyMessage: string;
  userNames: Record<string, string>;
  channelNames: Record<string, string>;
  recordingDurations: Record<string, number | undefined>;
  canEditClients: boolean;
  canLinkClientFirms: boolean;
  onOpenTicket: (ticket: Ticket) => void;
  onEditClient: (clientId: number) => void;
  onOpenFirm: (firm: TicketFirmLink) => void;
  onOpenRecording: (ticket: Ticket) => void;
};

export default function TicketCards({
  tickets,
  isLoading,
  emptyMessage,
  userNames,
  channelNames,
  recordingDurations,
  canEditClients,
  canLinkClientFirms,
  onOpenTicket,
  onEditClient,
  onOpenFirm,
  onOpenRecording,
}: TicketCardsProps) {
  if (isLoading) return <LoadingState />;
  if (!tickets.length) return <p className="empty-state">{emptyMessage}</p>;

  return (
    <div className="ticket-cards">
      {tickets.map((ticket) => {
        const clientName = ticket.client?.name || "—";
        const clientId = getTicketClientId(ticket);
        const canOpenClient = Boolean(clientId && (canEditClients || canLinkClientFirms));
        const unpaidLabel = hasLookupPhone(ticket) ? unpaidOrdersLabel(ticket) : null;
        const unpaidHref = unpaidLabel ? unpaidOrdersHref(ticket) : null;
        const ts = technicalSupportDisplay(ticket);
        const firms = ticket.local?.firms || [];
        const cached = getCachedRecordingDuration(ticket);
        const probed = recordingDurations[String(ticket.id)];
        const duration = cached ?? probed;

        return (
          <article
            key={ticket.id}
            className="ticket-card"
            role="button"
            tabIndex={0}
            onClick={() => onOpenTicket(ticket)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpenTicket(ticket);
              }
            }}
          >
            <header className="ticket-card__head">
              <div className="ticket-card__id-row">
                <span className="ticket-card__id">#{ticket.id}</span>
                <span className={statusBadgeClass(ticket.status)}>{statusLabel(ticket.status)}</span>
              </div>
              <h2 className="ticket-card__subject">{ticket.subject || "Без темы"}</h2>
            </header>

            <div className="ticket-card__client">
              {canOpenClient ? (
                <button
                  type="button"
                  className="ticket-client-edit"
                  aria-label={`Редактировать клиента ${clientName}`}
                  title="Редактировать клиента"
                  onClick={(event) => {
                    event.stopPropagation();
                    onEditClient(clientId!);
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                </button>
              ) : null}
              <span>{clientName}</span>
              {ticket.client?.phone ? <span className="ticket-card__muted">· {ticket.client.phone}</span> : null}
            </div>

            <dl className="ticket-card__meta">
              <div>
                <dt>Ответственный</dt>
                <dd>{userDisplayName(ticket.responsible_user_id, userNames)}</dd>
              </div>
              <div>
                <dt>Канал</dt>
                <dd>{channelDisplayName(ticket.channel_id, channelNames)}</dd>
              </div>
              <div>
                <dt>Направление</dt>
                <dd>{directionLabel(ticket.direction)}</dd>
              </div>
              <div>
                <dt>Создан</dt>
                <dd>{formatUnix(ticket.created_date)}</dd>
              </div>
            </dl>

            <div className="ticket-card__badges">
              {unpaidLabel ? (
                unpaidHref ? (
                  <Link
                    to={unpaidHref}
                    className="ticket-unpaid-link"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {unpaidLabel}
                  </Link>
                ) : (
                  <span>{unpaidLabel}</span>
                )
              ) : hasLookupPhone(ticket) ? (
                <span className="badge badge--muted">Неоплаченных нет</span>
              ) : null}

              {ts.kind === "active" ? (
                <span className="badge badge--ok" title={`Действует до ${ts.dateLabel}`}>
                  ТП до {ts.dateLabel}
                </span>
              ) : null}
              {ts.kind === "expired" ? (
                <span className="badge badge--warn" title={`Истекла ${ts.dateLabel}`}>
                  ТП истекла {ts.dateLabel}
                </span>
              ) : null}
              {ts.kind === "none" ? <span className="badge badge--muted">ТП нет</span> : null}

              {ticket.sla_breached ? (
                <span className="badge badge--warn">SLA нарушен</span>
              ) : (
                <span className="badge badge--muted">SLA ок</span>
              )}

              {ticket.rating != null ? <span className="badge">Оценка {ticket.rating}</span> : null}
            </div>

            {firms.length ? (
              <div className="ticket-card__firms" onClick={(event) => event.stopPropagation()}>
                {firms.map((firm) => (
                  <button
                    key={firm.id}
                    type="button"
                    className="ticket-firm-open"
                    title={firmButtonLabel(firm)}
                    onClick={() => onOpenFirm(firm)}
                  >
                    {firmButtonLabel(firm)}
                  </button>
                ))}
              </div>
            ) : null}

            <footer className="ticket-card__foot">
              <span className="ticket-card__muted">
                {duration != null ? formatCallDuration(duration) : "Длительность —"}
              </span>
              {hasTicketRecording(ticket) ? (
                <button
                  type="button"
                  className="ticket-recording-open"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenRecording(ticket);
                  }}
                >
                  Воспроизвести
                </button>
              ) : null}
            </footer>
          </article>
        );
      })}
    </div>
  );
}
