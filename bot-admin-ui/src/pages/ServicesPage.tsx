import { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import {
  createService,
  createServiceCategory,
  deleteService,
  deleteServiceCategory,
  deleteServiceImage,
  listServiceCategories,
  listServices,
  updateService,
  updateServiceCategory,
  uploadServiceImages,
} from "../api/services";
import { getExchangeRate } from "../api/settings";
import CatalogCategoryManager from "../components/CatalogCategoryManager";
import CatalogImageGallery, { CatalogThumb } from "../components/CatalogImageGallery";
import EntityCards from "../components/EntityCards";
import InfiniteScrollSentinel from "../components/InfiniteScrollSentinel";
import ListFiltersChrome from "../components/ListFiltersChrome";
import Modal from "../components/Modal";
import MoneyFields, { MoneyCell } from "../components/MoneyFields";
import SimpleTable from "../components/SimpleTable";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { usePagedInfiniteQuery } from "../hooks/usePagedInfiniteQuery";
import { useUiPreferences } from "../hooks/useUiPreferences";
import {
  DEFAULT_USD_UZS_RATE,
  catalogCostLines,
  catalogPriceLines,
  emptyMoneyEditor,
  moneyEditorFromItem,
  moneyPayloadFromEditor,
} from "../lib/money";
import type { CatalogCategory, CatalogImage, CatalogService } from "../lib/types";
import { formatDateTime } from "../lib/utils";

type ServiceEditor = {
  id?: number;
  name: string;
  description: string;
  category_id: string;
  cost_amount: string;
  cost_currency: "UZS" | "USD";
  price_uzs: string;
  price_usd: string;
};

function ServiceFilterFields({
  categoryId,
  categories,
  onCategoryChange,
  showActions,
  onApply,
}: {
  categoryId: string;
  categories: CatalogCategory[];
  onCategoryChange: (value: string) => void;
  showActions?: boolean;
  onApply?: () => void;
}) {
  return (
    <>
      <label className="ticket-filters__field">
        <span>Категория</span>
        <select value={categoryId} onChange={(event) => onCategoryChange(event.target.value)}>
          <option value="">Все</option>
          <option value="none">Без категории</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      {showActions ? (
        <div className="ticket-filters__actions">
          <button type="button" className="btn-primary" onClick={onApply}>
            Применить
          </button>
        </div>
      ) : null}
    </>
  );
}

export default function ServicesPage() {
  const { hasPermission } = useAuth();
  const { dateTimeFormat } = useUiPreferences();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [appliedCategoryId, setAppliedCategoryId] = useState("");
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [editor, setEditor] = useState<ServiceEditor | null>(null);
  const [formError, setFormError] = useState("");
  const [uploading, setUploading] = useState(false);

  const rateQuery = useQuery({
    queryKey: ["exchange-rate"],
    queryFn: getExchangeRate,
  });
  const rate = rateQuery.data?.usd_uzs_rate || DEFAULT_USD_UZS_RATE;

  const categoriesQuery = useQuery({
    queryKey: ["service-categories"],
    queryFn: listServiceCategories,
  });
  const categories = categoriesQuery.data?.categories || [];

  const servicesQuery = usePagedInfiniteQuery({
    queryKey: ["services", search, appliedCategoryId],
    queryFn: (page, pageSize) =>
      listServices({
        page,
        limit: pageSize,
        q: search || undefined,
        category_id: appliedCategoryId || undefined,
      }),
    getItems: (data) => data.services || [],
    getItemId: (service) => service.id,
  });

  function invalidateServices() {
    void queryClient.invalidateQueries({ queryKey: ["services"] });
    void queryClient.invalidateQueries({ queryKey: ["service-categories"] });
  }

  const saveMutation = useMutation({
    mutationFn: (payload: ServiceEditor) => {
      const body = {
        name: payload.name.trim(),
        description: payload.description.trim(),
        category_id: payload.category_id ? Number(payload.category_id) : null,
        ...moneyPayloadFromEditor(payload),
      };
      if (payload.id) return updateService(payload.id, body);
      return createService(body);
    },
    onSuccess: () => {
      setEditor(null);
      invalidateServices();
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteService,
    onSuccess: invalidateServices,
  });

  async function handleDelete(service: CatalogService) {
    const ok = await confirm({
      message: `Удалить услугу «${service.name}»?`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) deleteMutation.mutate(service.id);
  }

  function openCreate() {
    setFormError("");
    setEditor({ name: "", description: "", category_id: "", ...emptyMoneyEditor() });
  }

  function openEdit(service: CatalogService) {
    setFormError("");
    setEditor({
      id: service.id,
      name: service.name,
      description: service.description || "",
      category_id: service.category_id ? String(service.category_id) : "",
      ...moneyEditorFromItem(service),
    });
  }

  async function handleDeleteCategory(category: CatalogCategory) {
    const ok = await confirm({
      message: `Удалить категорию «${category.name}»? Услуги останутся без категории.`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    await deleteServiceCategory(category.id);
    invalidateServices();
  }

  function serviceActions(service: CatalogService): ReactNode {
    return (
      <>
        {hasPermission("services_edit") ? (
          <button type="button" className="btn-secondary" onClick={() => openEdit(service)}>
            Изменить
          </button>
        ) : null}
        {hasPermission("services_delete") ? (
          <button type="button" className="btn-danger" onClick={() => void handleDelete(service)}>
            Удалить
          </button>
        ) : null}
      </>
    );
  }

  const editorService = editor?.id ? servicesQuery.items.find((service) => service.id === editor.id) : null;

  async function handleUploadImages(files: File[]) {
    if (!editor?.id) return;
    setUploading(true);
    setFormError("");
    try {
      await uploadServiceImages(editor.id, files);
      void queryClient.invalidateQueries({ queryKey: ["services"] });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Не удалось загрузить изображение.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteImage(image: CatalogImage) {
    if (!editor?.id) return;
    const ok = await confirm({
      message: "Удалить это фото услуги?",
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    setFormError("");
    try {
      await deleteServiceImage(editor.id, image.id);
      void queryClient.invalidateQueries({ queryKey: ["services"] });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Не удалось удалить изображение.");
    }
  }

  const columns = useMemo<ColumnDef<CatalogService>[]>(
    () => [
      {
        id: "photo",
        header: "",
        enableSorting: false,
        cell: ({ row }) => <CatalogThumb images={row.original.images} alt={row.original.name} />,
      },
      { id: "name", header: "Название", accessorKey: "name" },
      {
        id: "category",
        header: "Категория",
        accessorFn: (row) => row.category?.name || "—",
      },
      {
        id: "description",
        header: "Описание",
        accessorFn: (row) => row.description || "—",
      },
      {
        id: "cost",
        header: "Себестоимость",
        cell: ({ row }) => {
          const lines = catalogCostLines(row.original);
          return <MoneyCell primary={lines.primary} muted={lines.muted} />;
        },
      },
      {
        id: "price",
        header: "Цена",
        cell: ({ row }) => {
          const lines = catalogPriceLines(row.original, rate);
          return <MoneyCell primary={lines.primary} muted={lines.muted} />;
        },
      },
      {
        id: "updated_at",
        header: "Обновлено",
        accessorFn: (row) => formatDateTime(row.updated_at),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => <div className="cell-actions">{serviceActions(row.original)}</div>,
      },
    ],
    [dateTimeFormat, hasPermission, rate],
  );

  const services = servicesQuery.items;
  const total = servicesQuery.total;

  return (
    <section className="card">
      <div className="card-toolbar">
        <div className="card-toolbar-right">
          {hasPermission("services_edit") ? (
            <button type="button" className="btn-secondary" onClick={() => setCategoryManagerOpen(true)}>
              Категории
            </button>
          ) : null}
          {hasPermission("services_create") ? (
            <button type="button" className="btn-primary" onClick={openCreate}>
              + Создать
            </button>
          ) : null}
        </div>
      </div>

      <ListFiltersChrome
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Поиск по названию…"
        filtersActive={Boolean(appliedCategoryId)}
        filtersModalOpen={filtersModalOpen}
        onFiltersModalOpenChange={setFiltersModalOpen}
        onApplyFilters={() => setAppliedCategoryId(categoryId)}
        onResetFilters={() => setCategoryId("")}
        desktopFilters={
          <ServiceFilterFields
            categoryId={categoryId}
            categories={categories}
            onCategoryChange={setCategoryId}
            showActions
            onApply={() => setAppliedCategoryId(categoryId)}
          />
        }
        sheetFilters={
          <ServiceFilterFields categoryId={categoryId} categories={categories} onCategoryChange={setCategoryId} />
        }
      />

      <div className="ticket-table-section">
        {compact ? (
          <EntityCards
            items={services}
            isLoading={servicesQuery.isPending}
            emptyMessage={search || appliedCategoryId ? "Ничего не найдено." : "Услуг пока нет."}
            getKey={(service) => String(service.id)}
            getTitle={(service) => (
              <span className="catalog-title-with-thumb">
                <CatalogThumb images={service.images} alt={service.name} />
                {service.name}
              </span>
            )}
            getSubtitle={(service) => [service.category?.name, service.description].filter(Boolean).join(" · ") || "—"}
            getFields={(service) => [
              { label: "Себестоимость", value: <MoneyCell {...catalogCostLines(service)} /> },
              { label: "Цена", value: <MoneyCell {...catalogPriceLines(service, rate)} /> },
              { label: "Обновлено", value: formatDateTime(service.updated_at) },
            ]}
            getActions={(service) => serviceActions(service)}
          />
        ) : (
          <SimpleTable
            tableKey="bot-admin.services"
            data={services}
            columns={columns}
            isLoading={servicesQuery.isPending}
            serverSideSearch
            emptyMessage={search || appliedCategoryId ? "Ничего не найдено." : "Услуг пока нет."}
            getRowId={(row) => String(row.id)}
          />
        )}
        <InfiniteScrollSentinel
          loaded={services.length}
          total={total}
          hasNextPage={Boolean(servicesQuery.hasNextPage)}
          isFetchingNextPage={servicesQuery.isFetchingNextPage}
          fetchNextPage={servicesQuery.fetchNextPage}
        />
      </div>

      <Modal
        open={editor != null}
        title={editor?.id ? "Редактирование услуги" : "Новая услуга"}
        onClose={() => setEditor(null)}
      >
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!editor) return;
            if (!editor.price_uzs.trim() && !editor.price_usd.trim()) {
              setFormError("Укажите цену в сумах или в USD.");
              return;
            }
            setFormError("");
            saveMutation.mutate(editor);
          }}
        >
          <label>
            Название
            <input
              required
              maxLength={200}
              value={editor?.name || ""}
              onChange={(event) => setEditor((prev) => (prev ? { ...prev, name: event.target.value } : prev))}
            />
          </label>
          <label>
            Категория
            <select
              value={editor?.category_id || ""}
              onChange={(event) =>
                setEditor((prev) => (prev ? { ...prev, category_id: event.target.value } : prev))
              }
            >
              <option value="">Без категории</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Описание
            <textarea
              rows={3}
              maxLength={2000}
              value={editor?.description || ""}
              onChange={(event) =>
                setEditor((prev) => (prev ? { ...prev, description: event.target.value } : prev))
              }
            />
          </label>
          {editor ? (
            <MoneyFields value={editor} onChange={(value) => setEditor((prev) => (prev ? { ...prev, ...value } : prev))} />
          ) : null}
          {editor?.id ? (
            <CatalogImageGallery
              variant="compact"
              images={editorService?.images}
              alt={editor.name || "Услуга"}
              canEdit={hasPermission("services_edit")}
              uploading={uploading}
              onUpload={(files) => void handleUploadImages(files)}
              onDelete={(image) => void handleDeleteImage(image)}
            />
          ) : (
            <p className="muted-copy">Сохраните услугу, чтобы добавить фото.</p>
          )}
          {formError ? <p className="message error">{formError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setEditor(null)}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={saveMutation.isPending}>
              Сохранить
            </button>
          </div>
        </form>
      </Modal>

      <CatalogCategoryManager
        open={categoryManagerOpen}
        categories={categories}
        isLoading={categoriesQuery.isPending}
        canEdit={hasPermission("services_edit")}
        onClose={() => setCategoryManagerOpen(false)}
        onSave={async (payload) => {
          if (payload.id) await updateServiceCategory(payload.id, { name: payload.name });
          else await createServiceCategory({ name: payload.name });
          invalidateServices();
        }}
        onDelete={(category) => void handleDeleteCategory(category)}
      />
    </section>
  );
}
