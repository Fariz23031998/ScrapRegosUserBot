import type { FirmSearchResult } from "./types";

export function firmSearchQuery(draft: string): string {
  return draft.trim();
}

export function firmCheckView({
  query,
  isFetching,
  isError,
  isSuccess,
  errorMessage,
  results,
}: {
  query: string;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  errorMessage?: string;
  results?: FirmSearchResult[];
}): {
  loading: boolean;
  error: string | null;
  notFound: boolean;
  results: FirmSearchResult[];
} {
  const rows = results || [];
  return {
    loading: isFetching,
    error: isError ? errorMessage || "Не удалось выполнить поиск." : null,
    notFound: Boolean(query) && isSuccess && !isFetching && rows.length === 0,
    results: rows,
  };
}
