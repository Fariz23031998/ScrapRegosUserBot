import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useLayoutEffect, useMemo, useRef, useState, type RefObject, type SyntheticEvent, type UIEvent } from "react";
import { Link } from "react-router-dom";
import {
  channelDisplayName,
  formatUnix,
  getCachedRecordingDuration,
  statusBadgeClass,
  statusLabel,
  unpaidOrdersHref,
  unpaidOrdersLabel,
  userDisplayName,
} from "../lib/ticket-display";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import type { TicketBoardColumnState } from "../hooks/useTicketBoardColumns";
import { visibleBoardStatuses } from "../lib/ticket-board";
import type { Ticket } from "../lib/types";
import LoadingState from "./LoadingState";
import PhoneCopyButton from "./PhoneCopyButton";
import { TicketRecordingControl } from "./TicketCards";

function stopCardAction(event: SyntheticEvent) {
  event.stopPropagation();
}

export type TicketBoardColumn = {
  id: string;
  label: string;
  droppable: boolean;
  tickets: Ticket[];
};

export function buildTicketBoardColumns(
  ticketsByStatus: Record<string, Ticket[]>,
  statusFilter: string[],
): TicketBoardColumn[] {
  return visibleBoardStatuses(statusFilter).map((status) => ({
    id: status,
    label: statusLabel(status),
    droppable: true,
    tickets: ticketsByStatus[status] ?? [],
  }));
}

export function resolveActiveBoardColumnId(columnIds: string[], activeId: string | null): string | null {
  if (activeId && columnIds.includes(activeId)) return activeId;
  return columnIds[0] ?? null;
}

function canDragTicket(ticket: Ticket, canEditTickets: boolean, canEditClosedTickets: boolean) {
  if (!canEditTickets) return false;
  if (String(ticket.status || "") === "Closed" && !canEditClosedTickets) return false;
  return true;
}

const collisionDetection: CollisionDetection = (args) => {
  const byPointer = pointerWithin(args);
  if (byPointer.length > 0) return byPointer;
  return rectIntersection(args);
};

function ticketIdFromDragId(id: unknown): number | null {
  const raw = String(id || "");
  if (!raw.startsWith("ticket:")) return null;
  const ticketId = Number(raw.slice("ticket:".length));
  return Number.isFinite(ticketId) ? ticketId : null;
}

function statusFromDropId(id: unknown): string | null {
  const raw = String(id || "");
  if (!raw.startsWith("status:")) return null;
  const status = raw.slice("status:".length);
  return status || null;
}

export type TicketBoardProps = {
  columns: TicketBoardColumnState[];
  emptyMessage: string;
  userNames: Record<string, string>;
  channelNames: Record<string, string>;
  canEditTickets: boolean;
  canEditClosedTickets: boolean;
  busyTicketId?: number | null;
  recordingDurations: Record<string, number | undefined>;
  onNearEnd: (status: string) => void;
  onOpenTicket: (ticket: Ticket) => void;
  onOpenRecording: (ticket: Ticket) => void;
  onStatusChange: (ticket: Ticket, status: string) => void;
};

