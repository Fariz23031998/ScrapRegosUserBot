import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  createPaymentType,
  createSettingsLocation,
  deletePaymentType,
  deleteSettingsLocation,
  listPaymentTypes,
  listSettingsLocations,
  updatePaymentType,
  updateSettingsLocation,
} from "../api/settings";
import { listTaskEmployees } from "../api/tasks";
import { useConfirm } from "../contexts/ConfirmContext";
import type { PaymentType, SettingsLocation } from "../lib/types";
import LoadingState from "./LoadingState";
import Modal from "./Modal";
import TicketParticipantsPicker from "./TicketParticipantsPicker";

type LocationEditor = {
  id?: number;
  name: string;
  allowed_user_ids: number[];
};

type PaymentEditor = {
  id?: number;
  name: string;
  currency: "UZS" | "USD";
};

function emptyPaymentEditor(): PaymentEditor {
  return { name: "", currency: "UZS" };
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

export default function SettingsLocationsTab({ canEdit }: { canEdit: boolean }) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [locationEditor, setLocationEditor] = useState<LocationEditor | null>(null);
  const [paymentEditor, setPaymentEditor] = useState<PaymentEditor | null>(null);
  const [locationError, setLocationError] = useState("");
  const [paymentError, setPaymentError] = useState("");

  const locationsQuery = useQuery({
    queryKey: ["settings-locations"],
    queryFn: listSettingsLocations,
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
  const paymentTypes = paymentTypesQuery.data?.payment_types || [];
  const employeeOptions = (employeesQuery.data?.employees || []).map((employee) => ({
    id: employee.id,
    full_name: employee.name,
    login: employee.phone,
  }));

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

  const savePaymentType = useMutation({
    mutationFn: (payload: PaymentEditor) => {
      const body = { name: payload.name.trim(), currency: payload.currency };
      if (payload.id) return updatePaymentType(payload.id, body);
      return createPaymentType(body);
    },
    onSuccess: () => {
      setPaymentEditor(null);
      void queryClient.invalidateQueries({ queryKey: ["settings-payment-types"] });
    },
    onError: (error: Error) => setPaymentError(error.message),
  });

  const removePaymentType = useMutation({
    mutationFn: deletePaymentType,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings-payment-types"] });
    },
  });

  async function handleDeleteLocation(location: SettingsLocation) {
    const ok = await confirm({
      message: `Удалить локацию «${location.name}»? Задачи останутся без локации.`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) removeLocation.mutate(location.id);
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
          <h2>Локации</h2>
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
          <p className="empty-state">Локаций нет.</p>
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
                  <strong>{paymentType.name}</strong>
                  <small>{paymentType.currency}</small>
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
                          currency: paymentType.currency,
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
                      onClick={() => void handleDeletePaymentType(paymentType)}
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

      <Modal
        open={locationEditor != null}
        title={locationEditor?.id ? "Редактирование локации" : "Новая локация"}
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
              value={paymentEditor?.name || ""}
              onChange={(event) =>
                setPaymentEditor((prev) => (prev ? { ...prev, name: event.target.value } : prev))
              }
            />
          </label>
          <label>
            Валюта
            <select
              required
              value={paymentEditor?.currency || "UZS"}
              onChange={(event) =>
                setPaymentEditor((prev) =>
                  prev ? { ...prev, currency: event.target.value === "USD" ? "USD" : "UZS" } : prev,
                )
              }
            >
              <option value="UZS">UZS</option>
              <option value="USD">USD</option>
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
