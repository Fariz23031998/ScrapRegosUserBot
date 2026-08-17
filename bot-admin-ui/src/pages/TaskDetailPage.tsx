import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { deleteDeviceImage, listDeviceCategories, listDevices, uploadDeviceImages } from "../api/devices";
import { deleteServiceImage, listServiceCategories, listServices, uploadServiceImages } from "../api/services";
import { getExchangeRate } from "../api/settings";
import {
  addTaskDevice,
  addTaskService,
  deleteTaskDevice,
  deleteTaskService,
  getTask,
  listTaskCategories,
} from "../api/tasks";
import CatalogImageGallery, { CatalogThumb } from "../components/CatalogImageGallery";
import LoadingState from "../components/LoadingState";
import { MoneyCell } from "../components/MoneyFields";
import SearchField from "../components/SearchField";
import TaskEditorModal from "../components/TaskEditorModal";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { DEFAULT_USD_UZS_RATE, catalogPriceLines, formatMoneyLine } from "../lib/money";
import type {
  CatalogCategory,
  CatalogDevice,
  CatalogImage,
  CatalogService,
  FieldTask,
  TaskDeviceLine,
  TaskServiceLine,
} from "../lib/types";
import { formatDateTime } from "../lib/utils";

type CatalogKind = "device" | "service";
type KindFilter = "all" | CatalogKind;
type CategoryKey = "all" | `${CatalogKind}:none` | `${CatalogKind}:${number}`;

type CatalogProduct = {
  kind: CatalogKind;
  id: number;
  name: string;
  description?: string;
  category_id?: number | null;
  category?: { id: number; name: string } | null;
  images?: CatalogImage[];
  price_uzs?: number | null;
  price_usd?: number | null;
};

function textOrDash(value: unknown): string {
  if (value == null || value === "") return "—";
  return String(value);
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="task-detail-meta__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function clientLabel(task: FieldTask): string {
  return (
    task.client_name ||
    task.client_phone ||
    (task.regos_client_id ? `Клиент #${task.regos_client_id}` : "—")
  );
}

function toProducts(devices: CatalogDevice[], services: CatalogService[]): CatalogProduct[] {
  return [
    ...devices.map((device) => ({
      kind: "device" as const,
      id: device.id,
      name: device.name,
      description: device.description,
      category_id: device.category_id,
      category: device.category,
      images: device.images,
      price_uzs: device.price_uzs,
      price_usd: device.price_usd,
    })),
    ...services.map((service) => ({
      kind: "service" as const,
      id: service.id,
      name: service.name,
      description: service.description,
      category_id: service.category_id,
      category: service.category,
      images: service.images,
      price_uzs: service.price_uzs,
      price_usd: service.price_usd,
    })),
  ];
}

function productKey(product: { kind: CatalogKind; id: number }) {
  return `${product.kind}:${product.id}`;
}

function matchesCategory(product: CatalogProduct, categoryKey: CategoryKey) {
  if (categoryKey === "all") return true;
  const [kind, rawId] = categoryKey.split(":") as [CatalogKind, string];
  if (product.kind !== kind) return false;
  if (rawId === "none") return !product.category_id;
  return product.category_id === Number(rawId);
}

function CategoryNavButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`task-catalog__cat${active ? " is-active" : ""}`}
      onClick={onClick}
    >
      <span>{label}</span>
      <span className="task-catalog__cat-count">{count}</span>
    </button>
  );
}

