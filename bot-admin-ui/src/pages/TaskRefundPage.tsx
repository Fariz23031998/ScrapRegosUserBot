import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { createTaskRefund, getTask, listTaskPaymentTypes } from "../api/tasks";
import LoadingState from "../components/LoadingState";
import { useAuth } from "../hooks/useAuth";
import {
  formatMoneyLine,
  lineRefundAmount,
  parseDisplayCurrency,
  type MoneyCurrency,
} from "../lib/money";
import type { FieldTask, PaymentType, TaskDeviceLine, TaskServiceLine } from "../lib/types";

type RefundLineOption = {
  key: string;
  kind: "device" | "service";
  lineId: number;
  label: string;
  quantity: number;
  line: TaskDeviceLine | TaskServiceLine;
};

type RefundEditor = {
  line_key: string;
  quantity: string;
  payment_type_id: string;
  amount: string;
  currency: MoneyCurrency;
  note: string;
};

function amountInputValue(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function paymentTypeCurrency(paymentType?: PaymentType | null): MoneyCurrency {
  return parseDisplayCurrency(paymentType?.currency) || "UZS";
}

function lineQuantity(value: unknown): number {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty < 1) return 1;
  return Math.min(999, Math.trunc(qty));
}

function buildLineOptions(task: FieldTask): RefundLineOption[] {
  const devices = (task.devices || [])
    .filter((line) => line.id)
    .map((line) => ({
      key: `device:${line.id}`,
      kind: "device" as const,
      lineId: line.id!,
      label: line.device_name || `Устройство #${line.device_id}`,
      quantity: lineQuantity(line.quantity),
      line,
    }));
  const services = (task.services || [])
    .filter((line) => line.id)
    .map((line) => ({
      key: `service:${line.id}`,
      kind: "service" as const,
      lineId: line.id!,
      label: line.service_name || `Услуга #${line.service_id}`,
      quantity: lineQuantity(line.quantity),
      line,
    }));
  return [...devices, ...services];
}

