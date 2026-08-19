import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, BadgeCheck, BadgeX, Eye, Minus, Pencil, Plus, Printer, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { listDeviceCategories, listDevices } from "../api/devices";
import { listServiceCategories, listServices } from "../api/services";
import { getExchangeRate } from "../api/settings";
import {
  addTaskDevice,
  addTaskService,
  advanceTaskStatus,
  applyTaskDiscount,
  deleteTaskDevice,
  deleteTaskPayment,
  deleteTaskService,
  getTask,
  listTaskCategories,
  postTask,
  unpostTask,
  updateTaskDevice,
  updateTaskService,
} from "../api/tasks";
import CatalogImageGallery, { CatalogThumb } from "../components/CatalogImageGallery";
import LoadingState from "../components/LoadingState";
import Modal from "../components/Modal";
import { MoneyCell } from "../components/MoneyFields";
import SearchField from "../components/SearchField";
import TaskEditorModal from "../components/TaskEditorModal";
import TaskInvoicePrint from "../components/TaskInvoicePrint";
import TaskPaymentModal from "../components/TaskPaymentModal";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import { useMediaQuery } from "../hooks/useMediaQuery";
import {
  DEFAULT_USD_UZS_RATE,
  cartOperationPriceLines,
  catalogPriceLines,
  formatMoneyLine,
  hasCartDiscount,
  parseDisplayCurrency,
  totalsPriceLines,
  type MoneyCurrency,
} from "../lib/money";
import type {
  CatalogCategory,
  CatalogDevice,
  CatalogImage,
  CatalogService,
  FieldTask,
  TaskDeviceLine,
  TaskPayment,
  TaskServiceLine,
} from "../lib/types";
import { formatDateTime } from "../lib/utils";
import { isTaskCartLocked, nextTaskStatus } from "../lib/task-status";

type CatalogKind = "device" | "service";
type CategoryKey = "all" | `${CatalogKind}:none` | `${CatalogKind}:${number}`;

const MAX_LINE_QUANTITY = 999;

function lineQuantity(value: unknown): number {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty < 1) return 1;
  return Math.min(MAX_LINE_QUANTITY, Math.trunc(qty));
}

function discountLabel(line: { discount_type?: string | null; discount_value?: number | null; discount_currency?: string | null }) {
  if (!line.discount_type || !Number(line.discount_value)) return "";
  if (line.discount_type === "percent") return `−${Number(line.discount_value)}%`;
  const currency = line.discount_currency === "USD" ? "USD" : "UZS";
  return `−${formatMoneyLine(Number(line.discount_value), currency)}`;
}

function cartLineKey(kind: CatalogKind, id?: number) {
  return id ? `${kind}:${id}` : "";
}

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

type MetaChipTone = "neutral" | "muted" | "danger" | "warn" | "ok" | "info";

function taskFullMetaRows(
  task: FieldTask,
  displayCurrency: MoneyCurrency | null,
): { label: string; value: string }[] {
  const rows = [
    { label: "Статус", value: task.status_label || task.status || "—" },
    { label: "Проведение", value: task.posted ? "Проведена" : "Не проведена" },
    { label: "Тип", value: task.action_label || "—" },
    { label: "Валюта", value: displayCurrency || "Обе валюты" },
    { label: "Категория", value: task.category?.name || "—" },
    { label: "Филиал", value: task.location?.name || "—" },
    { label: "Клиент", value: clientLabel(task) },
    { label: "Адрес", value: textOrDash(task.address) },
    { label: "Менеджер", value: task.manager?.name || "—" },
  ];
  if (task.action !== "sale") {
    rows.push({ label: "Техник", value: task.technician?.name || "—" });
  }
  rows.push(
    { label: "Заметки", value: textOrDash(task.notes) },
    { label: "Обновлено", value: formatDateTime(task.updated_at) },
  );
  return rows;
}

