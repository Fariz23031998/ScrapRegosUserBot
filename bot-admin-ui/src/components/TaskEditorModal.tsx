import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import {
  createTask,
  createTaskClient,
  listTaskCategories,
  listTaskEmployees,
  listTaskLocations,
  searchTaskClients,
  updateTask,
  type TaskPayload,
} from "../api/tasks";
import Modal from "./Modal";
import { useAuth } from "../hooks/useAuth";
import { useConfirm } from "../contexts/ConfirmContext";
import type { FieldTask, TaskCategory, TaskClient } from "../lib/types";
import { technicianFinishWarning } from "../lib/employee-schedule";
import { parseDisplayCurrency, type MoneyCurrency } from "../lib/money";
import {
  addMinutesToDatetimeLocal,
  datetimeLocalDiffMinutes,
  formatDurationParts,
  parseDurationMinutes,
  sanitizeDurationHours,
  sanitizeDurationMinutes,
  toDatetimeLocalMinutes,
} from "../lib/task-plan";
import { TASK_STATUSES } from "../lib/task-status";
import { datetimeLocalToIso } from "../lib/utils";

const TASK_ACTIONS = [
  { value: "install", label: "Установка" },
  { value: "repair", label: "Ремонт" },
  { value: "sale", label: "Продажа" },
] as const;

const TASK_CURRENCIES = [
  { value: "", label: "Обе валюты" },
  { value: "UZS", label: "UZS" },
  { value: "USD", label: "USD" },
] as const;

type TaskEditor = {
  id?: number;
  title: string;
  status: string;
  action: string;
  category_id: string;
  location_id: string;
  notes: string;
  address: string;
  manager_user_id: string;
  technician_user_id: string;
  currency: "" | MoneyCurrency;
  planned_start_at: string;
  planned_finish_at: string;
  duration_hours: string;
  duration_minutes: string;
  client: TaskClient | null;
  clientQuery: string;
};

function emptyEditor(): TaskEditor {
  return {
    title: "",
    status: "new",
    action: "",
    category_id: "",
    location_id: "",
    notes: "",
    address: "",
    manager_user_id: "",
    technician_user_id: "",
    currency: "",
    planned_start_at: "",
    planned_finish_at: "",
    duration_hours: "",
    duration_minutes: "",
    client: null,
    clientQuery: "",
  };
}

function editorFromTask(task: FieldTask): TaskEditor {
  const plannedStart = toDatetimeLocalMinutes(task.planned_start_at);
  const plannedFinish = toDatetimeLocalMinutes(task.planned_finish_at);
  const duration = formatDurationParts(datetimeLocalDiffMinutes(plannedStart, plannedFinish));
  return {
    id: task.id,
    title: task.title,
    status: task.status || "new",
    action: task.action || "",
    category_id: task.category_id ? String(task.category_id) : "",
    location_id: task.location_id ? String(task.location_id) : "",
    notes: task.notes || "",
    address: task.address || "",
    manager_user_id: task.manager_user_id ? String(task.manager_user_id) : "",
    technician_user_id: task.technician_user_id ? String(task.technician_user_id) : "",
    currency: parseDisplayCurrency(task.currency) || "",
    planned_start_at: plannedStart,
    planned_finish_at: plannedFinish,
    duration_hours: duration.hours,
    duration_minutes: duration.minutes,
    client: task.regos_client_id
      ? {
          id: task.regos_client_id,
          name: task.client_name || null,
          phone: task.client_phone || null,
        }
      : null,
    clientQuery: "",
  };
}

function durationFromRange(start: string, finish: string): { hours: string; minutes: string } {
  return formatDurationParts(datetimeLocalDiffMinutes(start, finish));
}

