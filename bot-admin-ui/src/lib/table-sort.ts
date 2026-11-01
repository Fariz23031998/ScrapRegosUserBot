import { useCallback, useMemo, useState } from "react";
import type { SortingState } from "@tanstack/react-table";

export function sortQueryParam(sorting: SortingState): string {
  const primary = sorting[0];
  if (!primary?.id) return "";
  return `${primary.id}:${primary.desc ? "desc" : "asc"}`;
}

export function useServerTableSort() {
  const [sorting, setSorting] = useState<SortingState>([]);
  const sort = useMemo(() => sortQueryParam(sorting), [sorting]);
  const onSortingChange = useCallback((next: SortingState) => {
    setSorting(next);
  }, []);
  return { sort, onSortingChange };
}
