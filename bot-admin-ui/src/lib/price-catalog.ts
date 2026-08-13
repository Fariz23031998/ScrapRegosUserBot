import type { PriceCatalog, PriceCategory, PriceItem, PriceKey, PriceValues } from "./types";

export const PRICE_KEYS = ["fixed", "min5", "min30", "hour1", "hour2"] as const satisfies readonly PriceKey[];

export const PRICE_LABELS: Record<PriceKey, string> = {
  fixed: "ФИКСА",
  min5: "5 мин",
  min30: "30 мин",
  hour1: "1 час",
  hour2: "2 часа",
};

function newId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function priceText(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

function normalizePrices(item: PriceItem): PriceValues {
  const prices = item.prices || {};
  return Object.fromEntries(PRICE_KEYS.map((key) => [key, priceText(prices[key])])) as PriceValues;
}

export function emptyItem(): PriceItem {
  return {
    id: newId(),
    name_ru: "",
    name_uz: "",
    prices: { fixed: "", min5: "", min30: "", hour1: "", hour2: "" },
  };
}

export function emptyCategory(): PriceCategory {
  return { id: newId(), name_ru: "", name_uz: "", items: [emptyItem()] };
}

export function normalizeCatalog(raw: PriceCatalog | null | undefined): PriceCatalog {
  const source = raw || {};
  const categories = (source.categories || []).map((category) => ({
    ...category,
    id: category.id ?? newId(),
    name_ru: category.name_ru || "",
    name_uz: category.name_uz || "",
    items: (category.items || [emptyItem()]).map((item) => ({
      ...item,
      id: item.id ?? newId(),
      name_ru: item.name_ru || "",
      name_uz: item.name_uz || "",
      prices: normalizePrices(item),
    })),
  }));

  return {
    title_ru: source.title_ru || "",
    title_uz: source.title_uz || "",
    notice_ru: source.notice_ru || "",
    notice_uz: source.notice_uz || "",
    updated_at: source.updated_at,
    categories: categories.length ? categories : [emptyCategory()],
  };
}

export function toPriceCatalogPayload(catalog: PriceCatalog) {
  return {
    title_ru: catalog.title_ru || "",
    title_uz: catalog.title_uz || "",
    notice_ru: catalog.notice_ru || "",
    notice_uz: catalog.notice_uz || "",
    categories: (catalog.categories || []).map((category) => ({
      name_ru: category.name_ru || "",
      name_uz: category.name_uz || "",
      items: (category.items || []).map((item) => ({
        name_ru: item.name_ru || "",
        name_uz: item.name_uz || "",
        prices: Object.fromEntries(PRICE_KEYS.map((key) => [key, item.prices?.[key] ?? ""])) as PriceValues,
      })),
    })),
  };
}
