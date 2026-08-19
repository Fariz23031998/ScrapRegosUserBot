import { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Pencil, Trash2 } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import {
  createTaskCategory,
  deleteTask,
  deleteTaskCategory,
  listTaskCategories,
  listTaskLocations,
  listTasks,
  advanceTaskStatus,
  updateTaskCategory,
} from "../api/tasks";
import EntityCards from "../components/EntityCards";
import InfiniteScrollSentinel from "../components/InfiniteScrollSentinel";
import ListFiltersChrome from "../components/ListFiltersChrome";
import Modal from "../components/Modal";
import SimpleTable from "../components/SimpleTable";
import TaskEditorModal from "../components/TaskEditorModal";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { usePagedInfiniteQuery } from "../hooks/usePagedInfiniteQuery";
import { useUiPreferences } from "../hooks/useUiPreferences";
import type { FieldTask, TaskCategory, TaskLocation } from "../lib/types";
import { formatDateTime } from "../lib/utils";
import { TASK_STATUSES, nextTaskStatus } from "../lib/task-status";

function taskClientLabel(task: FieldTask): string {
  return (
    task.client_name ||
    task.client_phone ||
    (task.regos_client_id ? `Клиент #${task.regos_client_id}` : "—")
  );
}

function taskDevicesSummary(task: FieldTask): string {
  const names = (task.devices || []).map((line) => line.device_name).filter(Boolean);
  return names.join(", ") || "—";
}

