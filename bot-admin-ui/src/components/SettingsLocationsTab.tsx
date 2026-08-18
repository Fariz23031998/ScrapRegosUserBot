import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  createPaymentType,
  createSettingsAccount,
  createSettingsLocation,
  deletePaymentType,
  deleteSettingsAccount,
  deleteSettingsLocation,
  listPaymentTypes,
  listSettingsAccounts,
  listSettingsLocations,
  updatePaymentType,
  updateSettingsAccount,
  updateSettingsLocation,
} from "../api/settings";
import { listTaskEmployees } from "../api/tasks";
import { useConfirm } from "../contexts/ConfirmContext";
import { formatMoneyLine } from "../lib/money";
import type { PaymentAccount, PaymentType, SettingsLocation } from "../lib/types";
import LoadingState from "./LoadingState";
import Modal from "./Modal";
import TicketParticipantsPicker from "./TicketParticipantsPicker";

type LocationEditor = {
  id?: number;
  name: string;
  allowed_user_ids: number[];
};

type AccountEditor = {
  id?: number;
  name: string;
  currency: "UZS" | "USD";
};

type PaymentEditor = {
  id?: number;
  name: string;
  account_id: string;
  is_system?: boolean;
};

function emptyAccountEditor(): AccountEditor {
  return { name: "", currency: "UZS" };
}

function emptyPaymentEditor(): PaymentEditor {
  return { name: "", account_id: "" };
}

function emptyLocationEditor(): LocationEditor {
  return { name: "", allowed_user_ids: [] };
}

function locationEditorFrom(location: SettingsLocation): LocationEditor {
  return {
    id: location.id,
    name: location.name,
    allowed_user_ids: location.allowed_user_ids || location.allowed_users.map((user) => user.id),
  };
}

function allowedUsersLabel(location: SettingsLocation): string {
  const names = (location.allowed_users || []).map((user) => user.name).filter(Boolean);
  return names.join(", ") || "Нет доступа";
}

function paymentTypeSubtitle(paymentType: PaymentType): string {
  const accountName = paymentType.account?.name;
  const currency = paymentType.currency;
  if (accountName) return `${accountName} · ${currency}`;
  return currency;
}

