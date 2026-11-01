import type { Db } from '../types/db';
import { ensureTaskTables } from './tasks-schema';

const MAX_CATEGORY_NAME = 100;

function mapCategory(row?: any) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeCategoryInput(input: any = {}) {
  const name = String(input.name || '').trim();
  if (!name || name.length > MAX_CATEGORY_NAME) throw new Error('INVALID_CATEGORY_NAME');
  return { name };
}

function listTaskCategories(db: Db) {
  ensureTaskTables(db);
  return db
    .prepare(
      `SELECT id, name, created_at, updated_at
       FROM task_categories
       ORDER BY name COLLATE NOCASE ASC, id ASC`
    )
    .all()
    .map(mapCategory);
}

function getTaskCategory(db: Db, id?: any) {
  ensureTaskTables(db);
  const categoryId = Number(id);
  if (!Number.isFinite(categoryId) || categoryId <= 0) return null;
  return mapCategory(
    db.prepare('SELECT id, name, created_at, updated_at FROM task_categories WHERE id = ?').get(categoryId)
  );
}

function createTaskCategory(db: Db, input?: any) {
  ensureTaskTables(db);
  const category = normalizeCategoryInput(input);
  const result = db
    .prepare(
      `INSERT INTO task_categories (name, created_at, updated_at)
       VALUES (?, datetime('now'), datetime('now'))`
    )
    .run(category.name);
  return getTaskCategory(db, Number(result.lastInsertRowid));
}

function updateTaskCategory(db: Db, id: any, input: any = {}) {
  const current = getTaskCategory(db, id);
  if (!current) throw new Error('NOT_FOUND');
  const category = normalizeCategoryInput({
    name: input.name != null ? input.name : current.name,
  });
  db.prepare(
    `UPDATE task_categories SET name = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(category.name, current.id);
  return getTaskCategory(db, current.id);
}

function deleteTaskCategory(db: Db, id?: any) {
  const current = getTaskCategory(db, id);
  if (!current) return false;
  db.prepare('UPDATE tasks SET category_id = NULL WHERE category_id = ?').run(current.id);
  db.prepare('DELETE FROM task_categories WHERE id = ?').run(current.id);
  return true;
}

export {
  listTaskCategories,
  getTaskCategory,
  createTaskCategory,
  updateTaskCategory,
  deleteTaskCategory,
};
