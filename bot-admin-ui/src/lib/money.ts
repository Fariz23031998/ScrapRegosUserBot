export type MoneyCurrency = "UZS" | "USD";

export type CatalogMoney = {
  cost_amount?: number | null;
  cost_currency?: string | null;
  cost_uzs?: number | null;
  cost_usd?: number | null;
  price_uzs?: number | null;
  price_usd?: number | null;
};

export type MoneyLines = {
  primary: string;
  muted: string;
};

export const DEFAULT_USD_UZS_RATE = 12500;

export function parseMoneyCurrency(value: unknown): MoneyCurrency {
  return String(value || "").toUpperCase() === "USD" ? "USD" : "UZS";
}

export function parseDisplayCurrency(value: unknown): MoneyCurrency | null {
  const raw = String(value || "").trim().toUpperCase();
  if (raw === "USD" || raw === "UZS") return raw;
  return null;
}

export function formatMoneyLine(amount: number | null | undefined, currency: MoneyCurrency): string {
  const n = Number(amount);
  const safe = Number.isFinite(n) ? n : 0;
  const formatted = safe.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  return currency === "USD" ? `${formatted} USD` : `${formatted} сум`;
}

export function resolvePrice(
  priceUzs: number | null | undefined,
  priceUsd: number | null | undefined,
  rate: number,
): { uzs: number; usd: number; storedUzs: boolean; storedUsd: boolean } {
  const storedUzs = priceUzs != null && Number.isFinite(Number(priceUzs));
  const storedUsd = priceUsd != null && Number.isFinite(Number(priceUsd));
  const safeRate = rate > 0 ? rate : DEFAULT_USD_UZS_RATE;
  const uzs = storedUzs ? Number(priceUzs) : storedUsd ? Number(priceUsd) * safeRate : 0;
  const usd = storedUsd ? Number(priceUsd) : storedUzs ? Number(priceUzs) / safeRate : 0;
  return { uzs, usd, storedUzs, storedUsd };
}

export function catalogCostLines(item: CatalogMoney): MoneyLines {
  const currency = parseMoneyCurrency(item.cost_currency);
  const amount = Number(item.cost_amount) || 0;
  if (currency === "USD") {
    return {
      primary: formatMoneyLine(amount, "USD"),
      muted: formatMoneyLine(item.cost_uzs ?? amount, "UZS"),
    };
  }
  return {
    primary: formatMoneyLine(amount, "UZS"),
    muted: formatMoneyLine(item.cost_usd ?? 0, "USD"),
  };
}

export function catalogPriceLines(
  item: CatalogMoney,
  rate: number,
  displayCurrency?: MoneyCurrency | null,
): MoneyLines {
  const resolved = resolvePrice(item.price_uzs, item.price_usd, rate);
  if (!resolved.storedUzs && !resolved.storedUsd) return { primary: "—", muted: "" };
  if (displayCurrency === "USD" || displayCurrency === "UZS") {
    return {
      primary: formatMoneyLine(displayCurrency === "USD" ? resolved.usd : resolved.uzs, displayCurrency),
      muted: "",
    };
  }
  if (resolved.storedUsd && !resolved.storedUzs) {
    return {
      primary: formatMoneyLine(item.price_usd, "USD"),
      muted: formatMoneyLine(resolved.uzs, "UZS"),
    };
  }
  if (resolved.storedUzs && !resolved.storedUsd) {
    return {
      primary: formatMoneyLine(item.price_uzs, "UZS"),
      muted: formatMoneyLine(resolved.usd, "USD"),
    };
  }
  if (resolved.storedUzs && resolved.storedUsd) {
    return {
      primary: formatMoneyLine(item.price_uzs, "UZS"),
      muted: formatMoneyLine(item.price_usd, "USD"),
    };
  }
  return { primary: "—", muted: "" };
}

export type CartMoney = CatalogMoney & {
  price_stored_uzs?: number | null;
  price_stored_usd?: number | null;
  price_without_discount_uzs?: number | null;
  price_without_discount_usd?: number | null;
  discount_type?: string | null;
  discount_value?: number | null;
  discount_currency?: string | null;
};

export function cartOperationPriceLines(
  line: CartMoney,
  rate: number,
  field: "price" | "price_without_discount" = "price",
  displayCurrency?: MoneyCurrency | null,
): MoneyLines {
  const uzs = field === "price" ? line.price_uzs : line.price_without_discount_uzs;
  const usd = field === "price" ? line.price_usd : line.price_without_discount_usd;
  const storedUzs = line.price_stored_uzs != null && Number.isFinite(Number(line.price_stored_uzs));
  const storedUsd = line.price_stored_usd != null && Number.isFinite(Number(line.price_stored_usd));
  return catalogPriceLines(
    {
      price_uzs: storedUzs || !storedUsd ? uzs : null,
      price_usd: storedUsd || !storedUzs ? usd : null,
    },
    rate,
    displayCurrency,
  );
}

export function totalsPriceLines(
  uzs: number | null | undefined,
  usd: number | null | undefined,
  displayCurrency?: MoneyCurrency | null,
): MoneyLines {
  if (displayCurrency === "USD") {
    return { primary: formatMoneyLine(usd, "USD"), muted: "" };
  }
  if (displayCurrency === "UZS") {
    return { primary: formatMoneyLine(uzs, "UZS"), muted: "" };
  }
  return {
    primary: formatMoneyLine(uzs, "UZS"),
    muted: formatMoneyLine(usd, "USD"),
  };
}

export function hasCartDiscount(line: CartMoney): boolean {
  if (line.discount_type && Number(line.discount_value) > 0) return true;
  const price = Number(line.price_uzs);
  const original = Number(line.price_without_discount_uzs);
  return Number.isFinite(original) && Number.isFinite(price) && original > 0 && price < original - 0.0001;
}

export function emptyMoneyEditor() {
  return {
    cost_amount: "0",
    cost_currency: "UZS" as MoneyCurrency,
    price_uzs: "",
    price_usd: "",
  };
}

export function moneyEditorFromItem(item: CatalogMoney) {
  return {
    cost_amount: item.cost_amount != null ? String(item.cost_amount) : "0",
    cost_currency: parseMoneyCurrency(item.cost_currency),
    price_uzs: item.price_uzs != null ? String(item.price_uzs) : "",
    price_usd: item.price_usd != null ? String(item.price_usd) : "",
  };
}

export function moneyPayloadFromEditor(editor: {
  cost_amount: string;
  cost_currency: MoneyCurrency;
  price_uzs: string;
  price_usd: string;
}) {
  return {
    cost_amount: Number(editor.cost_amount),
    cost_currency: editor.cost_currency,
    price_uzs: editor.price_uzs.trim() === "" ? null : Number(editor.price_uzs),
    price_usd: editor.price_usd.trim() === "" ? null : Number(editor.price_usd),
  };
}

export function lineRefundAmount(
  line: {
    price_uzs?: number | null;
    price_usd?: number | null;
    quantity?: number | null;
  },
  refundQty: number,
  currency: MoneyCurrency,
): number {
  const totalQty = Math.max(1, Math.trunc(Number(line.quantity) || 1));
  const qty = Math.min(Math.max(1, Math.trunc(refundQty)), totalQty);
  const ratio = qty / totalQty;
  const uzs = (Number(line.price_uzs) || 0) * ratio;
  const usd = (Number(line.price_usd) || 0) * ratio;
  const value = currency === "USD" ? usd : uzs;
  return Math.round(value * 100) / 100;
}
