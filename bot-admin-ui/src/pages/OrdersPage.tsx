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
import InfiniteScrollSentinel from "../components/InfiniteScrollSentinel";
import ListFiltersChrome from "../components/ListFiltersChrome";
import SimpleTable from "../components/SimpleTable";
import SummaryBar from "../components/SummaryBar";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { usePagedInfiniteQuery } from "../hooks/usePagedInfiniteQuery";
import { useUiPreferences } from "../hooks/useUiPreferences";
import type { Order, OrderSummary } from "../lib/types";
import { formatAmount, formatDateTime } from "../lib/utils";

type OrderFilters = {
  search: string;
  client: string;
  status: string;
  payment: string;
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
  const statusRaw = params.get("status") || "";
  const paymentRaw = params.get("payment") || params.get("payment_provider") || "";
  const statusIsCash = statusRaw === "paid_cash";
  return {
    search: params.get("q") || "",
    client: params.get("client") || "",
    status: statusIsCash ? "paid" : statusRaw,
    payment: paymentRaw || (statusIsCash ? "cash" : ""),
    employee: params.get("telegram_id") || params.get("employee") || "",
    fromDate: params.get("from_date") || "",
    toDate: params.get("to_date") || "",
  };
}

function filtersHaveAdvancedValues(filters: OrderFilters) {
  return Boolean(
    filters.client ||
      filters.status ||
      filters.payment ||
      filters.employee ||
      filters.fromDate ||
      filters.toDate,
  );
}

function emptyOrderSummary(count = 0): OrderSummary {
  return { count, pending: 0, paid: 0, deleted: 0, amount: 0 };
}

function addOrderToSummary(summary: OrderSummary, order: Order) {
  const status = String(order.status || "");
  if (status === "pending") summary.pending += 1;
  else if (status === "paid" || status === "paid_cash") summary.paid += 1;
  else if (status === "deleted") summary.deleted += 1;
  if (status === "paid" || status === "paid_cash") {
    const amount = Number(order.amount);
    if (Number.isFinite(amount)) summary.amount += amount;
  }
}

function resolveOrderSummary(
  pages: Array<{ summary?: OrderSummary }> | undefined,
  total: number,
  orders: Order[],
): OrderSummary {
  const fromApi = pages?.find((page) => page.summary)?.summary;
  if (fromApi) {
    return {
      count: Number(fromApi.count) || total,
      pending: Number(fromApi.pending) || 0,
      paid: Number(fromApi.paid) || 0,
      deleted: Number(fromApi.deleted) || 0,
      amount: Number(fromApi.amount) || 0,
    };
  }
  const summary = emptyOrderSummary(total);
  for (const order of orders) addOrderToSummary(summary, order);
  return summary;
}

function isOrderPaid(order: Order): boolean {
  const status = String(order.status || "");
  return status === "paid" || status === "paid_cash";
}

function orderStatusLabel(order: Order): string {
  if (isOrderPaid(order)) return "Оплачен";
  return order.status_label || String(order.status || "") || "—";
}

