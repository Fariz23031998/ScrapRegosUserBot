import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../src/db/partners-db';
import { createEmployeeUser, deleteEmployeeUser, getBotUserById, linkEmployeeTelegram } from '../src/db/bot-users-db';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-delete-user-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
}

describe('deleteEmployeeUser', () => {
  const dbPath = makeTempDbPath();
  const db = openDb(dbPath);

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('deletes an employee who already created orders and keeps those orders', () => {
    const employee = createEmployeeUser(db, {
      phone: '+998901112233',
      displayName: 'With orders',
    });
    linkEmployeeTelegram(db, employee.id, 88001122, { username: 'withorders' });

    db.prepare(
      `INSERT INTO orders (id, telegram_id, client_phone, amount)
       VALUES (?, ?, ?, ?)`
    ).run('ord-keep', 88001122, '+998900000001', 1000);

    assert.equal(deleteEmployeeUser(db, employee.id), true);
    assert.equal(getBotUserById(db, employee.id), null);
    const order = db.prepare('SELECT id, telegram_id FROM orders WHERE id = ?').get('ord-keep') as {
      id: string;
      telegram_id: number;
    };
    assert.equal(order.id, 'ord-keep');
    assert.equal(order.telegram_id, 88001122);
  });

  it('rejects a missing user', () => {
    assert.throws(() => deleteEmployeeUser(db, 999999), /NOT_FOUND/);
  });
});
