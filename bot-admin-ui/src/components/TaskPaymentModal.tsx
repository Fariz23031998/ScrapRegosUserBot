import { useMutation, useQuery } from "@tanstack/react-query";

import { useEffect, useMemo, useState } from "react";

import { Link } from "react-router-dom";

import { createTaskPayment, listTaskPaymentTypes } from "../api/tasks";

import Modal from "./Modal";

import { formatMoneyLine, parseDisplayCurrency, type MoneyCurrency } from "../lib/money";

import type { FieldTask, PaymentType } from "../lib/types";



type PaymentEditor = {

  payment_type_id: string;

  amount: string;

  currency: MoneyCurrency;

  note: string;

};



function dueAmount(task: FieldTask, currency: MoneyCurrency): number {

  const due = currency === "USD" ? task.payment_totals?.due_usd : task.payment_totals?.due_uzs;

  const value = Number(due);

  return Number.isFinite(value) ? value : 0;

}



function amountInputValue(value: number): string {

  return String(Math.round(value * 100) / 100);

}



function paymentTypeCurrency(paymentType?: PaymentType | null): MoneyCurrency {

  return parseDisplayCurrency(paymentType?.currency) || "UZS";

}



export default function TaskPaymentModal({

  open,

  task,

  onClose,

  onSaved,

}: {

  open: boolean;

  task: FieldTask;

  onClose: () => void;

  onSaved: () => void;

}) {

  const [editor, setEditor] = useState<PaymentEditor>({

    payment_type_id: "",

    amount: "",

    currency: "UZS",

    note: "",

  });

  const [formError, setFormError] = useState("");



  const paymentTypesQuery = useQuery({

    queryKey: ["task-payment-types"],

    queryFn: listTaskPaymentTypes,

    enabled: open,

  });

  const paymentTypes = paymentTypesQuery.data?.payment_types || [];



  const selectedPaymentType = useMemo(

    () => paymentTypes.find((item: PaymentType) => String(item.id) === editor.payment_type_id),

    [paymentTypes, editor.payment_type_id],

  );



  useEffect(() => {

    if (!open) return;

    setEditor({

      payment_type_id: "",

      amount: "",

      currency: "UZS",

      note: "",

    });

    setFormError("");

  }, [open, task.id]);



  const saveMutation = useMutation({

    mutationFn: () =>

      createTaskPayment(task.id, {

        payment_type_id: Number(editor.payment_type_id),

        amount: Number(editor.amount),

        currency: editor.currency,

        note: editor.note.trim() || undefined,

      }),

    onSuccess: () => onSaved(),

    onError: (error: Error) => setFormError(error.message),

  });



  function handlePaymentTypeChange(value: string) {

    const selected = paymentTypes.find((item: PaymentType) => String(item.id) === value);

    const currency = paymentTypeCurrency(selected);

    const remaining = dueAmount(task, currency);

    setEditor({

      payment_type_id: value,

      currency,

      amount: remaining > 0 ? amountInputValue(remaining) : "",

      note: editor.note,

    });

  }



  const remaining = dueAmount(task, editor.currency);



  return (

    <Modal open={open} title="Приём оплаты" onClose={onClose}>

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

            if (!editor.payment_type_id) {

              setFormError("Выберите тип оплаты.");

              return;

            }

            const amount = Number(editor.amount);

            if (!Number.isFinite(amount) || amount <= 0) {

              setFormError("Укажите сумму оплаты больше 0.");

              return;

            }

            setFormError("");

            saveMutation.mutate();

          }}

        >

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

            Сумма{selectedPaymentType ? ` (${editor.currency})` : ""}

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

          {selectedPaymentType ? (

            <p className="task-payment-hint">

              Остаток к оплате: {formatMoneyLine(Math.max(0, remaining), editor.currency)}

              {remaining > 0 ? (

                <button

                  type="button"

                  className="btn-secondary btn-sm"

                  onClick={() =>

                    setEditor((prev) => ({ ...prev, amount: amountInputValue(remaining) }))

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


