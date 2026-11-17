import { CalendarDays } from "lucide-react";
import { useEffect, useState } from "react";
import type { TicketPeriodPreset } from "../lib/ticket-period-db";
import { getTicketPeriodDefaults, getTodayPeriodDefaults } from "../lib/ticket-display";
import Modal from "./Modal";

export function formatPeriodButtonLabel(from: string, to: string): string {
  const formatPart = (value: string) => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  if (!from && !to) return "Выберите период";
  return `${formatPart(from)} — ${formatPart(to)}`;
}

export type TicketPeriodApplyMeta = {
  preset: TicketPeriodPreset;
};

type TicketPeriodModalProps = {
  open: boolean;
  dateFrom: string;
  dateTo: string;
  onClose: () => void;
  onApply: (dateFrom: string, dateTo: string, meta: TicketPeriodApplyMeta) => void;
};

export function TicketPeriodModal({ open, dateFrom, dateTo, onClose, onApply }: TicketPeriodModalProps) {
  const [draftFrom, setDraftFrom] = useState(dateFrom);
  const [draftTo, setDraftTo] = useState(dateTo);
  const [preset, setPreset] = useState<TicketPeriodPreset>("custom");

  useEffect(() => {
    if (!open) return;
    setDraftFrom(dateFrom);
    setDraftTo(dateTo);
    setPreset("custom");
  }, [open, dateFrom, dateTo]);

  return (
    <Modal title="Период" open={open} onClose={onClose}>
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          onApply(draftFrom, draftTo, { preset });
          onClose();
        }}
      >
        <label>
          С
          <input
            type="datetime-local"
            value={draftFrom}
            onChange={(event) => {
              setPreset("custom");
              setDraftFrom(event.target.value);
            }}
          />
        </label>
        <label>
          По
          <input
            type="datetime-local"
            value={draftTo}
            onChange={(event) => {
              setPreset("custom");
              setDraftTo(event.target.value);
            }}
          />
        </label>
        <div className="period-modal__presets">
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => {
              const today = getTodayPeriodDefaults();
              setPreset("today");
              setDraftFrom(today.from);
              setDraftTo(today.to);
            }}
          >
            Сегодня
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => {
              const defaults = getTicketPeriodDefaults();
              setPreset("preference");
              setDraftFrom(defaults.from);
              setDraftTo(defaults.to);
            }}
          >
            Сбросить
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => {
              setPreset("custom");
              setDraftFrom("");
              setDraftTo("");
            }}
          >
            Очистить
          </button>
        </div>
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn-primary">
            Применить
          </button>
        </div>
      </form>
    </Modal>
  );
}

type PeriodFilterButtonProps = {
  dateFrom: string;
  dateTo: string;
  onClick: () => void;
};

export function PeriodFilterButton({ dateFrom, dateTo, onClick }: PeriodFilterButtonProps) {
  return (
    <button type="button" className="period-filter-btn" onClick={onClick} aria-label="Выбрать период">
      <CalendarDays size={16} aria-hidden="true" />
      <span className="period-filter-btn__label">{formatPeriodButtonLabel(dateFrom, dateTo)}</span>
    </button>
  );
}
