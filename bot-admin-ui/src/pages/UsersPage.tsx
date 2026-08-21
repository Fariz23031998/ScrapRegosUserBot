import { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2, UserPlus } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  createUser,
  deleteUser,
  getRightsMeta,
  listRegosUsers,
  listUsers,
  promoteUser,
  regosAutoLink,
  updateUser,
} from "../api/admin";
import EntityCards from "../components/EntityCards";
import InfiniteScrollSentinel from "../components/InfiniteScrollSentinel";
import ListFiltersChrome from "../components/ListFiltersChrome";
import Modal from "../components/Modal";
import SimpleTable from "../components/SimpleTable";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { usePagedInfiniteQuery } from "../hooks/usePagedInfiniteQuery";
import { useUiPreferences } from "../hooks/useUiPreferences";
import type { BotUser, RegosUser, RightMeta } from "../lib/types";
import { formatDateTime, phonesEqual } from "../lib/utils";

type ModalMode = "create" | "edit" | "promote" | null;

function collectRegosPhones(user: RegosUser): string[] {
  const values = [user.main_phone, user.phones];
  const phones: string[] = [];
  for (const value of values) {
    if (!value) continue;
    for (const part of String(value).split(/[,;|/]+/)) {
      const trimmed = part.trim();
      if (trimmed) phones.push(trimmed);
    }
  }
  return phones;
}

function formatRegosLabel(user: RegosUser): string {
  const name = user.full_name || [user.last_name, user.first_name].filter(Boolean).join(" ");
  const parts = [name, user.login ? `@${user.login}` : "", user.main_phone || ""]
    .map((p) => String(p || "").trim())
    .filter(Boolean);
  return parts.join(" · ") || `ID ${user.id}`;
}

