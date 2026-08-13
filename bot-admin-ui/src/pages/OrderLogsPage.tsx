import { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { listOrderLogs } from "../api/admin";
import EntityCards from "../components/EntityCards";
import InfiniteScrollSentinel from "../components/InfiniteScrollSentinel";
import ListFiltersChrome from "../components/ListFiltersChrome";
import SimpleTable from "../components/SimpleTable";
import type { OrderLog } from "../lib/types";
import { formatAmount, formatDateTime } from "../lib/utils";
import { useUiPreferences } from "../hooks/useUiPreferences";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { usePagedInfiniteQuery } from "../hooks/usePagedInfiniteQuery";

export default function OrderLogsPage() {
  const { dateTimeFormat } = useUiPreferences();
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const [search, setSearch] = useState("");

  const query = usePagedInfiniteQuery({
    queryKey: ["order-logs", search],
    queryFn: (page, pageSize) => listOrderLogs({ page, limit: pageSize, q: search || undefined }),
    getItems: (data) => data.logs || [],
    getItemId: (log) => log.id,
  });

  const columns = useMemo<ColumnDef<OrderLog>[]>(
    () => [
      { id: "created_at", header: "Дата", accessorFn: (row) => formatDateTime(row.created_at) },
      { id: "action", header: "Действие", accessorKey: "action_label" },
      { id: "order_id", header: "Заказ", accessorKey: "order_id" },
      { id: "amount", header: "Сумма", accessorFn: (row) => formatAmount(row.order_amount) },
      {
        id: "client",
        header: "Клиент",
        accessorKey: "client_phone",
        cell: ({ getValue }) => getValue() || "—",
      },
      {
        id: "additional",
        header: "Доп. номер",
        accessorKey: "additional_phone",
        cell: ({ getValue }) => getValue() || "—",
      },
      {
        id: "payment",
        header: "Оплата",
        accessorFn: (row) => row.payment_provider_label || row.payment_provider || "—",
      },
      {
        id: "actor",
        header: "Сотрудник",
        accessorFn: (row) =>
          [row.actor_name, row.actor_phone, row.actor_telegram_id ? `TG ${row.actor_telegram_id}` : null]
            .filter(Boolean)
            .join(" · ") || "—",
      },
    ],
    [dateTimeFormat],
  );

  const logs = query.items;
  const total = query.total;

  return (
    <section className="card">
      <ListFiltersChrome
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Поиск по журналу заказов…"
      />

      <div className="ticket-table-section">
        {compact ? (
          <EntityCards
            items={logs}
            isLoading={query.isPending}
            emptyMessage={search ? "Ничего не найдено." : "Записей пока нет."}
            getKey={(log) => String(log.id)}
            getTitle={(log) => log.action_label || log.action || "Событие"}
            getSubtitle={(log) =>
              [formatDateTime(log.created_at), log.order_id ? `Заказ ${log.order_id}` : null]
                .filter(Boolean)
                .join(" · ")
            }
            getFields={(log) => [
              { label: "Сумма", value: formatAmount(log.order_amount) },
              { label: "Клиент", value: log.client_phone || "—" },
              { label: "Доп. номер", value: log.additional_phone || "—" },
              {
                label: "Оплата",
                value: log.payment_provider_label || log.payment_provider || "—",
              },
              {
                label: "Сотрудник",
                value:
                  [log.actor_name, log.actor_phone, log.actor_telegram_id ? `TG ${log.actor_telegram_id}` : null]
                    .filter(Boolean)
                    .join(" · ") || "—",
              },
            ]}
          />
        ) : (
          <SimpleTable
            tableKey="bot-admin.order-logs"
            data={logs}
            columns={columns}
            isLoading={query.isPending}
            serverSideSearch
            emptyMessage={search ? "Ничего не найдено." : "Записей пока нет."}
            getRowId={(row) => String(row.id)}
          />
        )}
        <InfiniteScrollSentinel
          loaded={logs.length}
          total={total}
          hasNextPage={Boolean(query.hasNextPage)}
          isFetchingNextPage={query.isFetchingNextPage}
          fetchNextPage={query.fetchNextPage}
        />
      </div>
    </section>
  );
}