function taskSummaryItems(task: FieldTask): { key: string; label?: string; value: string; tone: MetaChipTone }[] {
  const statusTone: MetaChipTone =
    task.status === "done" ? "ok" : task.status === "in_progress" ? "warn" : "muted";
  const items: { key: string; label?: string; value: string; tone: MetaChipTone }[] = [
    { key: "action", value: task.action_label || task.action || "—", tone: "info" },
    { key: "status", value: task.status_label || task.status || "—", tone: statusTone },
    {
      key: "posted",
      value: task.posted ? "Проведена" : "Не проведена",
      tone: task.posted ? "ok" : "muted",
    },
  ];
  const client = clientLabel(task);
  if (client !== "—") items.push({ key: "client", label: "Клиент", value: client, tone: "neutral" });
  if (task.location?.name) {
    items.push({ key: "location", label: "Филиал", value: task.location.name, tone: "neutral" });
  }
  if (task.manager?.name) {
    items.push({ key: "manager", label: "Менеджер", value: task.manager.name, tone: "neutral" });
  }
  if (task.action !== "sale" && task.technician?.name) {
    items.push({ key: "technician", label: "Техник", value: task.technician.name, tone: "neutral" });
  }
  return items;
}

function TaskMetaModal({
  open,
  task,
  displayCurrency,
  onClose,
}: {
  open: boolean;
  task: FieldTask | null;
  displayCurrency: MoneyCurrency | null;
  onClose: () => void;
}) {
  return (
    <Modal open={open} title="Задача" onClose={onClose} closeOnOverlayClick>
      {task ? (
        <dl className="task-detail-meta">
          {taskFullMetaRows(task, displayCurrency).map((row) => (
            <DetailRow key={row.label} label={row.label}>
              {row.value}
            </DetailRow>
          ))}
        </dl>
      ) : null}
    </Modal>
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

function QuantityStepper({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled?: boolean;
  onChange: (quantity: number) => void;
}) {
  const qty = lineQuantity(value);
  const [draft, setDraft] = useState(String(qty));

  useEffect(() => {
    setDraft(String(qty));
  }, [qty]);

  function commit(raw: string) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setDraft(String(qty));
      return;
    }
    const next = Math.min(MAX_LINE_QUANTITY, Math.max(1, Math.trunc(parsed)));
    setDraft(String(next));
    if (next !== qty) onChange(next);
  }

  return (
    <div className="task-qty">
      <button
        type="button"
        className="task-qty__btn"
        aria-label="Уменьшить количество"
        title="Уменьшить"
        disabled={disabled || qty <= 1}
        onClick={() => onChange(qty - 1)}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <input
        className="task-qty__input"
        type="number"
        min={1}
        max={MAX_LINE_QUANTITY}
        inputMode="numeric"
        aria-label="Количество"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(draft);
          }
        }}
      />
      <button
        type="button"
        className="task-qty__btn"
        aria-label="Увеличить количество"
        title="Увеличить"
        disabled={disabled || qty >= MAX_LINE_QUANTITY}
        onClick={() => onChange(qty + 1)}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

function DiscountBar({
  disabled,
  hasSelection,
  lockedCurrency,
  onApplySelected,
  onApplyAll,
  onClear,
}: {
  disabled?: boolean;
  hasSelection: boolean;
  lockedCurrency?: "UZS" | "USD" | null;
  onApplySelected: (payload: { type: "percent" | "amount"; value: number; currency: "UZS" | "USD" }) => void;
  onApplyAll: (payload: { type: "percent" | "amount"; value: number; currency: "UZS" | "USD" }) => void;
  onClear: () => void;
}) {
  const [type, setType] = useState<"percent" | "amount">("percent");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState<"UZS" | "USD">(lockedCurrency || "UZS");

  useEffect(() => {
    if (lockedCurrency) setCurrency(lockedCurrency);
  }, [lockedCurrency]);

  function parsed() {
    const amount = Number(value.replace(",", "."));
    if (!Number.isFinite(amount) || amount < 0) return null;
    if (type === "percent" && amount > 100) return null;
    return { type, value: amount, currency: lockedCurrency || currency };
  }

  return (
    <div className="task-discount">
      <div className="task-discount__row">
        <label>
          Скидка
          <select
            value={type}
            disabled={disabled}
            onChange={(event) => setType(event.target.value === "amount" ? "amount" : "percent")}
          >
            <option value="percent">Процент</option>
            <option value="amount">Сумма</option>
          </select>
        </label>
        <label>
          Значение
          <input
            type="number"
            min={0}
            max={type === "percent" ? 100 : undefined}
            step="any"
            value={value}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
            placeholder={type === "percent" ? "0–100" : "0"}
          />
        </label>
        {type === "amount" && !lockedCurrency ? (
          <label>
            Валюта
            <select
              value={currency}
              disabled={disabled}
              onChange={(event) => setCurrency(event.target.value === "USD" ? "USD" : "UZS")}
            >
              <option value="UZS">UZS</option>
              <option value="USD">USD</option>
            </select>
          </label>
        ) : null}
      </div>
      <div className="task-discount__actions">
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={disabled || !hasSelection || parsed() == null}
          onClick={() => {
            const payload = parsed();
            if (payload) onApplySelected(payload);
          }}
        >
          К выбранным
        </button>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={disabled || parsed() == null}
          onClick={() => {
            const payload = parsed();
            if (payload) onApplyAll(payload);
          }}
        >
          Ко всем
        </button>
        <button type="button" className="btn-secondary btn-sm" disabled={disabled} onClick={onClear}>
          Сбросить
        </button>
      </div>
    </div>
  );
}

