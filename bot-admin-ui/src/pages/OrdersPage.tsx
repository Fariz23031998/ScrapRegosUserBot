import { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  deleteCashOrder,
  deleteOrder,
  listOrderEmployees,
  listOrders,
  markPaidCash,
  renotifyOrder,
} from "../api/admin";
import EntityCards from "../components/EntityCards";
import ListFiltersChrome from "../components/ListFiltersChrome";
import Pagination from "../components/Pagination";
import SimpleTable from "../components/SimpleTable";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { useUiPreferences } from "../hooks/useUiPreferences";
import type { Order } from "../lib/types";
import { formatAmount, formatDateTime } from "../lib/utils";

type OrderFilters = {
  search: string;
  client: string;
  status: string;
  employee: string;
  fromDate: string;
  toDate: string;
};

function employeeOptionLabel(employee: {
  display_name?: string | null;
  phone?: string | null;
  telegram_id: number;
}) {
  return (
    [employee.display_name, employee.phone].filter(Boolean).join(" · ") ||
    `TG ${employee.telegram_id}`
  );
}

function defaultFiltersFromParams(params: URLSearchParams): OrderFilters {
  return {
    search: params.get("q") || "",
    client: params.get("client") || "",
    status: params.get("status") || "",
    employee: params.get("telegram_id") || params.get("employee") || "",
    fromDate: params.get("from_date") || "",
    toDate: params.get("to_date") || "",
  };
}

function filtersHaveAdvancedValues(filters: OrderFilters) {
  return Boolean(filters.client || filters.status || filters.employee || filters.fromDate || filters.toDate);
}

function OrderFilterFields({
  filters,
  setFilters,
  employees,
  showActions,
  onApply,
}: {
  filters: OrderFilters;
  setFilters: (next: OrderFilters) => void;
  employees: Array<{ display_name?: string | null; phone?: string | null; telegram_id: number }>;
  showActions?: boolean;
  onApply?: () => void;
}) {
  return (
    <>
      <label className="ticket-filters__field">
        <span>Телефон клиента</span>
        <input
          value={filters.client}
          onChange={(e) => setFilters({ ...filters, client: e.target.value })}
        />
      </label>
      <label className="ticket-filters__field">
        <span>Статус</span>
        <select
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value })}
        >
          <option value="">Все</option>
          <option value="pending">Ожидает оплаты</option>
          <option value="paid">Оплачен</option>
          <option value="paid_cash">Наличные</option>
          <option value="deleted">Удалён</option>
        </select>
      </label>
      <label className="ticket-filters__field">
        <span>Сотрудник</span>
        <select
          value={filters.employee}
          onChange={(e) => setFilters({ ...filters, employee: e.target.value })}
        >
          <option value="">Все</option>
          {employees.map((row) => (
            <option key={row.telegram_id} value={String(row.telegram_id)}>
              {employeeOptionLabel(row)}
            </option>
          ))}
        </select>
      </label>
      <label className="ticket-filters__field">
        <span>С даты</span>
        <input
          type="date"
          value={filters.fromDate}
          onChange={(e) => setFilters({ ...filters, fromDate: e.target.value })}
        />
      </label>
      <label className="ticket-filters__field">
        <span>По дату</span>
        <input
          type="date"
          value={filters.toDate}
          onChange={(e) => setFilters({ ...filters, toDate: e.target.value })}
        />
      </label>
      {showActions ? (
        <div className="ticket-filters__actions">
          <button type="button" className="btn-primary" onClick={onApply}>
            Применить
          </button>
        </div>
      ) : null}
    </>
  );
}

function orderActionButtons(
  order: Order,
  hasPermission: (key: string) => boolean,
  onAction: (action: string, id: string) => void,
): ReactNode {
  const actions: Array<{ key: string; label: string; className?: string }> = [];
  if (order.status === "pending") {
    if (hasPermission("renotify_order")) actions.push({ key: "renotify", label: "Уведомить" });
    if (hasPermission("mark_paid_cash")) actions.push({ key: "paid-cash", label: "Наличные" });
    if (hasPermission("delete_unpaid_order")) {
      actions.push({ key: "delete", label: "Удалить", className: "btn-danger" });
    }
  } else if (order.status === "paid_cash" && hasPermission("delete_cash_order")) {
    actions.push({ key: "delete-cash", label: "Удалить", className: "btn-danger" });
  }
  if (!actions.length) return null;
  return actions.map((a) => (
    <button
      key={a.key}
      type="button"
      className={a.className || "btn-secondary"}
      onClick={() => void onAction(a.key, order.id)}
    >
      {a.label}
    </button>
  ));
}

