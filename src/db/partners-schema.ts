import type { Db } from '../types/db';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { dbPath } from '../paths';
import { migrateBotUsersSchema } from './bot-users-db';

const DEFAULT_DB_PATH = dbPath();

function openDb(dbPath: any = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  initSchema(db);
  return db;
}

const SCRAPED_TABLES = [
  'partners',
  'partner_accounts',
  'licenses',
  'rpos_clients',
  'rpos_accounts',
  'vcr1_partners',
  'vcr1_licenses',
  'fetch_runs',
];

function dropScrapedTables(db: Db) {
  for (const table of SCRAPED_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

function initSchema(db: Db) {
  dropScrapedTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_users (
      telegram_id INTEGER PRIMARY KEY,
      phone TEXT NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      registered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_bot_users_phone ON bot_users(phone);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      telegram_id INTEGER NOT NULL,
      bot_user_phone TEXT,
      client_phone TEXT NOT NULL,
      client_type TEXT,
      additional_phone TEXT,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'UZS',
      status TEXT NOT NULL DEFAULT 'pending',
      payment_provider TEXT NOT NULL DEFAULT 'click',
      payment_transaction_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orders_telegram_id ON orders(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_client_phone ON orders(client_phone);

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      telegram_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      provider TEXT NOT NULL,
      click_trans_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);

    CREATE TABLE IF NOT EXISTS payme_transactions (
      payme_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      state INTEGER NOT NULL,
      create_time INTEGER NOT NULL,
      perform_time INTEGER,
      cancel_time INTEGER,
      cancel_reason INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_payme_transactions_order_id ON payme_transactions(order_id);
  `);
  migrateSchema(db);
}

function columnExists(db: Db, table?: any, column?: any) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c?: any) => c.name === column);
}

function migrateSchema(db: Db) {
  dropScrapedTables(db);
  if (!columnExists(db, 'payments', 'external_transaction_id')) {
    db.exec('ALTER TABLE payments ADD COLUMN external_transaction_id TEXT');
  }
  if (!columnExists(db, 'orders', 'payme_receipt_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN payme_receipt_id TEXT');
  }
  if (!columnExists(db, 'orders', 'payme_receipt_created_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN payme_receipt_created_at INTEGER');
  }
  if (!columnExists(db, 'orders', 'ticket_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN ticket_id INTEGER');
  }
  if (!columnExists(db, 'orders', 'paid_notified_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN paid_notified_at TEXT');
  }
  migrateBotUsersSchema(db);
  const { ensureOrderLogsTable } = (require('./order-logs') as typeof import('./order-logs'));
  ensureOrderLogsTable(db);
  const { ensureAdminAuditLogsTable } = (require('./admin-audit-logs') as typeof import('./admin-audit-logs'));
  ensureAdminAuditLogsTable(db);
  const { ensureDashboardLoginTokensTable } = (require('../admin/dashboard-login-tokens') as typeof import('../admin/dashboard-login-tokens'));
  ensureDashboardLoginTokensTable(db);
  const { ensureTechnicalSupportTables } = (require('./technical-support') as typeof import('./technical-support'));
  ensureTechnicalSupportTables(db);
  const { ensureServicePricesTables } = (require('./service-prices') as typeof import('./service-prices'));
  ensureServicePricesTables(db);
  const { ensureRegosChannelSettingsTable } = (require('./regos-channel-settings') as typeof import('./regos-channel-settings'));
  ensureRegosChannelSettingsTable(db);
  const { ensureTicketRecordingsTable } = (require('./ticket-recordings') as typeof import('./ticket-recordings'));
  ensureTicketRecordingsTable(db);
  const { ensureAppSettingsTable } = (require('./app-settings') as typeof import('./app-settings'));
  ensureAppSettingsTable(db);
  const { ensureKnowledgeTables } = (require('./knowledge-articles') as typeof import('./knowledge-articles'));
  ensureKnowledgeTables(db);
  const { ensureOpsAgentSessionTables } = (require('./ops-agent-sessions') as typeof import('./ops-agent-sessions'));
  ensureOpsAgentSessionTables(db);
  const { ensureAiPromptsTable } = (require('./ai-prompts') as typeof import('./ai-prompts'));
  ensureAiPromptsTable(db);
  const { ensureAiPromptVariablesTable } = (require('./ai-prompt-variables') as typeof import('./ai-prompt-variables'));
  ensureAiPromptVariablesTable(db);
  const { ensureAiToolDescriptionsTable } = (require('./ai-tool-descriptions') as typeof import('./ai-tool-descriptions'));
  ensureAiToolDescriptionsTable(db);
  const { ensureCustomerTestTables } = (require('./customer-agent-sessions') as typeof import('./customer-agent-sessions'));
  ensureCustomerTestTables(db);
  const { ensureTicketAssistTables } = (require('./ticket-assist-sessions') as typeof import('./ticket-assist-sessions'));
  ensureTicketAssistTables(db);
  const { ensureTicketSummariesTable } = (require('./ticket-summaries') as typeof import('./ticket-summaries'));
  ensureTicketSummariesTable(db);
  const { ensureChatFileExtractionsTable } = (require('./chat-file-extractions') as typeof import('./chat-file-extractions'));
  ensureChatFileExtractionsTable(db);
  const { ensureTicketAiStateTable } = (require('./ticket-ai-state') as typeof import('./ticket-ai-state'));
  ensureTicketAiStateTable(db);
  const { ensureAiCustomerUsageTable } = (require('./ai-customer-usage') as typeof import('./ai-customer-usage'));
  ensureAiCustomerUsageTable(db);
  const { ensureCustomerMessageClaimsTable } = (require('./customer-message-claims') as typeof import('./customer-message-claims'));
  ensureCustomerMessageClaimsTable(db);
  const { ensureDeviceTables } = (require('./devices') as typeof import('./devices'));
  ensureDeviceTables(db);
  const { ensureServiceTables } = (require('./services') as typeof import('./services'));
  ensureServiceTables(db);
  const { ensureTaskTables } = (require('./tasks') as typeof import('./tasks'));
  ensureTaskTables(db);
  const { ensureLocationTables } = (require('./locations') as typeof import('./locations'));
  ensureLocationTables(db);
  const { ensureAccountTables } = (require('./accounts') as typeof import('./accounts'));
  ensureAccountTables(db);
  const { ensureAccountPaymentTables } = (require('./account-payments') as typeof import('./account-payments'));
  ensureAccountPaymentTables(db);
  const { ensurePaymentTypeTables } = (require('./payment-types') as typeof import('./payment-types'));
  ensurePaymentTypeTables(db);
}

export { DEFAULT_DB_PATH, openDb };
