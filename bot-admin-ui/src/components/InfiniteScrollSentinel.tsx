import { useEffect, useRef } from "react";

export type InfiniteScrollSentinelProps = {
  loaded: number;
  total: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
};

export default function InfiniteScrollSentinel({
  loaded,
  total,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: InfiniteScrollSentinelProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage || isFetchingNextPage) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void fetchNextPage();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  if (total === 0 && loaded === 0) return null;

  return (
    <div className="infinite-scroll">
      <div className="infinite-scroll__info">{`${loaded} из ${total}`}</div>
      {hasNextPage ? (
        <div ref={sentinelRef} className="infinite-scroll__sentinel">
          {isFetchingNextPage ? <span className="infinite-scroll__loading">Загрузка…</span> : null}
        </div>
      ) : null}
    </div>
  );
}