function CartLine({
  images,
  alt,
  title,
  badge,
  description,
  notes,
  price,
  originalPrice,
  discountText,
  quantity,
  selected,
  canEdit,
  removing,
  updating,
  onToggleSelected,
  onQuantityChange,
  onRemove,
}: {
  images?: CatalogImage[];
  alt: string;
  title: string;
  badge?: string;
  description?: string;
  notes?: string;
  price: { primary: string; muted?: string };
  originalPrice?: { primary: string; muted?: string } | null;
  discountText?: string;
  quantity: number;
  selected: boolean;
  canEdit: boolean;
  removing: boolean;
  updating: boolean;
  onToggleSelected: () => void;
  onQuantityChange: (quantity: number) => void;
  onRemove: () => void;
}) {
  return (
    <li className={`task-product-card task-product-card--cart${selected ? " is-selected" : ""}`}>
      {canEdit ? (
        <label className="task-cart-line__check">
          <input type="checkbox" checked={selected} onChange={onToggleSelected} />
        </label>
      ) : null}
      <CatalogThumb images={images} alt={alt} />
      <div className="task-product-card__body">
        <div className="task-product-card__title-row">
          <h3>{title}</h3>
          {badge ? <span className="task-product-card__badge">{badge}</span> : null}
        </div>
        {description ? <p className="task-product-card__description">{description}</p> : null}
        {notes ? <p className="muted-copy">{notes}</p> : null}
        <div className="task-product-card__price">
          <span className="task-product-card__total-label">Итого</span>
          {originalPrice ? (
            <MoneyCell primary={originalPrice.primary} muted={originalPrice.muted} className="money-pair--old" />
          ) : null}
          <MoneyCell primary={price.primary} muted={price.muted} />
          {discountText ? <span className="task-product-card__discount">{discountText}</span> : null}
        </div>
      </div>
      {canEdit ? (
        <QuantityStepper value={quantity} disabled={updating || removing} onChange={onQuantityChange} />
      ) : (
        <span className="task-qty-read">{`× ${lineQuantity(quantity)}`}</span>
      )}
      {canEdit ? (
        <button
          type="button"
          className="btn-danger btn-icon btn-sm"
          aria-label="Удалить"
          title="Удалить"
          onClick={onRemove}
          disabled={removing || updating}
        >
          <Trash2 size={16} aria-hidden="true" />
        </button>
      ) : null}
    </li>
  );
}

