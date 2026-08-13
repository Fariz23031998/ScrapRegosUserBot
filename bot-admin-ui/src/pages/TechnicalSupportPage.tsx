import { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import {
  createTechnicalSupportSubscription,
  deactivateTechnicalSupportSubscription,
  deleteTechnicalSupportSubscription,
  getTechnicalSupportPrices,
  listTechnicalSupportSubscriptions,
  saveTechnicalSupportPrices,
  updateTechnicalSupportSubscription,
} from "../api/catalog";
import EntityCards from "../components/EntityCards";
import InfiniteScrollSentinel from "../components/InfiniteScrollSentinel";
import ListFiltersChrome from "../components/ListFiltersChrome";
import Modal from "../components/Modal";
import SimpleTable from "../components/SimpleTable";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { usePagedInfiniteQuery } from "../hooks/usePagedInfiniteQuery";
import { useUiPreferences } from "../hooks/useUiPreferences";
import type { TechnicalSupportSubscription } from "../lib/types";
import { canonicalizeUzbekPhone, formatAmount, formatDateTime, formatUzbekPhone } from "../lib/utils";

const DURATIONS = [1, 3, 6, 12] as const;
const CUSTOM_MONTHS = "custom";

type SupportTab = "subscriptions" | "prices";

function durationLabel(months: number): string {
  if (months === 1) return "1 месяц";
  if (months === 3) return "3 месяца";
  if (months === 6) return "6 месяцев";
  if (months === 12) return "12 месяцев";
  if (months === 0) return "Custom";
  return `${months} мес.`;
}

function toDateInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addLocalMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getDate();
  result.setMonth(result.getMonth() + months);
  if (result.getDate() < day) result.setDate(0);
  return result;
}

function suggestedEndsAtFromMonths(months: number): string {
  return toDateInputValue(addLocalMonths(new Date(), months));
}

function fromDateInputValue(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date.toISOString();
}