export default function OrdersPage() {
  const { hasPermission } = useAuth();
  const { dateTimeFormat } = useUiPreferences();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const [searchParams, setSearchParams] = useSearchParams();
  const bootstrap = defaultFiltersFromParams(searchParams);
  const [page, setPage] = useState(Number(searchParams.get("page")) || 1);
  const [limit, setLimit] = useState(25);
  const [filters, setFilters] = useState(bootstrap);
  const [appliedFilters, setAppliedFilters] = useState(bootstrap);
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);

  const employeesQuery = useQuery({
    queryKey: ["order-employees"],
    queryFn: listOrderEmployees,
  });

  const ordersQuery = useQuery({
    queryKey: ["orders", page, limit, appliedFilters],
    queryFn: () =>
      listOrders({
        page: String(page),
        limit: String(limit),
        ...(appliedFilters.search ? { q: appliedFilters.search } : {}),
        ...(appliedFilters.client ? { client: appliedFilters.client } : {}),
        ...(appliedFilters.status ? { status: appliedFilters.status } : {}),
        ...(appliedFilters.employee ? { telegram_id: appliedFilters.employee } : {}),
        ...(appliedFilters.fromDate ? { from_date: appliedFilters.fromDate } : {}),
        ...(appliedFilters.toDate ? { to_date: appliedFilters.toDate } : {}),
      }),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["orders"] });

  const actionMutation = useMutation({
    mutationFn: async ({ action, id }: { action: string; id: string }) => {
      if (action === "delete") return deleteOrder(id);
      if (action === "delete-cash") return deleteCashOrder(id);
      if (action === "paid-cash") return markPaidCash(id);
      if (action === "renotify") return renotifyOrder(id);
      throw new Error("Unknown action");
    },
    onSuccess: invalidate,
  });

  async function handleAction(action: string, id: string) {
    const messages: Record<string, string> = {
      delete: "Удалить неоплаченный заказ?",
      "delete-cash": "Удалить заказ, оплаченный наличными?",
      "paid-cash": "Отметить заказ как оплаченный наличными?",
      renotify: "Повторно отправить уведомление?",
    };
    const ok = await confirm({ message: messages[action] || "Продолжить?" });
    if (ok) actionMutation.mutate({ action, id });
  }

  function syncParams(nextFilters: OrderFilters, nextPage = page) {
    const next = new URLSearchParams();
    if (nextFilters.search) next.set("q", nextFilters.search);
    if (nextFilters.client) next.set("client", nextFilters.client);
    if (nextFilters.status) next.set("status", nextFilters.status);
    if (nextFilters.employee) next.set("telegram_id", nextFilters.employee);
    if (nextFilters.fromDate) next.set("from_date", nextFilters.fromDate);
    if (nextFilters.toDate) next.set("to_date", nextFilters.toDate);
    if (nextPage > 1) next.set("page", String(nextPage));
    setSearchParams(next);
  }

  function applyFilters(next = filters) {
    setPage(1);
    setAppliedFilters(next);
    syncParams(next, 1);
  }

  const columns = useMemo<ColumnDef<Order>[]>(
    () => [
      { id: "created_at", header: "Дата", accessorFn: (row) => formatDateTime(row.created_at) },
      { id: "id", header: "ID", accessorKey: "id" },
      {
        id: "status",
        header: "Статус",
        cell: ({ row }) => row.original.status_label || row.original.status || "—",
      },
      { id: "amount", header: "Сумма", accessorFn: (row) => formatAmount(row.amount) },
      {
        id: "client_phone",
        header: "Клиент",
        accessorKey: "client_phone",
        cell: ({ getValue }) => getValue() || "—",
      },
      {
        id: "additional_phone",
        header: "Доп. номер",
        accessorKey: "additional_phone",
        cell: ({ getValue }) => getValue() || "—",
      },
      {
        id: "employee",
        header: "Сотрудник",
        accessorFn: (row) => [row.employee_name].filter(Boolean).join(" · ") || "—",
      },
      {
        id: "payment",
        header: "Оплата",
        accessorFn: (row) => row.payment_provider_label || row.payment_provider || "—",
      },
      {
        id: "ticket",
        header: "Тикет",
        cell: ({ row }) =>
          row.original.ticket_id ? (
            <Link to={`/tickets/${row.original.ticket_id}`}>{row.original.ticket_id}</Link>
          ) : (
            "—"
          ),
      },
      {
        id: "actions",
        header: "Действия",
        enableSorting: false,
        cell: ({ row }) => {
          const buttons = orderActionButtons(row.original, hasPermission, handleAction);
          return buttons ? <div className="cell-actions">{buttons}</div> : "—";
        },
      },
    ],
    [hasPermission, dateTimeFormat],
  );

  const orders = ordersQuery.data?.orders || [];
  const total = ordersQuery.data?.total || 0;
  const employees = employeesQuery.data?.employees || [];
  const filtersActive = filtersHaveAdvancedValues(appliedFilters);
  const emptyMessage =
    appliedFilters.search || filtersHaveAdvancedValues(appliedFilters)
      ? "Ничего не найдено. Измените фильтры."
      : "Заказов пока нет.";

  return (
    <section className="card">
      <div className="card-toolbar">
        <h1>Заказы</h1>
      </div>

      <ListFiltersChrome
        search={filters.search}
        onSearchChange={(value) => {
          const next = { ...filters, search: value };
          setFilters(next);
          setPage(1);
          setAppliedFilters((current) => ({ ...current, search: value }));
          syncParams({ ...appliedFilters, search: value }, 1);
        }}
        searchPlaceholder="ID или телефон"
        filtersActive={filtersActive}
        filtersModalOpen={filtersModalOpen}
        onFiltersModalOpenChange={setFiltersModalOpen}
        onApplyFilters={() => applyFilters()}
        onResetFilters={() => {
          const next = {
            ...filters,
            client: "",
            status: "",
            employee: "",
            fromDate: "",
            toDate: "",
          };
          setFilters(next);
        }}
        desktopFilters={
          <OrderFilterFields
            filters={filters}
            setFilters={setFilters}
            employees={employees}
            showActions
            onApply={() => applyFilters()}
          />
        }
        sheetFilters={
          <OrderFilterFields filters={filters} setFilters={setFilters} employees={employees} />
        }
      />

      <div className="ticket-table-section">
        {compact ? (
          <EntityCards
            items={orders}
            isLoading={ordersQuery.isLoading}
            emptyMessage={emptyMessage}
            getKey={(order) => order.id}
            getTitle={(order) => `Заказ ${order.id}`}
            getSubtitle={(order) =>
              [order.status_label || order.status, formatAmount(order.amount)].filter(Boolean).join(" · ")
            }
            getFields={(order) => [
              { label: "Дата", value: formatDateTime(order.created_at) },
              { label: "Клиент", value: order.client_phone || "—" },
              { label: "Доп. номер", value: order.additional_phone || "—" },
              { label: "Сотрудник", value: order.employee_name || "—" },
              {
                label: "Оплата",
                value: order.payment_provider_label || order.payment_provider || "—",
              },
              {
                label: "Тикет",
                value: order.ticket_id ? (
                  <Link to={`/tickets/${order.ticket_id}`}>{order.ticket_id}</Link>
                ) : (
                  "—"
                ),
              },
            ]}
            getActions={(order) => orderActionButtons(order, hasPermission, handleAction)}
          />
        ) : (
          <SimpleTable
            tableKey="bot-admin.orders"
            data={orders}
            columns={columns}
            isLoading={ordersQuery.isLoading}
            serverSideSearch
            emptyMessage={emptyMessage}
            getRowId={(row) => row.id}
          />
        )}
        <Pagination page={page} limit={limit} total={total} onPageChange={setPage} onLimitChange={setLimit} />
      </div>
    </section>
  );
}
