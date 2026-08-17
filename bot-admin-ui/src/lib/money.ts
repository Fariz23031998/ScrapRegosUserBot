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

export function catalogPriceLines(item: CatalogMoney, rate: number): MoneyLines {
  const resolved = resolvePrice(item.price_uzs, item.price_usd, rate);
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