function SupportFilterFields({
  status,
  onStatusChange,
  showActions,
  onApply,
}: {
  status: string;
  onStatusChange: (value: string) => void;
  showActions?: boolean;
  onApply?: () => void;
}) {
  return (
    <>
      <label className="ticket-filters__field">
        <span>Статус</span>
        <select value={status} onChange={(e) => onStatusChange(e.target.value)}>
          <option value="">Все</option>
          <option value="active">Активные</option>
          <option value="expired">Истёкшие</option>
        </select>
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

function subscriptionActions(
  item: TechnicalSupportSubscription,
  hasPermission: (key: string) => boolean,
  onEdit: (item: TechnicalSupportSubscription) => void,
  onDeactivate: (id: number) => void,
  onDelete: (id: number) => void,
): ReactNode {
  return (
    <>
      {hasPermission("technical_support_edit") ? (
        <>
          <button type="button" className="btn-secondary" onClick={() => onEdit(item)}>
            Изменить
          </button>
          <button type="button" className="btn-secondary" onClick={() => onDeactivate(item.id)}>
            Деактивировать
          </button>
        </>
      ) : null}
      {hasPermission("technical_support_delete") ? (
        <button type="button" className="btn-danger" onClick={() => void onDelete(item.id)}>
          Удалить
        </button>
      ) : null}
    </>
  );
}

export default function TechnicalSupportPage() {
  const { hasPermission } = useAuth();
  const { dateTimeFormat } = useUiPreferences();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const [tab, setTab] = useState<SupportTab>("subscriptions");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [appliedStatus, setAppliedStatus] = useState("");
  const [priceDraft, setPriceDraft] = useState<Record<string, number>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [createMonths, setCreateMonths] = useState<string>("3");
  const [createEndsAt, setCreateEndsAt] = useState(() => suggestedEndsAtFromMonths(3));
  const [createAmount, setCreateAmount] = useState(0);
  const [editItem, setEditItem] = useState<TechnicalSupportSubscription | null>(null);
  const [message, setMessage] = useState("");
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
  const isCustomDuration = createMonths === CUSTOM_MONTHS;

  const pricesQuery = useQuery({
    queryKey: ["ts-prices"],
    queryFn: async () => {
      const data = await getTechnicalSupportPrices();
      const map: Record<string, number> = {};
      const list = Array.isArray(data.prices) ? data.prices : [];
      for (const months of DURATIONS) {
        const fromList = list.find((row) => Number(row.months) === months);
        const fromMap = Array.isArray(data.prices) ? undefined : data.prices?.[String(months)];
        map[String(months)] = Number(fromList?.amount ?? fromMap ?? 0);
      }
      setPriceDraft(map);
      return data;
    },
  });

  const subsQuery = usePagedInfiniteQuery({
    queryKey: ["ts-subscriptions", search, appliedStatus],
    queryFn: (page, pageSize) =>
      listTechnicalSupportSubscriptions({
        page,
        limit: pageSize,
        q: search || undefined,
        status: appliedStatus || undefined,
      }),
    getItems: (data) => data.subscriptions || [],
    getItemId: (item) => item.id,
  });

  const savePricesMutation = useMutation({
    mutationFn: () => saveTechnicalSupportPrices(priceDraft),
    onSuccess: () => {
      setMessage("Цены сохранены.");
      void queryClient.invalidateQueries({ queryKey: ["ts-prices"] });
    },
  });

  const createMutation = useMutation({
    mutationFn: createTechnicalSupportSubscription,
    onSuccess: () => {
      setCreateOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["ts-subscriptions"] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ends_at }: { id: number; ends_at: string }) =>
      updateTechnicalSupportSubscription(id, { ends_at }),
    onSuccess: () => {
      setEditItem(null);
      void queryClient.invalidateQueries({ queryKey: ["ts-subscriptions"] });
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: deactivateTechnicalSupportSubscription,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["ts-subscriptions"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteTechnicalSupportSubscription,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["ts-subscriptions"] }),
  });

  async function handleDelete(id: number) {
    const ok = await confirm({ message: "Удалить подписку?", variant: "danger" });
    if (ok) deleteMutation.mutate(id);
  }

  function applyStatusFilter() {
    setAppliedStatus(status);
  }

  function openCreateModal() {
    setCreateMonths("3");
    setCreateEndsAt(suggestedEndsAtFromMonths(3));
    setCreateAmount(Number(priceDraft["3"] || 0));
    setCreateOpen(true);
  }

  function handleMonthsChange(value: string) {
    setCreateMonths(value);
    if (value === CUSTOM_MONTHS) return;
    const months = Number(value);
    if ((DURATIONS as readonly number[]).includes(months)) {
      setCreateEndsAt(suggestedEndsAtFromMonths(months));
      setCreateAmount(Number(priceDraft[value] || 0));
    }
  }

  function handleEndsAtChange(value: string) {
    setCreateEndsAt(value);
    setCreateMonths(CUSTOM_MONTHS);
  }

  const columns = useMemo<ColumnDef<TechnicalSupportSubscription>[]>(
    () => [
      { id: "phone", header: "Телефон", accessorFn: (row) => formatUzbekPhone(row.phone) },
      { id: "months", header: "Срок", accessorFn: (row) => durationLabel(Number(row.months || 0)) },
      { id: "amount", header: "Сумма", accessorFn: (row) => formatAmount(row.amount) },
      { id: "order_id", header: "Заказ", accessorKey: "order_id", cell: ({ getValue }) => getValue() || "—" },
      { id: "starts_at", header: "Начало", accessorFn: (row) => formatDateTime(row.starts_at) },
      { id: "ends_at", header: "Окончание", accessorFn: (row) => formatDateTime(row.ends_at) },
      { id: "status", header: "Статус", accessorKey: "status_label" },
      {
        id: "actions",
        header: "Действия",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="cell-actions">
            {subscriptionActions(
              row.original,
              hasPermission,
              setEditItem,
              (id) => void deactivateMutation.mutateAsync(id),
              handleDelete,
            )}
          </div>
        ),
      },
    ],
    [confirm, dateTimeFormat, deactivateMutation, deleteMutation, hasPermission],
  );

  const subscriptions = subsQuery.items;
  const total = subsQuery.total;
  const emptyMessage = search || appliedStatus ? "Ничего не найдено. Измените фильтры." : "Подписок пока нет.";

  return (
    <section className="card">
      <div className="card-toolbar">
        <div className="role-tabs" role="tablist">
          <button
            type="button"
            className={`role-tab${tab === "subscriptions" ? " role-tab--active" : ""}`}
            role="tab"
            aria-selected={tab === "subscriptions"}
            onClick={() => setTab("subscriptions")}
          >
            Подписки
          </button>
          <button
            type="button"
            className={`role-tab${tab === "prices" ? " role-tab--active" : ""}`}
            role="tab"
            aria-selected={tab === "prices"}
            onClick={() => setTab("prices")}
          >
            Цены
          </button>
        </div>
        {tab === "subscriptions" && hasPermission("technical_support_create") ? (
          <button type="button" className="btn-primary" onClick={openCreateModal}>
            + Создать
          </button>
        ) : null}
        {tab === "prices" && hasPermission("technical_support_edit") ? (
          <button
            type="button"
            className="btn-primary"
            onClick={() => savePricesMutation.mutate()}
            disabled={savePricesMutation.isPending || pricesQuery.isLoading}
          >
            Сохранить цены
          </button>
        ) : null}
      </div>
      {message ? <p className="message success">{message}</p> : null}

      {tab === "prices" ? (
        <div className="filters-grid">
          {DURATIONS.map((months) => (
            <label key={months}>
              {durationLabel(months)}
              <input
                type="number"
                min={0}
                value={priceDraft[String(months)] ?? 0}
                disabled={!hasPermission("technical_support_edit")}
                onChange={(event) =>
                  setPriceDraft((prev) => ({ ...prev, [String(months)]: Number(event.target.value) }))
                }
              />
            </label>
          ))}
        </div>
      ) : (
        <>
          <ListFiltersChrome
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder="Телефон или заказ…"
            filtersActive={Boolean(appliedStatus)}
            filtersModalOpen={filtersModalOpen}
            onFiltersModalOpenChange={setFiltersModalOpen}
            onApplyFilters={applyStatusFilter}
            onResetFilters={() => setStatus("")}
            desktopFilters={
              <SupportFilterFields
                status={status}
                onStatusChange={setStatus}
                showActions
                onApply={applyStatusFilter}
              />
            }
            sheetFilters={<SupportFilterFields status={status} onStatusChange={setStatus} />}
          />

          <div className="ticket-table-section">
            {compact ? (
              <EntityCards
                items={subscriptions}
                isLoading={subsQuery.isPending}
                emptyMessage={emptyMessage}
                getKey={(item) => String(item.id)}
                getTitle={(item) => formatUzbekPhone(item.phone) || `Подписка #${item.id}`}
                getSubtitle={(item) =>
                  [item.status_label, durationLabel(Number(item.months || 0)), formatAmount(item.amount)]
                    .filter(Boolean)
                    .join(" · ")
                }
                getFields={(item) => [
                  { label: "Заказ", value: item.order_id || "—" },
                  { label: "Начало", value: formatDateTime(item.starts_at) },
                  { label: "Окончание", value: formatDateTime(item.ends_at) },
                ]}
                getActions={(item) =>
                  subscriptionActions(
                    item,
                    hasPermission,
                    setEditItem,
                    (id) => void deactivateMutation.mutateAsync(id),
                    handleDelete,
                  )
                }
              />
            ) : (
              <SimpleTable
                tableKey="bot-admin.technical-support"
                data={subscriptions}
                columns={columns}
                isLoading={subsQuery.isPending}
                serverSideSearch
                emptyMessage={emptyMessage}
                getRowId={(row) => String(row.id)}
              />
            )}
            <InfiniteScrollSentinel
              loaded={subscriptions.length}
              total={total}
              hasNextPage={Boolean(subsQuery.hasNextPage)}
              isFetchingNextPage={subsQuery.isFetchingNextPage}
              fetchNextPage={subsQuery.fetchNextPage}
            />
          </div>
        </>
      )}

      <Modal title="Новая подписка" open={createOpen} onClose={() => setCreateOpen(false)}>
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const months = isCustomDuration ? 0 : Number(createMonths);
            const endsAt = fromDateInputValue(createEndsAt);
            const rawPhone = String(form.get("phone") || "");
            const phone = canonicalizeUzbekPhone(rawPhone) || rawPhone;
            createMutation.mutate(
              isCustomDuration
                ? { phone, months: 0, amount: Number(createAmount), ends_at: endsAt }
                : { phone, months, amount: Number(priceDraft[String(months)] || 0) },
            );
          }}
        >
          <label>
            Телефон
            <input name="phone" type="tel" required />
          </label>
          <label>
            Срок (мес.)
            <select value={createMonths} onChange={(event) => handleMonthsChange(event.target.value)}>
              {DURATIONS.map((m) => (
                <option key={m} value={m}>
                  {durationLabel(m)}
                </option>
              ))}
              <option value={CUSTOM_MONTHS}>Custom</option>
            </select>
          </label>
          <label>
            Сумма
            <input
              name="amount"
              type="number"
              min={0}
              value={createAmount}
              onChange={(event) => setCreateAmount(Number(event.target.value))}
              disabled={!isCustomDuration}
              required
            />
          </label>
          <label>
            Окончание
            <input
              name="ends_at"
              type="date"
              value={createEndsAt}
              onChange={(event) => handleEndsAtChange(event.target.value)}
              disabled={!isCustomDuration}
              required={isCustomDuration}
            />
          </label>
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setCreateOpen(false)}>
              Отмена
            </button>
            <button type="submit" className="btn-primary">
              Создать
            </button>
          </div>
        </form>
      </Modal>

      <Modal title="Изменить подписку" open={editItem != null} onClose={() => setEditItem(null)}>
        {editItem ? (
          <form
            className="stack-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              updateMutation.mutate({ id: editItem.id, ends_at: String(form.get("ends_at")) });
            }}
          >
            <p>
              {formatUzbekPhone(editItem.phone)} · {durationLabel(Number(editItem.months || 0))}
            </p>
            <label>
              Окончание
              <input name="ends_at" type="date" defaultValue={(editItem.ends_at || "").slice(0, 10)} required />
            </label>
            <div className="form-actions">
              <button type="button" className="btn-secondary" onClick={() => setEditItem(null)}>
                Отмена
              </button>
              <button type="submit" className="btn-primary">
                Сохранить
              </button>
            </div>
          </form>
        ) : null}
      </Modal>
    </section>
  );
}
