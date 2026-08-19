import { MoneyCell } from "./MoneyFields";
import {
  cartOperationPriceLines,
  formatMoneyLine,
  hasCartDiscount,
  totalsPriceLines,
  type CartMoney,
  type MoneyCurrency,
} from "../lib/money";
import type { FieldTask, TaskDeviceLine, TaskServiceLine } from "../lib/types";
import { formatDateTime, formatUzbekPhone } from "../lib/utils";

type InvoiceLine = (TaskDeviceLine | TaskServiceLine) & { name: string };

function lineQuantity(value: unknown): number {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty < 1) return 1;
  return Math.min(999, Math.trunc(qty));
}

function discountLabel(line: {
  discount_type?: string | null;
  discount_value?: number | null;
  discount_currency?: string | null;
}) {
  if (!line.discount_type || !Number(line.discount_value)) return "—";
  if (line.discount_type === "percent") return `−${Number(line.discount_value)}%`;
  const currency = line.discount_currency === "USD" ? "USD" : "UZS";
  return `−${formatMoneyLine(Number(line.discount_value), currency)}`;
}

function textOrDash(value: unknown): string {
  if (value == null || String(value).trim() === "") return "—";
  return String(value);
}

function clientName(task: FieldTask): string {
  if (task.client_name?.trim()) return task.client_name.trim();
  if (task.regos_client_id) return `Клиент #${task.regos_client_id}`;
  return "—";
}

function clientPhone(task: FieldTask): string {
  const raw = String(task.client_phone || "").trim();
  if (!raw) return "—";
  return formatUzbekPhone(raw);
}

function unitPriceLines(
  line: CartMoney,
  quantity: number,
  rate: number,
  displayCurrency: MoneyCurrency | null,
) {
  if (quantity <= 1) return cartOperationPriceLines(line, rate, "price", displayCurrency);
  return cartOperationPriceLines(
    {
      ...line,
      price_uzs: (Number(line.price_uzs) || 0) / quantity,
      price_usd: (Number(line.price_usd) || 0) / quantity,
    },
    rate,
    "price",
    displayCurrency,
  );
}

function invoiceLines(task: FieldTask): InvoiceLine[] {
  const devices = (task.devices || []).map((line) => ({
    ...line,
    name: line.device_name || `Устройство #${line.device_id}`,
  }));
  const services = (task.services || []).map((line) => ({
    ...line,
    name: line.service_name || `Услуга #${line.service_id}`,
  }));
  return [...devices, ...services];
}