function withPlannedStart(editor: TaskEditor, plannedStart: string): TaskEditor {
  const duration = parseDurationMinutes(editor.duration_hours, editor.duration_minutes);
  if (duration != null && plannedStart) {
    return {
      ...editor,
      planned_start_at: plannedStart,
      planned_finish_at: addMinutesToDatetimeLocal(plannedStart, duration),
    };
  }
  if (plannedStart && editor.planned_finish_at) {
    const durationParts = durationFromRange(plannedStart, editor.planned_finish_at);
    return {
      ...editor,
      planned_start_at: plannedStart,
      duration_hours: durationParts.hours,
      duration_minutes: durationParts.minutes,
    };
  }
  return { ...editor, planned_start_at: plannedStart };
}

function withDuration(editor: TaskEditor, hours: string, minutes: string): TaskEditor {
  const next = { ...editor, duration_hours: hours, duration_minutes: minutes };
  const duration = parseDurationMinutes(hours, minutes);
  if (duration != null && editor.planned_start_at) {
    next.planned_finish_at = addMinutesToDatetimeLocal(editor.planned_start_at, duration);
  }
  return next;
}

function withPlannedFinish(editor: TaskEditor, plannedFinish: string): TaskEditor {
  if (editor.planned_start_at && plannedFinish) {
    const durationParts = durationFromRange(editor.planned_start_at, plannedFinish);
    return {
      ...editor,
      planned_finish_at: plannedFinish,
      duration_hours: durationParts.hours,
      duration_minutes: durationParts.minutes,
    };
  }
  return { ...editor, planned_finish_at: plannedFinish };
}

function emptyCreateClientForm() {
  return { name: "", phone: "", email: "", external_id: "", description: "" };
}

function prefillFromQuery(query: string) {
  const text = query.trim();
  const digits = text.replace(/\D/g, "");
  const looksLikePhone =
    digits.length >= 5 && digits.length >= text.replace(/[\s+()-]/g, "").length * 0.6;
  return {
    ...emptyCreateClientForm(),
    name: looksLikePhone ? "" : text,
    phone: looksLikePhone ? text : "",
  };
}

