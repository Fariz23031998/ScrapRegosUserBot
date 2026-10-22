import { describe, expect, it } from "vitest";
import { firmCheckView, firmSearchQuery } from "./firm-check";
import { firstAllowedPath, navItemsForPermissions } from "./permissions";
import { parseTelegramCard } from "./telegram-card";

describe("firm check view", () => {
  it("does not search an empty query", () => {
    expect(firmSearchQuery("   ")).toBe("");
    const view = firmCheckView({
      query: "",
      isFetching: false,
      isError: false,
      isSuccess: false,
    });
    expect(view.loading).toBe(false);
    expect(view.notFound).toBe(false);
    expect(view.error).toBeNull();
    expect(view.results).toEqual([]);
  });

  it("shows the firm name and phone on a card", () => {
    const message = "<b>Имя:</b> Acme &amp; Co\n<b>Телефон:</b> +998901112233\n<script>alert(1)</script>";
    const lines = parseTelegramCard(message);
    expect(lines[0]).toEqual([
      { type: "bold", text: "Имя:" },
      { type: "text", text: " Acme & Co" },
    ]);
    expect(lines[1][1]?.text).toBe(" +998901112233");
    expect(lines[2][0]?.text).toContain("<script>");

    const view = firmCheckView({
      query: "Acme",
      isFetching: false,
      isError: false,
      isSuccess: true,
      results: [{ clientName: "Acme & Co", phone: "+998901112233", message }],
    });
    expect(view.results[0]?.clientName).toBe("Acme & Co");
    expect(view.results[0]?.phone).toBe("+998901112233");
    expect(view.notFound).toBe(false);
  });

  it("shows not found and the portal error", () => {
    expect(
      firmCheckView({
        query: "missing",
        isFetching: false,
        isError: false,
        isSuccess: true,
        results: [],
      }).notFound,
    ).toBe(true);
    expect(
      firmCheckView({
        query: "missing",
        isFetching: false,
        isError: true,
        isSuccess: false,
        errorMessage: "Ошибка загрузки данных с портала. Попробуйте ещё раз.",
      }).error,
    ).toBe("Ошибка загрузки данных с портала. Попробуйте ещё раз.");
  });
});

describe("firm check navigation", () => {
  it("puts the page first in the sidebar and last as a landing fallback", () => {
    const permissions = { open_admin_dashboard: true, tickets_read: true };
    expect(navItemsForPermissions(permissions)[0]?.to).toBe("/firms");
    expect(firstAllowedPath(permissions)).toBe("/tickets");
    expect(firstAllowedPath({ open_admin_dashboard: true })).toBe("/firms");
  });
});