export default function SettingsLocationsTab({ canEdit }: { canEdit: boolean }) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [locationEditor, setLocationEditor] = useState<LocationEditor | null>(null);
  const [accountEditor, setAccountEditor] = useState<AccountEditor | null>(null);
  const [paymentEditor, setPaymentEditor] = useState<PaymentEditor | null>(null);
  const [locationError, setLocationError] = useState("");
  const [accountError, setAccountError] = useState("");
  const [paymentError, setPaymentError] = useState("");

  const locationsQuery = useQuery({
    queryKey: ["settings-locations"],
    queryFn: listSettingsLocations,
  });
  const accountsQuery = useQuery({
    queryKey: ["settings-accounts"],
    queryFn: listSettingsAccounts,
  });
  const paymentTypesQuery = useQuery({
    queryKey: ["settings-payment-types"],
    queryFn: listPaymentTypes,
  });
  const employeesQuery = useQuery({
    queryKey: ["task-employees"],
    queryFn: listTaskEmployees,
    enabled: canEdit,
  });

  const locations = locationsQuery.data?.locations || [];
  const accounts = accountsQuery.data?.accounts || [];
  const paymentTypes = paymentTypesQuery.data?.payment_types || [];
  const employeeOptions = (employeesQuery.data?.employees || []).map((employee) => ({
    id: employee.id,
    full_name: employee.name,
    login: employee.phone,
  }));

  function invalidatePaymentCatalog() {
    void queryClient.invalidateQueries({ queryKey: ["settings-accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["settings-payment-types"] });
    void queryClient.invalidateQueries({ queryKey: ["task-payment-types"] });
  }

  const saveLocation = useMutation({
    mutationFn: (payload: LocationEditor) => {
      const body = {
        name: payload.name.trim(),
        allowed_user_ids: payload.allowed_user_ids,
      };
      if (payload.id) return updateSettingsLocation(payload.id, body);
      return createSettingsLocation(body);
    },
    onSuccess: () => {
      setLocationEditor(null);
      void queryClient.invalidateQueries({ queryKey: ["settings-locations"] });
      void queryClient.invalidateQueries({ queryKey: ["task-locations"] });
    },
    onError: (error: Error) => setLocationError(error.message),
  });

  const removeLocation = useMutation({
    mutationFn: deleteSettingsLocation,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings-locations"] });
      void queryClient.invalidateQueries({ queryKey: ["task-locations"] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const saveAccount = useMutation({
    mutationFn: (payload: AccountEditor) => {
      const body = { name: payload.name.trim(), currency: payload.currency };
      if (payload.id) return updateSettingsAccount(payload.id, body);
      return createSettingsAccount(body);
    },
    onSuccess: () => {
      setAccountEditor(null);
      invalidatePaymentCatalog();
    },
    onError: (error: Error) => setAccountError(error.message),
  });

  const removeAccount = useMutation({
    mutationFn: deleteSettingsAccount,
    onSuccess: invalidatePaymentCatalog,
  });

  const savePaymentType = useMutation({
    mutationFn: (payload: PaymentEditor) => {
      const body = { name: payload.name.trim(), account_id: Number(payload.account_id) };
      if (payload.id) return updatePaymentType(payload.id, body);
      return createPaymentType(body);
    },
    onSuccess: () => {
      setPaymentEditor(null);
      invalidatePaymentCatalog();
    },
    onError: (error: Error) => setPaymentError(error.message),
  });

  const removePaymentType = useMutation({
    mutationFn: deletePaymentType,
    onSuccess: invalidatePaymentCatalog,
  });

  async function handleDeleteLocation(location: SettingsLocation) {
    const ok = await confirm({
      message: `Удалить филиал «${location.name}»? Задачи останутся без филиала.`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) removeLocation.mutate(location.id);
  }

  async function handleDeleteAccount(account: PaymentAccount) {
    const ok = await confirm({
      message: `Удалить счёт «${account.name}»?`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) removeAccount.mutate(account.id);
  }

  async function handleDeletePaymentType(paymentType: PaymentType) {
    const ok = await confirm({
      message: `Удалить тип оплаты «${paymentType.name}»?`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) removePaymentType.mutate(paymentType.id);
  }

  return (
    <div className="settings-catalogs">
      <section className="settings-catalog">
        <div className="settings-catalog__header">
          <h2>Филиалы</h2>
          {canEdit ? (
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={() => {
                setLocationError("");
                setLocationEditor(emptyLocationEditor());
              }}
            >
              Добавить
            </button>
          ) : null}
        </div>
        {locationsQuery.isLoading ? (
          <LoadingState />
        ) : !locations.length ? (
          <p className="empty-state">Филиалов нет.</p>
        ) : (
          <ul className="knowledge-category-list">
            {locations.map((location) => (
              <li key={location.id} className="knowledge-category-list__item">
                <div>
                  <strong>{location.name}</strong>
                  <small>{allowedUsersLabel(location)}</small>
                </div>
                {canEdit ? (
                  <div className="cell-actions">
                    <button
                      type="button"
                      className="btn-secondary btn-icon btn-sm"
                      aria-label="Изменить"
                      title="Изменить"
                      onClick={() => {
                        setLocationError("");
                        setLocationEditor(locationEditorFrom(location));
                      }}
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="btn-danger btn-icon btn-sm"
                      aria-label="Удалить"
                      title="Удалить"
                      onClick={() => void handleDeleteLocation(location)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-catalog">
        <div className="settings-catalog__header">
          <h2>Счета</h2>
          {canEdit ? (
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={() => {
                setAccountError("");
                setAccountEditor(emptyAccountEditor());
              }}
            >
              Добавить
            </button>
          ) : null}
        </div>
        {accountsQuery.isLoading ? (
          <LoadingState />
        ) : !accounts.length ? (
          <p className="empty-state">Счетов нет.</p>
        ) : (
          <ul className="knowledge-category-list">
            {accounts.map((account) => (
              <li key={account.id} className="knowledge-category-list__item">
                <div>
                  <strong>{account.name}</strong>
                  <small>{formatMoneyLine(account.value, account.currency)}</small>
                </div>
                {canEdit ? (
                  <div className="cell-actions">
                    <button
                      type="button"
                      className="btn-secondary btn-icon btn-sm"
                      aria-label="Изменить"
                      title="Изменить"
                      onClick={() => {
                        setAccountError("");
                        setAccountEditor({
                          id: account.id,
                          name: account.name,
                          currency: account.currency,
                        });
                      }}
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="btn-danger btn-icon btn-sm"
                      aria-label="Удалить"
                      title="Удалить"
                      onClick={() => void handleDeleteAccount(account)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-catalog">
        <div className="settings-catalog__header">
          <h2>Типы оплаты</h2>
          {canEdit ? (
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={() => {
                setPaymentError("");
                setPaymentEditor(emptyPaymentEditor());
              }}
            >
              Добавить
            </button>
          ) : null}
        </div>
        {paymentTypesQuery.isLoading ? (
          <LoadingState />
        ) : !paymentTypes.length ? (
          <p className="empty-state">Типов оплаты нет.</p>
        ) : (
          <ul className="knowledge-category-list">
            {paymentTypes.map((paymentType) => (
              <li key={paymentType.id} className="knowledge-category-list__item">
                <div>
                  <strong>
                    {paymentType.name}
                    {paymentType.is_system ? " · системный" : ""}
                  </strong>
                  <small>{paymentTypeSubtitle(paymentType)}</small>
                </div>
                {canEdit ? (
                  <div className="cell-actions">
                    <button
                      type="button"
                      className="btn-secondary btn-icon btn-sm"
                      aria-label="Изменить"
                      title="Изменить"
                      onClick={() => {
                        setPaymentError("");
                        setPaymentEditor({
                          id: paymentType.id,
                          name: paymentType.name,
                          account_id: paymentType.account_id ? String(paymentType.account_id) : "",
                          is_system: Boolean(paymentType.is_system),
                        });
                      }}
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                    {paymentType.is_system ? null : (
                      <button
                        type="button"
                        className="btn-danger btn-icon btn-sm"
                        aria-label="Удалить"
                        title="Удалить"
                        onClick={() => void handleDeletePaymentType(paymentType)}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={locationEditor != null}
        title={locationEditor?.id ? "Редактирование филиала" : "Новый филиал"}
        onClose={() => setLocationEditor(null)}
      >
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!locationEditor) return;
            setLocationError("");
            saveLocation.mutate(locationEditor);
          }}
        >
          <label>
            Название
            <input
              required
              maxLength={100}
              value={locationEditor?.name || ""}
              onChange={(event) =>
                setLocationEditor((prev) => (prev ? { ...prev, name: event.target.value } : prev))
              }
            />
          </label>
          <TicketParticipantsPicker
            users={employeeOptions}
            value={locationEditor?.allowed_user_ids || []}
            onChange={(ids) =>
              setLocationEditor((prev) => (prev ? { ...prev, allowed_user_ids: ids } : prev))
            }
            label="Разрешённые сотрудники"
            emptyLabel="Сотрудники не выбраны."
          />
          {locationError ? <p className="message error">{locationError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setLocationEditor(null)}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={saveLocation.isPending}>
              Сохранить
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={accountEditor != null}
        title={accountEditor?.id ? "Редактирование счёта" : "Новый счёт"}
        onClose={() => setAccountEditor(null)}
      >
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!accountEditor) return;
            setAccountError("");
            saveAccount.mutate(accountEditor);
          }}
        >
          <label>
            Название
            <input
              required
              maxLength={100}
              value={accountEditor?.name || ""}
              onChange={(event) =>
                setAccountEditor((prev) => (prev ? { ...prev, name: event.target.value } : prev))
              }
            />
          </label>
          <label>
            Валюта
            <select
              required
              value={accountEditor?.currency || "UZS"}
              onChange={(event) =>
                setAccountEditor((prev) =>
                  prev ? { ...prev, currency: event.target.value === "USD" ? "USD" : "UZS" } : prev,
                )
              }
            >
              <option value="UZS">UZS</option>
              <option value="USD">USD</option>
            </select>
          </label>
          {accountError ? <p className="message error">{accountError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setAccountEditor(null)}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={saveAccount.isPending}>
              Сохранить
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={paymentEditor != null}
        title={paymentEditor?.id ? "Редактирование типа оплаты" : "Новый тип оплаты"}
        onClose={() => setPaymentEditor(null)}
      >
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!paymentEditor) return;
            setPaymentError("");
            savePaymentType.mutate(paymentEditor);
          }}
        >
          <label>
            Название
            <input
              required
              maxLength={100}
              disabled={Boolean(paymentEditor?.is_system)}
              value={paymentEditor?.name || ""}
              onChange={(event) =>
                setPaymentEditor((prev) => (prev ? { ...prev, name: event.target.value } : prev))
              }
            />
          </label>
          <label>
            Счёт
            <select
              required
              value={paymentEditor?.account_id || ""}
              onChange={(event) =>
                setPaymentEditor((prev) => (prev ? { ...prev, account_id: event.target.value } : prev))
              }
            >
              <option value="">Выберите счёт</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} ({account.currency})
                </option>
              ))}
            </select>
          </label>
          {paymentError ? <p className="message error">{paymentError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setPaymentEditor(null)}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={savePaymentType.isPending}>
              Сохранить
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
