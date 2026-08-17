import { describe, expect, it } from "vitest";
import { catalogCostLines, catalogPriceLines, formatMoneyLine, resolvePrice } from "./money";

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

  it("formats UZS with a thousands separator", () => {
    expect(formatMoneyLine(1250000, "UZS")).toContain("сум");
    expect(normalizeSpaces(formatMoneyLine(1250000, "UZS"))).toBe("1 250 000 сум");
  });
});
