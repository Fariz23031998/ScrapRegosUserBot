import { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { listAdminLogs } from "../api/admin";
import EntityCards from "../components/EntityCards";
import InfiniteScrollSentinel from "../components/InfiniteScrollSentinel";
import ListFiltersChrome from "../components/ListFiltersChrome";
import SimpleTable from "../components/SimpleTable";
import type { AdminLog } from "../lib/types";
import { formatDateTime } from "../lib/utils";
import { useUiPreferences } from "../hooks/useUiPreferences";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { usePagedInfiniteQuery } from "../hooks/usePagedInfiniteQuery";

function formatAuditValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "string" || typeof value === "number") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderChanges(
  log: AdminLog & {
    details?: Record<string, unknown>;
    summary?: string;
    entity_type_label?: string;
    entity_id?: string;
  },
) {
  const details = log.details;
  if (!details) return log.description || log.summary || "—";

  let rows: Array<{ field: string; from: unknown; to: unknown }> = [];
  if (details.changes && typeof details.changes === "object") {
    rows = Object.entries(details.changes as Record<string, { from?: unknown; to?: unknown }>).map(
      ([field, change]) => ({
        field,
        from: change?.from ?? null,
        to: change?.to ?? change,
      }),
    );
  } else {
    const before = (details.before as Record<string, unknown>) || null;
    const after = (details.after as Record<string, unknown>) || null;
    const keys = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})]));
    rows = keys
      .map((field) => ({ field, from: before?.[field], to: after?.[field] }))
      .filter((row) => JSON.stringify(row.from) !== JSON.stringify(row.to));
  }

  return (
    <div>
      <div>{log.summary || log.description || "—"}</div>
      {rows.length ? (
        <ul className="log-diff">
          {rows.map((row) => (
            <li key={row.field}>
              <strong>{row.field}:</strong> {formatAuditValue(row.from)} → {formatAuditValue(row.to)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function entityLabel(log: AdminLog & { entity_type_label?: string; entity_id?: string }) {
  const label = log.entity_type_label || log.entity_type || "—";
  return log.entity_id ? `${label} · ${log.entity_id}` : label;
}

export default function LogsPage() {
  const { dateTimeFormat } = useUiPreferences();
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const [search, setSearch] = useState("");

  const query = usePagedInfiniteQuery({
    queryKey: ["admin-logs", search],
    queryFn: (page, pageSize) => listAdminLogs({ page, limit: pageSize, q: search || undefined }),
    getItems: (data) => data.logs || [],
    getItemId: (log) => log.id,
  });

  const columns = useMemo<ColumnDef<AdminLog>[]>(
    () => [
      { id: "created_at", header: "Дата", accessorFn: (row) => formatDateTime(row.created_at) },
      { id: "action", header: "Действие", accessorKey: "action_label" },
      {
        id: "entity",
        header: "Объект",
        cell: ({ row }) =>
          entityLabel(row.original as AdminLog & { entity_type_label?: string; entity_id?: string }),
      },
      {
        id: "description",
        header: "Описание / изменения",
        cell: ({ row }) =>
          renderChanges(
            row.original as AdminLog & { details?: Record<string, unknown>; summary?: string },
          ),
      },
      {
        id: "actor",
        header: "Сотрудник",
        accessorFn: (row) => [row.actor_name, row.actor_phone].filter(Boolean).join(" · ") || "—",
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
        searchPlaceholder="Поиск по журналу…"
      />

      <div className="ticket-table-section">
        {compact ? (
          <EntityCards
            items={logs}
            isLoading={query.isPending}
            emptyMessage={search ? "Ничего не найдено." : "Записей пока нет."}
            getKey={(log) => String(log.id)}
            getTitle={(log) => log.action_label || log.action || "Событие"}
            getSubtitle={(log) => formatDateTime(log.created_at)}
            getFields={(log) => [
              {
                label: "Объект",
                value: entityLabel(log as AdminLog & { entity_type_label?: string; entity_id?: string }),
              },
              {
                label: "Сотрудник",
                value: [log.actor_name, log.actor_phone].filter(Boolean).join(" · ") || "—",
              },
              {
                label: "Описание",
                value: renderChanges(
                  log as AdminLog & { details?: Record<string, unknown>; summary?: string },
                ),
              },
            ]}
          />
        ) : (
          <SimpleTable
            tableKey="bot-admin.logs"
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