export default function UsersPage() {
  const { hasPermission } = useAuth();
  const { dateTimeFormat } = useUiPreferences();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const [role, setRole] = useState<"employee" | "customer">("employee");
  const [search, setSearch] = useState("");
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [selectedUser, setSelectedUser] = useState<BotUser | null>(null);
  const [regosUserId, setRegosUserId] = useState("");
  const [modalError, setModalError] = useState("");

  const rightsQuery = useQuery({ queryKey: ["rights-meta"], queryFn: getRightsMeta });
  const regosQuery = useQuery({ queryKey: ["regos-users"], queryFn: listRegosUsers, enabled: modalMode != null });
  const usersQuery = usePagedInfiniteQuery({
    queryKey: ["users", role, search],
    queryFn: (page, pageSize) => listUsers({ role, page, limit: pageSize, q: search || undefined }),
    getItems: (data) => data.users || [],
    getItemId: (user) => user.id,
  });

  const rightsMeta = rightsQuery.data?.rights || [];

  const autoLinkMutation = useMutation({
    mutationFn: regosAutoLink,
    onSuccess: (result) => {
      const s = result as { summary?: Record<string, number> };
      const summary = s.summary || {};
      window.alert(
        `Готово.\nСопоставлено: ${summary.matched || 0}\nУже связаны: ${summary.already_linked || 0}\nНе найдено: ${summary.none || 0}\nНеоднозначно: ${summary.ambiguous || 0}`,
      );
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (payload: { mode: ModalMode; body: Record<string, unknown>; userId?: number }) => {
      if (payload.mode === "create") return createUser(payload.body);
      if (payload.mode === "promote" && payload.userId) return promoteUser(payload.userId, payload.body);
      if (payload.mode === "edit" && payload.userId) return updateUser(payload.userId, payload.body);
      throw new Error("Invalid mode");
    },
    onSuccess: () => {
      setModalMode(null);
      setSelectedUser(null);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (error: Error) => setModalError(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["users"] }),
  });

  const employeeColumns = useMemo<ColumnDef<BotUser>[]>(
    () => [
      { id: "id", header: "ID", accessorKey: "id" },
      { id: "phone", header: "Телефон", accessorKey: "phone", cell: ({ getValue }) => getValue() || "—" },
      {
        id: "name",
        header: "Имя",
        cell: ({ row }) => {
          const u = row.original;
          const tg = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
          const admin = String(u.display_name || "").trim();
          if (admin && tg) return (
            <span>
              <strong>{admin}</strong>
              <br />
              <small>{tg}</small>
            </span>
          );
          return admin || tg || (u.username ? `@${u.username}` : "—");
        },
      },
      { id: "login", header: "Логин", accessorKey: "admin_login", cell: ({ getValue }) => getValue() || "—" },
      { id: "job_title", header: "Должность", accessorKey: "job_title", cell: ({ getValue }) => getValue() || "—" },
      {
        id: "regos",
        header: "REGOS",
        cell: ({ row }) =>
          row.original.regos_user_id ? (
            <span className="status-linked">
              {row.original.regos_full_name || row.original.regos_login || `ID ${row.original.regos_user_id}`}
            </span>
          ) : (
            "Не связан"
          ),
      },
      {
        id: "telegram",
        header: "Telegram",
        cell: ({ row }) =>
          row.original.telegram_id ? `Привязан · ${row.original.telegram_id}` : "Ожидает привязки",
      },
      {
        id: "rights",
        header: "Права",
        cell: ({ row }) => {
          const active = rightsMeta.filter((r) => row.original.rights?.[r.key]);
          if (!active.length) return "Нет прав";
          if (active.length <= 2) return active.map((r) => r.label).join(", ");
          return `${active.length} права`;
        },
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="cell-actions">
            {hasPermission("users_edit") ? (
              <button
                type="button"
                className="btn-secondary btn-icon btn-sm"
                aria-label="Изменить"
                title="Изменить"
                onClick={() => openModal("edit", row.original)}
              >
                <Pencil size={15} aria-hidden="true" />
              </button>
            ) : null}
            {hasPermission("users_delete") ? (
              <button
                type="button"
                className="btn-danger btn-icon btn-sm"
                aria-label="Удалить"
                title="Удалить"
                onClick={() => void handleDelete(row.original.id)}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ),
      },
    ],
    [hasPermission, rightsMeta, dateTimeFormat],
  );

  const customerColumns = useMemo<ColumnDef<BotUser>[]>(
    () => [
      { id: "id", header: "ID", accessorKey: "id" },
      { id: "phone", header: "Телефон", accessorKey: "phone", cell: ({ getValue }) => getValue() || "—" },
      {
        id: "name",
        header: "Имя",
        cell: ({ row }) => {
          const u = row.original;
          return u.display_name || [u.first_name, u.last_name].filter(Boolean).join(" ") || "—";
        },
      },
      {
        id: "telegram",
        header: "Telegram",
        cell: ({ row }) => (row.original.telegram_id ? `Привязан · ${row.original.telegram_id}` : "Не привязан"),
      },
      {
        id: "linked_at",
        header: "Привязан",
        accessorFn: (row) => formatDateTime(row.linked_at),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) =>
          hasPermission("users_edit") ? (
            <div className="cell-actions">
              <button
                type="button"
                className="btn-primary btn-icon btn-sm"
                aria-label="Сделать сотрудником"
                title="Сделать сотрудником"
                onClick={() => openModal("promote", row.original)}
              >
                <UserPlus size={15} aria-hidden="true" />
              </button>
            </div>
          ) : null,
      },
    ],
    [hasPermission, dateTimeFormat],
  );

  function openModal(mode: ModalMode, user?: BotUser) {
    setModalError("");
    setModalMode(mode);
    setSelectedUser(user || null);
    setRegosUserId(user?.regos_user_id != null ? String(user.regos_user_id) : "");
  }

  async function handleDelete(id: number) {
    const ok = await confirm({ message: "Удалить сотрудника?", variant: "danger", confirmLabel: "Удалить" });
    if (ok) deleteMutation.mutate(id);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setModalError("");
    const form = new FormData(event.currentTarget);
    const regosUserId = String(form.get("regos_user_id") || "").trim();
    const body: Record<string, unknown> = {
      phone: form.get("phone"),
      display_name: form.get("display_name"),
      job_title: form.get("job_title"),
      description: form.get("description"),
      admin_login: String(form.get("admin_login") || "").trim(),
      rights: Object.fromEntries(
        rightsMeta.map((r) => [r.key, form.get(`right_${r.key}`) === "on"]),
      ),
    };
    if (regosUserId) body.regos_user_id = Number(regosUserId);
    else if (modalMode === "create" || modalMode === "promote") body.auto_link_regos = true;
    const password = String(form.get("password") || "");
    if (modalMode === "create" || modalMode === "promote" || password) body.password = password;

    saveMutation.mutate({ mode: modalMode, body, userId: selectedUser?.id });
  }

  function matchRegosByPhone(phone: string): RegosUser[] {
    return (regosQuery.data?.users || []).filter((user) =>
      collectRegosPhones(user).some((candidate) => phonesEqual(candidate, phone)),
    );
  }

  const users = usersQuery.items;
  const total = usersQuery.total;
  const regosUsers = regosQuery.data?.users || [];
  const selectedRegosInList = regosUsers.some((user) => String(user.id) === regosUserId);

  function userDisplayName(user: BotUser): string {
    if (role === "customer") {
      return user.display_name || [user.first_name, user.last_name].filter(Boolean).join(" ") || "—";
    }
    const tg = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    const admin = String(user.display_name || "").trim();
    return admin || tg || (user.username ? `@${user.username}` : "—");
  }

  function userActions(user: BotUser): ReactNode {
    if (role === "customer") {
      return hasPermission("users_edit") ? (
        <button
          type="button"
          className="btn-primary btn-icon btn-sm"
          aria-label="Сделать сотрудником"
          title="Сделать сотрудником"
          onClick={() => openModal("promote", user)}
        >
          <UserPlus size={15} aria-hidden="true" />
        </button>
      ) : null;
    }
    return (
      <>
        {hasPermission("users_edit") ? (
          <button
            type="button"
            className="btn-secondary btn-icon btn-sm"
            aria-label="Изменить"
            title="Изменить"
            onClick={() => openModal("edit", user)}
          >
            <Pencil size={15} aria-hidden="true" />
          </button>
        ) : null}
        {hasPermission("users_delete") ? (
          <button
            type="button"
            className="btn-danger btn-icon btn-sm"
            aria-label="Удалить"
            title="Удалить"
            onClick={() => void handleDelete(user.id)}
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        ) : null}
      </>
    );
  }

  return (
    <section className="card">
      <div className="card-toolbar">
        <div>
          <div className="role-tabs" role="tablist">
            <button
              type="button"
              className={`role-tab${role === "employee" ? " role-tab--active" : ""}`}
              onClick={() => setRole("employee")}
            >
              Сотрудники
            </button>
            <button
              type="button"
              className={`role-tab${role === "customer" ? " role-tab--active" : ""}`}
              onClick={() => setRole("customer")}
            >
              Клиенты
            </button>
          </div>
        </div>
        <div className="card-toolbar-right">
          {role === "employee" && hasPermission("users_edit") ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => autoLinkMutation.mutate()}
              disabled={autoLinkMutation.isPending}
            >
              Сопоставить с REGOS
            </button>
          ) : null}
          {role === "employee" && hasPermission("users_create") ? (
            <button type="button" className="btn-primary" onClick={() => openModal("create")}>
              + Создать сотрудника
            </button>
          ) : null}
        </div>
      </div>

      <ListFiltersChrome
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Поиск по телефону, имени, Telegram…"
      />

      <div className="ticket-table-section">
        {compact ? (
          <EntityCards
            items={users}
            isLoading={usersQuery.isPending}
            emptyMessage={search ? "Ничего не найдено." : "Пользователей пока нет."}
            getKey={(user) => String(user.id)}
            getTitle={(user) => userDisplayName(user)}
            getSubtitle={(user) => user.phone || "—"}
            getFields={(user) =>
              role === "employee"
                ? [
                    { label: "Логин", value: user.admin_login || "—" },
                    {
                      label: "REGOS",
                      value: user.regos_user_id
                        ? user.regos_full_name || user.regos_login || `ID ${user.regos_user_id}`
                        : "Не связан",
                    },
                    {
                      label: "Telegram",
                      value: user.telegram_id ? `Привязан · ${user.telegram_id}` : "Ожидает привязки",
                    },
                    {
                      label: "Права",
                      value: (() => {
                        const active = rightsMeta.filter((r) => user.rights?.[r.key]);
                        if (!active.length) return "Нет прав";
                        if (active.length <= 2) return active.map((r) => r.label).join(", ");
                        return `${active.length} права`;
                      })(),
                    },
                  ]
                : [
                    {
                      label: "Telegram",
                      value: user.telegram_id ? `Привязан · ${user.telegram_id}` : "Не привязан",
                    },
                    { label: "Привязан", value: formatDateTime(user.linked_at) },
                  ]
            }
            getActions={(user) => userActions(user)}
          />
        ) : (
          <SimpleTable
            tableKey={`bot-admin.users.${role}`}
            data={users}
            columns={role === "employee" ? employeeColumns : customerColumns}
            isLoading={usersQuery.isPending}
            serverSideSearch
            emptyMessage={search ? "Ничего не найдено." : "Пользователей пока нет."}
            getRowId={(row) => String(row.id)}
          />
        )}

        <InfiniteScrollSentinel
          loaded={users.length}
          total={total}
          hasNextPage={Boolean(usersQuery.hasNextPage)}
          isFetchingNextPage={usersQuery.isFetchingNextPage}
          fetchNextPage={usersQuery.fetchNextPage}
        />
      </div>
      <Modal
        open={modalMode != null}
        title={
          modalMode === "create"
            ? "Новый сотрудник"
            : modalMode === "promote"
              ? "Назначить сотрудником"
              : "Редактирование сотрудника"
        }
        onClose={() => setModalMode(null)}
        size="wide"
      >
        <form className="stack-form" onSubmit={handleSubmit}>
          <label>
            Телефон
            <input
              name="phone"
              defaultValue={selectedUser?.phone || ""}
              readOnly={modalMode === "promote"}
              required={modalMode !== "promote"}
            />
          </label>
          <label>
            Имя
            <input name="display_name" defaultValue={selectedUser?.display_name || ""} />
          </label>
          <label>
            Должность
            <input name="job_title" defaultValue={selectedUser?.job_title || ""} placeholder="Менеджер по продажам" />
          </label>
          <label>
            Описание для AI
            <textarea name="description" rows={3} defaultValue={selectedUser?.description || ""} />
          </label>
          <label>
            Логин админ-панели
            <input name="admin_login" defaultValue={selectedUser?.admin_login || ""} autoComplete="off" />
          </label>
          <label>
            Пароль
            <input name="password" type="password" autoComplete="new-password" />
          </label>
          <label>
            REGOS
            <select name="regos_user_id" value={regosUserId} onChange={(event) => setRegosUserId(event.target.value)}>
              <option value="">— Не связан —</option>
              {regosUserId && !selectedRegosInList ? (
                <option value={regosUserId}>
                  {selectedUser?.regos_full_name || selectedUser?.regos_login || `ID ${regosUserId}`}
                </option>
              ) : null}
              {regosUsers.map((user) => (
                <option key={user.id} value={user.id}>
                  {formatRegosLabel(user)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              const phone = (document.querySelector('input[name="phone"]') as HTMLInputElement)?.value;
              const matches = matchRegosByPhone(phone);
              if (!matches.length) window.alert("По этому телефону пользователь REGOS не найден.");
              else if (matches.length > 1) window.alert(`Найдено несколько (${matches.length}). Выберите вручную.`);
              else setRegosUserId(String(matches[0].id));
            }}
          >
            Найти по телефону
          </button>
          <fieldset>
            <legend>Права</legend>
            <div className="rights-grid">
              {rightsMeta.map((right: RightMeta) => (
                <label key={right.key} className="rights-item">
                  <input
                    type="checkbox"
                    name={`right_${right.key}`}
                    defaultChecked={Boolean(
                      selectedUser?.rights?.[right.key] ?? (right.key === "see_own_report" && modalMode !== "edit"),
                    )}
                  />
                  <span>{right.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {modalError ? <p className="message error">{modalError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setModalMode(null)}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={saveMutation.isPending}>
              {modalMode === "create" ? "Создать" : modalMode === "promote" ? "Назначить" : "Сохранить"}
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