function CreateTaskClientModal({
  open,
  initialQuery,
  onClose,
  onCreated,
}: {
  open: boolean;
  initialQuery: string;
  onClose: () => void;
  onCreated: (client: TaskClient) => void;
}) {
  const [form, setForm] = useState(emptyCreateClientForm);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setForm(prefillFromQuery(initialQuery));
    setError("");
  }, [open, initialQuery]);

  const createMutation = useMutation({
    mutationFn: (payload: {
      name?: string;
      phone?: string;
      email?: string;
      description?: string;
      external_id?: string;
    }) => createTaskClient(payload),
    onSuccess: (data) => onCreated(data.client),
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal open={open} title="Новый клиент REGOS" onClose={onClose} size="wide">
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          const name = form.name.trim();
          const phone = form.phone.trim();
          const email = form.email.trim();
          const externalId = form.external_id.trim();
          const description = form.description.trim();
          if (!name && !phone) {
            setError("Укажите имя или телефон.");
            return;
          }
          setError("");
          createMutation.mutate({
            name: name || undefined,
            phone: phone || undefined,
            email: email || undefined,
            external_id: externalId || undefined,
            description: description || undefined,
          });
        }}
      >
        <p className="muted-copy">Укажите имя или телефон. Остальные поля необязательны.</p>
        <label>
          Имя
          <input
            value={form.name}
            maxLength={200}
            autoComplete="name"
            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
          />
        </label>
        <label>
          Телефон
          <input
            type="tel"
            value={form.phone}
            maxLength={50}
            autoComplete="tel"
            onChange={(event) => setForm((prev) => ({ ...prev, phone: event.target.value }))}
          />
        </label>
        <label>
          Email
          <input
            type="email"
            value={form.email}
            maxLength={150}
            autoComplete="email"
            onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
          />
        </label>
        <label>
          Внешний ID
          <input
            value={form.external_id}
            maxLength={150}
            onChange={(event) => setForm((prev) => ({ ...prev, external_id: event.target.value }))}
          />
        </label>
        <label>
          Комментарий
          <textarea
            rows={4}
            maxLength={4000}
            value={form.description}
            onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
          />
        </label>
        {error ? <p className="message error">{error}</p> : null}
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={createMutation.isPending}>
            Отмена
          </button>
          <button type="submit" className="btn-primary" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Создание…" : "Создать"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function TaskEditorModal({
  open,
  task,
  categories,
  onClose,
  onSaved,
}: {
  open: boolean;
  task?: FieldTask | null;
  categories: TaskCategory[];
  onClose: () => void;
  onSaved: (saved: FieldTask) => void;
}) {
  const { hasPermission } = useAuth();
  const confirm = useConfirm();
  const canChangeStatus = hasPermission("tasks_status");
  const canChangeManager = hasPermission("tasks_manager");
  const canChangeTechnician = hasPermission("tasks_technician");
  const [editor, setEditor] = useState<TaskEditor>(() => (task ? editorFromTask(task) : emptyEditor()));
  const [formError, setFormError] = useState("");
  const [createClientOpen, setCreateClientOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEditor(task ? editorFromTask(task) : emptyEditor());
    setFormError("");
    setCreateClientOpen(false);
  }, [open, task?.id]);

  const employeesQuery = useQuery({
    queryKey: ["task-employees"],
    queryFn: listTaskEmployees,
    enabled: open,
  });
  const clientQueryValue = editor.clientQuery || "";
  const clientsQuery = useQuery({
    queryKey: ["task-clients", clientQueryValue],
    queryFn: () => searchTaskClients(clientQueryValue),
    enabled: open && !editor.client && clientQueryValue.trim().length >= 2,
  });
  const categoriesQuery = useQuery({
    queryKey: ["task-categories"],
    queryFn: listTaskCategories,
    enabled: open && !categories.length,
  });
  const locationsQuery = useQuery({
    queryKey: ["task-locations"],
    queryFn: listTaskLocations,
    enabled: open,
  });

  const employees = employeesQuery.data?.employees || [];
  const clients = clientsQuery.data?.clients || [];
  const categoryOptions = categories.length ? categories : categoriesQuery.data?.categories || [];
  const locations = locationsQuery.data?.locations || [];
  const technician = employees.find((employee) => String(employee.id) === editor.technician_user_id);
  const scheduleWarning =
    editor.action !== "sale" && editor.technician_user_id && editor.planned_finish_at
      ? technicianFinishWarning(
          technician?.name,
          datetimeLocalToIso(editor.planned_finish_at) || editor.planned_finish_at,
          technician?.schedule,
        )
      : null;

  const saveMutation = useMutation({
    mutationFn: (payload: { id?: number; body: TaskPayload }) => {
      if (payload.id) return updateTask(payload.id, payload.body);
      return createTask(payload.body);
    },
    onSuccess: (data) => onSaved(data.task),
    onError: (error: Error) => setFormError(error.message),
  });

  function buildPayload(current: TaskEditor): TaskPayload {
    const payload: TaskPayload = {
      title: current.title.trim(),
      action: current.action,
      notes: current.notes.trim(),
      address: current.address.trim(),
      category_id: current.category_id ? Number(current.category_id) : null,
      location_id: current.location_id ? Number(current.location_id) : null,
      currency: parseDisplayCurrency(current.currency),
      planned_start_at: datetimeLocalToIso(current.planned_start_at) || null,
      planned_finish_at: datetimeLocalToIso(current.planned_finish_at) || null,
      regos_client_id: current.client?.id ?? null,
      client_name: current.client?.name || "",
      client_phone: current.client?.phone || "",
    };
    if (canChangeStatus) payload.status = current.status;
    if (canChangeManager) {
      payload.manager_user_id = current.manager_user_id ? Number(current.manager_user_id) : null;
    }
    if (canChangeTechnician) {
      payload.technician_user_id = current.action === "sale" ? null : current.technician_user_id ? Number(current.technician_user_id) : null;
    }
    return payload;
  }

  return (
    <>
    <Modal
      open={open}
      title={editor.id ? "Редактирование задачи" : "Новая задача"}
      onClose={onClose}
      size="wide"
    >
      <form
        className="stack-form task-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            if (task?.posted) {
              setFormError("Проведённую задачу нельзя изменить.");
              return;
            }
            if (!TASK_ACTIONS.some((item) => item.value === editor.action)) {
              setFormError("Выберите тип задачи: установка, ремонт или продажа.");
              return;
            }
            if (!editor.location_id) {
              setFormError("Выберите филиал.");
              return;
            }
            if (editor.planned_start_at && editor.planned_finish_at) {
              const start = new Date(editor.planned_start_at);
              const finish = new Date(editor.planned_finish_at);
              if (finish < start) {
                setFormError("Ориентировочное окончание не может быть раньше начала.");
                return;
              }
            }
            if (scheduleWarning) {
              const ok = await confirm({
                message: `${scheduleWarning} Всё равно сохранить?`,
                confirmLabel: "Сохранить",
              });
              if (!ok) return;
            }
            setFormError("");
            saveMutation.mutate({ id: editor.id, body: buildPayload(editor) });
          })();
        }}
      >
        <label>
          Название
          <input
            required
            maxLength={200}
            value={editor.title}
            onChange={(event) => setEditor((prev) => ({ ...prev, title: event.target.value }))}
          />
        </label>
        <div className="task-editor-fields">
          {canChangeStatus ? (
            <label>
              Статус
              <select
                required
                value={editor.status}
                onChange={(event) => setEditor((prev) => ({ ...prev, status: event.target.value }))}
              >
                {TASK_STATUSES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            Тип
            <select
              required
              value={editor.action}
              onChange={(event) =>
                setEditor((prev) => ({
                  ...prev,
                  action: event.target.value,
                  technician_user_id: event.target.value === "sale" ? "" : prev.technician_user_id,
                }))
              }
            >
              <option value="">Выберите тип</option>
              {TASK_ACTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Валюта
            <select
              value={editor.currency}
              onChange={(event) =>
                setEditor((prev) => ({
                  ...prev,
                  currency: parseDisplayCurrency(event.target.value) || "",
                }))
              }
            >
              {TASK_CURRENCIES.map((item) => (
                <option key={item.value || "both"} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="task-editor-fields">
          <label>
            Категория
            <select
              value={editor.category_id}
              onChange={(event) => setEditor((prev) => ({ ...prev, category_id: event.target.value }))}
            >
              <option value="">Без категории</option>
              {categoryOptions.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Филиал
            <select
              required
              value={editor.location_id}
              onChange={(event) => setEditor((prev) => ({ ...prev, location_id: event.target.value }))}
            >
              <option value="">Выберите филиал</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field">
          <span>Клиент REGOS</span>
          {editor.client ? (
            <div className="firm-selected">
              <div className="firm-selected__body">
                <strong>{editor.client.name || `Клиент #${editor.client.id}`}</strong>
                <span>{editor.client.phone || `ID ${editor.client.id}`}</span>
              </div>
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={Boolean(task?.posted)}
                onClick={() => setEditor((prev) => ({ ...prev, client: null, clientQuery: "" }))}
              >
                Сбросить
              </button>
            </div>
          ) : (
            <>
              <div className="firm-search-row">
                <input
                  value={editor.clientQuery}
                  onChange={(event) => setEditor((prev) => ({ ...prev, clientQuery: event.target.value }))}
                  placeholder="Имя, телефон или email"
                  disabled={Boolean(task?.posted)}
                />
                <button
                  type="button"
                  className="btn-secondary btn-icon btn-sm"
                  aria-label="Создать клиента"
                  title="Создать клиента"
                  disabled={Boolean(task?.posted)}
                  onClick={() => setCreateClientOpen(true)}
                >
                  <Plus size={16} aria-hidden="true" />
                </button>
              </div>
              {clientQueryValue.trim().length >= 2 && !clients.length && !clientsQuery.isFetching ? (
                <p className="firm-search-status">Клиенты не найдены.</p>
              ) : null}
              <div className="firm-search-results">
                {clients.map((client) => (
                  <button
                    key={client.id}
                    type="button"
                    className="firm-search-result"
                    onClick={() => setEditor((prev) => ({ ...prev, client, clientQuery: "" }))}
                  >
                    <strong>{client.name || `Клиент #${client.id}`}</strong>
                    <span className="firm-search-result__meta">
                      {[client.phone, client.email].filter(Boolean).join(" · ") || `ID ${client.id}`}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <label>
          Адрес
          <input
            maxLength={500}
            value={editor.address}
            onChange={(event) => setEditor((prev) => ({ ...prev, address: event.target.value }))}
          />
        </label>
        <label>
          Заметки
          <textarea
            rows={3}
            maxLength={5000}
            value={editor.notes}
            onChange={(event) => setEditor((prev) => ({ ...prev, notes: event.target.value }))}
          />
        </label>
        <div className="task-editor-plan">
          <label>
            Начало
            <input
              type="datetime-local"
              value={editor.planned_start_at}
              onChange={(event) => setEditor((prev) => withPlannedStart(prev, event.target.value))}
            />
          </label>
          <label>
            Время выполнения
            <div className="task-duration-fields">
              <input
                type="number"
                min={0}
                max={999}
                inputMode="numeric"
                aria-label="Часы"
                placeholder="0"
                value={editor.duration_hours}
                onChange={(event) =>
                  setEditor((prev) =>
                    withDuration(prev, sanitizeDurationHours(event.target.value), prev.duration_minutes),
                  )
                }
              />
              <span>ч</span>
              <input
                type="number"
                min={0}
                max={59}
                inputMode="numeric"
                aria-label="Минуты"
                placeholder="00"
                value={editor.duration_minutes}
                onChange={(event) =>
                  setEditor((prev) =>
                    withDuration(prev, prev.duration_hours, sanitizeDurationMinutes(event.target.value)),
                  )
                }
              />
              <span>мин</span>
            </div>
          </label>
          <label>
            Ориентировочное окончание
            <input
              type="datetime-local"
              value={editor.planned_finish_at}
              onChange={(event) => setEditor((prev) => withPlannedFinish(prev, event.target.value))}
            />
          </label>
        </div>
        <div className="task-editor-fields">
          <label>
            Менеджер
            <select
              value={editor.manager_user_id}
              disabled={!canChangeManager}
              onChange={(event) => setEditor((prev) => ({ ...prev, manager_user_id: event.target.value }))}
            >
              <option value="">Не назначен</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </label>
          {editor.action === "sale" ? null : (
            <label>
              Техник
              <select
                value={editor.technician_user_id}
                disabled={!canChangeTechnician}
                onChange={(event) => setEditor((prev) => ({ ...prev, technician_user_id: event.target.value }))}
              >
                <option value="">Не назначен</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {scheduleWarning ? <p className="message warn">{scheduleWarning}</p> : null}
        {formError ? <p className="message error">{formError}</p> : null}
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn-primary" disabled={saveMutation.isPending || Boolean(task?.posted)}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
    <CreateTaskClientModal
      open={createClientOpen}
      initialQuery={editor.clientQuery}
      onClose={() => setCreateClientOpen(false)}
      onCreated={(client) => {
        setEditor((prev) => ({ ...prev, client, clientQuery: "" }));
        setCreateClientOpen(false);
      }}
    />
    </>
  );
}

export { emptyEditor, editorFromTask };
export type { TaskEditor };