function TaskFilterFields({
  categoryId,
  locationId,
  status,
  categories,
  locations,
  onCategoryChange,
  onLocationChange,
  onStatusChange,
  showActions,
  onApply,
}: {
  categoryId: string;
  locationId: string;
  status: string;
  categories: TaskCategory[];
  locations: TaskLocation[];
  onCategoryChange: (value: string) => void;
  onLocationChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  showActions?: boolean;
  onApply?: () => void;
}) {
  return (
    <>
      <label className="ticket-filters__field">
        <span>Категория</span>
        <select value={categoryId} onChange={(event) => onCategoryChange(event.target.value)}>
          <option value="">Все</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      <label className="ticket-filters__field">
        <span>Филиал</span>
        <select value={locationId} onChange={(event) => onLocationChange(event.target.value)}>
          <option value="">Все</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      </label>
      <label className="ticket-filters__field">
        <span>Статус</span>
        <select value={status} onChange={(event) => onStatusChange(event.target.value)}>
          <option value="">Все</option>
          {TASK_STATUSES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
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

export default function TasksPage() {
  const { hasPermission } = useAuth();
  const { dateTimeFormat } = useUiPreferences();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [status, setStatus] = useState("");
  const [appliedCategoryId, setAppliedCategoryId] = useState("");
  const [appliedLocationId, setAppliedLocationId] = useState("");
  const [appliedStatus, setAppliedStatus] = useState("");
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [categoryEditor, setCategoryEditor] = useState<Partial<TaskCategory> | null>(null);
  const [categoryFormError, setCategoryFormError] = useState("");

  const categoriesQuery = useQuery({
    queryKey: ["task-categories"],
    queryFn: listTaskCategories,
  });
  const locationsQuery = useQuery({
    queryKey: ["task-locations"],
    queryFn: listTaskLocations,
  });

  const tasksQuery = usePagedInfiniteQuery({
    queryKey: ["tasks", search, appliedStatus, appliedCategoryId, appliedLocationId],
    queryFn: (page, pageSize) =>
      listTasks({
        page,
        limit: pageSize,
        q: search || undefined,
        status: appliedStatus || undefined,
        category_id: appliedCategoryId || undefined,
        location_id: appliedLocationId || undefined,
      }),
    getItems: (data) => data.tasks || [],
    getItemId: (task) => task.id,
  });

  const categories = categoriesQuery.data?.categories || [];
  const locations = locationsQuery.data?.locations || [];

  function invalidateTasks() {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    void queryClient.invalidateQueries({ queryKey: ["task-categories"] });
  }

  const deleteMutation = useMutation({
    mutationFn: deleteTask,
    onSuccess: invalidateTasks,
  });

  const advanceStatusMutation = useMutation({
    mutationFn: advanceTaskStatus,
    onSuccess: invalidateTasks,
  });

  const saveCategory = useMutation({
    mutationFn: () => {
      const name = String(categoryEditor?.name || "").trim();
      if (categoryEditor?.id) return updateTaskCategory(categoryEditor.id, { name });
      return createTaskCategory({ name });
    },
    onSuccess: () => {
      setCategoryEditor(null);
      void queryClient.invalidateQueries({ queryKey: ["task-categories"] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error: Error) => setCategoryFormError(error.message),
  });

  const removeCategory = useMutation({
    mutationFn: deleteTaskCategory,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task-categories"] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  function applyFilters() {
    setAppliedCategoryId(categoryId);
    setAppliedLocationId(locationId);
    setAppliedStatus(status);
  }

  async function handleDelete(task: FieldTask) {
    const ok = await confirm({
      message: `Удалить задачу «${task.title}»?`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) deleteMutation.mutate(task.id);
  }

  async function handleDeleteCategory(category: TaskCategory) {
    const ok = await confirm({
      message: `Удалить категорию «${category.name}»? Задачи останутся без категории.`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) removeCategory.mutate(category.id);
  }

  function openDetails(task: FieldTask) {
    navigate(`/tasks/${task.id}`);
  }

  function taskActions(task: FieldTask): ReactNode {
    const nextStatus = nextTaskStatus(task.status);
    return (
      <>
        {hasPermission("tasks_edit") && !task.posted && nextStatus ? (
          <button
            type="button"
            className="btn-secondary btn-icon btn-sm"
            aria-label={nextStatus.label}
            title={nextStatus.label}
            disabled={advanceStatusMutation.isPending}
            onClick={(event) => {
              event.stopPropagation();
              advanceStatusMutation.mutate(task.id);
            }}
          >
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        ) : null}
        {hasPermission("tasks_delete") && !task.posted ? (
          <button
            type="button"
            className="btn-danger btn-icon btn-sm"
            aria-label="Удалить"
            title="Удалить"
            onClick={(event) => {
              event.stopPropagation();
              void handleDelete(task);
            }}
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        ) : null}
      </>
    );
  }

  const columns = useMemo<ColumnDef<FieldTask>[]>(
    () => [
      {
        id: "title",
        header: "Задача",
        cell: ({ row }) => (
          <Link to={`/tasks/${row.original.id}`} onClick={(event) => event.stopPropagation()}>
            {row.original.title}
          </Link>
        ),
      },
      {
        id: "category",
        header: "Категория",
        accessorFn: (row) => row.category?.name || "—",
      },
      {
        id: "location",
        header: "Филиал",
        accessorFn: (row) => row.location?.name || "—",
      },
      {
        id: "client",
        header: "Клиент",
        accessorFn: (row) => taskClientLabel(row),
      },
      {
        id: "manager",
        header: "Менеджер",
        accessorFn: (row) => row.manager?.name || "—",
      },
      {
        id: "technician",
        header: "Техник",
        accessorFn: (row) => row.technician?.name || "—",
      },
      {
        id: "devices",
        header: "Устройства",
        accessorFn: (row) => taskDevicesSummary(row),
      },
      {
        id: "status",
        header: "Статус",
        accessorFn: (row) => row.status_label || row.status,
      },
      {
        id: "action",
        header: "Тип",
        accessorFn: (row) => row.action_label || "—",
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
        cell: ({ row }) => (
          <div className="cell-actions" onClick={(event) => event.stopPropagation()}>
            {taskActions(row.original)}
          </div>
        ),
      },
    ],
    [dateTimeFormat, hasPermission, advanceStatusMutation.isPending],
  );

  const tasks = tasksQuery.items;
  const total = tasksQuery.total;
  const emptyMessage =
    search || appliedStatus || appliedCategoryId || appliedLocationId
      ? "Ничего не найдено. Измените фильтры."
      : "Задач пока нет.";

  return (
    <section className="card">
      <div className="card-toolbar">
        <div className="card-toolbar-right">
          {hasPermission("tasks_edit") ? (
            <button type="button" className="btn-secondary" onClick={() => setCategoryManagerOpen(true)}>
              Категории
            </button>
          ) : null}
          {hasPermission("tasks_create") ? (
            <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
              + Создать
            </button>
          ) : null}
        </div>
      </div>

      <ListFiltersChrome
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Поиск по задаче, клиенту, устройству…"
        filtersActive={Boolean(appliedStatus || appliedCategoryId || appliedLocationId)}
        filtersModalOpen={filtersModalOpen}
        onFiltersModalOpenChange={setFiltersModalOpen}
        onApplyFilters={applyFilters}
        onResetFilters={() => {
          setCategoryId("");
          setLocationId("");
          setStatus("");
        }}
        desktopFilters={
          <TaskFilterFields
            categoryId={categoryId}
            locationId={locationId}
            status={status}
            categories={categories}
            locations={locations}
            onCategoryChange={setCategoryId}
            onLocationChange={setLocationId}
            onStatusChange={setStatus}
            showActions
            onApply={applyFilters}
          />
        }
        sheetFilters={
          <TaskFilterFields
            categoryId={categoryId}
            locationId={locationId}
            status={status}
            categories={categories}
            locations={locations}
            onCategoryChange={setCategoryId}
            onLocationChange={setLocationId}
            onStatusChange={setStatus}
          />
        }
      />

      <div className="ticket-table-section">
        {compact ? (
          <EntityCards
            items={tasks}
            isLoading={tasksQuery.isPending}
            emptyMessage={emptyMessage}
            getKey={(task) => String(task.id)}
            getTitle={(task) => task.title}
            getSubtitle={(task) =>
              [task.action_label, task.status_label, task.location?.name, task.category?.name]
                .filter(Boolean)
                .join(" · ")
            }
            getFields={(task) => [
              { label: "Филиал", value: task.location?.name || "—" },
              { label: "Клиент", value: taskClientLabel(task) },
              { label: "Менеджер", value: task.manager?.name || "—" },
              ...(task.action === "sale"
                ? []
                : [{ label: "Техник", value: task.technician?.name || "—" }]),
              { label: "Устройства", value: taskDevicesSummary(task) },
              { label: "Обновлено", value: formatDateTime(task.updated_at) },
            ]}
            getActions={(task) => taskActions(task)}
            onOpen={openDetails}
          />
        ) : (
          <SimpleTable
            tableKey="bot-admin.tasks"
            data={tasks}
            columns={columns}
            isLoading={tasksQuery.isPending}
            serverSideSearch
            emptyMessage={emptyMessage}
            getRowId={(row) => String(row.id)}
            onRowClick={openDetails}
          />
        )}
        <InfiniteScrollSentinel
          loaded={tasks.length}
          total={total}
          hasNextPage={Boolean(tasksQuery.hasNextPage)}
          isFetchingNextPage={tasksQuery.isFetchingNextPage}
          fetchNextPage={tasksQuery.fetchNextPage}
        />
      </div>

      <TaskEditorModal
        open={createOpen}
        categories={categories}
        onClose={() => setCreateOpen(false)}
        onSaved={(task) => {
          setCreateOpen(false);
          invalidateTasks();
          navigate(`/tasks/${task.id}`);
        }}
      />

      <Modal open={categoryManagerOpen} title="Категории" onClose={() => setCategoryManagerOpen(false)}>
        <div className="knowledge-category-manager">
          {hasPermission("tasks_edit") ? (
            <div className="form-actions">
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => {
                  setCategoryFormError("");
                  setCategoryEditor({ name: "" });
                }}
              >
                Новая категория
              </button>
            </div>
          ) : null}
          {categoriesQuery.isPending ? (
            <p>Загрузка…</p>
          ) : !categories.length ? (
            <p className="empty-state">Категорий нет.</p>
          ) : (
            <ul className="knowledge-category-list">
              {categories.map((category) => (
                <li key={category.id} className="knowledge-category-list__item">
                  <div>
                    <strong>{category.name}</strong>
                  </div>
                  {hasPermission("tasks_edit") ? (
                    <div className="cell-actions">
                      <button
                        type="button"
                        className="btn-secondary btn-icon btn-sm"
                        aria-label="Изменить"
                        title="Изменить"
                        onClick={() => {
                          setCategoryFormError("");
                          setCategoryEditor(category);
                        }}
                      >
                        <Pencil size={15} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn-danger btn-icon btn-sm"
                        aria-label="Удалить"
                        title="Удалить"
                        onClick={() => void handleDeleteCategory(category)}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>

      <Modal
        open={categoryEditor != null}
        title={categoryEditor?.id ? "Редактирование категории" : "Новая категория"}
        onClose={() => setCategoryEditor(null)}
      >
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            setCategoryFormError("");
            saveCategory.mutate();
          }}
        >
          <label>
            Название
            <input
              required
              maxLength={100}
              value={categoryEditor?.name || ""}
              onChange={(event) =>
                setCategoryEditor((prev) => (prev ? { ...prev, name: event.target.value } : prev))
              }
            />
          </label>
          {categoryFormError ? <p className="message error">{categoryFormError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setCategoryEditor(null)}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={saveCategory.isPending}>
              Сохранить
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