export default function TaskDetailPage() {
  const { id } = useParams();
  const taskId = Number(id);
  const { hasPermission } = useAuth();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const isMobile = useMediaQuery("(max-width: 960px)");
  const [editOpen, setEditOpen] = useState(false);
  const [mobileView, setMobileView] = useState<"catalog" | "task">("catalog");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [categoryKey, setCategoryKey] = useState<CategoryKey>("all");
  const [productQuery, setProductQuery] = useState("");
  const [lineError, setLineError] = useState("");
  const [uploadingKey, setUploadingKey] = useState("");
  const [addingKey, setAddingKey] = useState("");

  const canEdit = hasPermission("tasks_edit");
  const validId = Number.isFinite(taskId) && taskId > 0;

  const taskQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => getTask(taskId),
    enabled: validId,
  });
  const categoriesQuery = useQuery({
    queryKey: ["task-categories"],
    queryFn: listTaskCategories,
  });
  const rateQuery = useQuery({
    queryKey: ["exchange-rate"],
    queryFn: getExchangeRate,
  });
  const devicesQuery = useQuery({
    queryKey: ["devices", "task-picker"],
    queryFn: () => listDevices({ page: 1, limit: 100 }),
  });
  const servicesQuery = useQuery({
    queryKey: ["services", "task-picker"],
    queryFn: () => listServices({ page: 1, limit: 100 }),
  });
  const deviceCategoriesQuery = useQuery({
    queryKey: ["device-categories"],
    queryFn: listDeviceCategories,
  });
  const serviceCategoriesQuery = useQuery({
    queryKey: ["service-categories"],
    queryFn: listServiceCategories,
  });

  const task = taskQuery.data?.task;
  const rate = rateQuery.data?.usd_uzs_rate || DEFAULT_USD_UZS_RATE;
  const catalogDevices = devicesQuery.data?.devices || [];
  const catalogServices = servicesQuery.data?.services || [];
  const taskCategories = categoriesQuery.data?.categories || [];
  const deviceCategories = deviceCategoriesQuery.data?.categories || [];
  const serviceCategories = serviceCategoriesQuery.data?.categories || [];
  const products = useMemo(
    () => toProducts(catalogDevices, catalogServices),
    [catalogDevices, catalogServices],
  );

  const filteredProducts = useMemo(() => {
    const needle = productQuery.trim().toLowerCase();
    return products.filter((product) => {
      if (kindFilter !== "all" && product.kind !== kindFilter) return false;
      if (!matchesCategory(product, categoryKey)) return false;
      if (!needle) return true;
      return (
        product.name.toLowerCase().includes(needle) ||
        (product.description || "").toLowerCase().includes(needle) ||
        (product.category?.name || "").toLowerCase().includes(needle)
      );
    });
  }, [products, kindFilter, categoryKey, productQuery]);

  function countProducts(kind?: CatalogKind, key: CategoryKey = "all") {
    return products.filter((product) => {
      if (kind && product.kind !== kind) return false;
      return matchesCategory(product, key);
    }).length;
  }

  function invalidateTask() {
    void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    void queryClient.invalidateQueries({ queryKey: ["devices"] });
    void queryClient.invalidateQueries({ queryKey: ["services"] });
  }

  function selectKind(next: KindFilter) {
    setKindFilter(next);
    setCategoryKey("all");
  }

  const addDeviceMutation = useMutation({
    mutationFn: (payload: { device_id: number; action: "install" | "repair" }) =>
      addTaskDevice(taskId, payload),
    onSuccess: () => {
      setLineError("");
      setAddingKey("");
      invalidateTask();
    },
    onError: (error: Error) => {
      setAddingKey("");
      setLineError(error.message);
    },
  });

  const addServiceMutation = useMutation({
    mutationFn: (serviceId: number) => addTaskService(taskId, { service_id: serviceId }),
    onSuccess: () => {
      setLineError("");
      setAddingKey("");
      invalidateTask();
    },
    onError: (error: Error) => {
      setAddingKey("");
      setLineError(error.message);
    },
  });

  const removeDeviceMutation = useMutation({
    mutationFn: (lineId: number) => deleteTaskDevice(taskId, lineId),
    onSuccess: invalidateTask,
    onError: (error: Error) => setLineError(error.message),
  });

  const removeServiceMutation = useMutation({
    mutationFn: (lineId: number) => deleteTaskService(taskId, lineId),
    onSuccess: invalidateTask,
    onError: (error: Error) => setLineError(error.message),
  });

  async function handleRemoveDevice(line: TaskDeviceLine) {
    if (!line.id) return;
    const ok = await confirm({
      message: `Удалить устройство «${line.device_name || line.device_id}» из задачи?`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) removeDeviceMutation.mutate(line.id);
  }

  async function handleRemoveService(line: TaskServiceLine) {
    if (!line.id) return;
    const ok = await confirm({
      message: `Удалить услугу «${line.service_name || line.service_id}» из задачи?`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) removeServiceMutation.mutate(line.id);
  }

  function handleAddProduct(product: CatalogProduct, action?: "install" | "repair") {
    if (!canEdit) return;
    if (product.kind === "device") {
      const nextAction = action || "install";
      setAddingKey(`${productKey(product)}:${nextAction}`);
      addDeviceMutation.mutate({ device_id: product.id, action: nextAction });
      return;
    }
    setAddingKey(productKey(product));
    addServiceMutation.mutate(product.id);
  }

  async function handleUploadDevice(line: TaskDeviceLine, files: File[]) {
    setUploadingKey(`device-${line.device_id}`);
    setLineError("");
    try {
      await uploadDeviceImages(line.device_id, files);
      invalidateTask();
    } catch (error) {
      setLineError(error instanceof Error ? error.message : "Не удалось загрузить изображение.");
    } finally {
      setUploadingKey("");
    }
  }

  async function handleUploadService(line: TaskServiceLine, files: File[]) {
    setUploadingKey(`service-${line.service_id}`);
    setLineError("");
    try {
      await uploadServiceImages(line.service_id, files);
      invalidateTask();
    } catch (error) {
      setLineError(error instanceof Error ? error.message : "Не удалось загрузить изображение.");
    } finally {
      setUploadingKey("");
    }
  }

  async function handleDeleteDeviceImage(line: TaskDeviceLine, image: CatalogImage) {
    const ok = await confirm({
      message: "Удалить это фото устройства? Оно пропадёт во всех задачах.",
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    setLineError("");
    try {
      await deleteDeviceImage(line.device_id, image.id);
      invalidateTask();
    } catch (error) {
      setLineError(error instanceof Error ? error.message : "Не удалось удалить изображение.");
    }
  }

  async function handleDeleteServiceImage(line: TaskServiceLine, image: CatalogImage) {
    const ok = await confirm({
      message: "Удалить это фото услуги? Оно пропадёт во всех задачах.",
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    setLineError("");
    try {
      await deleteServiceImage(line.service_id, image.id);
      invalidateTask();
    } catch (error) {
      setLineError(error instanceof Error ? error.message : "Не удалось удалить изображение.");
    }
  }

  if (!validId) return <p className="message error">Некорректный идентификатор задачи.</p>;
  if (taskQuery.isLoading) return <LoadingState message="Загрузка задачи…" />;
  if (!task) return <p className="message error">Задача не найдена.</p>;

  const totals = task.totals || { cost_uzs: 0, cost_usd: 0, price_uzs: 0, price_usd: 0 };
  const devices = task.devices || [];
  const services = task.services || [];
  const inTask = new Set([
    ...devices.map((line) => `device:${line.device_id}`),
    ...services.map((line) => `service:${line.service_id}`),
  ]);
  const catalogLoading = devicesQuery.isPending || servicesQuery.isPending;
  const showDeviceCats = kindFilter !== "service";
  const showServiceCats = kindFilter !== "device";
  const uncategorizedDevices = countProducts("device", "device:none");
  const uncategorizedServices = countProducts("service", "service:none");

  function renderCategoryGroup(
    title: string,
    kind: CatalogKind,
    categories: CatalogCategory[],
    uncategorizedCount: number,
  ) {
    if (!categories.length && !uncategorizedCount) return null;
    return (
      <div className="task-catalog__group">
        {kindFilter === "all" ? <h3>{title}</h3> : null}
        {categories.map((category) => {
          const key = `${kind}:${category.id}` as CategoryKey;
          return (
            <CategoryNavButton
              key={key}
              label={category.name}
              count={countProducts(kind, key)}
              active={categoryKey === key}
              onClick={() => setCategoryKey(key)}
            />
          );
        })}
        {uncategorizedCount ? (
          <CategoryNavButton
            label="Без категории"
            count={uncategorizedCount}
            active={categoryKey === `${kind}:none`}
            onClick={() => setCategoryKey(`${kind}:none`)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="page page--task-detail">
      <div className="ticket-detail-header">
        <div className="ticket-detail-header__title-row">
          <Link to="/tasks" className="ticket-detail-header__back" aria-label="К списку задач" title="К списку задач">
            <ArrowLeft size={18} aria-hidden="true" />
          </Link>
          <h1>{task.title}</h1>
          {canEdit ? (
            <button type="button" className="btn-secondary btn-sm" onClick={() => setEditOpen(true)}>
              Изменить
            </button>
          ) : null}
        </div>
      </div>

      {isMobile ? (
        <div className="task-view-tabs role-tabs" role="tablist" aria-label="Разделы задачи">
          <button
            type="button"
            className={`role-tab${mobileView === "catalog" ? " role-tab--active" : ""}`}
            role="tab"
            aria-selected={mobileView === "catalog"}
            onClick={() => setMobileView("catalog")}
          >
            Каталог
          </button>
          <button
            type="button"
            className={`role-tab${mobileView === "task" ? " role-tab--active" : ""}`}
            role="tab"
            aria-selected={mobileView === "task"}
            onClick={() => setMobileView("task")}
          >
            Задача
          </button>
        </div>
      ) : null}

      {lineError ? <p className="message error">{lineError}</p> : null}

      <div className="task-workspace">
        <section
          className={`card task-workspace__panel task-workspace__panel--catalog${
            isMobile && mobileView !== "catalog" ? " task-workspace__panel--hidden" : ""
          }`}
        >
          <div className="task-catalog__toolbar">
            <div className="role-tabs" role="tablist" aria-label="Тип товара">
              <button
                type="button"
                className={`role-tab${kindFilter === "all" ? " role-tab--active" : ""}`}
                onClick={() => selectKind("all")}
              >
                Все
              </button>
              <button
                type="button"
                className={`role-tab${kindFilter === "device" ? " role-tab--active" : ""}`}
                onClick={() => selectKind("device")}
              >
                Устройства
              </button>
              <button
                type="button"
                className={`role-tab${kindFilter === "service" ? " role-tab--active" : ""}`}
                onClick={() => selectKind("service")}
              >
                Услуги
              </button>
            </div>
            <SearchField
              value={productQuery}
              onChange={setProductQuery}
              placeholder="Поиск товара…"
              className="task-catalog__search"
            />
          </div>

          <div className="task-catalog">
            <nav className="task-catalog__nav" aria-label="Категории">
              <CategoryNavButton
                label="Все"
                count={countProducts(kindFilter === "all" ? undefined : kindFilter)}
                active={categoryKey === "all"}
                onClick={() => setCategoryKey("all")}
              />
              {showDeviceCats
                ? renderCategoryGroup("Устройства", "device", deviceCategories, uncategorizedDevices)
                : null}
              {showServiceCats
                ? renderCategoryGroup("Услуги", "service", serviceCategories, uncategorizedServices)
                : null}
            </nav>

            <div className="task-catalog__grid-wrap">
              {catalogLoading ? (
                <LoadingState message="Загрузка каталога…" />
              ) : !filteredProducts.length ? (
                <p className="empty-state">
                  {products.length
                    ? "Ничего не найдено. Измените категорию или поиск."
                    : "Сначала добавьте устройства и услуги в каталог."}
                </p>
              ) : (
                <ul className="task-shop-grid">
                  {filteredProducts.map((product) => {
                    const price = catalogPriceLines(product, rate);
                    const added = inTask.has(productKey(product));
                    const busyDeviceInstall = addingKey === `${productKey(product)}:install`;
                    const busyDeviceRepair = addingKey === `${productKey(product)}:repair`;
                    const busyService = addingKey === productKey(product);
                    return (
                      <li key={productKey(product)} className="task-shop-card">
                        <CatalogThumb images={product.images} alt={product.name} />
                        <div className="task-shop-card__body">
                          <div className="task-shop-card__meta">
                            <span className="task-product-card__badge">
                              {product.kind === "device" ? "Устройство" : "Услуга"}
                            </span>
                            {product.category?.name ? (
                              <span className="task-shop-card__category">{product.category.name}</span>
                            ) : null}
                            {added ? <span className="task-shop-card__in-cart">В задаче</span> : null}
                          </div>
                          <h3>{product.name}</h3>
                          {product.description ? (
                            <p className="task-product-card__description">{product.description}</p>
                          ) : null}
                          <div className="task-product-card__price">
                            <MoneyCell primary={price.primary} muted={price.muted} />
                          </div>
                          {canEdit ? (
                            product.kind === "device" ? (
                              <div className="task-shop-card__actions">
                                <button
                                  type="button"
                                  className="btn-primary btn-sm"
                                  disabled={addDeviceMutation.isPending}
                                  onClick={() => handleAddProduct(product, "install")}
                                >
                                  {busyDeviceInstall ? "…" : "Установка"}
                                </button>
                                <button
                                  type="button"
                                  className="btn-secondary btn-sm"
                                  disabled={addDeviceMutation.isPending}
                                  onClick={() => handleAddProduct(product, "repair")}
                                >
                                  {busyDeviceRepair ? "…" : "Ремонт"}
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="btn-primary btn-sm"
                                disabled={addServiceMutation.isPending}
                                onClick={() => handleAddProduct(product)}
                              >
                                {busyService ? "Добавление…" : "Добавить"}
                              </button>
                            )
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </section>

        <div
          className={`task-workspace__side${
            isMobile && mobileView !== "task" ? " task-workspace__panel--hidden" : ""
          }`}
        >
          <section className="card">
            <h2 className="task-detail-section-title">Задача</h2>
            <dl className="task-detail-meta">
              <DetailRow label="Статус">{task.status_label || task.status}</DetailRow>
              <DetailRow label="Категория">{task.category?.name || "—"}</DetailRow>
              <DetailRow label="Клиент">{clientLabel(task)}</DetailRow>
              <DetailRow label="Адрес">{textOrDash(task.address)}</DetailRow>
              <DetailRow label="Менеджер">{task.manager?.name || "—"}</DetailRow>
              <DetailRow label="Техник">{task.technician?.name || "—"}</DetailRow>
              <DetailRow label="Заметки">{textOrDash(task.notes)}</DetailRow>
              <DetailRow label="Обновлено">{formatDateTime(task.updated_at)}</DetailRow>
            </dl>
          </section>

          <section className="card">
            <h2 className="task-detail-section-title">Корзина</h2>
            {!devices.length && !services.length ? (
              <p className="empty-state">Добавьте товары из каталога.</p>
            ) : (
              <ul className="task-cart-list">
                {devices.map((line) => {
                  const price = catalogPriceLines(line, rate);
                  return (
                    <li key={`device-${line.id}`} className="task-product-card task-product-card--cart">
                      <CatalogImageGallery
                        images={line.images}
                        alt={line.device_name || `Устройство #${line.device_id}`}
                        canEdit={canEdit}
                        uploading={uploadingKey === `device-${line.device_id}`}
                        onUpload={(files) => void handleUploadDevice(line, files)}
                        onDelete={(image) => void handleDeleteDeviceImage(line, image)}
                      />
                      <div className="task-product-card__body">
                        <div className="task-product-card__title-row">
                          <h3>{line.device_name || `Устройство #${line.device_id}`}</h3>
                          <span className="task-product-card__badge">{line.action_label || line.action}</span>
                        </div>
                        {line.description ? (
                          <p className="task-product-card__description">{line.description}</p>
                        ) : null}
                        {line.notes ? <p className="muted-copy">{line.notes}</p> : null}
                        <div className="task-product-card__price">
                          <MoneyCell primary={price.primary} muted={price.muted} />
                        </div>
                        {canEdit && line.id ? (
                          <button
                            type="button"
                            className="btn-danger btn-sm"
                            onClick={() => void handleRemoveDevice(line)}
                            disabled={removeDeviceMutation.isPending}
                          >
                            Удалить
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
                {services.map((line) => {
                  const price = catalogPriceLines(line, rate);
                  return (
                    <li key={`service-${line.id}`} className="task-product-card task-product-card--cart">
                      <CatalogImageGallery
                        images={line.images}
                        alt={line.service_name || `Услуга #${line.service_id}`}
                        canEdit={canEdit}
                        uploading={uploadingKey === `service-${line.service_id}`}
                        onUpload={(files) => void handleUploadService(line, files)}
                        onDelete={(image) => void handleDeleteServiceImage(line, image)}
                      />
                      <div className="task-product-card__body">
                        <h3>{line.service_name || `Услуга #${line.service_id}`}</h3>
                        {line.description ? (
                          <p className="task-product-card__description">{line.description}</p>
                        ) : null}
                        {line.notes ? <p className="muted-copy">{line.notes}</p> : null}
                        <div className="task-product-card__price">
                          <MoneyCell primary={price.primary} muted={price.muted} />
                        </div>
                        {canEdit && line.id ? (
                          <button
                            type="button"
                            className="btn-danger btn-sm"
                            onClick={() => void handleRemoveService(line)}
                            disabled={removeServiceMutation.isPending}
                          >
                            Удалить
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="card card--task-totals">
            <h2 className="task-detail-section-title">Итого</h2>
            <dl className="task-detail-totals task-detail-totals--price">
              <div>
                <dt>Цена</dt>
                <dd>
                  <MoneyCell
                    primary={formatMoneyLine(totals.price_uzs, "UZS")}
                    muted={formatMoneyLine(totals.price_usd, "USD")}
                  />
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </div>

      <TaskEditorModal
        open={editOpen}
        task={task}
        categories={taskCategories}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          invalidateTask();
        }}
      />
    </div>
  );
}
