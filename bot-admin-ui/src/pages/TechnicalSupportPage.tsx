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
import ListFiltersChrome from "../components/ListFiltersChrome";
import Modal from "../components/Modal";
import Pagination from "../components/Pagination";
import SimpleTable from "../components/SimpleTable";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { useUiPreferences } from "../hooks/useUiPreferences";
import type { TechnicalSupportSubscription } from "../lib/types";
import { formatAmount, formatDateTime } from "../lib/utils";

const DURATIONS = [1, 3, 6, 12] as const;

function durationLabel(months: number): string {
  if (months === 1) return "1 месяц";
  if (months === 3) return "3 месяца";
  if (months === 6) return "6 месяцев";
  if (months === 12) return "12 месяцев";
  return `${months} мес.`;
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
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [appliedStatus, setAppliedStatus] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [priceDraft, setPriceDraft] = useState<Record<string, number>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [editItem, setEditItem] = useState<TechnicalSupportSubscription | null>(null);
  const [message, setMessage] = useState("");
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);

  const pricesQuery = useQuery({
    queryKey: ["ts-prices"],
    queryFn: async () => {
      const data = await getTechnicalSupportPrices();
      const map: Record<string, number> = {};
      for (const months of DURATIONS) map[String(months)] = Number(data.prices?.[String(months)] || 0);
      setPriceDraft(map);
      return data;
    },
  });

  const subsQuery = useQuery({
    queryKey: ["ts-subscriptions", page, limit, search, appliedStatus],
    queryFn: () =>
      listTechnicalSupportSubscriptions({
        page,
        limit,
        q: search || undefined,
        status: appliedStatus || undefined,
      }),
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
    setPage(1);
    setAppliedStatus(status);
  }

  const columns = useMemo<ColumnDef<TechnicalSupportSubscription>[]>(
    () => [
      { id: "phone", header: "Телефон", accessorKey: "phone" },
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

  const subscriptions = subsQuery.data?.subscriptions || [];
  const total = subsQuery.data?.total || 0;
  const emptyMessage = search || appliedStatus ? "Ничего не найдено. Измените фильтры." : "Подписок пока нет.";

  return (
    <section className="card">
      <h1>Техподдержка</h1>
      {message ? <p className="message success">{message}</p> : null}

      <h2>Цены</h2>
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
      {hasPermission("technical_support_edit") ? (
        <button
          type="button"
          className="btn-primary"
          onClick={() => savePricesMutation.mutate()}
          disabled={savePricesMutation.isPending || pricesQuery.isLoading}
        >
          Сохранить цены
        </button>
      ) : null}

      <div className="card-toolbar" style={{ marginTop: "1.5rem" }}>
        <h2>Подписки</h2>
        {hasPermission("technical_support_create") ? (
          <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
            + Создать
          </button>
        ) : null}
      </div>

      <ListFiltersChrome
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
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
            isLoading={subsQuery.isLoading}
            emptyMessage={emptyMessage}
            getKey={(item) => String(item.id)}
            getTitle={(item) => item.phone || `Подписка #${item.id}`}
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
            isLoading={subsQuery.isLoading}
            serverSideSearch
            emptyMessage={emptyMessage}
            getRowId={(row) => String(row.id)}
          />
        )}
        <Pagination page={page} limit={limit} total={total} onPageChange={setPage} onLimitChange={setLimit} />
      </div>

      <Modal title="Новая подписка" open={createOpen} onClose={() => setCreateOpen(false)}>
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            createMutation.mutate({
              phone: form.get("phone"),
              months: Number(form.get("months")),
              amount: Number(form.get("amount")),
              ends_at: form.get("ends_at"),
            });
          }}
        >
          <label>
            Телефон
            <input name="phone" required />
          </label>
          <label>
            Срок (мес.)
            <select name="months" defaultValue="3">
              {DURATIONS.map((m) => (
                <option key={m} value={m}>
                  {durationLabel(m)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Сумма
            <input name="amount" type="number" min={0} defaultValue={0} required />
          </label>
          <label>
            Окончание
            <input name="ends_at" type="date" required />
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
              {editItem.phone} · {durationLabel(Number(editItem.months || 0))}
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