function orderPaymentLabel(order: Order): string {
  if (!isOrderPaid(order)) return "";
  return order.payment_provider_label || order.payment_provider || "";
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
          <option value="deleted">Удалён</option>
        </select>
      </label>
      <label className="ticket-filters__field">
        <span>Тип оплаты</span>
        <select
          value={filters.payment}
          onChange={(e) => setFilters({ ...filters, payment: e.target.value })}
        >
          <option value="">Все</option>
          <option value="payme">Payme</option>
          <option value="click">CLICK</option>
          <option value="cash">Наличные</option>
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
  const [filters, setFilters] = useState(bootstrap);
  const [appliedFilters, setAppliedFilters] = useState(bootstrap);
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);

  const employeesQuery = useQuery({
    queryKey: ["order-employees"],
    queryFn: listOrderEmployees,
  });

  const ordersQuery = usePagedInfiniteQuery({
    queryKey: ["orders", appliedFilters],
    queryFn: (page, pageSize) =>
      listOrders({
        page: String(page),
        limit: String(pageSize),
        ...(appliedFilters.search ? { q: appliedFilters.search } : {}),
        ...(appliedFilters.client ? { client: appliedFilters.client } : {}),
        ...(appliedFilters.status ? { status: appliedFilters.status } : {}),
        ...(appliedFilters.payment ? { payment: appliedFilters.payment } : {}),
        ...(appliedFilters.employee ? { telegram_id: appliedFilters.employee } : {}),
        ...(appliedFilters.fromDate ? { from_date: appliedFilters.fromDate } : {}),
        ...(appliedFilters.toDate ? { to_date: appliedFilters.toDate } : {}),
      }),
    getItems: (data) => data.orders || [],
    getItemId: (order) => order.id,
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

  function syncParams(nextFilters: OrderFilters) {
    const next = new URLSearchParams();
    if (nextFilters.search) next.set("q", nextFilters.search);
    if (nextFilters.client) next.set("client", nextFilters.client);
    if (nextFilters.status) next.set("status", nextFilters.status);
    if (nextFilters.payment) next.set("payment", nextFilters.payment);
    if (nextFilters.employee) next.set("telegram_id", nextFilters.employee);
    if (nextFilters.fromDate) next.set("from_date", nextFilters.fromDate);
    if (nextFilters.toDate) next.set("to_date", nextFilters.toDate);
    setSearchParams(next);
  }

  function applyFilters(next = filters) {
    setAppliedFilters(next);
    syncParams(next);
  }

  const columns = useMemo<ColumnDef<Order>[]>(
    () => [
      { id: "created_at", header: "Дата", accessorFn: (row) => formatDateTime(row.created_at) },
      { id: "id", header: "ID", accessorKey: "id" },
      {
        id: "status",
        header: "Статус",
        cell: ({ row }) => orderStatusLabel(row.original),
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
        accessorFn: (row) => orderPaymentLabel(row),
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

  const orders = ordersQuery.items;
  const total = ordersQuery.total;
  const orderSummary = resolveOrderSummary(ordersQuery.data?.pages, total, orders);
  const employees = employeesQuery.data?.employees || [];
  const filtersActive = filtersHaveAdvancedValues(appliedFilters);
  const emptyMessage =
    appliedFilters.search || filtersHaveAdvancedValues(appliedFilters)
      ? "Ничего не найдено. Измените фильтры."
      : "Заказов пока нет.";

  return (
    <section className="card">
      <SummaryBar
        placeholder={ordersQuery.isPending ? "Загрузка…" : undefined}
        items={
          ordersQuery.isPending
            ? undefined
            : [
                { label: "заказов", value: orderSummary.count, tone: "neutral", valueFirst: true },
                { label: "Сумма", value: formatAmount(orderSummary.amount), tone: "info" },
                { label: "Неоплачен", value: orderSummary.pending, tone: "warn" },
                { label: "Оплачен", value: orderSummary.paid, tone: "ok" },
                { label: "Удалён", value: orderSummary.deleted, tone: "muted" },
              ]
        }
      />
      <ListFiltersChrome
        search={filters.search}
        onSearchChange={(value) => {
          const next = { ...filters, search: value };
          setFilters(next);
          setAppliedFilters((current) => ({ ...current, search: value }));
          syncParams({ ...appliedFilters, search: value });
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
            payment: "",
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
            isLoading={ordersQuery.isPending}
            emptyMessage={emptyMessage}
            getKey={(order) => order.id}
            getTitle={(order) => `Заказ ${order.id}`}
            getSubtitle={(order) =>
              [orderStatusLabel(order), formatAmount(order.amount)].filter(Boolean).join(" · ")
            }
            getFields={(order) => [
              { label: "Дата", value: formatDateTime(order.created_at) },
              { label: "Клиент", value: order.client_phone || "—" },
              { label: "Доп. номер", value: order.additional_phone || "—" },
              { label: "Сотрудник", value: order.employee_name || "—" },
              {
                label: "Оплата",
                value: orderPaymentLabel(order),
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
            isLoading={ordersQuery.isPending}
            serverSideSearch
            emptyMessage={emptyMessage}
            getRowId={(row) => row.id}
          />
        )}
        <InfiniteScrollSentinel
          loaded={orders.length}
          total={total}
          hasNextPage={Boolean(ordersQuery.hasNextPage)}
          isFetchingNextPage={ordersQuery.isFetchingNextPage}
          fetchNextPage={ordersQuery.fetchNextPage}
        />
      </div>
    </section>
  );
}
