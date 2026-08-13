import { useInfiniteQuery, type QueryKey } from "@tanstack/react-query";

export const INFINITE_PAGE_SIZE = 25;

export type PagedPage = {
  total: number;
  page: number;
};

export function usePagedInfiniteQuery<TPage extends PagedPage, TItem>({
  queryKey,
  queryFn,
  getItems,
  getItemId,
  pageSize = INFINITE_PAGE_SIZE,
  enabled = true,
}: {
  queryKey: QueryKey;
  queryFn: (page: number, pageSize: number) => Promise<TPage>;
  getItems: (page: TPage) => TItem[];
  getItemId?: (item: TItem) => string | number;
  pageSize?: number;
  enabled?: boolean;
}) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => queryFn(pageParam, pageSize),
    initialPageParam: 1,
    enabled,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((count, page) => count + getItems(page).length, 0);
      if (loaded >= lastPage.total) return undefined;
      if (!getItems(lastPage).length) return undefined;
      return lastPage.page + 1;
    },
  });

  const items = (() => {
    const flat = query.data?.pages.flatMap(getItems) ?? [];
    if (!getItemId) return flat;
    const seen = new Set<string | number>();
    return flat.filter((item) => {
      const id = getItemId(item);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  })();

  const pages = query.data?.pages;
  const total = pages?.[pages.length - 1]?.total ?? pages?.[0]?.total ?? 0;

  return { ...query, items, total };
}
