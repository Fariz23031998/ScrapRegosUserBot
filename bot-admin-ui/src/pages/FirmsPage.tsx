import { useMutation, useQuery } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import {
  createFirmServiceOrder,
  createFirmSupportOrder,
  getFirmSupportPrices,
  getFirmTariff,
  searchFirms,
  type FirmOrderResult,
} from "../api/tickets";
import LoadingState from "../components/LoadingState";
import Modal from "../components/Modal";
import { useAuth } from "../hooks/useAuth";
import { firmCheckView, firmSearchQuery } from "../lib/firm-check";
import { parseTelegramCard, type TelegramSegment } from "../lib/telegram-card";
import type { FirmSearchResult } from "../lib/types";

function SegmentView({ segment }: { segment: TelegramSegment }) {
  if (segment.type === "bold") return <strong>{segment.text}</strong>;
  if (segment.type === "code") return <code>{segment.text}</code>;
  return <>{segment.text}</>;
}

function TelegramMessage({ message }: { message: string }) {
  const lines = parseTelegramCard(message);
  if (!lines.some((line) => line.length > 0)) return null;
  return (
    <div className="firm-check-card__body">
      {lines.map((line, index) => (
        <p key={index}>
          {line.map((segment, segmentIndex) => (
            <SegmentView key={segmentIndex} segment={segment} />
          ))}
        </p>
      ))}
    </div>
  );
}

function firmPayload(firm: FirmSearchResult) {
  return {
    client_name: firm.clientName || undefined,
    client_type: firm.type || undefined,
    record_id: firm.recordId ?? undefined,
    firm_message: firm.message || undefined,
    firm_phone: firm.phone || undefined,
  };
}

function OrderCreated({ result }: { result: FirmOrderResult }) {
  return (
    <p className="message success">
      Заказ {result.order.id} создан.
      {result.payment_page_url ? (
        <>
          {" "}
          <a href={result.payment_page_url} target="_blank" rel="noopener noreferrer">
            Страница оплаты
          </a>
        </>
      ) : null}
    </p>
  );
}

