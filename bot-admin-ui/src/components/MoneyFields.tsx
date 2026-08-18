import type { MoneyCurrency } from "../lib/money";

export type MoneyFieldsValue = {
  cost_amount: string;
  cost_currency: MoneyCurrency;
  price_uzs: string;
  price_usd: string;
};

export default function MoneyFields({
  value,
  onChange,
}: {
  value: MoneyFieldsValue;
  onChange: (value: MoneyFieldsValue) => void;
}) {
  return (
    <>
      <div className="filters-grid">
        <label>
          Себестоимость
          <input
            required
            type="number"
            min="0"
            step="any"
            value={value.cost_amount}
            onChange={(event) => onChange({ ...value, cost_amount: event.target.value })}
          />
        </label>
        <label>
          Валюта
          <select
            value={value.cost_currency}
            onChange={(event) =>
              onChange({
                ...value,
                cost_currency: event.target.value === "USD" ? "USD" : "UZS",
              })
            }
          >
            <option value="UZS">UZS</option>
            <option value="USD">USD</option>
          </select>
        </label>
      </div>
      <div className="filters-grid">
        <label>
          Цена, сум
          <input
            type="number"
            min="0"
            step="any"
            value={value.price_uzs}
            onChange={(event) => onChange({ ...value, price_uzs: event.target.value })}
          />
        </label>
        <label>
          Цена, USD
          <input
            type="number"
            min="0"
            step="any"
            value={value.price_usd}
            onChange={(event) => onChange({ ...value, price_usd: event.target.value })}
          />
        </label>
      </div>
    </>
  );
}

export function MoneyCell({
  primary,
  muted,
  className,
}: {
  primary: string;
  muted?: string;
  className?: string;
}) {
  return (
    <div className={className ? `money-pair ${className}` : "money-pair"}>
      <div>{primary}</div>
      {muted ? <div className="money-pair__muted">{muted}</div> : null}
    </div>
  );
}
