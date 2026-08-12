import { PAGE_SIZES } from "../lib/types";

export type PaginationProps = {
  page: number;
  limit: number;
  total: number;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
};

export default function Pagination({ page, limit, total, onPageChange, onLimitChange }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  return (
    <div className="pagination-wrap">
      <div className="pagination-info">
        {total === 0 ? "Нет записей" : `${from}–${to} из ${total}`}
      </div>
      <div className="pagination-controls">
        <label className="pagination-limit">
          <span className="pagination-limit__label">На странице</span>
          <select
            value={limit}
            aria-label="На странице"
            onChange={(event) => {
              onLimitChange(Number(event.target.value));
              onPageChange(1);
            }}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <div className="pagination-nav">
          <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
            Назад
          </button>
          <span className="pagination-page">
            {page} / {totalPages}
          </span>
          <button
            type="button"
            className="btn-secondary"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Вперёд
          </button>
        </div>
      </div>
    </div>
  );
}
