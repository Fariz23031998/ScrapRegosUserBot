const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const {
  addCatalogImage,
  deleteCatalogImagesForEntity,
  getCatalogImagesRoot,
  listCatalogImages,
} = require('../src/db/catalog-images');
const { createDevice, deleteDevice, getDevice } = require('../src/db/devices');
const { createService, deleteService, getService } = require('../src/db/services');
const { addTaskDevice, addTaskService, createTask, getTask } = require('../src/db/tasks');
const { setUsdUzsRate } = require('../src/db/money');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-catalog-images-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('catalog images', () => {
  let dbPath;
  let db;
  let imagesDir;
  let previousImagesDir;

  before(() => {
    previousImagesDir = process.env.CATALOG_IMAGES_DIR;
    imagesDir = makeTempDir('scrapregos-catalog-images-');
    process.env.CATALOG_IMAGES_DIR = imagesDir;
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    setUsdUzsRate(db, 12500);
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
    if (previousImagesDir == null) delete process.env.CATALOG_IMAGES_DIR;
    else process.env.CATALOG_IMAGES_DIR = previousImagesDir;
    fs.rmSync(imagesDir, { recursive: true, force: true });
  });

  it('stores images on catalog items and joins them onto task lines', () => {
    const device = createDevice(db, {
      name: 'POS-терминал',
      description: 'Кассовый терминал',
      cost_amount: 100,
      cost_currency: 'USD',
      price_usd: 150,
    });
    const service = createService(db, {
      name: 'Настройка',
      description: 'Пуско-наладка',
      cost_amount: 250000,
      cost_currency: 'UZS',
      price_uzs: 300000,
    });

    const deviceImage = addCatalogImage(db, 'device', device.id, {
      buffer: PNG_1X1,
      originalName: 'pos.png',
    });
    const serviceImage = addCatalogImage(db, 'service', service.id, {
      buffer: PNG_1X1,
      originalName: 'setup.png',
    });

    const loadedDevice = getDevice(db, device.id);
    assert.equal(loadedDevice.images.length, 1);
    assert.equal(loadedDevice.images[0].id, deviceImage.id);
    assert.equal(loadedDevice.images[0].url, `/bot-admin/api/devices/${device.id}/images/${deviceImage.id}`);
    assert.equal(path.extname(loadedDevice.images[0].filename), '.png');
    assert.equal(
      fs.existsSync(path.join(getCatalogImagesRoot(), 'device', String(device.id), loadedDevice.images[0].filename)),
      true
    );

    const task = createTask(db, { title: 'Выезд', devices: [] });
    addTaskDevice(db, task.id, { device_id: device.id, action: 'install' });
    addTaskService(db, task.id, { service_id: service.id });
    const loaded = getTask(db, task.id);

    assert.equal(loaded.devices[0].description, 'Кассовый терминал');
    assert.equal(loaded.devices[0].images.length, 1);
    assert.equal(loaded.devices[0].images[0].id, deviceImage.id);
    assert.equal(loaded.services[0].description, 'Пуско-наладка');
    assert.equal(loaded.services[0].images.length, 1);
    assert.equal(loaded.services[0].images[0].id, serviceImage.id);

    assert.throws(() => deleteDevice(db, device.id), /DEVICE_IN_USE/);
    assert.equal(listCatalogImages(db, 'device', device.id).length, 1);

    assert.throws(() => addCatalogImage(db, 'device', device.id, { buffer: Buffer.from('not-an-image') }), /INVALID_IMAGE_TYPE/);
  });

  it('removes image files when a catalog item is deleted', () => {
    const device = createDevice(db, {
      name: 'Сканер',
      cost_amount: 10,
      cost_currency: 'USD',
      price_usd: 20,
    });
    const image = addCatalogImage(db, 'device', device.id, {
      buffer: PNG_1X1,
      originalName: 'scanner.png',
    });
    const filePath = path.join(getCatalogImagesRoot(), 'device', String(device.id), `${image.id}.png`);
    assert.equal(fs.existsSync(filePath), true);

    assert.equal(deleteDevice(db, device.id), true);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(getDevice(db, device.id), null);
  });

  it('cleans service images on delete', () => {
    const service = createService(db, {
      name: 'Доставка',
      cost_amount: 1000,
      cost_currency: 'UZS',
      price_uzs: 2000,
    });
    const image = addCatalogImage(db, 'service', service.id, { buffer: PNG_1X1 });
    const filePath = path.join(getCatalogImagesRoot(), 'service', String(service.id), `${image.id}.png`);
    assert.equal(fs.existsSync(filePath), true);
    assert.equal(deleteService(db, service.id), true);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(getService(db, service.id), null);
    assert.equal(deleteCatalogImagesForEntity(db, 'service', service.id), 0);
  });
});
