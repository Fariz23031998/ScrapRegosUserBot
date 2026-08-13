import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getPrices, savePrices } from "../api/catalog";
import { apiUrl } from "../lib/api-url";
import { useAuth } from "../hooks/useAuth";
import { emptyCategory, emptyItem, normalizeCatalog, PRICE_KEYS, PRICE_LABELS } from "../lib/price-catalog";
import type { PriceCatalog, PriceCategory, PriceItem, PriceKey } from "../lib/types";

export default function PricesPage() {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const canSave = hasPermission("prices_create") || hasPermission("prices_edit") || hasPermission("prices_delete");
  const [catalog, setCatalog] = useState<PriceCatalog | null>(null);
  const [message, setMessage] = useState<{ text: string; type?: "success" | "error" } | null>(null);

  const pricesQuery = useQuery({
    queryKey: ["prices-catalog"],
    queryFn: async () => normalizeCatalog(await getPrices()),
  });

  useEffect(() => {
    if (pricesQuery.data) setCatalog(pricesQuery.data);
  }, [pricesQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => savePrices(catalog || {}),
    onSuccess: (data) => {
      const next = normalizeCatalog(data);
      setCatalog(next);
      queryClient.setQueryData(["prices-catalog"], next);
      setMessage({ text: "Прайс сохранён.", type: "success" });
    },
    onError: (error: Error) => setMessage({ text: error.message, type: "error" }),
  });

  if (pricesQuery.isError && !catalog) {
    return (
      <section className="card">
        <p className="message error">{pricesQuery.error.message || "Не удалось загрузить прайс."}</p>
        <button type="button" className="btn-secondary" onClick={() => void pricesQuery.refetch()}>
          Повторить
        </button>
      </section>
    );
  }

  if (!catalog || pricesQuery.isPending) {
    return <section className="card">Загрузка…</section>;
  }

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

  function updateItemPrice(catIndex: number, itemIndex: number, key: PriceKey, value: string) {
    setCatalog((prev) => {
      if (!prev) return prev;
      const categories = [...(prev.categories || [])];
      const items = [...(categories[catIndex].items || [])];
      const item = items[itemIndex];
      items[itemIndex] = { ...item, prices: { ...item.prices, [key]: value } };
      categories[catIndex] = { ...categories[catIndex], items };
      return { ...prev, categories };
    });
  }

  return (
    <section className="card price-editor">
      {canSave ? (
        <div className="card-toolbar">
          <button type="button" className="btn-primary" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            Сохранить
          </button>
        </div>
      ) : null}
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
        <div key={category.id ?? catIndex} className="price-category">
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
            <div key={item.id ?? `${catIndex}-${itemIndex}`} className="price-category" style={{ marginLeft: "1rem" }}>
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
                      value={item.prices?.[key] ?? ""}
                      disabled={!canSave}
                      onChange={(e) => updateItemPrice(catIndex, itemIndex, key, e.target.value)}
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
        <a href={apiUrl("/prices")} target="_blank" rel="noreferrer">
          Открыть публичную страницу прайса
        </a>
      </p>
    </section>
  );
}
