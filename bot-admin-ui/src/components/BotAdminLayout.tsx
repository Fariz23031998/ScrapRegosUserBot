import {
  Bot,
  ClipboardList,
  FilePen,
  FileText,
  Headphones,
  BookOpen,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  Settings,
  Ticket,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { logout, updateAccount } from "../api/auth";
import { useAuth } from "../hooks/useAuth";
import { useUiPreferences } from "../hooks/useUiPreferences";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import type { AdminShellContextValue } from "../lib/admin-shell";
import { AdminShellProvider } from "../lib/admin-shell";
import { navItemsForPermissions } from "../lib/permissions";
import {
  DATETIME_FORMAT_OPTIONS,
  MAX_TICKET_PERIOD_DAYS,
  MIN_TICKET_PERIOD_DAYS,
} from "../lib/ui-preferences";
import { loadNavVisible, saveNavVisible } from "../lib/utils";

const NAV_ICONS: Record<string, LucideIcon> = {
  "/users": Users,
  "/orders": Receipt,
  "/order-logs": ClipboardList,
  "/logs": FileText,
  "/tickets": Ticket,
  "/technical-support": Headphones,
  "/prices": LayoutDashboard,
  "/knowledge": BookOpen,
  "/customer-agent": Bot,
  "/prompts": FilePen,
  "/settings": Settings,
};

function initials(profile: { displayName?: string | null; phone?: string; username?: string; login?: string | null } | null): string {
  const name = profile?.displayName?.trim() || profile?.login || profile?.username || profile?.phone || "?";
  const parts = name.replace(/^@/, "").split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function BotAdminLayout() {
  const { actor, profile, permissions, clearSession, refreshSession } = useAuth();
  const { theme, dateTimeFormat, ticketPeriodDays, setTheme, setDateTimeFormat, setTicketPeriodDays } =
    useUiPreferences();
  const navigate = useNavigate();
  const location = useLocation();
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const [navVisible, setNavVisible] = useState(loadNavVisible);
  const hideCompactNavButton = /^\/tickets(\/|$)/.test(location.pathname);
  const toggleNav = useCallback(() => setNavVisible((value) => !value), []);
  const shellContext = useMemo<AdminShellContextValue>(
    () => ({ navVisible, toggleNav, setNavVisible }),
    [navVisible, toggleNav],
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [loginValue, setLoginValue] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [profileError, setProfileError] = useState("");
  const [profileSuccess, setProfileSuccess] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const canEditProfile = actor?.type === "user" || actor?.type === "telegram";
  const canChangeCredentials = Boolean(profile?.canChangeCredentials ?? profile?.hasCredentials);
  const profileLogin = profile?.login || profile?.adminLogin || "";

  const navItems = useMemo(() => navItemsForPermissions(permissions), [permissions]);

  useEffect(() => {
    saveNavVisible(navVisible);
  }, [navVisible]);

  useEffect(() => {
    if (!menuOpen) return;
    setDisplayName(profile?.displayName || "");
    setLoginValue(profileLogin);
    setCurrentPassword("");
    setNewPassword("");
    setProfileError("");
    setProfileSuccess("");
  }, [menuOpen, profile?.displayName, profileLogin]);

  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } finally {
      clearSession();
      navigate("/login", { replace: true });
    }
  }, [clearSession, navigate]);

  async function handleProfileSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEditProfile) return;
    setProfileError("");
    setProfileSuccess("");
    setProfileBusy(true);

    const payload: {
      display_name?: string | null;
      login?: string;
      new_password?: string;
      current_password?: string;
    } = {
      display_name: displayName.trim() || null,
    };

    const loginChanged = canChangeCredentials && loginValue.trim() !== profileLogin;
    const passwordChanged = canChangeCredentials && Boolean(newPassword);
    if (loginChanged || passwordChanged) {
      if (!currentPassword) {
        setProfileError("Укажите текущий пароль для смены логина или пароля.");
        setProfileBusy(false);
        return;
      }
      payload.current_password = currentPassword;
      if (canChangeCredentials) payload.login = loginValue.trim();
      if (passwordChanged) payload.new_password = newPassword;
    }

    try {
      await updateAccount(payload);
      setCurrentPassword("");
      setNewPassword("");
      setProfileSuccess("Профиль сохранён.");
      await refreshSession();
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Ошибка сохранения");
    } finally {
      setProfileBusy(false);
    }
  }

  const sidebarClass = [
    "admin-sidebar",
    navVisible ? "admin-sidebar--open" : "admin-sidebar--collapsed",
    compact ? "admin-sidebar--compact" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <AdminShellProvider value={shellContext}>
    <div className="admin-shell">
      <aside className={sidebarClass}>
        <div className="admin-sidebar__head">
          <div className="admin-sidebar__brand">Bot Admin</div>
          <button
            type="button"
            className="sidebar-icon-btn"
            aria-label={navVisible ? "Свернуть меню" : "Развернуть меню"}
            onClick={toggleNav}
          >
            {navVisible ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
        </div>
        <nav className="admin-sidebar__nav" aria-label="Разделы админ-панели">
          {navItems.map((item) => {
            const Icon = NAV_ICONS[item.to] || LayoutDashboard;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `admin-sidebar__link${isActive ? " admin-sidebar__link--active" : ""}`
                }
                onClick={() => {
                  if (compact) setNavVisible(false);
                }}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className="admin-sidebar__footer">
          <div className="account-menu account-menu--sidebar" ref={menuRef}>
            <button
              type="button"
              className="account-menu__avatar"
              aria-haspopup="true"
              aria-expanded={menuOpen}
              aria-label="Аккаунт"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <span className="account-menu__initials">{initials(profile)}</span>
            </button>
            {menuOpen ? (
              <div className="account-menu__dropdown account-menu__dropdown--profile">
                <div className="account-menu__identity">
                  <strong>{profile?.displayName || profile?.login || profile?.username || "Аккаунт"}</strong>
                  {profileLogin ? <span className="account-menu__login">@{profileLogin}</span> : null}
                  {profile?.phone ? <span>{profile.phone}</span> : null}
                </div>

                <form className="account-menu__form" onSubmit={handleProfileSave}>
                  {canEditProfile ? (
                    <section className="account-menu__section">
                      <h4>Профиль</h4>
                      <label>
                        Отображаемое имя
                        <input
                          value={displayName}
                          onChange={(event) => setDisplayName(event.target.value)}
                          maxLength={200}
                          autoComplete="nickname"
                        />
                      </label>
                      {canChangeCredentials ? (
                        <>
                          <label>
                            Логин
                            <input
                              value={loginValue}
                              onChange={(event) => setLoginValue(event.target.value)}
                              autoComplete="username"
                              required
                            />
                          </label>
                          <label>
                            Текущий пароль
                            <input
                              type="password"
                              value={currentPassword}
                              onChange={(event) => setCurrentPassword(event.target.value)}
                              autoComplete="current-password"
                              placeholder="Нужен при смене логина/пароля"
                            />
                          </label>
                          <label>
                            Новый пароль
                            <input
                              type="password"
                              value={newPassword}
                              onChange={(event) => setNewPassword(event.target.value)}
                              autoComplete="new-password"
                              placeholder="Оставьте пустым, чтобы не менять"
                            />
                          </label>
                        </>
                      ) : (
                        <p className="account-menu__hint">Логин и пароль для этой учётной записи не заданы.</p>
                      )}
                    </section>
                  ) : (
                    <section className="account-menu__section">
                      <p className="account-menu__hint">
                        Вход через системный пароль. Смена имени и логина доступна сотрудникам.
                      </p>
                    </section>
                  )}

                  <section className="account-menu__section">
                    <h4>Интерфейс</h4>
                    <label>
                      Тема
                      <select
                        value={theme}
                        onChange={(event) => setTheme(event.target.value as "light" | "dark" | "system")}
                      >
                        <option value="system">Системная</option>
                        <option value="light">Светлая</option>
                        <option value="dark">Тёмная</option>
                      </select>
                    </label>
                    <label>
                      Формат даты и времени
                      <select
                        value={dateTimeFormat}
                        onChange={(event) =>
                          setDateTimeFormat(event.target.value as (typeof DATETIME_FORMAT_OPTIONS)[number]["id"])
                        }
                      >
                        {DATETIME_FORMAT_OPTIONS.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="account-menu__hint">
                      Пример: {DATETIME_FORMAT_OPTIONS.find((option) => option.id === dateTimeFormat)?.example}
                    </p>
                    <label>
                      Период тикетов по умолчанию (дни)
                      <input
                        type="number"
                        min={MIN_TICKET_PERIOD_DAYS}
                        max={MAX_TICKET_PERIOD_DAYS}
                        step={1}
                        value={ticketPeriodDays}
                        onChange={(event) => setTicketPeriodDays(Number(event.target.value))}
                      />
                    </label>
                    <p className="account-menu__hint">
                      От 1 до 30. Например, 7 — последние 7 дней (00:00–23:59).
                    </p>
                  </section>

                  {profileError ? <p className="message error">{profileError}</p> : null}
                  {profileSuccess ? <p className="message success">{profileSuccess}</p> : null}

                  {canEditProfile ? (
                    <button type="submit" className="btn-primary account-menu__save" disabled={profileBusy}>
                      {profileBusy ? "Сохранение…" : "Сохранить профиль"}
                    </button>
                  ) : null}
                </form>

                <button type="button" className="account-menu__item account-menu__item--danger" onClick={handleLogout}>
                  <LogOut size={16} />
                  Выйти
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      {compact && navVisible ? (
        <button
          type="button"
          className="admin-sidebar-backdrop"
          aria-label="Закрыть меню"
          onClick={() => setNavVisible(false)}
        />
      ) : null}

      <div className="admin-main">
        <main className="admin-content">
          <Outlet />
        </main>
        {compact && !hideCompactNavButton ? (
          <div className="tickets-fab-dock">
            <button
              type="button"
              className="tickets-fab tickets-fab--nav"
              aria-label="Меню"
              title="Меню"
              onClick={toggleNav}
            >
              <Menu size={22} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
    </AdminShellProvider>
  );
}
