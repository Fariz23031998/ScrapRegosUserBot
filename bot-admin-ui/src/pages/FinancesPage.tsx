import { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Pencil, Trash2 } from "lucide-react";
import {
  createFinanceCategory,
  createFinancePayment,
  deleteFinanceCategory,
  deleteFinancePayment,
  listFinanceAccounts,
  listFinanceCategories,
  listFinanceLocations,
  listFinancePayments,
  updateFinanceCategory,
  updateFinancePayment,
} from "../api/finances";
import CatalogCategoryManager from "../components/CatalogCategoryManager";
import EntityCards from "../components/EntityCards";
import ListFiltersChrome from "../components/ListFiltersChrome";
import Modal from "../components/Modal";
import SimpleTable from "../components/SimpleTable";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { useUiPreferences } from "../hooks/useUiPreferences";
import { formatMoneyLine, parseDisplayCurrency, type MoneyCurrency } from "../lib/money";
import type {
  AccountPayment,
  AccountPaymentDirection,
  CatalogCategory,
  PaymentAccount,
  TaskLocation,
} from "../lib/types";
import { datetimeLocalToIso, formatDateTime, matchesSearch, toDatetimeLocalInput } from "../lib/utils";

type PaymentEditor = {
  id?: number;
  account_id: string;
  direction: AccountPaymentDirection;
  amount: string;
  currency: MoneyCurrency;
  note: string;
  category_id: string;
  location_id: string;
  created_at: string;
};

function directionLabel(direction: AccountPaymentDirection): string {
  return direction === "out" ? "Расход" : "Приход";
}

function accountCurrency(account?: PaymentAccount | null): MoneyCurrency {
  return parseDisplayCurrency(account?.currency) || "UZS";
}

