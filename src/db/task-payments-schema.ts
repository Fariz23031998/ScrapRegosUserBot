import type { Db } from '../types/db';
import { recalculateAllAccountValues } from './accounts';
import { ensurePaymentTypeTables } from './payment-types';

function tableExists(db: Db, name?: any) {

  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

}

function ensureColumn(db: Db, table?: any, column?: any, ddl?: any) {

  if (!tableExists(db, table)) return false;

  const cols = db.prepare(`PRAGMA table_info(${table})`).all();

  if (cols.some((col?: any) => col.name === column)) return false;

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);

  return true;

}

function ensureTaskPaymentTables(db: Db) {

  ensurePaymentTypeTables(db);

  db.exec(`

    CREATE TABLE IF NOT EXISTS task_payments (

      id INTEGER PRIMARY KEY AUTOINCREMENT,

      task_id INTEGER NOT NULL,

      payment_type_id INTEGER,

      payment_type_name TEXT NOT NULL,

      amount REAL NOT NULL,

      currency TEXT NOT NULL,

      amount_uzs REAL NOT NULL,

      amount_usd REAL NOT NULL,

      usd_uzs_rate REAL NOT NULL,

      note TEXT,

      created_by_user_id INTEGER,

      created_at TEXT NOT NULL DEFAULT (datetime('now')),

      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE

    );

    CREATE INDEX IF NOT EXISTS idx_task_payments_task_id ON task_payments(task_id);

  `);

  ensureColumn(db, 'task_payments', 'kind', "TEXT NOT NULL DEFAULT 'payment'");

  ensureColumn(db, 'task_payments', 'device_line_id', 'INTEGER');

  ensureColumn(db, 'task_payments', 'service_line_id', 'INTEGER');

  ensureColumn(db, 'task_payments', 'refunded_quantity', 'INTEGER');

  ensureColumn(db, 'task_payments', 'refund_id', 'INTEGER');

  ensureColumn(db, 'task_payments', 'account_id', 'INTEGER');

  db.exec('CREATE INDEX IF NOT EXISTS idx_task_payments_account_id ON task_payments(account_id)');

  const backfilled = db
    .prepare(
      `UPDATE task_payments
       SET account_id = (
         SELECT account_id FROM payment_types WHERE payment_types.id = task_payments.payment_type_id
       )
       WHERE account_id IS NULL AND payment_type_id IS NOT NULL`
    )
    .run();

  if (backfilled.changes > 0) recalculateAllAccountValues(db);

}

export { ensureTaskPaymentTables };
