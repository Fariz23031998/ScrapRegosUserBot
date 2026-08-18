export const TASK_STATUSES = [
  { value: "new", label: "Новая" },
  { value: "in_progress", label: "В работе" },
  { value: "done", label: "Выполнена" },
] as const;

export function nextTaskStatus(status: string | undefined): { value: string; label: string } | null {
  if (status === "new") return { value: "in_progress", label: "В работу" };
  if (status === "in_progress") return { value: "done", label: "Выполнена" };
  return null;
}

export function isTaskCartLocked(task: { status?: string; posted?: boolean } | null | undefined): boolean {
  return Boolean(task && task.status === "done" && task.posted);
}
