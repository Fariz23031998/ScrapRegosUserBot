const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createEmployeeUser } = require('../src/db/bot-users-db');
const { createDevice } = require('../src/db/devices');
const { createService } = require('../src/db/services');
const { createLocation } = require('../src/db/locations');
const { openDb } = require('../src/db/partners-db');
const { createOpsTools } = require('../src/ai/tools/ops');
const { listPaymentTypes } = require('../src/db/payment-types');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-ops-tools-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
}

function toolMap(tools) {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

describe('ops AI tools', () => {
  let dbPath;
  let db;
  let alice;
  let bob;
  let aliceLocation;
  let bobLocation;
  let device;
  let service;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    alice = createEmployeeUser(db, { phone: '+998901000031', displayName: 'Алиса' });
    bob = createEmployeeUser(db, { phone: '+998901000032', displayName: 'Боб' });
    aliceLocation = createLocation(db, { name: 'Офис Алисы', allowed_user_ids: [alice.id] });
    bobLocation = createLocation(db, { name: 'Офис Боба', allowed_user_ids: [bob.id] });
    device = createDevice(db, { name: 'Касса SR', price_uzs: 1000000 });
    service = createService(db, { name: 'Установка', price_uzs: 150000 });
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('returns compact catalog and task search results', async () => {
    const tools = toolMap(
      createOpsTools({
        db,
        write: true,
        viewer: { seeAll: true, userId: null },
      })
    );
    const devices = await tools.get('search_devices').execute({ query: 'Касса' });
    assert.equal(devices.total >= 1, true);
    assert.equal(devices.devices[0].name, 'Касса SR');
    assert.equal(devices.devices[0].images, undefined);

    const created = await tools.get('create_task').execute({
      title: 'Выезд по кассе',
      location_id: aliceLocation.id,
      action: 'install',
    });
    assert.equal(created.title, 'Выезд по кассе');
    assert.equal(created.location_id, aliceLocation.id);

    await tools.get('add_task_device').execute({
      task_id: created.id,
      device_id: device.id,
      quantity: 3,
    });
    const withService = await tools.get('add_task_service').execute({
      task_id: created.id,
      service_id: service.id,
    });
    assert.equal(withService.devices[0].quantity, 3);
    assert.equal(withService.services[0].quantity, 1);

    const listed = await tools.get('search_tasks').execute({ query: 'кассе' });
    assert.ok(listed.tasks.some((task) => task.id === created.id));
    const compact = listed.tasks.find((task) => task.id === created.id);
    assert.equal(compact.device_count, 1);
    assert.equal(compact.payments, undefined);

    const full = await tools.get('get_task').execute({ id: created.id });
    assert.ok(Array.isArray(full.payments));
    assert.equal(full.devices.length, 1);
  });

  it('omits write tools without rights and filters tasks by location', async () => {
    const readOnly = toolMap(
      createOpsTools({
        db,
        write: true,
        viewer: { seeAll: false, userId: alice.id },
        permissions: { tasks_read: true },
      })
    );
    assert.ok(readOnly.get('search_tasks'));
    assert.ok(readOnly.get('search_devices'));
    assert.ok(readOnly.get('search_repair_returns'));
    assert.equal(readOnly.get('create_task'), undefined);
    assert.equal(readOnly.get('create_task_client'), undefined);
    assert.equal(readOnly.get('create_device'), undefined);
    assert.equal(readOnly.get('create_repair_return'), undefined);

    const aliceTools = toolMap(
      createOpsTools({
        db,
        write: true,
        viewer: { seeAll: false, userId: alice.id },
        userId: alice.id,
      })
    );
    const bobTools = toolMap(
      createOpsTools({
        db,
        write: true,
        viewer: { seeAll: false, userId: bob.id },
        userId: bob.id,
      })
    );

    const hidden = await bobTools.get('create_task').execute({
      title: 'Только Боб',
      location_id: bobLocation.id,
    });
    const aliceSearch = await aliceTools.get('search_tasks').execute({ query: 'Только Боб' });
    assert.equal(aliceSearch.tasks.some((task) => task.id === hidden.id), false);
    const aliceGet = await aliceTools.get('get_task').execute({ id: hidden.id });
    assert.equal(aliceGet.ok, false);
    assert.equal(aliceGet.error, 'NOT_FOUND');
  });

  it('increments quantity when adding the same catalog item again', async () => {
    const tools = toolMap(
      createOpsTools({
        db,
        write: true,
        viewer: { seeAll: true, userId: null },
      })
    );
    const task = await tools.get('create_task').execute({
      title: 'Повтор устройства',
      location_id: aliceLocation.id,
    });
    await tools.get('add_task_device').execute({ task_id: task.id, device_id: device.id });
    const again = await tools.get('add_task_device').execute({
      task_id: task.id,
      device_id: device.id,
      quantity: 9,
    });
    assert.equal(again.devices.length, 1);
    assert.equal(again.devices[0].quantity, 2);
  });

  it('creates a catalog item and records a payment', async () => {
    const tools = toolMap(
      createOpsTools({
        db,
        write: true,
        viewer: { seeAll: true, userId: null },
      })
    );
    const created = await tools.get('create_device').execute({
      name: 'Сканер',
      price_uzs: 200000,
    });
    assert.equal(created.name, 'Сканер');
    const loaded = await tools.get('get_device').execute({ id: created.id });
    assert.equal(loaded.id, created.id);
    assert.equal(loaded.images, undefined);

    const task = await tools.get('create_task').execute({
      title: 'Оплата',
      location_id: aliceLocation.id,
      action: 'sale',
    });
    const types = await tools.get('list_payment_types').execute();
    const cash = types.payment_types.find((item) => item.name === 'Наличные') || types.payment_types[0];
    assert.ok(cash);
    assert.ok(listPaymentTypes(db).length >= 1);
    const paid = await tools.get('create_task_payment').execute({
      task_id: task.id,
      payment_type_id: cash.id,
      amount: 1000,
      currency: 'UZS',
    });
    assert.ok(paid.payment);
    assert.equal(paid.task.payments.length, 1);
  });

  it('lists pending repair returns, records a return, and can undo it', async () => {
    const tools = toolMap(
      createOpsTools({
        db,
        write: true,
        viewer: { seeAll: true, userId: null },
      })
    );
    const task = await tools.get('create_task').execute({
      title: 'Ремонт для возврата',
      location_id: aliceLocation.id,
      action: 'repair',
    });
    await tools.get('add_task_device').execute({
      task_id: task.id,
      device_id: device.id,
      quantity: 2,
    });
    await tools.get('advance_task_status').execute({ id: task.id });
    await tools.get('advance_task_status').execute({ id: task.id });
    await tools.get('post_task').execute({ id: task.id });
    const lineId = (await tools.get('get_task').execute({ id: task.id })).devices[0].id;

    const pending = await tools.get('search_repair_returns').execute({ query: 'возврата' });
    assert.equal(pending.require_serials, false);
    const pendingItem = pending.items.find((item) => item.device_line_id === lineId);
    assert.ok(pendingItem);
    assert.equal(pendingItem.kind, 'pending');
    assert.equal(pendingItem.remaining_quantity, 2);
    assert.equal(pendingItem.task.id, task.id);

    const created = await tools.get('create_repair_return').execute({
      device_line_id: lineId,
      quantity: 1,
      note: 'Частичный возврат',
    });
    assert.equal(created.item.kind, 'returned');
    assert.equal(created.item.return_quantity, 1);
    assert.equal(created.item.note, 'Частичный возврат');
    assert.ok(created.item.return_id);

    const returned = await tools.get('search_repair_returns').execute({
      query: 'возврата',
      status: 'returned',
    });
    assert.ok(returned.items.some((item) => item.return_id === created.item.return_id));

    const undone = await tools.get('delete_repair_return').execute({ id: created.item.return_id });
    assert.equal(undone.ok, true);
    const afterUndo = await tools.get('search_repair_returns').execute({
      query: 'возврата',
      status: 'returned',
    });
    assert.equal(afterUndo.items.some((item) => item.return_id === created.item.return_id), false);
  });

  it('creates a REGOS client through create_task_client', async () => {
    const tools = toolMap(
      createOpsTools({
        db,
        write: true,
        viewer: { seeAll: true, userId: null },
        deps: {
          createClient: async ({ name, phone }) => {
            assert.equal(name, 'Иван');
            assert.equal(phone, '998901112233');
            return { id: 77 };
          },
          getClientById: async (id) => ({ id, name: 'Иван', phone: '998901112233', email: null }),
        },
      })
    );
    const created = await tools.get('create_task_client').execute({
      name: 'Иван',
      phone: '998901112233',
    });
    assert.equal(created.id, 77);
    assert.equal(created.name, 'Иван');
    assert.equal(created.phone, '998901112233');

    const readOnly = toolMap(
      createOpsTools({
        db,
        write: false,
        viewer: { seeAll: true, userId: null },
      })
    );
    assert.equal(readOnly.get('create_task_client'), undefined);
  });

  it('maps REGOS errors from create_task_client', async () => {
    const error = new Error('Для создания клиента укажите имя или телефон.');
    error.name = 'RegosCrmError';
    error.code = 'BAD_REQUEST';
    const tools = toolMap(
      createOpsTools({
        db,
        write: true,
        viewer: { seeAll: true, userId: null },
        deps: {
          createClient: async () => {
            throw error;
          },
        },
      })
    );
    const result = await tools.get('create_task_client').execute({});
    assert.equal(result.ok, false);
    assert.equal(result.error, 'BAD_REQUEST');
    assert.match(result.message, /имя или телефон/);
  });

  it('previews the ops agent prompt without calling the model', () => {
    const { previewOpsAgentPrompt } = require('../src/ai/ops-agent');
    const { savePrompt } = require('../src/db/ai-prompts');
    const { addOpsSessionMessage, getOrCreateOpsSession } = require('../src/db/ops-agent-sessions');
    savePrompt(db, 'ops', 'OPS PREVIEW PROMPT');
    const session = getOrCreateOpsSession(db, { userId: alice.id });
    addOpsSessionMessage(db, session.id, { role: 'user', content: 'Найди задачу' });
    const preview = previewOpsAgentPrompt({
      db,
      userId: alice.id,
      sessionId: session.id,
      write: true,
      viewer: { seeAll: true, userId: null },
    });
    assert.equal(preview.system, 'OPS PREVIEW PROMPT');
    assert.equal(preview.session_id, session.id);
    assert.equal(preview.messages.at(-1).content, 'Найди задачу');
    assert.ok(preview.tools.some((tool) => tool.name === 'search_tasks'));
    assert.ok(preview.tools.some((tool) => tool.name === 'create_task'));
    assert.equal(
      preview.tools.every((tool) => tool.execute == null),
      true
    );
  });
});