function ServiceOrderModal({ firm, onClose }: { firm: FirmSearchResult; onClose: () => void }) {
  const [result, setResult] = useState<FirmOrderResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: createFirmServiceOrder,
    onSuccess: (data) => {
      setError(null);
      setResult(data);
    },
    onError: (err: Error) => setError(err.message),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const additional = String(form.get("additional_phone") || "").trim();
    mutation.mutate({
      ...firmPayload(firm),
      amount: form.get("amount"),
      additional_phone: additional || undefined,
    });
  }

  return (
    <Modal title="Добавить услуги" open onClose={onClose}>
      {error ? <p className="message error">{error}</p> : null}
      {result ? (
        <OrderCreated result={result} />
      ) : (
        <form className="stack-form" onSubmit={onSubmit}>
          <p className="firm-check-card__phone">{firm.clientName || "Фирма"}</p>
          <label className="field">
            Стоимость услуги, сум
            <input name="amount" inputMode="numeric" required autoFocus />
          </label>
          <label className="field">
            Дополнительный номер <span className="field-hint">(необязательно)</span>
            <input name="additional_phone" type="tel" placeholder="Оставьте пустым, чтобы пропустить" />
          </label>
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Отменить
            </button>
            <button type="submit" className="btn-primary" disabled={mutation.isPending}>
              Создать заказ
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function SupportOrderModal({ firm, onClose }: { firm: FirmSearchResult; onClose: () => void }) {
  const [result, setResult] = useState<FirmOrderResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pricesQuery = useQuery({
    queryKey: ["firm-support-prices"],
    queryFn: getFirmSupportPrices,
  });
  const mutation = useMutation({
    mutationFn: createFirmSupportOrder,
    onSuccess: (data) => {
      setError(null);
      setResult(data);
    },
    onError: (err: Error) => setError(err.message),
  });
  const prices = pricesQuery.data?.prices || [];

  return (
    <Modal title="Добавить ТП" open onClose={onClose}>
      {error ? <p className="message error">{error}</p> : null}
      {result ? (
        <OrderCreated result={result} />
      ) : (
        <>
          <p className="firm-check-card__phone">{firm.clientName || "Фирма"}</p>
          {pricesQuery.isPending ? <LoadingState message="Загрузка сроков…" /> : null}
          {pricesQuery.isError ? (
            <p className="message error">{(pricesQuery.error as Error).message}</p>
          ) : null}
          {!pricesQuery.isPending && !prices.length ? (
            <p className="firm-search-status">
              {pricesQuery.data?.message ||
                "Цены на техподдержку не настроены. Задайте их в админ-панели (Техподдержка)."}
            </p>
          ) : null}
          {prices.length ? (
            <div className="firm-support-prices">
              {prices.map((price) => (
                <button
                  key={price.months}
                  type="button"
                  className="firm-check-card__action"
                  disabled={mutation.isPending}
                  onClick={() =>
                    mutation.mutate({
                      ...firmPayload(firm),
                      phone: firm.phone,
                      months: price.months,
                    })
                  }
                >
                  {price.label}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </Modal>
  );
}

function TariffModal({ firm, onClose }: { firm: FirmSearchResult; onClose: () => void }) {
  const tariffQuery = useQuery({
    queryKey: ["firm-tariff", firm.accountId, firm.apiLogin, firm.tariff],
    queryFn: () => getFirmTariff(firm),
  });

  return (
    <Modal title="О тарифе" open onClose={onClose}>
      {tariffQuery.isPending ? <LoadingState message="Загрузка тарифа…" /> : null}
      {tariffQuery.isError ? <p className="message error">{(tariffQuery.error as Error).message}</p> : null}
      {tariffQuery.data?.message ? <TelegramMessage message={tariffQuery.data.message} /> : null}
    </Modal>
  );
}

function FirmCard({
  firm,
  canCreateSupport,
  onService,
  onSupport,
  onTariff,
}: {
  firm: FirmSearchResult;
  canCreateSupport: boolean;
  onService: (firm: FirmSearchResult) => void;
  onSupport: (firm: FirmSearchResult) => void;
  onTariff: (firm: FirmSearchResult) => void;
}) {
  const showSupport = canCreateSupport && Boolean(String(firm.phone || "").trim());
  const showTariff = Boolean(String(firm.accountId || "").trim());

  return (
    <article className="firm-check-card">
      <h2 className="firm-check-card__title">{firm.clientName || "Фирма"}</h2>
      {firm.phone ? <p className="firm-check-card__phone">{firm.phone}</p> : null}
      <TelegramMessage message={firm.message || ""} />
      <div className="firm-check-card__actions">
        <button
          type="button"
          className={`firm-check-card__action${showSupport ? "" : " firm-check-card__action--wide"}`}
          onClick={() => onService(firm)}
        >
          Добавить услуги
        </button>
        {showSupport ? (
          <button type="button" className="firm-check-card__action" onClick={() => onSupport(firm)}>
            Добавить ТП
          </button>
        ) : null}
        {showTariff ? (
          <button
            type="button"
            className="firm-check-card__action firm-check-card__action--wide"
            onClick={() => onTariff(firm)}
          >
            О тарифе
          </button>
        ) : null}
      </div>
    </article>
  );
}

export default function FirmsPage() {
  const { hasPermission } = useAuth();
  const canCreateSupport = hasPermission("create_technical_support");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [serviceFirm, setServiceFirm] = useState<FirmSearchResult | null>(null);
  const [supportFirm, setSupportFirm] = useState<FirmSearchResult | null>(null);
  const [tariffFirm, setTariffFirm] = useState<FirmSearchResult | null>(null);

  const search = useQuery({
    queryKey: ["firm-check", query],
    queryFn: () => searchFirms(query),
    enabled: query.length > 0,
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next = firmSearchQuery(draft);
    if (!next) return;
    setQuery(next);
  }

  const view = firmCheckView({
    query,
    isFetching: search.isFetching,
    isError: search.isError,
    isSuccess: search.isSuccess,
    errorMessage: search.error instanceof Error ? search.error.message : undefined,
    results: search.data?.results,
  });

  return (
    <main className="page firm-check-page">
      <h1>Проверка фирм</h1>
      <form className="firm-search-row" onSubmit={onSubmit}>
        <input
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Телефон, ИНН, код лицензии, API-логин или название"
          aria-label="Поиск фирмы"
        />
        <button type="submit" className="btn btn-primary" disabled={search.isFetching}>
          Найти
        </button>
      </form>

      {view.loading ? <LoadingState message="Поиск фирмы…" /> : null}
      {view.error ? <p className="message error">{view.error}</p> : null}
      {view.notFound ? <p className="firm-search-status">Не найдено</p> : null}
      {view.results.length > 0 ? (
        <div className="firm-check-results">
          {view.results.map((firm, index) => (
            <FirmCard
              key={`${firm.type || "firm"}-${firm.recordId ?? index}`}
              firm={firm}
              canCreateSupport={canCreateSupport}
              onService={setServiceFirm}
              onSupport={setSupportFirm}
              onTariff={setTariffFirm}
            />
          ))}
        </div>
      ) : null}

      {serviceFirm ? <ServiceOrderModal firm={serviceFirm} onClose={() => setServiceFirm(null)} /> : null}
      {supportFirm ? <SupportOrderModal firm={supportFirm} onClose={() => setSupportFirm(null)} /> : null}
      {tariffFirm ? <TariffModal firm={tariffFirm} onClose={() => setTariffFirm(null)} /> : null}
    </main>
  );
}
