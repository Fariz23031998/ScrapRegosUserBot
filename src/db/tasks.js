const { ensureDeviceTables, getDevice } = require('./devices');
const { ensureServiceTables, getService } = require('./services');
const { attachCatalogImages } = require('./catalog-images');
const { getBotUserById } = require('./bot-users-db');
const { getUsdUzsRate, presentMoneyFields, snapshotMoney, sumMoneyTotals } = require('./money');

const MAX_TITLE = 200;
const MAX_NOTES = 5000;
const MAX_ADDRESS = 500;
const MAX_CATEGORY_NAME = 100;
const MAX_CLIENT_NAME = 200;
const MAX_CLIENT_PHONE = 40;
const MAX_LINE_NOTES = 500;
const TASK_STATUSES = ['new', 'in_progress', 'done'];
const TASK_ACTIONS = ['install', 'repair'];
const TASK_STATUS_LABELS = {
  new: 'Новая',
  in_progress: 'В работе',
  done: 'Выполнена',
};
const TASK_ACTION_LABELS = {
  install: 'Установка',
  repair: 'Ремонт',
};

const TASK_SELECT = `
  t.id, t.title, t.status, t.notes, t.address, t.category_id,
  t.regos_client_id, t.client_name, t.client_phone,
  t.manager_user_id, t.technician_user_id,
  t.created_at, t.updated_at,
  c.name AS category_name,
  manager.display_name AS manager_display_name,
  manager.first_name AS manager_first_name,
  manager.last_name AS manager_last_name,
  manager.admin_login AS manager_admin_login,
  manager.username AS manager_username,
  tech.display_name AS technician_display_name,
  tech.first_name AS technician_first_name,
  tech.last_name AS technician_last_name,
  tech.admin_login AS technician_admin_login,
  tech.username AS technician_username
`;

const TASK_FROM = `
  tasks t
  LEFT JOIN task_categories c ON c.id = t.category_id
  LEFT JOIN bot_users manager ON manager.id = t.manager_user_id
  LEFT JOIN bot_users tech ON tech.id = t.technician_user_id
`;

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function ensureTaskTables(db) {
  ensureDeviceTables(db);
  ensureServiceTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      notes TEXT,
      address TEXT,
      category_id INTEGER,
      regos_client_id INTEGER,
      client_name TEXT,
      client_phone TEXT,
      manager_user_id INTEGER,
      technician_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (category_id) REFERENCES task_categories(id) ON DELETE SET NULL,
      FOREIGN KEY (manager_user_id) REFERENCES bot_users(id) ON DELETE SET NULL,
      FOREIGN KEY (technician_user_id) REFERENCES bot_users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS task_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      device_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      notes TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (device_id) REFERENCES devices(id)
    );

    CREATE TABLE IF NOT EXISTS task_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      service_id INTEGER NOT NULL,
      notes TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      cost_amount REAL NOT NULL DEFAULT 0,
      cost_currency TEXT NOT NULL DEFAULT 'UZS',
      price_uzs REAL,
      price_usd REAL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (service_id) REFERENCES services(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_category_id ON tasks(category_id);
    CREATE INDEX IF NOT EXISTS idx_task_devices_task_id ON task_devices(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_devices_device_id ON task_devices(device_id);
    CREATE INDEX IF NOT EXISTS idx_task_services_task_id ON task_services(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_services_service_id ON task_services(service_id);
  `);
  ensureColumn(db, 'task_devices', 'cost_amount', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'task_devices', 'cost_currency', "TEXT NOT NULL DEFAULT 'UZS'");
  ensureColumn(db, 'task_devices', 'price_uzs', 'REAL');
  ensureColumn(db, 'task_devices', 'price_usd', 'REAL');
  if (tableExists(db, 'devices')) {
    db.exec(`
      UPDATE task_devices
      SET
        cost_amount = IFNULL((SELECT cost_amount FROM devices d WHERE d.id = task_devices.device_id), 0),
        cost_currency = IFNULL((SELECT cost_currency FROM devices d WHERE d.id = task_devices.device_id), 'UZS'),
        price_uzs = (SELECT price_uzs FROM devices d WHERE d.id = task_devices.device_id),
        price_usd = (SELECT price_usd FROM devices d WHERE d.id = task_devices.device_id)
      WHERE price_uzs IS NULL AND price_usd IS NULL
    `);
  }
}

function employeeLabel(row, prefix) {
  const displayName = row[`${prefix}_display_name`];
  const firstName = row[`${prefix}_first_name`];
  const lastName = row[`${prefix}_last_name`];
  const adminLogin = row[`${prefix}_admin_login`];
  const username = row[`${prefix}_username`];
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  return displayName || fullName || adminLogin || (username ? `@${username}` : null);
}

function mapEmployeeSummary(id, name) {
  if (id == null) return null;
  return { id, name: name || `Сотрудник #${id}` };
}

function mapTaskDevice(row, rate) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    device_id: row.device_id,
    device_name: row.device_name || '',
    description: row.device_description || '',
    action: row.action,
    action_label: TASK_ACTION_LABELS[row.action] || row.action,
    notes: row.notes || '',
    sort_order: row.sort_order ?? 0,
    ...presentMoneyFields(row, rate),
  };
}

