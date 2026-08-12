import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getPrices, savePrices } from "../api/catalog";
import { useAuth } from "../hooks/useAuth";
import type { PriceCatalog, PriceCategory, PriceItem } from "../lib/types";

const PRICE_KEYS = ["fixed", "min5", "min30", "hour1", "hour2"] as const;
const PRICE_LABELS: Record<(typeof PRICE_KEYS)[number], string> = {
  fixed: "ФИКСА",
  min5: "5 мин",
  min30: "30 мин",
  hour1: "1 час",
  hour2: "2 часа",
};

function emptyItem(): PriceItem {
  return { id: crypto.randomUUID(), name_ru: "", name_uz: "", fixed: undefined, min5: undefined, min30: undefined, hour1: undefined, hour2: undefined };
}

function emptyCategory(): PriceCategory {
  return { id: crypto.randomUUID(), name_ru: "", name_uz: "", items: [emptyItem()] };
}

function normalizeCatalog(raw: PriceCatalog): PriceCatalog {
  const categories = (raw.categories || []).map((cat) => ({
    ...cat,
    id: cat.id || crypto.randomUUID(),
    items: (cat.items || [emptyItem()]).map((item) => ({
      ...item,
      id: item.id || crypto.randomUUID(),
    })),
  }));
  return { ...raw, categories: categories.length ? categories : [emptyCategory()] };
}

export default function PricesPage() {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const canSave = hasPermission("prices_create") || hasPermission("prices_edit") || hasPermission("prices_delete");
  const [catalog, setCatalog] = useState<PriceCatalog | null>(null);
  const [message, setMessage] = useState<{ text: string; type?: "success" | "error" } | null>(null);

  useQuery({
    queryKey: ["prices-catalog"],
    queryFn: async () => {
      const data = await getPrices();
      const normalized = normalizeCatalog(data.catalog || {});
      setCatalog(normalized);
      return normalized;
    },
  });

  const saveMutation = useMutation({
    mutationFn: () => savePrices(catalog || {}),
    onSuccess: (data) => {
      setCatalog(normalizeCatalog(data.catalog));
      setMessage({ text: "Прайс сохранён.", type: "success" });
      void queryClient.invalidateQueries({ queryKey: ["prices-catalog"] });
    },
    onError: (error: Error) => setMessage({ text: error.message, type: "error" }),
  });

  if (!catalog) return <section className="card">Загрузка…</section>;

  function updateCategory(index: number, patch: Partial<PriceCategory>) {
    setCatalog((prev) => {
      if (!prev) return prev;
      const categories = [...(prev.categories || [])];
      categories[index] = { ...categories[index], ...patch };
      return { ...prev, categories };
    });
  }

  function updateItem(catIndex: number, itemIndex: number, patch: Partial<PriceItem>) {
    setCatalog((prev) => {
      if (!prev) return prev;
      const categories = [...(prev.categories || [])];
      const items = [...(categories[catIndex].items || [])];
      items[itemIndex] = { ...items[itemIndex], ...patch };
      categories[catIndex] = { ...categories[catIndex], items };
      return { ...prev, categories };
    });
  }

  return (
    <section className="card price-editor">
      <div className="card-toolbar">
        <h1>Прайс услуг</h1>
        {canSave ? (
          <button type="button" className="btn-primary" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            Сохранить
          </button>
        ) : null}
      </div>
      {message ? <p className={`message ${message.type || ""}`}>{message.text}</p> : null}

      <div className="filters-grid">
        <label>
          Заголовок (RU)
          <input
            value={catalog.title_ru || ""}
            disabled={!canSave}
            onChange={(e) => setCatalog({ ...catalog, title_ru: e.target.value })}
          />
        </label>
        <label>
          Заголовок (UZ)
          <input
            value={catalog.title_uz || ""}
            disabled={!canSave}
            onChange={(e) => setCatalog({ ...catalog, title_uz: e.target.value })}
          />
        </label>
        <label>
          Примечание (RU)
          <textarea
            value={catalog.notice_ru || ""}
            disabled={!canSave}
            onChange={(e) => setCatalog({ ...catalog, notice_ru: e.target.value })}
          />
        </label>
        <label>
          Примечание (UZ)
          <textarea
            value={catalog.notice_uz || ""}
            disabled={!canSave}
            onChange={(e) => setCatalog({ ...catalog, notice_uz: e.target.value })}
          />
        </label>
      </div>

      {(catalog.categories || []).map((category, catIndex) => (
        <div key={category.id} className="price-category">
          <div className="card-toolbar">
            <h3>Категория {catIndex + 1}</h3>
            {canSave ? (
              <button
                type="button"
                className="btn-danger"
                onClick={() =>
                  setCatalog((prev) => {
                    if (!prev) return prev;
                    const categories = [...(prev.categories || [])];
                    categories.splice(catIndex, 1);
                    return { ...prev, categories: categories.length ? categories : [emptyCategory()] };
                  })
                }
              >
                Удалить категорию
              </button>
            ) : null}
          </div>
          <div className="filters-grid">
            <label>
              Название (RU)
              <input
                value={category.name_ru || ""}
                disabled={!canSave}
                onChange={(e) => updateCategory(catIndex, { name_ru: e.target.value })}
              />
            </label>
            <label>
              Название (UZ)
              <input
                value={category.name_uz || ""}
                disabled={!canSave}
                onChange={(e) => updateCategory(catIndex, { name_uz: e.target.value })}
              />
            </label>
          </div>

          {(category.items || []).map((item, itemIndex) => (
            <div key={item.id} className="price-category" style={{ marginLeft: "1rem" }}>
              <div className="filters-grid">
                <label>
                  Услуга (RU)
                  <input
                    value={item.name_ru || ""}
                    disabled={!canSave}
                    onChange={(e) => updateItem(catIndex, itemIndex, { name_ru: e.target.value })}
                  />
                </label>
                <label>
                  Услуга (UZ)
                  <input
                    value={item.name_uz || ""}
                    disabled={!canSave}
                    onChange={(e) => updateItem(catIndex, itemIndex, { name_uz: e.target.value })}
                  />
                </label>
                {PRICE_KEYS.map((key) => (
                  <label key={key}>
                    {PRICE_LABELS[key]}
                    <input
                      value={String(item[key] ?? "")}
                      disabled={!canSave}
                      onChange={(e) => updateItem(catIndex, itemIndex, { [key]: e.target.value ? Number(e.target.value) : undefined })}
                    />
                  </label>
                ))}
              </div>
              {canSave ? (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    const items = [...(category.items || [])];
                    items.splice(itemIndex, 1);
                    updateCategory(catIndex, { items: items.length ? items : [emptyItem()] });
                  }}
                >
                  Удалить услугу
                </button>
              ) : null}
            </div>
          ))}

          {canSave ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => updateCategory(catIndex, { items: [...(category.items || []), emptyItem()] })}
            >
              + Услуга
            </button>
          ) : null}
        </div>
      ))}

      {canSave ? (
        <button type="button" className="btn-secondary" onClick={() => setCatalog({ ...catalog, categories: [...(catalog.categories || []), emptyCategory()] })}>
          + Категория
        </button>
      ) : null}

      <p style={{ marginTop: "1rem" }}>
        <a href="/prices" target="_blank" rel="noreferrer">
          Открыть публичную страницу прайса
        </a>
      </p>
    </section>
  );
}
