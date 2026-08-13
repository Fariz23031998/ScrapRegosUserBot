import { describe, expect, it } from "vitest";
import { emptyCategory, normalizeCatalog, toPriceCatalogPayload } from "./price-catalog";

describe("price-catalog", () => {
  it("normalizes the public API catalog shape", () => {
    const catalog = normalizeCatalog({
      title_ru: "Прайс",
      title_uz: "Narxlar",
      notice_ru: "RU",
      notice_uz: "UZ",
      categories: [
        {
          id: 1,
          name_ru: "Категория",
          name_uz: "Turkum",
          items: [
            {
              id: 10,
              name_ru: "Услуга",
              name_uz: "Xizmat",
              prices: { fixed: "70 000/120 000", min5: null, hour1: "2000" },
            },
          ],
        },
      ],
    });

    expect(catalog.categories?.[0]?.items?.[0]?.prices).toEqual({
      fixed: "70 000/120 000",
      min5: "",
      min30: "",
      hour1: "2000",
      hour2: "",
    });
  });

  it("creates ids when crypto.randomUUID is unavailable", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
    try {
      const category = emptyCategory();
      expect(String(category.id)).toMatch(/^id-/);
      expect(String(category.items?.[0]?.id)).toMatch(/^id-/);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { configurable: true, value: original });
    }
  });

  it("builds the PUT payload expected by /bot-admin/api/prices", () => {
    const payload = toPriceCatalogPayload({
      title_ru: "Прайс",
      title_uz: "Narxlar",
      notice_ru: "RU",
      notice_uz: "UZ",
      categories: [
        {
          id: "ui-only",
          name_ru: "Категория",
          name_uz: "Turkum",
          items: [
            {
              id: "item-1",
              name_ru: "Услуга",
              name_uz: "Xizmat",
              prices: { fixed: "70 000/120 000", min5: "", hour1: "2000" },
            },
          ],
        },
      ],
    });

    expect(payload).toEqual({
      title_ru: "Прайс",
      title_uz: "Narxlar",
      notice_ru: "RU",
      notice_uz: "UZ",
      categories: [
        {
          name_ru: "Категория",
          name_uz: "Turkum",
          items: [
            {
              name_ru: "Услуга",
              name_uz: "Xizmat",
              prices: { fixed: "70 000/120 000", min5: "", min30: "", hour1: "2000", hour2: "" },
            },
          ],
        },
      ],
    });
  });
});
