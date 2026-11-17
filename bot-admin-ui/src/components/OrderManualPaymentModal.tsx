import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listOrderPaymentTypes, markPaidCash } from "../api/admin";
import { formatMoneyLine } from "../lib/money";
import type { Order, PaymentType } from "../lib/types";
import Modal from "./Modal";

export default function OrderManualPaymentModal({
  open,
  order,
  onClose,
  onSaved,
}: {
  open: boolean;
  order: Order | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [paymentTypeId, setPaymentTypeId] = useState("");
  const [formError, setFormError] = useState("");

  const paymentTypesQuery = useQuery({
    queryKey: ["order-payment-types"],
    queryFn: listOrderPaymentTypes,
    enabled: open,
  });

  const paymentTypes = paymentTypesQuery.data?.payment_types || [];

  useEffect(() => {
    if (!open) return;
    setPaymentTypeId("");
    setFormError("");
  }, [open, order?.id]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!order) throw new Error("Заказ не выбран.");
      return markPaidCash(order.id, { payment_type_id: Number(paymentTypeId) });
    },
    onSuccess: () => onSaved(),
    onError: (error: Error) => setFormError(error.message),
  });

  return (
    <Modal open={open} title="Ручная оплата" onClose={onClose}>
      {!order ? (
        <p className="empty-state">Заказ не выбран.</p>
      ) : paymentTypesQuery.isLoading ? (
        <p className="empty-state">Загрузка типов оплаты…</p>
      ) : !paymentTypes.length ? (
        <p className="empty-state">
          Типы оплаты в UZS не настроены. Добавьте их в <Link to="/settings">настройках</Link>.
        </p>
      ) : (
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!paymentTypeId) {
              setFormError("Выберите тип оплаты.");
              return;
            }
            setFormError("");
            saveMutation.mutate();
          }}
        >
          <p>
            Сумма заказа: <strong>{formatMoneyLine(Number(order.amount) || 0, "UZS")}</strong>
          </p>
          <label>
            Тип оплаты
            <select
              required
              value={paymentTypeId}
              onChange={(event) => setPaymentTypeId(event.target.value)}
            >
              <option value="">Выберите тип оплаты</option>
              {paymentTypes.map((paymentType: PaymentType) => (
                <option key={paymentType.id} value={paymentType.id}>
                  {paymentType.name} ({paymentType.currency})
                </option>
              ))}
            </select>
          </label>
          {formError ? <p className="message error">{formError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={saveMutation.isPending}>
              Принять оплату
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