export default function TaskInvoicePrint({
  task,
  rate,
  displayCurrency,
}: {
  task: FieldTask;
  rate: number;
  displayCurrency: MoneyCurrency | null;
}) {
  const lines = invoiceLines(task);
  const payments = (task.payments || []).filter((payment) => payment.kind !== "refund");
  const totals = task.totals || {
    price_uzs: 0,
    price_usd: 0,
    price_without_discount_uzs: 0,
    price_without_discount_usd: 0,
  };
  const paymentTotals = task.payment_totals || { paid_uzs: 0, paid_usd: 0, due_uzs: 0, due_usd: 0 };
  const overpaid = Number(paymentTotals.due_uzs) < -0.0001;
  const totalsHaveDiscount =
    Number(totals.price_without_discount_uzs) > 0 &&
    Number(totals.price_uzs) < Number(totals.price_without_discount_uzs) - 0.0001;

  const metaRows = [
    { label: "Филиал", value: textOrDash(task.location?.name) },
    { label: "Клиент", value: clientName(task) },
    { label: "Телефон", value: clientPhone(task) },
    { label: "Адрес", value: textOrDash(task.address) },
    { label: "Тип", value: textOrDash(task.action_label || task.action) },
    { label: "Менеджер", value: textOrDash(task.manager?.name) },
  ];
  if (task.action !== "sale") {
    metaRows.push({ label: "Техник", value: textOrDash(task.technician?.name) });
  }

  return (
    <div className="task-invoice-print" aria-hidden="true">
      <header className="task-invoice-print__header">
        <div>
          <h1>Счёт №{task.id}</h1>
          <p className="task-invoice-print__date">{formatDateTime(task.created_at)}</p>
        </div>
        {!task.posted ? <span className="task-invoice-print__draft">Черновик</span> : null}
      </header>

      <dl className="task-invoice-print__meta">
        {metaRows.map((row) => (
          <div key={row.label} className="task-invoice-print__meta-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      <table className="task-invoice-print__table">
        <thead>
          <tr>
            <th className="task-invoice-print__col-num">№</th>
            <th>Наименование</th>
            <th className="task-invoice-print__col-qty">Кол-во</th>
            <th className="task-invoice-print__col-money">Цена</th>
            <th className="task-invoice-print__col-money">Скидка</th>
            <th className="task-invoice-print__col-money">Сумма</th>
          </tr>
        </thead>
        <tbody>
          {!lines.length ? (
            <tr>
              <td colSpan={6} className="task-invoice-print__empty">
                Нет позиций
              </td>
            </tr>
          ) : (
            lines.map((line, index) => {
              const qty = lineQuantity(line.quantity);
              const discounted = hasCartDiscount(line);
              return (
                <tr key={`${line.name}-${line.id ?? index}`}>
                  <td>{index + 1}</td>
                  <td>{line.name}</td>
                  <td className="task-invoice-print__col-qty">{qty}</td>
                  <td className="task-invoice-print__col-money">
                    <MoneyCell {...unitPriceLines(line, qty, rate, displayCurrency)} />
                  </td>
                  <td className="task-invoice-print__col-money">{discounted ? discountLabel(line) : "—"}</td>
                  <td className="task-invoice-print__col-money">
                    <MoneyCell {...cartOperationPriceLines(line, rate, "price", displayCurrency)} />
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      <div className="task-invoice-print__totals">
        {totalsHaveDiscount ? (
          <div className="task-invoice-print__total-row">
            <span>Без скидки</span>
            <MoneyCell
              {...totalsPriceLines(
                totals.price_without_discount_uzs,
                totals.price_without_discount_usd,
                displayCurrency,
              )}
            />
          </div>
        ) : null}
        <div className="task-invoice-print__total-row">
          <span>Цена</span>
          <MoneyCell {...totalsPriceLines(totals.price_uzs, totals.price_usd, displayCurrency)} />
        </div>
        <div className="task-invoice-print__total-row">
          <span>Оплачено</span>
          <MoneyCell
            {...totalsPriceLines(paymentTotals.paid_uzs, paymentTotals.paid_usd, displayCurrency)}
          />
        </div>
        <div className="task-invoice-print__total-row task-invoice-print__total-row--strong">
          <span>{overpaid ? "Переплата" : "Остаток"}</span>
          <MoneyCell
            {...totalsPriceLines(
              overpaid ? -paymentTotals.due_uzs : paymentTotals.due_uzs,
              overpaid ? -paymentTotals.due_usd : paymentTotals.due_usd,
              displayCurrency,
            )}
          />
        </div>
      </div>

      <section className="task-invoice-print__payments">
        <h2>Оплаты</h2>
        {!payments.length ? (
          <p>Оплаты не приняты.</p>
        ) : (
          <table className="task-invoice-print__table">
            <thead>
              <tr>
                <th>Тип</th>
                <th>Дата</th>
                <th className="task-invoice-print__col-money">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td>{payment.payment_type_name}</td>
                  <td>{formatDateTime(payment.created_at)}</td>
                  <td className="task-invoice-print__col-money">
                    {formatMoneyLine(payment.amount, payment.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer className="task-invoice-print__signs">
        <div>
          <span>Клиент</span>
          <span className="task-invoice-print__sign-line" />
        </div>
        <div>
          <span>Исполнитель</span>
          <span className="task-invoice-print__sign-line" />
        </div>
      </footer>
    </div>
  );
}