export default function TaskRefundPage() {
  const { id } = useParams();
  const taskId = Number(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const validId = Number.isFinite(taskId) && taskId > 0;
  const canRefund = hasPermission("tasks_edit") && hasPermission("tasks_payment_create");

  const taskQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => getTask(taskId),
    enabled: validId && canRefund,
  });

  const paymentTypesQuery = useQuery({
    queryKey: ["task-payment-types"],
    queryFn: listTaskPaymentTypes,
    enabled: canRefund,
  });

  const task = taskQuery.data?.task;
  const paymentTypes = paymentTypesQuery.data?.payment_types || [];
  const lineOptions = useMemo(() => (task ? buildLineOptions(task) : []), [task]);

  const [editor, setEditor] = useState<RefundEditor>({
    line_key: "",
    quantity: "1",
    payment_type_id: "",
    amount: "",
    currency: "UZS",
    note: "",
  });
  const [formError, setFormError] = useState("");

  const selectedLine = useMemo(
    () => lineOptions.find((item) => item.key === editor.line_key),
    [lineOptions, editor.line_key],
  );

  const selectedPaymentType = useMemo(
    () => paymentTypes.find((item: PaymentType) => String(item.id) === editor.payment_type_id),
    [paymentTypes, editor.payment_type_id],
  );

  const maxQuantity = selectedLine?.quantity || 1;
  const refundQuantity = Math.min(maxQuantity, Math.max(1, lineQuantity(editor.quantity)));
  const maxRefundAmount = selectedLine
    ? lineRefundAmount(selectedLine.line, refundQuantity, editor.currency)
    : 0;

  useEffect(() => {
    if (!task) return;
    const firstLine = lineOptions[0];
    setEditor({
      line_key: firstLine?.key || "",
      quantity: firstLine ? String(firstLine.quantity) : "1",
      payment_type_id: "",
      amount: "",
      currency: "UZS",
      note: "",
    });
    setFormError("");
  }, [task?.id]);

  useEffect(() => {
    if (!selectedLine || !selectedPaymentType) return;
    const currency = paymentTypeCurrency(selectedPaymentType);
    const amount = lineRefundAmount(selectedLine.line, refundQuantity, currency);
    setEditor((prev) => ({
      ...prev,
      currency,
      amount: amount > 0 ? amountInputValue(amount) : prev.amount,
    }));
  }, [selectedLine?.key, refundQuantity, selectedPaymentType?.id]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const line = lineOptions.find((item) => item.key === editor.line_key);
      if (!line || !task) throw new Error("Выберите позицию для возврата.");
      return createTaskRefund(task.id, {
        kind: line.kind,
        line_id: line.lineId,
        quantity: refundQuantity,
        payment_type_id: Number(editor.payment_type_id),
        amount: Number(editor.amount),
        currency: editor.currency,
        note: editor.note.trim() || undefined,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      navigate(`/tasks/${taskId}`, { replace: true });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  function handleLineChange(value: string) {
    const line = lineOptions.find((item) => item.key === value);
    setEditor((prev) => ({
      ...prev,
      line_key: value,
      quantity: line ? String(line.quantity) : "1",
    }));
  }

  function handlePaymentTypeChange(value: string) {
    const selected = paymentTypes.find((item: PaymentType) => String(item.id) === value);
    const currency = paymentTypeCurrency(selected);
    const amount = selectedLine ? lineRefundAmount(selectedLine.line, refundQuantity, currency) : 0;
    setEditor((prev) => ({
      ...prev,
      payment_type_id: value,
      currency,
      amount: amount > 0 ? amountInputValue(amount) : "",
    }));
  }

  if (!validId) {
    return <Navigate to="/tasks" replace />;
  }

  if (!canRefund) {
    return <Navigate to={`/tasks/${taskId}`} replace />;
  }

  if (taskQuery.isLoading) {
    return <LoadingState message="Загрузка задачи…" />;
  }

  if (taskQuery.isError || !task) {
    return (
      <main className="page page--centered">
        <p className="message error">Задача не найдена.</p>
        <Link to="/tasks" className="btn-secondary">
          К списку задач
        </Link>
      </main>
    );
  }

  if (!lineOptions.length) {
    return (
      <div className="page page--task-refund">
        <div className="ticket-detail-header">
          <div className="ticket-detail-header__title-row">
            <Link
              to={`/tasks/${taskId}`}
              className="ticket-detail-header__back"
              aria-label="К задаче"
              title="К задаче"
            >
              <ArrowLeft size={18} aria-hidden="true" />
            </Link>
            <div className="ticket-detail-header__heading">
              <h1>Возврат</h1>
            </div>
          </div>
        </div>
        <section className="card">
          <p className="empty-state">В задаче нет позиций для возврата.</p>
          <Link to={`/tasks/${taskId}`} className="btn-secondary">
            К задаче
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div className="page page--task-refund">
      <div className="ticket-detail-header">
        <div className="ticket-detail-header__title-row">
          <Link
            to={`/tasks/${taskId}`}
            className="ticket-detail-header__back"
            aria-label="К задаче"
            title="К задаче"
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </Link>
          <div className="ticket-detail-header__heading">
            <h1>Возврат</h1>
            <span className="muted-copy">{task.title}</span>
          </div>
        </div>
      </div>

      <section className="card task-refund-card">
        {paymentTypesQuery.isLoading ? (
          <p className="empty-state">Загрузка типов оплаты…</p>
        ) : !paymentTypes.length ? (
          <p className="empty-state">
            Типы оплаты не настроены. Добавьте их в <Link to="/settings">настройках</Link>.
          </p>
        ) : (
          <form
            className="stack-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!editor.line_key) {
                setFormError("Выберите позицию для возврата.");
                return;
              }
              if (!editor.payment_type_id) {
                setFormError("Выберите тип оплаты.");
                return;
              }
              const amount = Number(editor.amount);
              if (!Number.isFinite(amount) || amount <= 0) {
                setFormError("Укажите сумму возврата больше 0.");
                return;
              }
              if (amount > maxRefundAmount + 0.001) {
                setFormError("Сумма возврата не может превышать стоимость позиции.");
                return;
              }
              setFormError("");
              saveMutation.mutate();
            }}
          >
            <label>
              Позиция
              <select
                required
                value={editor.line_key}
                onChange={(event) => handleLineChange(event.target.value)}
              >
                {lineOptions.map((line) => (
                  <option key={line.key} value={line.key}>
                    {line.label} × {line.quantity}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Количество
              <input
                required
                type="number"
                min={1}
                max={maxQuantity}
                step={1}
                value={editor.quantity}
                onChange={(event) => setEditor((prev) => ({ ...prev, quantity: event.target.value }))}
              />
            </label>
            <label>
              Тип оплаты
              <select
                required
                value={editor.payment_type_id}
                onChange={(event) => handlePaymentTypeChange(event.target.value)}
              >
                <option value="">Выберите тип оплаты</option>
                {paymentTypes.map((paymentType: PaymentType) => (
                  <option key={paymentType.id} value={paymentType.id}>
                    {paymentType.name} ({paymentType.currency})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Сумма возврата{selectedPaymentType ? ` (${editor.currency})` : ""}
              <input
                required
                type="number"
                min={0}
                step="any"
                disabled={!selectedPaymentType}
                value={editor.amount}
                onChange={(event) => setEditor((prev) => ({ ...prev, amount: event.target.value }))}
              />
            </label>
            {selectedLine && selectedPaymentType ? (
              <p className="task-payment-hint">
                Максимум: {formatMoneyLine(maxRefundAmount, editor.currency)}
                {maxRefundAmount > 0 ? (
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() =>
                      setEditor((prev) => ({ ...prev, amount: amountInputValue(maxRefundAmount) }))
                    }
                  >
                    Вся сумма
                  </button>
                ) : null}
              </p>
            ) : null}
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
              <Link to={`/tasks/${taskId}`} className="btn-secondary">
                Отмена
              </Link>
              <button type="submit" className="btn-primary" disabled={saveMutation.isPending}>
                Оформить возврат
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