function FilterFields({
  accountId,
  direction,
  categoryId,
  locationId,
  accounts,
  categories,
  locations,
  onAccountChange,
  onDirectionChange,
  onCategoryChange,
  onLocationChange,
  showActions,
  onApply,
}: {
  accountId: string;
  direction: string;
  categoryId: string;
  locationId: string;
  accounts: PaymentAccount[];
  categories: CatalogCategory[];
  locations: TaskLocation[];
  onAccountChange: (value: string) => void;
  onDirectionChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onLocationChange: (value: string) => void;
  showActions?: boolean;
  onApply?: () => void;
}) {
  return (
    <>
      <label className="ticket-filters__field">
        <span>Счёт</span>
        <select value={accountId} onChange={(event) => onAccountChange(event.target.value)}>
          <option value="">Все</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </label>
      <label className="ticket-filters__field">
        <span>Тип</span>
        <select value={direction} onChange={(event) => onDirectionChange(event.target.value)}>
          <option value="">Все</option>
          <option value="in">Приход</option>
          <option value="out">Расход</option>
        </select>
      </label>
      <label className="ticket-filters__field">
        <span>Категория</span>
        <select value={categoryId} onChange={(event) => onCategoryChange(event.target.value)}>
          <option value="">Все</option>
          <option value="none">Без категории</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      <label className="ticket-filters__field">
        <span>Филиал</span>
        <select value={locationId} onChange={(event) => onLocationChange(event.target.value)}>
          <option value="">Все</option>
          <option value="none">Без филиала</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
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

export default function FinancesPage() {
  const { hasPermission } = useAuth();
  const { dateTimeFormat } = useUiPreferences();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const canCreate = hasPermission("finances_create");
  const canEdit = hasPermission("finances_edit");
  const canDelete = hasPermission("finances_delete");
  const [search, setSearch] = useState("");
  const [accountId, setAccountId] = useState("");
  const [direction, setDirection] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [appliedAccountId, setAppliedAccountId] = useState("");
  const [appliedDirection, setAppliedDirection] = useState("");
  const [appliedCategoryId, setAppliedCategoryId] = useState("");
  const [appliedLocationId, setAppliedLocationId] = useState("");
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [editor, setEditor] = useState<PaymentEditor | null>(null);
  const [formError, setFormError] = useState("");
  const [listError, setListError] = useState("");

  const accountsQuery = useQuery({
    queryKey: ["finance-accounts"],
    queryFn: listFinanceAccounts,
  });
  const categoriesQuery = useQuery({
    queryKey: ["finance-categories"],
    queryFn: listFinanceCategories,
  });
  const locationsQuery = useQuery({
    queryKey: ["finance-locations"],
    queryFn: listFinanceLocations,
  });
  const paymentsQuery = useQuery({
    queryKey: ["finance-payments", appliedAccountId, appliedDirection, appliedCategoryId, appliedLocationId],
    queryFn: () =>
      listFinancePayments({
        account_id: appliedAccountId || undefined,
        direction: (appliedDirection as AccountPaymentDirection) || undefined,
        category_id: appliedCategoryId || undefined,
        location_id: appliedLocationId || undefined,
      }),
  });

  const accounts = accountsQuery.data?.accounts || [];
  const categories = categoriesQuery.data?.categories || [];
  const locations = locationsQuery.data?.locations || [];
  const payments = paymentsQuery.data?.payments || [];
  const selectedAccount = accounts.find((item) => String(item.id) === editor?.account_id);

  function openCreate(nextDirection: AccountPaymentDirection) {
    const presetId = appliedAccountId || (accounts[0] ? String(accounts[0].id) : "");
    const account = accounts.find((item) => String(item.id) === presetId) || accounts[0] || null;
    setEditor({
      account_id: account ? String(account.id) : "",
      direction: nextDirection,
      amount: "",
      currency: accountCurrency(account),
      note: "",
      category_id: appliedCategoryId && appliedCategoryId !== "none" ? appliedCategoryId : "",
      location_id: appliedLocationId && appliedLocationId !== "none" ? appliedLocationId : "",
      created_at: toDatetimeLocalInput(new Date()),
    });
    setFormError("");
  }

  function openEdit(payment: AccountPayment) {
    setEditor({
      id: payment.id,
      account_id: String(payment.account_id),
      direction: payment.direction,
      amount: String(payment.amount),
      currency: parseDisplayCurrency(payment.currency) || "UZS",
      note: payment.note || "",
      category_id: payment.category_id ? String(payment.category_id) : "",
      location_id: payment.location_id ? String(payment.location_id) : "",
      created_at: toDatetimeLocalInput(payment.created_at) || toDatetimeLocalInput(new Date()),
    });
    setFormError("");
  }

  function invalidateFinances() {
    void queryClient.invalidateQueries({ queryKey: ["finance-accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["finance-categories"] });
    void queryClient.invalidateQueries({ queryKey: ["finance-locations"] });
    void queryClient.invalidateQueries({ queryKey: ["finance-payments"] });
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!editor) return Promise.reject(new Error("Форма не открыта."));
      const payload = {
        account_id: Number(editor.account_id),
        direction: editor.direction,
        amount: Number(editor.amount),
        currency: editor.currency,
        note: editor.note.trim() || undefined,
        category_id: editor.category_id ? Number(editor.category_id) : null,
        location_id: editor.location_id ? Number(editor.location_id) : null,
        created_at: datetimeLocalToIso(editor.created_at),
      };
      if (editor.id) return updateFinancePayment(editor.id, payload);
      return createFinancePayment(payload);
    },
    onSuccess: () => {
      setEditor(null);
      invalidateFinances();
    },
    onError: (error: Error) => setFormError(error.message),
  });

  async function handleDelete(payment: AccountPayment) {
    const ok = await confirm({
      message: `Удалить ${directionLabel(payment.direction).toLowerCase()} ${formatMoneyLine(
        payment.amount,
        payment.currency,
      )} по счёту «${payment.account?.name || payment.account_id}»?`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    setListError("");
    try {
      await deleteFinancePayment(payment.id);
      invalidateFinances();
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Не удалось удалить платёж.");
    }
  }

  async function handleDeleteCategory(category: CatalogCategory) {
    const ok = await confirm({
      message: `Удалить категорию «${category.name}»? Платежи останутся без категории.`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    await deleteFinanceCategory(category.id);
    invalidateFinances();
  }

  function paymentActions(payment: AccountPayment): ReactNode {
    if (!canEdit && !canDelete) return null;
    return (
      <div className="cell-actions">
        {canEdit ? (
          <button
            type="button"
            className="btn-secondary btn-icon btn-sm"
            aria-label="Изменить"
            title="Изменить"
            onClick={() => openEdit(payment)}
          >
            <Pencil size={15} aria-hidden="true" />
          </button>
        ) : null}
        {canDelete ? (
          <button
            type="button"
            className="btn-danger btn-icon btn-sm"
            aria-label="Удалить"
            title="Удалить"
            onClick={() => void handleDelete(payment)}
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    );
  }

  const visiblePayments = useMemo(
    () =>
      payments.filter((payment) =>
        matchesSearch(
          search,
          payment.account?.name,
          payment.note,
          payment.created_by?.name,
          payment.amount,
          payment.category?.name,
          payment.location?.name,
          directionLabel(payment.direction),
        ),
      ),
    [payments, search],
  );

  const columns = useMemo<ColumnDef<AccountPayment>[]>(
    () => [
      { id: "id", header: "ID", accessorKey: "id" },
      {
        id: "created_at",
        header: "Дата",
        accessorFn: (row) => formatDateTime(row.created_at),
      },
      {
        id: "direction",
        header: "Тип",
        accessorFn: (row) => directionLabel(row.direction),
      },
      {
        id: "account",
        header: "Счёт",
        accessorFn: (row) => row.account?.name || `Счёт #${row.account_id}`,
      },
      {
        id: "category",
        header: "Категория",
        accessorFn: (row) => row.category?.name || "—",
      },
      {
        id: "location",
        header: "Филиал",
        accessorFn: (row) => row.location?.name || "—",
      },
      {
        id: "amount",
        header: "Сумма",
        cell: ({ row }) => {
          const sign = row.original.direction === "out" ? "−" : "+";
          return `${sign}${formatMoneyLine(row.original.amount, row.original.currency)}`;
        },
      },
      {
        id: "note",
        header: "Комментарий",
        accessorFn: (row) => row.note || "—",
      },
      {
        id: "created_by",
        header: "Автор",
        accessorFn: (row) => row.created_by?.name || "—",
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => paymentActions(row.original),
      },
    ],
    [canEdit, canDelete, dateTimeFormat],
  );

  function applyFilters() {
    setAppliedAccountId(accountId);
    setAppliedDirection(direction);
    setAppliedCategoryId(categoryId);
    setAppliedLocationId(locationId);
  }

  return (
    <section className="card">
      <div className="card-toolbar">
        <div className="card-toolbar-right">
          {canCreate ? (
            <>
              <button type="button" className="btn-secondary" onClick={() => setCategoryManagerOpen(true)}>
                Категории
              </button>
              <button type="button" className="btn-primary" onClick={() => openCreate("in")}>
                Приход
              </button>
              <button type="button" className="btn-secondary" onClick={() => openCreate("out")}>
                Расход
              </button>
            </>
          ) : null}
        </div>
      </div>

      <section className="settings-catalog">
        <div className="settings-catalog__header">
          <h2>Счета</h2>
        </div>
        {accountsQuery.isLoading ? (
          <p className="empty-state">Загрузка счетов…</p>
        ) : !accounts.length ? (
          <p className="empty-state">
            Счетов нет. Добавьте их в <Link to="/settings">настройках</Link>.
          </p>
        ) : (
          <div className="cell-actions">
            <button
              type="button"
              className={!appliedAccountId ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
              onClick={() => {
                setAccountId("");
                setAppliedAccountId("");
              }}
            >
              Все
            </button>
            {accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                className={
                  appliedAccountId === String(account.id) ? "btn-primary btn-sm" : "btn-secondary btn-sm"
                }
                onClick={() => {
                  setAccountId(String(account.id));
                  setAppliedAccountId(String(account.id));
                }}
              >
                {account.name} · {formatMoneyLine(account.value, account.currency)}
              </button>
            ))}
          </div>
        )}
      </section>

      <ListFiltersChrome
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Поиск по счёту, комментарию, автору…"
        filtersActive={Boolean(appliedAccountId || appliedDirection || appliedCategoryId || appliedLocationId)}
        filtersModalOpen={filtersModalOpen}
        onFiltersModalOpenChange={setFiltersModalOpen}
        onApplyFilters={applyFilters}
        onResetFilters={() => {
          setAccountId("");
          setDirection("");
          setCategoryId("");
          setLocationId("");
        }}
        desktopFilters={
          <FilterFields
            accountId={accountId}
            direction={direction}
            categoryId={categoryId}
            locationId={locationId}
            accounts={accounts}
            categories={categories}
            locations={locations}
            onAccountChange={setAccountId}
            onDirectionChange={setDirection}
            onCategoryChange={setCategoryId}
            onLocationChange={setLocationId}
            showActions
            onApply={applyFilters}
          />
        }
        sheetFilters={
          <FilterFields
            accountId={accountId}
            direction={direction}
            categoryId={categoryId}
            locationId={locationId}
            accounts={accounts}
            categories={categories}
            locations={locations}
            onAccountChange={setAccountId}
            onDirectionChange={setDirection}
            onCategoryChange={setCategoryId}
            onLocationChange={setLocationId}
          />
        }
      />

      {listError ? <p className="message error">{listError}</p> : null}

      <div className="ticket-table-section">
        {compact ? (
          <EntityCards
            items={visiblePayments}
            isLoading={paymentsQuery.isPending}
            emptyMessage={
              search || appliedAccountId || appliedDirection || appliedCategoryId || appliedLocationId
                ? "Ничего не найдено."
                : "Платежей пока нет."
            }
            getKey={(payment) => String(payment.id)}
            getTitle={(payment) =>
              `${payment.direction === "out" ? "−" : "+"}${formatMoneyLine(payment.amount, payment.currency)}`
            }
            getSubtitle={(payment) =>
              [
                directionLabel(payment.direction),
                payment.account?.name,
                payment.category?.name,
                payment.location?.name,
              ]
                .filter(Boolean)
                .join(" · ")
            }
            getFields={(payment) => [
              { label: "Дата", value: formatDateTime(payment.created_at) },
              { label: "Комментарий", value: payment.note || "—" },
              { label: "Автор", value: payment.created_by?.name || "—" },
            ]}
            getActions={(payment) => paymentActions(payment)}
          />
        ) : (
          <SimpleTable
            tableKey="bot-admin.finances"
            data={visiblePayments}
            columns={columns}
            isLoading={paymentsQuery.isPending}
            serverSideSearch
            emptyMessage={
              search || appliedAccountId || appliedDirection || appliedCategoryId || appliedLocationId
                ? "Ничего не найдено."
                : "Платежей пока нет."
            }
            getRowId={(row) => String(row.id)}
          />
        )}
      </div>

      <Modal
        open={editor != null}
        title={
          editor?.id
            ? editor.direction === "out"
              ? "Изменить расход"
              : "Изменить приход"
            : editor?.direction === "out"
              ? "Расход"
              : "Приход"
        }
        onClose={() => setEditor(null)}
      >
        {!accounts.length ? (
          <p className="empty-state">
            Счетов нет. Добавьте их в <Link to="/settings">настройках</Link>.
          </p>
        ) : editor ? (
          <form
            className="stack-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!editor.account_id) {
                setFormError("Выберите счёт.");
                return;
              }
              const amount = Number(editor.amount);
              if (!Number.isFinite(amount) || amount <= 0) {
                setFormError("Укажите сумму больше 0.");
                return;
              }
              if (!editor.created_at || !datetimeLocalToIso(editor.created_at)) {
                setFormError("Укажите корректную дату платежа.");
                return;
              }
              setFormError("");
              saveMutation.mutate();
            }}
          >
            <label>
              Тип
              <select
                required
                value={editor.direction}
                onChange={(event) =>
                  setEditor((prev) =>
                    prev ? { ...prev, direction: event.target.value as AccountPaymentDirection } : prev,
                  )
                }
              >
                <option value="in">Приход</option>
                <option value="out">Расход</option>
              </select>
            </label>
            <label>
              Счёт
              <select
                required
                value={editor.account_id}
                onChange={(event) => {
                  const next = accounts.find((item) => String(item.id) === event.target.value);
                  setEditor((prev) =>
                    prev
                      ? {
                          ...prev,
                          account_id: event.target.value,
                          currency: accountCurrency(next),
                        }
                      : prev,
                  );
                }}
              >
                <option value="">Выберите счёт</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} ({account.currency})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Категория
              <select
                value={editor.category_id}
                onChange={(event) =>
                  setEditor((prev) => (prev ? { ...prev, category_id: event.target.value } : prev))
                }
              >
                <option value="">Без категории</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Филиал
              <select
                value={editor.location_id}
                onChange={(event) =>
                  setEditor((prev) => (prev ? { ...prev, location_id: event.target.value } : prev))
                }
              >
                <option value="">Без филиала</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Сумма{selectedAccount ? ` (${editor.currency})` : ""}
              <input
                required
                type="number"
                min={0}
                step="any"
                disabled={!editor.account_id}
                value={editor.amount}
                onChange={(event) =>
                  setEditor((prev) => (prev ? { ...prev, amount: event.target.value } : prev))
                }
              />
            </label>
            <label>
              Валюта
              <select
                value={editor.currency}
                disabled={!editor.account_id}
                onChange={(event) =>
                  setEditor((prev) =>
                    prev
                      ? {
                          ...prev,
                          currency: parseDisplayCurrency(event.target.value) || "UZS",
                        }
                      : prev,
                  )
                }
              >
                <option value="UZS">UZS</option>
                <option value="USD">USD</option>
              </select>
            </label>
            <label>
              Дата
              <input
                required
                type="datetime-local"
                step={1}
                value={editor.created_at}
                onChange={(event) =>
                  setEditor((prev) => (prev ? { ...prev, created_at: event.target.value } : prev))
                }
              />
            </label>
            <label>
              Комментарий
              <input
                maxLength={500}
                value={editor.note}
                onChange={(event) => setEditor((prev) => (prev ? { ...prev, note: event.target.value } : prev))}
              />
            </label>
            {formError ? <p className="message error">{formError}</p> : null}
            <div className="form-actions">
              <button type="button" className="btn-secondary" onClick={() => setEditor(null)}>
                Отмена
              </button>
              <button type="submit" className="btn-primary" disabled={saveMutation.isPending}>
                {editor.id
                  ? "Сохранить"
                  : editor.direction === "out"
                    ? "Провести расход"
                    : "Провести приход"}
              </button>
            </div>
          </form>
        ) : null}
      </Modal>

      <CatalogCategoryManager
        open={categoryManagerOpen}
        categories={categories}
        isLoading={categoriesQuery.isPending}
        canEdit={canCreate}
        onClose={() => setCategoryManagerOpen(false)}
        onSave={async (payload) => {
          if (payload.id) await updateFinanceCategory(payload.id, { name: payload.name });
          else await createFinanceCategory({ name: payload.name });
          invalidateFinances();
        }}
        onDelete={(category) => void handleDeleteCategory(category)}
      />
    </section>
  );
}
