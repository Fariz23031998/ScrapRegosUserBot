import { describe, expect, it } from "vitest";
import { catalogCostLines, catalogPriceLines, cartOperationPriceLines, formatMoneyLine, hasCartDiscount, resolvePrice } from "./money";

function normalizeSpaces(value: string) {
  return value.replace(/\s/g, " ");
}

describe("money display", () => {
  it("formats stored cost and converted counterpart", () => {
    const lines = catalogCostLines({
      cost_amount: 100,
      cost_currency: "USD",
      cost_uzs: 1_250_000,
      cost_usd: 100,
    });
    expect(normalizeSpaces(lines.primary)).toBe("100 USD");
    expect(normalizeSpaces(lines.muted)).toBe("1 250 000 сум");
  });

  it("shows stored price and converts the missing side", () => {
    expect(resolvePrice(null, 80, 12500)).toEqual({
      uzs: 1_000_000,
      usd: 80,
      storedUzs: false,
      storedUsd: true,
    });
    const lines = catalogPriceLines({ price_usd: 80 }, 12500);
    expect(normalizeSpaces(lines.primary)).toBe("80 USD");
    expect(normalizeSpaces(lines.muted)).toBe("1 000 000 сум");
  });

  it("shows cart operation totals using stored currency", () => {
    const line = {
      price_stored_usd: 80,
      price_stored_uzs: null,
      price_without_discount_usd: 160,
      price_without_discount_uzs: 2_000_000,
      price_usd: 144,
      price_uzs: 1_800_000,
      discount_type: "percent" as const,
      discount_value: 10,
    };
    expect(hasCartDiscount(line)).toBe(true);
    expect(normalizeSpaces(cartOperationPriceLines(line, 12500, "price").primary)).toBe("144 USD");
    expect(normalizeSpaces(cartOperationPriceLines(line, 12500, "price_without_discount").primary)).toBe("160 USD");
  });

  it("shows only the selected display currency", () => {
    const both = catalogPriceLines({ price_uzs: 1_250_000, price_usd: 100 }, 12500);
    expect(normalizeSpaces(both.primary)).toBe("1 250 000 сум");
    expect(normalizeSpaces(both.muted)).toBe("100 USD");

    const uzs = catalogPriceLines({ price_uzs: 1_250_000, price_usd: 100 }, 12500, "UZS");
    expect(normalizeSpaces(uzs.primary)).toBe("1 250 000 сум");
    expect(uzs.muted).toBe("");

    const usd = catalogPriceLines({ price_usd: 80 }, 12500, "USD");
    expect(normalizeSpaces(usd.primary)).toBe("80 USD");
    expect(usd.muted).toBe("");

    const converted = catalogPriceLines({ price_usd: 80 }, 12500, "UZS");
    expect(normalizeSpaces(converted.primary)).toBe("1 000 000 сум");
    expect(converted.muted).toBe("");
  });

  it("formats UZS with a thousands separator", () => {
    expect(formatMoneyLine(1250000, "UZS")).toContain("сум");
    expect(normalizeSpaces(formatMoneyLine(1250000, "UZS"))).toBe("1 250 000 сум");
  });
});