function mapTaskService(row, rate) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    service_id: row.service_id,
    service_name: row.service_name || '',
    description: row.service_description || '',
    notes: row.notes || '',
    sort_order: row.sort_order ?? 0,
    ...presentMoneyFields(row, rate),
  };
}

function mapTask(row, devices = [], services = [], totals = null) {
  if (!row) return null;
  const managerName = employeeLabel(row, 'manager');
  const technicianName = employeeLabel(row, 'technician');
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    status_label: TASK_STATUS_LABELS[row.status] || row.status,
    notes: row.notes || '',
    address: row.address || '',
    category_id: row.category_id ?? null,
    category: row.category_id
      ? { id: row.category_id, name: row.category_name || '' }
      : null,
    regos_client_id: row.regos_client_id ?? null,
    client_name: row.client_name || '',
    client_phone: row.client_phone || '',
    manager_user_id: row.manager_user_id ?? null,
    manager: mapEmployeeSummary(row.manager_user_id, managerName),
    technician_user_id: row.technician_user_id ?? null,
    technician: mapEmployeeSummary(row.technician_user_id, technicianName),
    devices,
    services,
    totals: totals || { cost_uzs: 0, cost_usd: 0, price_uzs: 0, price_usd: 0 },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapCategory(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeCategoryInput(input = {}) {
  const name = String(input.name || '').trim();
  if (!name || name.length > MAX_CATEGORY_NAME) throw new Error('INVALID_CATEGORY_NAME');
  return { name };
}

function listTaskCategories(db) {
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

function getTaskCategory(db, id) {
  ensureTaskTables(db);
  const categoryId = Number(id);
  if (!Number.isFinite(categoryId) || categoryId <= 0) return null;
  return mapCategory(
    db.prepare('SELECT id, name, created_at, updated_at FROM task_categories WHERE id = ?').get(categoryId)
  );
}

function createTaskCategory(db, input) {
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

function updateTaskCategory(db, id, input = {}) {
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

function deleteTaskCategory(db, id) {
  const current = getTaskCategory(db, id);
  if (!current) return false;
  db.prepare('UPDATE tasks SET category_id = NULL WHERE category_id = ?').run(current.id);
  db.prepare('DELETE FROM task_categories WHERE id = ?').run(current.id);
  return true;
}

function normalizeOptionalText(value, max, errorCode) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text.length > max) throw new Error(errorCode);
  return text || null;
}

function normalizeOptionalId(value) {
  if (value == null || value === '' || value === 0 || value === '0') return null;
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function normalizeCategoryId(db, value) {
  if (value === undefined) return undefined;
  const categoryId = normalizeOptionalId(value);
  if (categoryId == null) return null;
  const category = getTaskCategory(db, categoryId);
  if (!category) throw new Error('INVALID_TASK_CATEGORY');
  return category.id;
}

function normalizeEmployeeId(db, value, errorCode) {
  if (value === undefined) return undefined;
  const userId = normalizeOptionalId(value);
  if (userId == null) return null;
  const user = getBotUserById(db, userId);
  if (!user || user.role !== 'employee') throw new Error(errorCode);
  return user.id;
}

function normalizeStatus(value, fallback = 'new') {
  if (value == null || value === '') return fallback;
  const status = String(value).trim();
  if (!TASK_STATUSES.includes(status)) throw new Error('INVALID_TASK_STATUS');
  return status;
}

function normalizeTaskDeviceLine(db, item, index = 0) {
  const device = getDevice(db, item?.device_id);
  if (!device) throw new Error('INVALID_TASK_DEVICE');
  const action = String(item?.action || '').trim();
  if (!TASK_ACTIONS.includes(action)) throw new Error('INVALID_TASK_ACTION');
  const notes = normalizeOptionalText(item?.notes, MAX_LINE_NOTES, 'INVALID_TASK_DEVICE_NOTES');
  return {
    device_id: device.id,
    action,
    notes,
    sort_order: index,
    ...snapshotMoney(device),
  };
}

function normalizeTaskServiceLine(db, item, index = 0) {
  const service = getService(db, item?.service_id);
  if (!service) throw new Error('INVALID_TASK_SERVICE');
  const notes = normalizeOptionalText(item?.notes, MAX_LINE_NOTES, 'INVALID_TASK_SERVICE_NOTES');
  return {
    service_id: service.id,
    notes,
    sort_order: index,
    ...snapshotMoney(service),
  };
}

function normalizeTaskDevices(db, devices) {
  if (devices == null) return [];
  if (!Array.isArray(devices)) throw new Error('INVALID_TASK_DEVICES');
  return devices.map((item, index) => normalizeTaskDeviceLine(db, item, index));
}

function normalizeTaskInput(db, input = {}, { partial = false, current = null } = {}) {
  const titleSource = input.title != null ? input.title : current?.title;
  const title = String(titleSource || '').trim();
  if (!partial || input.title != null) {
    if (!title || title.length > MAX_TITLE) throw new Error('INVALID_TASK_TITLE');
  }
  const status = normalizeStatus(
    input.status != null ? input.status : current?.status,
    current?.status || 'new'
  );
  const notes = normalizeOptionalText(
    input.notes != null ? input.notes : current?.notes,
    MAX_NOTES,
    'INVALID_TASK_NOTES'
  );
  const address = normalizeOptionalText(
    input.address != null ? input.address : current?.address,
    MAX_ADDRESS,
    'INVALID_TASK_ADDRESS'
  );
  const clientName = normalizeOptionalText(
    input.client_name != null ? input.client_name : current?.client_name,
    MAX_CLIENT_NAME,
    'INVALID_TASK_CLIENT'
  );
  const clientPhone = normalizeOptionalText(
    input.client_phone != null ? input.client_phone : current?.client_phone,
    MAX_CLIENT_PHONE,
    'INVALID_TASK_CLIENT'
  );
  let regosClientId = current?.regos_client_id ?? null;
  if (input.regos_client_id !== undefined) {
    regosClientId = normalizeOptionalId(input.regos_client_id);
  }
  const categoryId = normalizeCategoryId(db, input.category_id);
  const managerUserId = normalizeEmployeeId(db, input.manager_user_id, 'INVALID_TASK_MANAGER');
  const technicianUserId = normalizeEmployeeId(db, input.technician_user_id, 'INVALID_TASK_TECHNICIAN');

  return {
    title: title || current?.title,
    status,
    notes,
    address,
    client_name: clientName,
    client_phone: clientPhone,
    regos_client_id: regosClientId,
    category_id: categoryId === undefined ? current?.category_id ?? null : categoryId,
    manager_user_id: managerUserId === undefined ? current?.manager_user_id ?? null : managerUserId,
    technician_user_id: technicianUserId === undefined ? current?.technician_user_id ?? null : technicianUserId,
  };
}

function listTaskDevicesForIds(db, taskIds, rate) {
  const map = new Map();
  if (!taskIds.length) return map;
  const placeholders = taskIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT td.id, td.task_id, td.device_id, td.action, td.notes, td.sort_order,
              td.cost_amount, td.cost_currency, td.price_uzs, td.price_usd,
              d.name AS device_name,
              d.description AS device_description
       FROM task_devices td
       LEFT JOIN devices d ON d.id = td.device_id
       WHERE td.task_id IN (${placeholders})
       ORDER BY td.sort_order ASC, td.id ASC`
    )
    .all(...taskIds);
  for (const row of rows) {
    const list = map.get(row.task_id) || [];
    list.push(mapTaskDevice(row, rate));
    map.set(row.task_id, list);
  }
  const allLines = [...map.values()].flat();
  attachCatalogImages(db, allLines, 'device', 'device_id');
  return map;
}

function listTaskServicesForIds(db, taskIds, rate) {
  const map = new Map();
  if (!taskIds.length || !tableExists(db, 'task_services')) return map;
  const placeholders = taskIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT ts.id, ts.task_id, ts.service_id, ts.notes, ts.sort_order,
              ts.cost_amount, ts.cost_currency, ts.price_uzs, ts.price_usd,
              s.name AS service_name,
              s.description AS service_description
       FROM task_services ts
       LEFT JOIN services s ON s.id = ts.service_id
       WHERE ts.task_id IN (${placeholders})
       ORDER BY ts.sort_order ASC, ts.id ASC`
    )
    .all(...taskIds);
  for (const row of rows) {
    const list = map.get(row.task_id) || [];
    list.push(mapTaskService(row, rate));
    map.set(row.task_id, list);
  }
  const allLines = [...map.values()].flat();
  attachCatalogImages(db, allLines, 'service', 'service_id');
  return map;
}

function getTaskRow(db, id) {
  const taskId = Number(id);
  if (!Number.isFinite(taskId) || taskId <= 0) return null;
  return db.prepare(`SELECT ${TASK_SELECT} FROM ${TASK_FROM} WHERE t.id = ?`).get(taskId) || null;
}

function assembleTask(db, row) {
  const rate = getUsdUzsRate(db);
  const devices = listTaskDevicesForIds(db, [row.id], rate).get(row.id) || [];
  const services = listTaskServicesForIds(db, [row.id], rate).get(row.id) || [];
  const totals = sumMoneyTotals([...devices, ...services], rate);
  return mapTask(row, devices, services, totals);
}

function getTask(db, id) {
  ensureTaskTables(db);
  const row = getTaskRow(db, id);
  if (!row) return null;
  return assembleTask(db, row);
}

function touchTask(db, taskId) {
  db.prepare(`UPDATE tasks SET updated_at = datetime('now') WHERE id = ?`).run(taskId);
}

function nextSortOrder(db, table, taskId) {
  if (table !== 'task_devices' && table !== 'task_services') {
    throw new Error('INVALID_TABLE');
  }
  const row = db.prepare(`SELECT MAX(sort_order) AS max_order FROM ${table} WHERE task_id = ?`).get(taskId);
  if (row?.max_order == null) return 0;
  return Number(row.max_order) + 1;
}

function replaceTaskDevices(db, taskId, devices) {
  db.prepare('DELETE FROM task_devices WHERE task_id = ?').run(taskId);
  const insert = db.prepare(
    `INSERT INTO task_devices (
       task_id, device_id, action, notes, sort_order, cost_amount, cost_currency, price_uzs, price_usd
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of devices) {
    insert.run(
      taskId,
      item.device_id,
      item.action,
      item.notes,
      item.sort_order,
      item.cost_amount,
      item.cost_currency,
      item.price_uzs,
      item.price_usd
    );
  }
}

function createTask(db, input) {
  ensureTaskTables(db);
  const task = normalizeTaskInput(db, input);
  const devices = normalizeTaskDevices(db, input.devices || []);
  db.exec('BEGIN');
  try {
    const result = db
      .prepare(
        `INSERT INTO tasks (
           title, status, notes, address, category_id,
           regos_client_id, client_name, client_phone,
           manager_user_id, technician_user_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .run(
        task.title,
        task.status,
        task.notes,
        task.address,
        task.category_id,
        task.regos_client_id,
        task.client_name,
        task.client_phone,
        task.manager_user_id,
        task.technician_user_id
      );
    const taskId = Number(result.lastInsertRowid);
    replaceTaskDevices(db, taskId, devices);
    db.exec('COMMIT');
    return getTask(db, taskId);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function updateTask(db, id, input = {}) {
  ensureTaskTables(db);
  const current = getTask(db, id);
  if (!current) throw new Error('NOT_FOUND');
  const task = normalizeTaskInput(db, input, { partial: true, current });
  const devices = input.devices != null ? normalizeTaskDevices(db, input.devices) : null;
  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE tasks
       SET title = ?, status = ?, notes = ?, address = ?, category_id = ?,
           regos_client_id = ?, client_name = ?, client_phone = ?,
           manager_user_id = ?, technician_user_id = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      task.title,
      task.status,
      task.notes,
      task.address,
      task.category_id,
      task.regos_client_id,
      task.client_name,
      task.client_phone,
      task.manager_user_id,
      task.technician_user_id,
      current.id
    );
    if (devices) replaceTaskDevices(db, current.id, devices);
    db.exec('COMMIT');
    return getTask(db, current.id);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function addTaskDevice(db, taskId, input = {}) {
  ensureTaskTables(db);
  const current = getTask(db, taskId);
  if (!current) throw new Error('NOT_FOUND');
  const line = normalizeTaskDeviceLine(db, input, nextSortOrder(db, 'task_devices', current.id));
  db.prepare(
    `INSERT INTO task_devices (
       task_id, device_id, action, notes, sort_order, cost_amount, cost_currency, price_uzs, price_usd
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    current.id,
    line.device_id,
    line.action,
    line.notes,
    line.sort_order,
    line.cost_amount,
    line.cost_currency,
    line.price_uzs,
    line.price_usd
  );
  touchTask(db, current.id);
  return getTask(db, current.id);
}

function deleteTaskDevice(db, taskId, lineId) {
  ensureTaskTables(db);
  const current = getTask(db, taskId);
  if (!current) throw new Error('NOT_FOUND');
  const id = Number(lineId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('NOT_FOUND');
  const result = db.prepare('DELETE FROM task_devices WHERE id = ? AND task_id = ?').run(id, current.id);
  if (!result.changes) throw new Error('NOT_FOUND');
  touchTask(db, current.id);
  return getTask(db, current.id);
}

function addTaskService(db, taskId, input = {}) {
  ensureTaskTables(db);
  const current = getTask(db, taskId);
  if (!current) throw new Error('NOT_FOUND');
  const line = normalizeTaskServiceLine(db, input, nextSortOrder(db, 'task_services', current.id));
  db.prepare(
    `INSERT INTO task_services (
       task_id, service_id, notes, sort_order, cost_amount, cost_currency, price_uzs, price_usd
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    current.id,
    line.service_id,
    line.notes,
    line.sort_order,
    line.cost_amount,
    line.cost_currency,
    line.price_uzs,
    line.price_usd
  );
  touchTask(db, current.id);
  return getTask(db, current.id);
}

function deleteTaskService(db, taskId, lineId) {
  ensureTaskTables(db);
  const current = getTask(db, taskId);
  if (!current) throw new Error('NOT_FOUND');
  const id = Number(lineId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('NOT_FOUND');
  const result = db.prepare('DELETE FROM task_services WHERE id = ? AND task_id = ?').run(id, current.id);
  if (!result.changes) throw new Error('NOT_FOUND');
  touchTask(db, current.id);
  return getTask(db, current.id);
}

function deleteTask(db, id) {
  const current = getTask(db, id);
  if (!current) return false;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM task_services WHERE task_id = ?').run(current.id);
    db.prepare('DELETE FROM task_devices WHERE task_id = ?').run(current.id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(current.id);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function listTasks(db, { query, status, categoryId, limit = 25, offset = 0 } = {}) {
  ensureTaskTables(db);
  const rate = getUsdUzsRate(db);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const where = [];
  const params = [];
  const trimmed = String(query || '').trim();
  if (trimmed) {
    const like = `%${trimmed}%`;
    where.push(`(
      t.title LIKE ?
      OR IFNULL(t.client_name, '') LIKE ?
      OR IFNULL(t.client_phone, '') LIKE ?
      OR IFNULL(t.address, '') LIKE ?
      OR IFNULL(t.notes, '') LIKE ?
      OR IFNULL(c.name, '') LIKE ?
      OR EXISTS (
        SELECT 1 FROM task_devices td
        LEFT JOIN devices d ON d.id = td.device_id
        WHERE td.task_id = t.id AND IFNULL(d.name, '') LIKE ?
      )
      OR EXISTS (
        SELECT 1 FROM task_services ts
        LEFT JOIN services s ON s.id = ts.service_id
        WHERE ts.task_id = t.id AND IFNULL(s.name, '') LIKE ?
      )
    )`);
    params.push(like, like, like, like, like, like, like, like);
  }
  if (status) {
    if (!TASK_STATUSES.includes(status)) throw new Error('INVALID_TASK_STATUS');
    where.push('t.status = ?');
    params.push(status);
  }
  if (categoryId != null && categoryId !== '' && categoryId !== 'all') {
    const parsed = Number(categoryId);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('INVALID_TASK_CATEGORY');
    where.push('t.category_id = ?');
    params.push(parsed);
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS count FROM ${TASK_FROM}${whereSql}`).get(...params).count;
  const rows = db
    .prepare(
      `SELECT ${TASK_SELECT}
       FROM ${TASK_FROM}${whereSql}
       ORDER BY datetime(t.updated_at) DESC, t.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, safeLimit, safeOffset);
  const ids = rows.map((row) => row.id);
  const devicesByTask = listTaskDevicesForIds(db, ids, rate);
  const servicesByTask = listTaskServicesForIds(db, ids, rate);
  return {
    tasks: rows.map((row) => {
      const devices = devicesByTask.get(row.id) || [];
      const services = servicesByTask.get(row.id) || [];
      return mapTask(row, devices, services, sumMoneyTotals([...devices, ...services], rate));
    }),
    total,
  };
}

module.exports = {
  TASK_STATUSES,
  TASK_ACTIONS,
  TASK_STATUS_LABELS,
  TASK_ACTION_LABELS,
  ensureTaskTables,
  listTaskCategories,
  getTaskCategory,
  createTaskCategory,
  updateTaskCategory,
  deleteTaskCategory,
  listTasks,
  getTask,
  createTask,
  updateTask,
  addTaskDevice,
  deleteTaskDevice,
  addTaskService,
  deleteTaskService,
  deleteTask,
};
