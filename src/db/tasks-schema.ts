import type { Db } from '../types/db';
import { ensureDeviceTables } from './devices';
import { ensureServiceTables } from './services';
import { ensureLocationTables } from './locations';
import { ensureTaskPaymentTables } from './task-payments';

function tableExists(db: Db, name?: any) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function ensureColumn(db: Db, table?: any, column?: any, ddl?: any) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col?: any) => col.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

function ensureTaskTables(db: Db) {
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
      action TEXT NOT NULL DEFAULT 'install',
      notes TEXT,
      address TEXT,
      category_id INTEGER,
      regos_client_id INTEGER,
      client_name TEXT,
      client_phone TEXT,
      manager_user_id INTEGER,
      technician_user_id INTEGER,
      currency TEXT,
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
      quantity INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (device_id) REFERENCES devices(id)
    );

    CREATE TABLE IF NOT EXISTS task_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      service_id INTEGER NOT NULL,
      notes TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
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
  ensureColumn(db, 'task_devices', 'quantity', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'task_services', 'quantity', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'task_devices', 'discount_type', 'TEXT');
  ensureColumn(db, 'task_devices', 'discount_value', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'task_devices', 'discount_currency', 'TEXT');
  ensureColumn(db, 'task_services', 'discount_type', 'TEXT');
  ensureColumn(db, 'task_services', 'discount_value', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'task_services', 'discount_currency', 'TEXT');
  ensureColumn(db, 'tasks', 'currency', 'TEXT');
  ensureColumn(db, 'tasks', 'posted', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'tasks', 'planned_start_at', 'TEXT');
  ensureColumn(db, 'tasks', 'planned_finish_at', 'TEXT');
  ensureColumn(db, 'tasks', 'technician_reminder_sent_at', 'TEXT');
  ensureColumn(db, 'tasks', 'distance_km', 'REAL');
  ensureColumn(db, 'tasks', 'distance_score', 'REAL');
  if (ensureColumn(db, 'tasks', 'action', "TEXT NOT NULL DEFAULT 'install'")) {
    db.exec(`
      UPDATE tasks
      SET action = (
        SELECT td.action FROM task_devices td
        WHERE td.task_id = tasks.id
        ORDER BY td.sort_order ASC, td.id ASC
        LIMIT 1
      )
      WHERE EXISTS (
        SELECT 1 FROM task_devices td WHERE td.task_id = tasks.id
      )
    `);
  }
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
  ensureLocationTables(db);
  ensureTaskPaymentTables(db);
  (require('./task-refunds') as typeof import('./task-refunds')).ensureTaskRefundTables(db);
  (require('./task-device-returns') as typeof import('./task-device-returns')).ensureTaskDeviceReturnTables(db);
  (require('./task-device-serials') as typeof import('./task-device-serials')).ensureTaskDeviceSerialTables(db);
}

export { tableExists, ensureTaskTables };
