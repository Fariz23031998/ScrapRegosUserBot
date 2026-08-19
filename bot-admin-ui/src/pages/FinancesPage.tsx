import { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Trash2 } from "lucide-react";
import {
  createFinancePayment,
  deleteFinancePayment,
  listFinanceAccounts,
  listFinancePayments,
} from "../api/finances";
import EntityCards from "../components/EntityCards";
import ListFiltersChrome from "../components/ListFiltersChrome";
import Modal from "../components/Modal";
import SimpleTable from "../components/SimpleTable";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { useUiPreferences } from "../hooks/useUiPreferences";
import { formatMoneyLine, parseDisplayCurrency, type MoneyCurrency } from "../lib/money";
import type { AccountPayment, AccountPaymentDirection, PaymentAccount } from "../lib/types";
import { formatDateTime, matchesSearch } from "../lib/utils";

type PaymentEditor = {
  account_id: string;
  amount: string;
  currency: MoneyCurrency;
  note: string;
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
  accounts,
  onAccountChange,
  onDirectionChange,
  showActions,
  onApply,
}: {
  accountId: string;
  direction: string;
  accounts: PaymentAccount[];
  onAccountChange: (value: string) => void;
  onDirectionChange: (value: string) => void;
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
  const canDelete = hasPermission("finances_delete");
  const [search, setSearch] = useState("");
  const [accountId, setAccountId] = useState("");
  const [direction, setDirection] = useState("");
  const [appliedAccountId, setAppliedAccountId] = useState("");
  const [appliedDirection, setAppliedDirection] = useState("");
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
  const [createDirection, setCreateDirection] = useState<AccountPaymentDirection | null>(null);
  const [editor, setEditor] = useState<PaymentEditor>({
    account_id: "",
    amount: "",
    currency: "UZS",
    note: "",
  });
  const [formError, setFormError] = useState("");
  const [listError, setListError] = useState("");

  const accountsQuery = useQuery({
    queryKey: ["finance-accounts"],
    queryFn: listFinanceAccounts,
  });
  const paymentsQuery = useQuery({
    queryKey: ["finance-payments", appliedAccountId, appliedDirection],
    queryFn: () =>
      listFinancePayments({
        account_id: appliedAccountId || undefined,
        direction: (appliedDirection as AccountPaymentDirection) || undefined,
      }),
  });

  const accounts = accountsQuery.data?.accounts || [];
  const payments = paymentsQuery.data?.payments || [];
  const selectedAccount = accounts.find((item) => String(item.id) === editor.account_id);

  function openCreate(nextDirection: AccountPaymentDirection) {
    const presetId = appliedAccountId || (accounts[0] ? String(accounts[0].id) : "");
    const account = accounts.find((item) => String(item.id) === presetId) || accounts[0] || null;
    setEditor({
      account_id: account ? String(account.id) : "",
      amount: "",
      currency: accountCurrency(account),
      note: "",
    });
    setFormError("");
    setCreateDirection(nextDirection);
  }

  function invalidateFinances() {
    void queryClient.invalidateQueries({ queryKey: ["finance-accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["finance-payments"] });
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      createFinancePayment({
        account_id: Number(editor.account_id),
        direction: createDirection || "in",
        amount: Number(editor.amount),
        currency: editor.currency,
        note: editor.note.trim() || undefined,
      }),
    onSuccess: () => {
      setCreateDirection(null);
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

  function paymentActions(payment: AccountPayment): ReactNode {
    if (!canDelete) return null;
    return (
      <div className="cell-actions">
        <button
          type="button"
          className="btn-danger btn-icon btn-sm"
          aria-label="Удалить"
          title="Удалить"
          onClick={() => void handleDelete(payment)}
        >
          <Trash2 size={15} aria-hidden="true" />
        </button>
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
          directionLabel(payment.direction),
        ),
      ),
    [payments, search],
  );

  const columns = useMemo<ColumnDef<AccountPayment>[]>(
    () => [
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
    [canDelete, dateTimeFormat],
  );

  function applyFilters() {
    setAppliedAccountId(accountId);
    setAppliedDirection(direction);
  }

  return (
    <section className="card">
      <div className="card-toolbar">
        <div className="card-toolbar-right">
          {canCreate ? (
            <>
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
        filtersActive={Boolean(appliedAccountId || appliedDirection)}
        filtersModalOpen={filtersModalOpen}
        onFiltersModalOpenChange={setFiltersModalOpen}
        onApplyFilters={applyFilters}
        onResetFilters={() => {
          setAccountId("");
          setDirection("");
        }}
        desktopFilters={
          <FilterFields
            accountId={accountId}
            direction={direction}
            accounts={accounts}
            onAccountChange={setAccountId}
            onDirectionChange={setDirection}
            showActions
            onApply={applyFilters}
          />
        }
        sheetFilters={
          <FilterFields
            accountId={accountId}
            direction={direction}
            accounts={accounts}
            onAccountChange={setAccountId}
            onDirectionChange={setDirection}
          />
        }
      />

      {listError ? <p className="message error">{listError}</p> : null}

      <div className="ticket-table-section">
        {compact ? (
          <EntityCards
            items={visiblePayments}
            isLoading={paymentsQuery.isPending}
            emptyMessage={search || appliedAccountId || appliedDirection ? "Ничего не найдено." : "Платежей пока нет."}
            getKey={(payment) => String(payment.id)}
            getTitle={(payment) =>
              `${payment.direction === "out" ? "−" : "+"}${formatMoneyLine(payment.amount, payment.currency)}`
            }
            getSubtitle={(payment) =>
              [directionLabel(payment.direction), payment.account?.name].filter(Boolean).join(" · ")
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
            emptyMessage={search || appliedAccountId || appliedDirection ? "Ничего не найдено." : "Платежей пока нет."}
            getRowId={(row) => String(row.id)}
          />
        )}
      </div>

      <Modal
        open={createDirection != null}
        title={createDirection === "out" ? "Расход" : "Приход"}
        onClose={() => setCreateDirection(null)}
      >
        {!accounts.length ? (
          <p className="empty-state">
            Счетов нет. Добавьте их в <Link to="/settings">настройках</Link>.
          </p>
        ) : (
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
              setFormError("");
              saveMutation.mutate();
            }}
          >
            <label>
              Счёт
              <select
                required
                value={editor.account_id}
                onChange={(event) => {
                  const next = accounts.find((item) => String(item.id) === event.target.value);
                  setEditor((prev) => ({
                    ...prev,
                    account_id: event.target.value,
                    currency: accountCurrency(next),
                  }));
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
              Сумма{selectedAccount ? ` (${editor.currency})` : ""}
              <input
                required
                type="number"
                min={0}
                step="any"
                disabled={!editor.account_id}
                value={editor.amount}
                onChange={(event) => setEditor((prev) => ({ ...prev, amount: event.target.value }))}
              />
            </label>
            <label>
              Валюта
              <select
                value={editor.currency}
                disabled={!editor.account_id}
                onChange={(event) =>
                  setEditor((prev) => ({
                    ...prev,
                    currency: parseDisplayCurrency(event.target.value) || "UZS",
                  }))
                }
              >
                <option value="UZS">UZS</option>
                <option value="USD">USD</option>
              </select>
            </label>
            <label>
              Комментарий
              <input
                maxLength={500}
                value={editor.note}
                onChange={(event) => setEditor((prev) => ({ ...prev, note: event.target.value }))}
              />
            </label>
            {formError ? <p className="message error">{formError}</p> : null}
            <div className="form-actions">
              <button type="button" className="btn-secondary" onClick={() => setCreateDirection(null)}>
                Отмена
              </button>
              <button type="submit" className="btn-primary" disabled={saveMutation.isPending}>
                {createDirection === "out" ? "Провести расход" : "Провести приход"}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </section>
  );
}
