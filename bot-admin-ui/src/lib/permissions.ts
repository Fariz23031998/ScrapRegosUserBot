import type { Permissions } from "./types";

export type NavItem = {
  to: string;
  label: string;
  permission: keyof Permissions | string;
};

export const NAV_ITEMS: NavItem[] = [
  { to: "/tickets", label: "Тикеты", permission: "tickets_read" },
  { to: "/tasks", label: "Задачи", permission: "tasks_read" },
  { to: "/finances", label: "Финансы", permission: "finances_read" },
  { to: "/repair-returns", label: "Возврат устройств", permission: "tasks_read" },
  { to: "/reports", label: "Отчёты", permission: "see_all_report" },
  { to: "/devices", label: "Устройства", permission: "devices_read" },
  { to: "/services", label: "Услуги", permission: "services_read" },
  { to: "/orders", label: "Заказы", permission: "orders_read" },
  { to: "/order-logs", label: "Журнал заказов", permission: "order_logs_read" },
  { to: "/logs", label: "Журнал", permission: "logs_read" },
  { to: "/users", label: "Пользователи", permission: "users_read" },
  { to: "/technical-support", label: "Техподдержка", permission: "technical_support_read" },
  { to: "/prices", label: "Прайс", permission: "prices_read" },
  { to: "/knowledge", label: "База знаний", permission: "knowledge_read" },
  { to: "/test-agents", label: "Тест агентов", permission: "ai_customer_test" },
  { to: "/prompts", label: "Промпты и Инструменты", permission: "settings_read" },
  { to: "/settings", label: "Настройки", permission: "settings_read" },
];

export const LANDING_REDIRECTS: NavItem[] = NAV_ITEMS;

const SIDEBAR_HIDDEN = new Set(["/logs"]);

export function hasPermission(permissions: Permissions | undefined, key: string): boolean {
  return Boolean(permissions?.[key]);
}

export function firstAllowedPath(permissions: Permissions | undefined): string | null {
  for (const item of LANDING_REDIRECTS) {
    if (hasPermission(permissions, item.permission)) return item.to;
  }
  return null;
}

export function navItemsForPermissions(permissions: Permissions | undefined): NavItem[] {
  return NAV_ITEMS.filter(
    (item) => !SIDEBAR_HIDDEN.has(item.to) && hasPermission(permissions, item.permission),
  );
}
