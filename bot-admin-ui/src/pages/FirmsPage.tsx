import { useQuery } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import { searchFirms } from "../api/tickets";
import LoadingState from "../components/LoadingState";
import { firmCheckView, firmSearchQuery } from "../lib/firm-check";
import { parseTelegramCard, type TelegramSegment } from "../lib/telegram-card";
import type { FirmSearchResult } from "../lib/types";

function SegmentView({ segment }: { segment: TelegramSegment }) {
  if (segment.type === "bold") return <strong>{segment.text}</strong>;
  if (segment.type === "code") return <code>{segment.text}</code>;
  return <>{segment.text}</>;
}

function FirmCard({ firm }: { firm: FirmSearchResult }) {
  const lines = parseTelegramCard(firm.message || "");
  return (
    <article className="firm-check-card">
      <h2 className="firm-check-card__title">{firm.clientName || "Фирма"}</h2>
      {firm.phone ? <p className="firm-check-card__phone">{firm.phone}</p> : null}
      {lines.some((line) => line.length > 0) ? (
        <div className="firm-check-card__body">
          {lines.map((line, index) => (
            <p key={index}>
              {line.map((segment, segmentIndex) => (
                <SegmentView key={segmentIndex} segment={segment} />
              ))}
            </p>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export default function FirmsPage() {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");

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
            <FirmCard key={`${firm.type || "firm"}-${firm.recordId ?? index}`} firm={firm} />
          ))}
        </div>
      ) : null}
    </main>
  );
}