function ProductPreviewModal({
  product,
  rate,
  displayCurrency,
  onClose,
}: {
  product: CatalogProduct | null;
  rate: number;
  displayCurrency: MoneyCurrency | null;
  onClose: () => void;
}) {
  const price = product ? catalogPriceLines(product, rate, displayCurrency) : { primary: "—", muted: "" };
  return (
    <Modal
      open={Boolean(product)}
      title={product?.name || "Товар"}
      onClose={onClose}
      size="wide"
      className="modal--product-preview"
      closeOnOverlayClick
    >
      {product ? (
        <div className="task-product-preview">
          <CatalogImageGallery images={product.images} alt={product.name} variant="compact" />
          <div className="task-product-preview__body">
            <div className="task-shop-card__meta">
              <span className="task-product-card__badge">
                {product.kind === "device" ? "Устройство" : "Услуга"}
              </span>
              {product.category?.name ? (
                <span className="task-shop-card__category">{product.category.name}</span>
              ) : null}
            </div>
            {product.description ? (
              <p className="task-product-preview__description">{product.description}</p>
            ) : (
              <p className="muted-copy">Нет описания.</p>
            )}
            <div className="task-product-preview__price">
              <span className="task-product-card__total-label">Цена</span>
              <MoneyCell primary={price.primary} muted={price.muted} />
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
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
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [mobileView, setMobileView] = useState<"catalog" | "task">("catalog");
  const [categoryKey, setCategoryKey] = useState<CategoryKey>("all");
  const [productQuery, setProductQuery] = useState("");
  const [lineError, setLineError] = useState("");
  const [addingKey, setAddingKey] = useState("");
  const [updatingLineKey, setUpdatingLineKey] = useState("");
  const [selectedLineKeys, setSelectedLineKeys] = useState<string[]>([]);
  const [viewingProduct, setViewingProduct] = useState<CatalogProduct | null>(null);
  const [taskMetaOpen, setTaskMetaOpen] = useState(false);

  const canEdit = hasPermission("tasks_edit");
  const canTakePayment = hasPermission("tasks_payment_create");
  const canDeletePayment = hasPermission("tasks_payment_delete");
  const canPost = hasPermission("tasks_post");
  const canUnpost = hasPermission("tasks_unpost");
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
  const cartLocked = isTaskCartLocked(task);
  const canEditCart = canEdit && !cartLocked;
  const displayCurrency = parseDisplayCurrency(task?.currency);
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
  const inTaskQty = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of task?.devices || []) {
      const key = `device:${line.device_id}`;
      map.set(key, (map.get(key) || 0) + lineQuantity(line.quantity));
    }
    for (const line of task?.services || []) {
      const key = `service:${line.service_id}`;
      map.set(key, (map.get(key) || 0) + lineQuantity(line.quantity));
    }
    return map;
  }, [task]);

  const filteredProducts = useMemo(() => {
    const needle = productQuery.trim().toLowerCase();
    return products.filter((product) => {
      if (!matchesCategory(product, categoryKey)) return false;
      if (!needle) return true;
      return (
        product.name.toLowerCase().includes(needle) ||
        (product.description || "").toLowerCase().includes(needle) ||
        (product.category?.name || "").toLowerCase().includes(needle)
      );
    });
  }, [products, categoryKey, productQuery]);

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

  const addDeviceMutation = useMutation({
    mutationFn: (payload: { device_id: number; action?: "install" | "repair" | "sale" }) =>
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

  const updateDeviceMutation = useMutation({
    mutationFn: (payload: { lineId: number; quantity: number }) =>
      updateTaskDevice(taskId, payload.lineId, { quantity: payload.quantity }),
    onSuccess: () => {
      setLineError("");
      setUpdatingLineKey("");
      invalidateTask();
    },
    onError: (error: Error) => {
      setUpdatingLineKey("");
      setLineError(error.message);
    },
  });

  const updateServiceMutation = useMutation({
    mutationFn: (payload: { lineId: number; quantity: number }) =>
      updateTaskService(taskId, payload.lineId, { quantity: payload.quantity }),
    onSuccess: () => {
      setLineError("");
      setUpdatingLineKey("");
      invalidateTask();
    },
    onError: (error: Error) => {
      setUpdatingLineKey("");
      setLineError(error.message);
    },
  });

  const discountMutation = useMutation({
    mutationFn: (payload: {
      scope?: "all" | "selected";
      lines?: Array<{ kind: "device" | "service"; id: number }>;
      type?: "percent" | "amount" | "none";
      value?: number;
      currency?: "UZS" | "USD";
      clear?: boolean;
    }) => applyTaskDiscount(taskId, payload),
    onSuccess: () => {
      setLineError("");
      invalidateTask();
    },
    onError: (error: Error) => setLineError(error.message),
  });

  const removePaymentMutation = useMutation({
    mutationFn: (paymentId: number) => deleteTaskPayment(taskId, paymentId),
    onSuccess: () => {
      setLineError("");
      invalidateTask();
    },
    onError: (error: Error) => setLineError(error.message),
  });

  const postMutation = useMutation({
    mutationFn: () => postTask(taskId),
    onSuccess: () => {
      setLineError("");
      invalidateTask();
    },
    onError: (error: Error) => setLineError(error.message),
  });

  const unpostMutation = useMutation({
    mutationFn: (deleteRefunds?: boolean) => unpostTask(taskId, { deleteRefunds }),
    onSuccess: () => {
      setLineError("");
      invalidateTask();
    },
    onError: (error: Error) => setLineError(error.message),
  });

  const advanceStatusMutation = useMutation({
    mutationFn: () => advanceTaskStatus(taskId),
    onSuccess: () => {
      setLineError("");
      invalidateTask();
    },
    onError: (error: Error) => setLineError(error.message),
  });

  async function handleRemovePayment(payment: TaskPayment) {
    const ok = await confirm({
      message: `Удалить оплату «${payment.payment_type_name}» на ${formatMoneyLine(
        payment.amount,
        payment.currency,
      )}?`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) removePaymentMutation.mutate(payment.id);
  }

  async function handleTogglePosted() {
    if (!taskQuery.data?.task) return;
    if (taskQuery.data.task.posted) {
      const hasRefunds = (taskQuery.data.task.refunds || []).length > 0;
      const ok = await confirm({
        title: "Отменить проведение",
        message: hasRefunds
          ? "Отменить проведение задачи? Все возвраты будут удалены вместе с позициями (услуги и устройства) и связанными оплатами. После этого документ снова можно будет менять."
          : "Отменить проведение задачи? После этого документ снова можно будет менять.",
        variant: hasRefunds ? "danger" : "default",
        confirmLabel: "Отменить проведение",
      });
      if (ok) unpostMutation.mutate(hasRefunds);
      return;
    }
    postMutation.mutate();
  }

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

  function handleAddProduct(product: CatalogProduct) {
    if (!canEditCart || addingKey || updatingLineKey) return;
    const currentQty = inTaskQty.get(productKey(product)) || 0;
    if (currentQty >= MAX_LINE_QUANTITY) return;
    if (product.kind === "device") {
      const action = task?.action || "install";
      setAddingKey(productKey(product));
      addDeviceMutation.mutate({ device_id: product.id, action });
      return;
    }
    setAddingKey(productKey(product));
    addServiceMutation.mutate(product.id);
  }

  function handleDeviceQuantity(line: TaskDeviceLine, quantity: number) {
    if (!line.id || updatingLineKey) return;
    setUpdatingLineKey(`device:${line.id}`);
    updateDeviceMutation.mutate({ lineId: line.id, quantity });
  }

  function handleServiceQuantity(line: TaskServiceLine, quantity: number) {
    if (!line.id || updatingLineKey) return;
    setUpdatingLineKey(`service:${line.id}`);
    updateServiceMutation.mutate({ lineId: line.id, quantity });
  }

  function toggleLineSelected(key: string) {
    setSelectedLineKeys((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  }

  function applyDiscount(
    scope: "all" | "selected",
    payload: { type: "percent" | "amount"; value: number; currency: "UZS" | "USD" },
  ) {
    const lines =
      scope === "selected"
        ? selectedLineKeys
            .map((key) => {
              const [kind, rawId] = key.split(":");
              const id = Number(rawId);
              if ((kind !== "device" && kind !== "service") || !Number.isFinite(id)) return null;
              return { kind, id };
            })
            .filter((item): item is { kind: "device" | "service"; id: number } => Boolean(item))
        : undefined;
    if (scope === "selected" && !lines?.length) {
      setLineError("Выберите позиции для скидки.");
      return;
    }
    discountMutation.mutate({
      scope,
      lines,
      type: payload.type,
      value: payload.value,
      currency: payload.currency,
    });
  }

  if (!validId) return <p className="message error">Некорректный идентификатор задачи.</p>;
  if (taskQuery.isLoading) return <LoadingState message="Загрузка задачи…" />;
  if (!task) return <p className="message error">Задача не найдена.</p>;

  const totals = task.totals || {
    cost_uzs: 0,
    cost_usd: 0,
    price_uzs: 0,
    price_usd: 0,
    price_without_discount_uzs: 0,
    price_without_discount_usd: 0,
  };
  const devices = task.devices || [];
  const services = task.services || [];
  const payments = (task.payments || []).filter((payment) => payment.kind !== "refund");
  const paymentTotals = task.payment_totals || { paid_uzs: 0, paid_usd: 0, due_uzs: 0, due_usd: 0 };
  const overpaid = Number(paymentTotals.due_uzs) < -0.0001;
  const hasCartLines = devices.length > 0 || services.length > 0;
  const showRefund = canEdit && task.status === "done" && Boolean(task.posted) && hasCartLines;
  const nextStatus = nextTaskStatus(task.status);
  const postingBusy = postMutation.isPending || unpostMutation.isPending;
  const cartLineKeys = [
    ...devices.map((line) => cartLineKey("device", line.id)),
    ...services.map((line) => cartLineKey("service", line.id)),
  ].filter(Boolean);
  const activeSelectedKeys = selectedLineKeys.filter((key) => cartLineKeys.includes(key));
  const totalsHaveDiscount =
    Number(totals.price_without_discount_uzs) > 0 &&
    Number(totals.price_uzs) < Number(totals.price_without_discount_uzs) - 0.0001;
  const catalogLoading = devicesQuery.isPending || servicesQuery.isPending;
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
        <h3>{title}</h3>
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
          <div className="ticket-detail-header__heading">
            <h1>{task.title}</h1>
            {canEdit && !task.posted ? (
              <button
                type="button"
                className="btn-secondary btn-sm ticket-detail-header__edit"
                onClick={() => setEditOpen(true)}
              >
                <Pencil size={14} aria-hidden="true" />
                Изменить
              </button>
            ) : null}
            {canEdit && !task.posted && nextStatus ? (
              <button
                type="button"
                className="btn-success btn-sm ticket-detail-header__edit"
                aria-label={nextStatus.label}
                title={nextStatus.label}
                disabled={advanceStatusMutation.isPending}
                onClick={() => advanceStatusMutation.mutate()}
              >
                <ArrowRight size={18} aria-hidden="true" />
                {nextStatus.label}
              </button>
            ) : null}
            {!task.posted && canPost ? (
              <button
                type="button"
                className="btn-success btn-icon ticket-detail-header__edit"
                aria-label="Провести"
                title="Провести"
                disabled={postingBusy}
                onClick={() => void handleTogglePosted()}
              >
                <BadgeCheck size={22} aria-hidden="true" />
              </button>
            ) : null}
            {task.posted && canUnpost ? (
              <button
                type="button"
                className="btn-danger btn-icon ticket-detail-header__edit"
                aria-label="Отменить проведение"
                title="Отменить проведение"
                disabled={postingBusy}
                onClick={() => void handleTogglePosted()}
              >
                <BadgeX size={22} aria-hidden="true" />
              </button>
            ) : null}
            {showRefund ? (
              <Link
                to={`/tasks/${taskId}/refund`}
                className="btn-secondary btn-sm ticket-detail-header__edit"
              >
                <RotateCcw size={14} aria-hidden="true" />
                Возврат
              </Link>
            ) : null}
            <button
              type="button"
              className="btn-secondary btn-sm ticket-detail-header__edit"
              aria-label="Печать"
              title="Печать"
              onClick={() => window.print()}
            >
              <Printer size={14} aria-hidden="true" />
              Печать
            </button>
          </div>
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
            <SearchField
              value={productQuery}
              onChange={setProductQuery}
              placeholder="Поиск товара…"
              className="task-catalog__search"
            />
            {canEditCart ? (
              <p className="muted-copy task-catalog__hint">
                Нажмите на товар, чтобы добавить в задачу
                {task.action_label ? ` (${task.action_label})` : ""}. Повторное нажатие увеличит количество.
              </p>
            ) : canEdit && cartLocked ? (
              <p className="muted-copy task-catalog__hint">
                Задача проведена: изменения недоступны. Сначала отмените проведение.
              </p>
            ) : null}
          </div>

          <div className="task-catalog">
            <nav className="task-catalog__nav" aria-label="Категории">
              <CategoryNavButton
                label="Все"
                count={countProducts()}
                active={categoryKey === "all"}
                onClick={() => setCategoryKey("all")}
              />
              {renderCategoryGroup("Устройства", "device", deviceCategories, uncategorizedDevices)}
              {renderCategoryGroup("Услуги", "service", serviceCategories, uncategorizedServices)}
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
                    const price = catalogPriceLines(product, rate, displayCurrency);
                    const addedQty = inTaskQty.get(productKey(product)) || 0;
                    const added = addedQty > 0;
                    const busy = addingKey === productKey(product);
                    const atMax = addedQty >= MAX_LINE_QUANTITY;
                    const cardBody = (
                      <>
                        <CatalogThumb images={product.images} alt={product.name} />
                        <div className="task-shop-card__body">
                          <div className="task-shop-card__meta">
                            <span className="task-product-card__badge">
                              {product.kind === "device" ? "Устройство" : "Услуга"}
                            </span>
                            {product.category?.name ? (
                              <span className="task-shop-card__category">{product.category.name}</span>
                            ) : null}
                            {added ? (
                              <span className="task-shop-card__in-cart">
                                {addedQty > 1 ? `В задаче · ${addedQty}` : "В задаче"}
                              </span>
                            ) : null}
                            {busy ? <span className="task-shop-card__in-cart">Добавление…</span> : null}
                          </div>
                          <h3>{product.name}</h3>
                          {product.description ? (
                            <p className="task-product-card__description">{product.description}</p>
                          ) : null}
                          <div className="task-product-card__price">
                            <MoneyCell primary={price.primary} muted={price.muted} />
                          </div>
                        </div>
                      </>
                    );
                    return (
                      <li key={productKey(product)} className={`task-shop-card${added ? " is-added" : ""}`}>
                        <button
                          type="button"
                          className="btn-icon task-shop-card__view"
                          aria-label="Подробнее"
                          title="Подробнее"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setViewingProduct(product);
                          }}
                        >
                          <Eye size={22} aria-hidden="true" />
                        </button>
                        {canEditCart ? (
                          <button
                            type="button"
                            className="task-shop-card__hit"
                            disabled={atMax || Boolean(addingKey) || Boolean(updatingLineKey)}
                            onClick={() => handleAddProduct(product)}
                          >
                            {cardBody}
                          </button>
                        ) : (
                          cardBody
                        )}
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
          <section className="card card--task-compact">
            <div className="task-detail-section-head">
              <h2 className="task-detail-section-title">Задача</h2>
              <button
                type="button"
                className="btn-secondary btn-icon btn-sm"
                aria-label="Полная информация"
                title="Полная информация"
                onClick={() => setTaskMetaOpen(true)}
              >
                <Eye size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="task-meta-summary">
              {taskSummaryItems(task).map((item) => (
                <span key={item.key} className={`summary-chip summary-chip--${item.tone}`}>
                  {item.label ? (
                    <>
                      {item.label}: <strong className="summary-chip__value">{item.value}</strong>
                    </>
                  ) : (
                    <strong className="summary-chip__value">{item.value}</strong>
                  )}
                </span>
              ))}
            </div>
          </section>

          <section className="card">
            <h2 className="task-detail-section-title">Корзина</h2>
            {!devices.length && !services.length ? (
              <p className="empty-state">Добавьте товары из каталога.</p>
            ) : (
              <>
                {canEditCart ? (
                  <DiscountBar
                    disabled={discountMutation.isPending}
                    hasSelection={activeSelectedKeys.length > 0}
                    lockedCurrency={displayCurrency}
                    onApplySelected={(payload) => applyDiscount("selected", payload)}
                    onApplyAll={(payload) => applyDiscount("all", payload)}
                    onClear={() => discountMutation.mutate({ scope: "all", clear: true })}
                  />
                ) : null}
                <ul className="task-cart-list">
                  {devices.map((line) => {
                    const lineKey = cartLineKey("device", line.id);
                    const discounted = hasCartDiscount(line);
                    const title = line.device_name || `Устройство #${line.device_id}`;
                    return (
                      <CartLine
                        key={lineKey}
                        images={line.images}
                        alt={title}
                        title={title}
                        badge={line.action_label || line.action}
                        description={line.description}
                        notes={line.notes}
                        price={cartOperationPriceLines(line, rate, "price", displayCurrency)}
                        originalPrice={discounted ? cartOperationPriceLines(line, rate, "price_without_discount", displayCurrency) : null}
                        discountText={discountLabel(line)}
                        quantity={lineQuantity(line.quantity)}
                        selected={activeSelectedKeys.includes(lineKey)}
                        canEdit={Boolean(canEditCart && line.id)}
                        removing={removeDeviceMutation.isPending}
                        updating={updatingLineKey === lineKey}
                        onToggleSelected={() => toggleLineSelected(lineKey)}
                        onQuantityChange={(quantity) => handleDeviceQuantity(line, quantity)}
                        onRemove={() => void handleRemoveDevice(line)}
                      />
                    );
                  })}
                  {services.map((line) => {
                    const lineKey = cartLineKey("service", line.id);
                    const discounted = hasCartDiscount(line);
                    const title = line.service_name || `Услуга #${line.service_id}`;
                    return (
                      <CartLine
                        key={lineKey}
                        images={line.images}
                        alt={title}
                        title={title}
                        description={line.description}
                        notes={line.notes}
                        price={cartOperationPriceLines(line, rate, "price", displayCurrency)}
                        originalPrice={discounted ? cartOperationPriceLines(line, rate, "price_without_discount", displayCurrency) : null}
                        discountText={discountLabel(line)}
                        quantity={lineQuantity(line.quantity)}
                        selected={activeSelectedKeys.includes(lineKey)}
                        canEdit={Boolean(canEditCart && line.id)}
                        removing={removeServiceMutation.isPending}
                        updating={updatingLineKey === lineKey}
                        onToggleSelected={() => toggleLineSelected(lineKey)}
                        onQuantityChange={(quantity) => handleServiceQuantity(line, quantity)}
                        onRemove={() => void handleRemoveService(line)}
                      />
                    );
                  })}
                </ul>
              </>
            )}
          </section>

          <section className="card">
            <div className="task-payments-head">
              <h2 className="task-detail-section-title">Оплаты</h2>
              {canTakePayment ? (
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={() => setPaymentOpen(true)}
                >
                  Принять оплату
                </button>
              ) : null}
            </div>
            {!payments.length ? (
              <p className="empty-state">Оплаты не приняты.</p>
            ) : (
              <ul className="task-payment-list">
                {payments.map((payment) => {
                  const isRefund = payment.kind === "refund";
                  return (
                  <li
                    key={payment.id}
                    className={`task-payment-list__item${isRefund ? " task-payment-list__item--refund" : ""}`}
                  >
                    <div className="task-payment-list__body">
                      <strong>
                        {isRefund ? "Возврат · " : ""}
                        {payment.payment_type_name}
                      </strong>
                      <small>
                        {[formatDateTime(payment.created_at), payment.created_by?.name]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                      {payment.note ? <small>{payment.note}</small> : null}
                    </div>
                    <div className="task-payment-list__money">
                      {isRefund ? "−" : ""}
                      {formatMoneyLine(payment.amount, payment.currency)}
                    </div>
                    {canDeletePayment ? (
                      <button
                        type="button"
                        className="btn-danger btn-icon btn-sm"
                        aria-label="Удалить оплату"
                        disabled={removePaymentMutation.isPending}
                        onClick={() => void handleRemovePayment(payment)}
                      >
                        <Trash2 size={16} />
                      </button>
                    ) : null}
                  </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="card card--task-compact card--task-totals">
            <h2 className="task-detail-section-title">Итого</h2>
            <dl className="task-detail-meta task-detail-meta--totals">
              {totalsHaveDiscount ? (
                <DetailRow label="Без скидки">
                  <MoneyCell
                    {...totalsPriceLines(
                      totals.price_without_discount_uzs,
                      totals.price_without_discount_usd,
                      displayCurrency,
                    )}
                    className="money-pair--old"
                  />
                </DetailRow>
              ) : null}
              <DetailRow label="Цена">
                <MoneyCell
                  {...totalsPriceLines(totals.price_uzs, totals.price_usd, displayCurrency)}
                />
              </DetailRow>
              <DetailRow label="Оплачено">
                <MoneyCell
                  {...totalsPriceLines(
                    paymentTotals.paid_uzs,
                    paymentTotals.paid_usd,
                    displayCurrency,
                  )}
                />
              </DetailRow>
              <DetailRow label={overpaid ? "Переплата" : "Остаток"}>
                <MoneyCell
                  {...totalsPriceLines(
                    overpaid ? -paymentTotals.due_uzs : paymentTotals.due_uzs,
                    overpaid ? -paymentTotals.due_usd : paymentTotals.due_usd,
                    displayCurrency,
                  )}
                />
              </DetailRow>
            </dl>
          </section>
        </div>
      </div>

      <TaskMetaModal
        open={taskMetaOpen}
        task={task}
        displayCurrency={displayCurrency}
        onClose={() => setTaskMetaOpen(false)}
      />

      <ProductPreviewModal
        product={viewingProduct}
        rate={rate}
        displayCurrency={displayCurrency}
        onClose={() => setViewingProduct(null)}
      />

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

      <TaskPaymentModal
        open={paymentOpen}
        task={task}
        onClose={() => setPaymentOpen(false)}
        onSaved={() => {
          setPaymentOpen(false);
          invalidateTask();
        }}
      />

      <TaskInvoicePrint task={task} rate={rate} displayCurrency={displayCurrency} />
    </div>
  );
}