export default function TicketBoard({
  columns,
  emptyMessage,
  userNames,
  channelNames,
  canEditTickets,
  canEditClosedTickets,
  busyTicketId,
  recordingDurations,
  onNearEnd,
  onOpenTicket,
  onOpenRecording,
  onStatusChange,
}: TicketBoardProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const suppressClickRef = useRef<boolean>(false);
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const [activeTicketId, setActiveTicketId] = useState<number | null>(null);
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  const boardColumns = useMemo(
    () =>
      columns.map((column) => ({
        ...column,
        label: statusLabel(column.id),
        droppable: true,
      })),
    [columns],
  );
  const resolvedActiveId = resolveActiveBoardColumnId(
    boardColumns.map((column) => column.id),
    activeColumnId,
  );
  const visibleColumns = compact ? boardColumns.filter((column) => column.id === resolvedActiveId) : boardColumns;
  const activeTicket =
    activeTicketId == null
      ? null
      : boardColumns.flatMap((column) => column.tickets).find((ticket) => ticket.id === activeTicketId) ?? null;

  function releaseSuppressedClick() {
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }

  function handleDragStart(event: DragStartEvent) {
    suppressClickRef.current = true;
    setActiveTicketId(ticketIdFromDragId(event.active.id));
  }

  function handleDragCancel() {
    setActiveTicketId(null);
    releaseSuppressedClick();
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTicketId(null);
    releaseSuppressedClick();
    const ticketId = ticketIdFromDragId(event.active.id);
    const nextStatus = statusFromDropId(event.over?.id);
    if (ticketId == null || !nextStatus) return;
    const ticket = boardColumns.flatMap((column) => column.tickets).find((item) => item.id === ticketId);
    if (!ticket || String(ticket.status || "") === nextStatus) return;
    if (!canDragTicket(ticket, canEditTickets, canEditClosedTickets) || ticket.id === busyTicketId) return;
    const column = boardColumns.find((item) => item.id === nextStatus && item.droppable);
    if (!column) return;
    onStatusChange(ticket, nextStatus);
  }

  const settledEmpty =
    boardColumns.length > 0 &&
    boardColumns.every(
      (column) => !column.isLoading && !column.errorMessage && column.total === 0 && column.tickets.length === 0,
    );
  if (settledEmpty) return <p className="empty-state">{emptyMessage}</p>;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <div className={`ticket-board-shell${compact ? " ticket-board-shell--tabs" : ""}`}>
        {compact ? (
          <div className="ticket-board-tabs" role="tablist" aria-label="Колонки тикетов">
            {boardColumns.map((column) => {
              const selected = column.id === resolvedActiveId;
              return (
                <button
                  key={column.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={`ticket-board-tab${selected ? " ticket-board-tab--active" : ""}`}
                  onClick={() => setActiveColumnId(column.id)}
                >
                  <span className="ticket-board-tab__label">{column.label}</span>
                  <span className="ticket-board-tab__count">{column.isLoading ? "…" : column.total}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="ticket-board">
          {visibleColumns.map((column) => (
            <TicketBoardColumn
              key={column.id}
              column={column}
              userNames={userNames}
              channelNames={channelNames}
              canEditTickets={canEditTickets}
              canEditClosedTickets={canEditClosedTickets}
              busyTicketId={busyTicketId}
              recordingDurations={recordingDurations}
              dragEnabled={!compact}
              suppressClickRef={suppressClickRef}
              onOpenTicket={onOpenTicket}
              onOpenRecording={onOpenRecording}
              onNearEnd={() => onNearEnd(column.id)}
            />
          ))}
        </div>
      </div>
      <DragOverlay>
        {activeTicket ? (
          <article className="ticket-board-card ticket-board-card--overlay">
            <TicketBoardCardBody
              ticket={activeTicket}
              userNames={userNames}
              channelNames={channelNames}
              recordingDurations={recordingDurations}
              onOpenRecording={onOpenRecording}
            />
          </article>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function TicketBoardColumn({
  column,
  userNames,
  channelNames,
  canEditTickets,
  canEditClosedTickets,
  busyTicketId,
  recordingDurations,
  dragEnabled,
  suppressClickRef,
  onOpenTicket,
  onOpenRecording,
  onNearEnd,
}: {
  column: TicketBoardColumn & TicketBoardColumnState;
  userNames: Record<string, string>;
  channelNames: Record<string, string>;
  canEditTickets: boolean;
  canEditClosedTickets: boolean;
  busyTicketId?: number | null;
  recordingDurations: Record<string, number | undefined>;
  dragEnabled: boolean;
  suppressClickRef: RefObject<boolean>;
  onOpenTicket: (ticket: Ticket) => void;
  onOpenRecording: (ticket: Ticket) => void;
  onNearEnd: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `status:${column.id}`,
    disabled: !column.droppable,
  });
  const listRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const onNearEndRef = useRef(onNearEnd);
  onNearEndRef.current = onNearEnd;

  function requestMore() {
    if (!column.hasNextPage || column.isFetchingNextPage || column.isLoading || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    onNearEndRef.current();
  }

  useLayoutEffect(() => {
    if (column.isFetchingNextPage) return;
    loadingMoreRef.current = false;
    if (!column.hasNextPage || column.isLoading) return;
    const list = listRef.current;
    if (!list || list.clientHeight <= 0) return;
    if (list.scrollHeight <= list.clientHeight + 1) requestMore();
  }, [column.tickets.length, column.total, column.hasNextPage, column.isFetchingNextPage, column.isLoading]);

  function handleListScroll(event: UIEvent<HTMLDivElement>) {
    const list = event.currentTarget;
    if (list.scrollHeight <= list.clientHeight + 1) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 48) requestMore();
  }

  return (
    <section
      ref={setNodeRef}
      className={`ticket-board-column${isOver ? " ticket-board-column--over" : ""}`}
      aria-label={column.label}
      data-status={column.id}
    >
      <header className="ticket-board-column__head">
        <span className={statusBadgeClass(column.id)}>{column.label}</span>
        <span className="ticket-board-column__count">{column.isLoading ? "…" : column.total}</span>
      </header>
      <div className="ticket-board-column__list" ref={listRef} onScroll={handleListScroll}>
        {column.isLoading ? (
          <LoadingState />
        ) : column.tickets.length ? (
          column.tickets.map((ticket) => (
            <TicketBoardCard
              key={ticket.id}
              ticket={ticket}
              userNames={userNames}
              channelNames={channelNames}
              recordingDurations={recordingDurations}
              draggable={
                dragEnabled &&
                canDragTicket(ticket, canEditTickets, canEditClosedTickets) &&
                ticket.id !== busyTicketId
              }
              suppressClickRef={suppressClickRef}
              onOpen={() => onOpenTicket(ticket)}
              onOpenRecording={onOpenRecording}
            />
          ))
        ) : (
          <p className="ticket-board-column__empty">{column.errorMessage || "Пусто"}</p>
        )}
        {column.isFetchingNextPage ? <p className="ticket-board-column__empty">Загрузка…</p> : null}
        {!column.isLoading && column.errorMessage && column.tickets.length ? (
          <p className="ticket-board-column__empty">{column.errorMessage}</p>
        ) : null}
      </div>
    </section>
  );
}

function TicketBoardCard({
  ticket,
  userNames,
  channelNames,
  recordingDurations,
  draggable,
  suppressClickRef,
  onOpen,
  onOpenRecording,
}: {
  ticket: Ticket;
  userNames: Record<string, string>;
  channelNames: Record<string, string>;
  recordingDurations: Record<string, number | undefined>;
  draggable: boolean;
  suppressClickRef: RefObject<boolean>;
  onOpen: () => void;
  onOpenRecording: (ticket: Ticket) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `ticket:${ticket.id}`,
    disabled: !draggable,
  });

  return (
    <article
      ref={setNodeRef}
      className={`ticket-board-card${draggable ? "" : " ticket-board-card--locked"}${isDragging ? " ticket-board-card--dragging" : ""}`}
      {...attributes}
      {...listeners}
      onClick={() => {
        if (suppressClickRef.current) return;
        onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
    >
      <TicketBoardCardBody
        ticket={ticket}
        userNames={userNames}
        channelNames={channelNames}
        recordingDurations={recordingDurations}
        onOpenRecording={onOpenRecording}
      />
    </article>
  );
}

function TicketBoardCardBody({
  ticket,
  userNames,
  channelNames,
  recordingDurations,
  onOpenRecording,
}: {
  ticket: Ticket;
  userNames: Record<string, string>;
  channelNames: Record<string, string>;
  recordingDurations: Record<string, number | undefined>;
  onOpenRecording: (ticket: Ticket) => void;
}) {
  const clientName = ticket.client?.name || ticket.client_name || "—";
  const phone = ticket.client?.phone || ticket.client_phone || "";
  const unpaidLabel = unpaidOrdersLabel(ticket);
  const unpaidHref = unpaidLabel ? unpaidOrdersHref(ticket) : null;
  const duration = getCachedRecordingDuration(ticket) ?? recordingDurations[String(ticket.id)];
  const showRecording = duration != null && duration > 0;
  const channelName = channelDisplayName(ticket.channel_id, channelNames);
  return (
    <>
      <div className="ticket-board-card__top">
        <span className="ticket-board-card__identity">
          <span className="ticket-card__id">#{ticket.id}</span>
          {channelName !== "—" ? <span className="ticket-card__channel">{channelName}</span> : null}
        </span>
        {ticket.sla_breached ? <span className="badge badge--warn">SLA нарушен</span> : null}
      </div>
      <h3 className="ticket-board-card__subject">{ticket.subject || "Без темы"}</h3>
      <p className="ticket-board-card__line ticket-board-card__client">
        <span>{clientName}</span>
        {phone ? <PhoneCopyButton phone={phone} /> : null}
      </p>
      <p className="ticket-board-card__line ticket-board-card__line--muted">
        {userDisplayName(ticket.responsible_user_id, userNames)}
      </p>
      <p className="ticket-board-card__line ticket-board-card__line--muted">{formatUnix(ticket.last_update)}</p>
      {unpaidLabel ? (
        <div className="ticket-board-card__extra">
          <span className="ticket-board-card__extra-label">Неоплаченные:</span>
          {unpaidHref ? (
            <Link
              to={unpaidHref}
              className="ticket-unpaid-link"
              onPointerDown={stopCardAction}
              onClick={stopCardAction}
              onKeyDown={stopCardAction}
            >
              {unpaidLabel}
            </Link>
          ) : (
            <span>{unpaidLabel}</span>
          )}
        </div>
      ) : null}
      {showRecording ? (
        <div
          className="ticket-board-card__extra"
          onPointerDown={stopCardAction}
          onClick={stopCardAction}
          onKeyDown={stopCardAction}
        >
          <span className="ticket-board-card__extra-label">Запись:</span>
          <TicketRecordingControl ticket={ticket} duration={duration} onOpen={onOpenRecording} />
        </div>
      ) : null}
    </>
  );
}
