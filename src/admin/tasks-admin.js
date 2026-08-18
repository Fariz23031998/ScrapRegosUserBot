const express = require('express');
const multer = require('multer');
const { getSessionActor, requireRight, requireAnyRight } = require('./bot-admin-auth');
const { getBotUserById, getBotUserByTelegramId, listEmployeeUsers } = require('../db/bot-users-db');
const {
  listLocations,
  listLocationsForViewer,
  getLocation,
  createLocation,
  updateLocation,
  deleteLocation,
  getLocationViewer,
} = require('../db/locations');
const {
  listPaymentTypes,
  getPaymentType,
  createPaymentType,
  updatePaymentType,
  deletePaymentType,
} = require('../db/payment-types');
const {
  addCatalogImage,
  countCatalogImages,
  deleteCatalogImage,
  getCatalogImage,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_ENTITY,
  resolveCatalogImageFile,
} = require('../db/catalog-images');
const { getUsdUzsRate, setUsdUzsRate } = require('../db/money');
const {
  listCatalogCategories,
  getCatalogCategory,
  createCatalogCategory,
  updateCatalogCategory,
  deleteCatalogCategory,
  parseCategoryFilter,
} = require('../db/catalog-categories');
const {
  listDevices,
  getDevice,
  createDevice,
  updateDevice,
  deleteDevice,
} = require('../db/devices');
const {
  listServices,
  getService,
  createService,
  updateService,
  deleteService,
} = require('../db/services');
const {
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
  updateTaskDevice,
  deleteTaskDevice,
  addTaskService,
  updateTaskService,
  deleteTaskService,
  applyTaskDiscount,
  deleteTask,
} = require('../db/tasks');
const {
  createTaskPayment,
  deleteTaskPayment,
  getTaskPayment,
} = require('../db/task-payments');
const { refundTaskLine } = require('../db/task-refunds');
const { RegosCrmError, searchClients } = require('../integrations/regos-crm');

function parsePaginationQuery(req) {
  const allowedLimits = [10, 25, 50, 100];
  let limit = Number(req.query.limit) || 25;
  if (!allowedLimits.includes(limit)) {
    limit = 25;
  }
  const page = Math.max(Number(req.query.page) || 1, 1);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function employeeLabel(user) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return (
    user.display_name ||
    fullName ||
    user.admin_login ||
    (user.username ? `@${user.username}` : null) ||
    `Сотрудник #${user.id}`
  );
}

function mapEmployee(user) {
  return {
    id: user.id,
    name: employeeLabel(user),
    display_name: user.display_name || null,
    phone: user.phone || null,
    job_title: user.job_title || null,
  };
}

function mapTaskClient(client) {
  return {
    id: client.id,
    name: client.name || null,
    phone: client.phone || null,
    email: client.email || null,
    external_id: client.external_id || null,
    photo_url: client.photo_url || null,
  };
}

function catalogMoneyFromBody(body = {}) {
  return {
    cost_amount: body.cost_amount,
    cost_currency: body.cost_currency,
    price_uzs: body.price_uzs,
    price_usd: body.price_usd,
    manager_sale_percent: body.manager_sale_percent,
    technician_score: body.technician_score,
  };
}

function deviceWriteErrorMessage(code) {
  if (code === 'INVALID_DEVICE_NAME') return 'Укажите название устройства.';
  if (code === 'INVALID_DEVICE_DESCRIPTION') return 'Слишком длинное описание устройства.';
  if (code === 'INVALID_DEVICE_CATEGORY') return 'Некорректная категория устройства.';
  if (code === 'DEVICE_IN_USE') return 'Устройство используется в задачах и не может быть удалено.';
  if (code === 'INVALID_MONEY_AMOUNT') return 'Некорректная сумма. Укажите число не меньше 0.';
  if (code === 'INVALID_COST_CURRENCY') return 'Валюта себестоимости: UZS или USD.';
  if (code === 'INVALID_PRICE') return 'Укажите цену в сумах или в USD.';
  if (code === 'INVALID_MANAGER_SALE_PERCENT') return 'Процент менеджеру: число от 0 до 100.';
  if (code === 'INVALID_TECHNICIAN_SCORE') return 'Баллы технику: число не меньше 0.';
  return null;
}

function serviceWriteErrorMessage(code) {
  if (code === 'INVALID_SERVICE_NAME') return 'Укажите название услуги.';
  if (code === 'INVALID_SERVICE_DESCRIPTION') return 'Слишком длинное описание услуги.';
  if (code === 'INVALID_SERVICE_CATEGORY') return 'Некорректная категория услуги.';
  if (code === 'SERVICE_IN_USE') return 'Услуга используется в задачах и не может быть удалена.';
  if (code === 'INVALID_MONEY_AMOUNT') return 'Некорректная сумма. Укажите число не меньше 0.';
  if (code === 'INVALID_COST_CURRENCY') return 'Валюта себестоимости: UZS или USD.';
  if (code === 'INVALID_PRICE') return 'Укажите цену в сумах или в USD.';
  if (code === 'INVALID_MANAGER_SALE_PERCENT') return 'Процент менеджеру: число от 0 до 100.';
  if (code === 'INVALID_TECHNICIAN_SCORE') return 'Баллы технику: число не меньше 0.';
  return null;
}

function categoryWriteErrorMessage(code) {
  if (code === 'INVALID_CATEGORY_NAME') return 'Укажите название категории.';
  return null;
}

function locationWriteErrorMessage(code) {
  if (code === 'INVALID_LOCATION_NAME') return 'Укажите название локации.';
  if (code === 'INVALID_LOCATION_USERS') return 'Выберите хотя бы одного сотрудника с доступом к локации.';
  return null;
}

function paymentTypeWriteErrorMessage(code) {
  if (code === 'INVALID_PAYMENT_TYPE_NAME') return 'Укажите название типа оплаты.';
  if (code === 'INVALID_PAYMENT_TYPE_CURRENCY') return 'Валюта типа оплаты: UZS или USD.';
  return null;
}

function taskWriteErrorMessage(code) {
  const messages = {
    INVALID_TASK_TITLE: 'Укажите название задачи.',
    INVALID_TASK_NOTES: 'Слишком длинные заметки задачи.',
    INVALID_TASK_ADDRESS: 'Слишком длинный адрес.',
    INVALID_TASK_CLIENT: 'Некорректные данные клиента.',
    INVALID_TASK_STATUS: 'Некорректный статус задачи.',
    INVALID_TASK_CATEGORY: 'Некорректная категория задачи.',
    INVALID_TASK_LOCATION: 'Выберите локацию, к которой у вас есть доступ.',
    INVALID_TASK_MANAGER: 'Некорректный менеджер.',
    INVALID_TASK_TECHNICIAN: 'Некорректный техник.',
    INVALID_TASK_DEVICES: 'Некорректный список устройств.',
    INVALID_TASK_DEVICE: 'Некорректное устройство в задаче.',
    INVALID_TASK_ACTION: 'Укажите действие: установка или ремонт.',
    INVALID_TASK_CURRENCY: 'Валюта задачи: UZS, USD или обе.',
    INVALID_TASK_DEVICE_NOTES: 'Слишком длинная заметка по устройству.',
    INVALID_TASK_SERVICE: 'Некорректная услуга в задаче.',
    INVALID_TASK_SERVICE_NOTES: 'Слишком длинная заметка по услуге.',
    INVALID_TASK_QUANTITY: 'Укажите количество от 1 до 999.',
    INVALID_TASK_DISCOUNT: 'Укажите скидку: процент от 0 до 100 или сумму не меньше 0.',
    INVALID_TASK_DISCOUNT_TARGET: 'Выберите позиции для скидки.',
    INVALID_TASK_PAYMENT_AMOUNT: 'Укажите сумму оплаты больше 0.',
    INVALID_TASK_PAYMENT_TYPE: 'Выберите тип оплаты.',
    INVALID_TASK_PAYMENT_CURRENCY: 'Валюта оплаты: UZS или USD.',
    INVALID_TASK_PAYMENT_NOTE: 'Слишком длинный комментарий к оплате.',
    INVALID_TASK_REFUND_LINE: 'Выберите позицию для возврата.',
    INVALID_TASK_REFUND_QUANTITY: 'Укажите количество для возврата.',
    INVALID_TASK_REFUND_AMOUNT: 'Сумма возврата не может превышать стоимость позиции.',
  };
  return messages[code] || null;
}

function catalogImageErrorMessage(code) {
  if (code === 'INVALID_IMAGE_TYPE') return 'Загрузите изображение JPEG, PNG, WebP или GIF.';
  if (code === 'INVALID_IMAGE_SIZE') return 'Изображение слишком большое. Максимум 5 МБ.';
  if (code === 'IMAGE_LIMIT_REACHED') return 'Можно прикрепить не больше 8 изображений.';
  if (code === 'INVALID_IMAGE_ENTITY') return 'Некорректный тип каталога.';
  return null;
}

const catalogImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_ENTITY },
});

function handleCatalogImageUpload(req, res, next) {
  catalogImageUpload.array('image', MAX_IMAGES_PER_ENTITY)(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: catalogImageErrorMessage('INVALID_IMAGE_SIZE') });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ message: catalogImageErrorMessage('IMAGE_LIMIT_REACHED') });
    }
    return res.status(400).json({ message: catalogImageErrorMessage('INVALID_IMAGE_TYPE') });
  });
}

function sendCatalogImageFile(res, db, entityType, entityId, imageId) {
  const row = getCatalogImage(db, entityType, entityId, imageId);
  if (!row) return res.status(404).json({ message: 'Изображение не найдено.' });
  const file = resolveCatalogImageFile(row);
  if (!file) return res.status(404).json({ message: 'Изображение не найдено.' });
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  return res.sendFile(file.filePath);
}

function uploadedImageFiles(req) {
  return Array.isArray(req.files) ? req.files : [];
}

function saveUploadedCatalogImages(db, entityType, entityId, files) {
  const incoming = Array.isArray(files) ? files : [];
  if (!incoming.length) throw new Error('INVALID_IMAGE_TYPE');
  const remaining = MAX_IMAGES_PER_ENTITY - countCatalogImages(db, entityType, entityId);
  if (remaining <= 0 || incoming.length > remaining) throw new Error('IMAGE_LIMIT_REACHED');
  for (const file of incoming) {
    addCatalogImage(db, entityType, entityId, {
      buffer: file.buffer,
      originalName: file.originalname,
    });
  }
}

function respondWriteError(res, error, fallbackMessage, mapMessage) {
  if (error.message === 'NOT_FOUND') {
    return res.status(404).json({ message: fallbackMessage });
  }
  const mapped = mapMessage(error.message);
  if (mapped) {
    return res.status(400).json({ message: mapped });
  }
  console.error(fallbackMessage, error);
  return res.status(500).json({ message: fallbackMessage });
}

function registerTaskRoutes(router, db, { auditAdminChange, buildAuditDetails }) {
  function taskViewer(req) {
    return getLocationViewer(db, getSessionActor(req));
  }

  // Password-only admin sessions are not linked to a bot user, so payments they
  // take are stored without an author.
  function sessionUserId(req) {
    const actor = getSessionActor(req);
    if (actor?.type === 'telegram') return getBotUserByTelegramId(db, actor.telegramId)?.id ?? null;
    if (actor?.type === 'user') return getBotUserById(db, actor.userId)?.id ?? null;
    return null;
  }

  function visibleTask(req, id = req.params.id) {
    return getTask(db, id, taskViewer(req));
  }

  function requireVisibleTask(req, res) {
    const task = visibleTask(req);
    if (!task) {
      res.status(404).json({ message: 'Задача не найдена.' });
      return null;
    }
    return task;
  }

  router.get(
    '/api/settings/exchange-rate',
    requireAnyRight(db, ['settings_read', 'tasks_read', 'devices_read', 'services_read']),
    (_req, res) => {
      try {
        return res.json({ usd_uzs_rate: getUsdUzsRate(db) });
      } catch (error) {
        console.error('Get exchange rate error:', error);
        return res.status(500).json({ message: 'Не удалось загрузить курс валют.' });
      }
    }
  );

  router.put('/api/settings/exchange-rate', requireRight(db, 'settings_edit'), express.json(), (req, res) => {
    try {
      const before = getUsdUzsRate(db);
      const usd_uzs_rate = setUsdUzsRate(db, req.body?.usd_uzs_rate);
      auditAdminChange(db, req, {
        entityType: 'settings',
        entityId: 'usd_uzs_rate',
        action: 'update',
        summary: `Изменён курс валют: 1 USD = ${usd_uzs_rate} UZS`,
        details: buildAuditDetails({ before: { usd_uzs_rate: before }, after: { usd_uzs_rate } }),
      });
      return res.json({ usd_uzs_rate });
    } catch (error) {
      if (error.message === 'INVALID_EXCHANGE_RATE') {
        return res.status(400).json({ message: 'Курс должен быть числом больше 0.' });
      }
      console.error('Save exchange rate error:', error);
      return res.status(500).json({ message: 'Не удалось сохранить курс валют.' });
    }
  });

  router.get('/api/settings/locations', requireRight(db, 'settings_read'), (_req, res) => {
    try {
      return res.json({ locations: listLocations(db) });
    } catch (error) {
      console.error('List locations error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить локации.' });
    }
  });

  router.post('/api/settings/locations', requireRight(db, 'settings_edit'), express.json(), (req, res) => {
    try {
      const location = createLocation(db, {
        name: req.body?.name,
        allowed_user_ids: req.body?.allowed_user_ids,
      });
      auditAdminChange(db, req, {
        entityType: 'location',
        entityId: location.id,
        action: 'create',
        summary: `Создана локация «${location.name}»`,
        details: buildAuditDetails({ before: null, after: location }),
      });
      return res.status(201).json({ location });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось создать локацию.', locationWriteErrorMessage);
    }
  });

  router.put('/api/settings/locations/:id', requireRight(db, 'settings_edit'), express.json(), (req, res) => {
    try {
      const before = getLocation(db, req.params.id);
      const location = updateLocation(db, req.params.id, {
        name: req.body?.name,
        allowed_user_ids: req.body?.allowed_user_ids,
      });
      auditAdminChange(db, req, {
        entityType: 'location',
        entityId: location.id,
        action: 'update',
        summary: `Изменена локация #${location.id}`,
        details: buildAuditDetails({ before, after: location }),
      });
      return res.json({ location });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Локация не найдена.' : 'Не удалось обновить локацию.',
        locationWriteErrorMessage
      );
    }
  });

  router.delete('/api/settings/locations/:id', requireRight(db, 'settings_edit'), (req, res) => {
    try {
      const before = getLocation(db, req.params.id);
      const deleted = deleteLocation(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Локация не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'location',
        entityId: before.id,
        action: 'delete',
        summary: `Удалена локация «${before.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось удалить локацию.', locationWriteErrorMessage);
    }
  });

  router.get('/api/settings/payment-types', requireRight(db, 'settings_read'), (_req, res) => {
    try {
      return res.json({ payment_types: listPaymentTypes(db) });
    } catch (error) {
      console.error('List payment types error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить типы оплаты.' });
    }
  });

  router.post('/api/settings/payment-types', requireRight(db, 'settings_edit'), express.json(), (req, res) => {
    try {
      const paymentType = createPaymentType(db, { name: req.body?.name, currency: req.body?.currency });
      auditAdminChange(db, req, {
        entityType: 'payment_type',
        entityId: paymentType.id,
        action: 'create',
        summary: `Создан тип оплаты «${paymentType.name}»`,
        details: buildAuditDetails({ before: null, after: paymentType }),
      });
      return res.status(201).json({ payment_type: paymentType });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось создать тип оплаты.', paymentTypeWriteErrorMessage);
    }
  });

  router.put('/api/settings/payment-types/:id', requireRight(db, 'settings_edit'), express.json(), (req, res) => {
    try {
      const before = getPaymentType(db, req.params.id);
      const paymentType = updatePaymentType(db, req.params.id, {
        name: req.body?.name,
        currency: req.body?.currency,
      });
      auditAdminChange(db, req, {
        entityType: 'payment_type',
        entityId: paymentType.id,
        action: 'update',
        summary: `Изменён тип оплаты #${paymentType.id}`,
        details: buildAuditDetails({ before, after: paymentType }),
      });
      return res.json({ payment_type: paymentType });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Тип оплаты не найден.' : 'Не удалось обновить тип оплаты.',
        paymentTypeWriteErrorMessage
      );
    }
  });

  router.delete('/api/settings/payment-types/:id', requireRight(db, 'settings_edit'), (req, res) => {
    try {
      const before = getPaymentType(db, req.params.id);
      const deleted = deletePaymentType(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Тип оплаты не найден.' });
      auditAdminChange(db, req, {
        entityType: 'payment_type',
        entityId: before.id,
        action: 'delete',
        summary: `Удалён тип оплаты «${before.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось удалить тип оплаты.', paymentTypeWriteErrorMessage);
    }
  });

  router.get('/api/devices/categories', requireAnyRight(db, ['devices_read', 'tasks_read']), (_req, res) => {
    try {
      return res.json({ categories: listCatalogCategories(db, 'device') });
    } catch (error) {
      console.error('List device categories error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить категории.' });
    }
  });

  router.post('/api/devices/categories', requireRight(db, 'devices_edit'), express.json(), (req, res) => {
    try {
      const category = createCatalogCategory(db, 'device', { name: req.body?.name });
      auditAdminChange(db, req, {
        entityType: 'device_category',
        entityId: category.id,
        action: 'create',
        summary: `Создана категория устройств «${category.name}»`,
        details: buildAuditDetails({ before: null, after: category }),
      });
      return res.status(201).json({ category });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось создать категорию.', categoryWriteErrorMessage);
    }
  });

  router.put('/api/devices/categories/:id', requireRight(db, 'devices_edit'), express.json(), (req, res) => {
    try {
      const before = getCatalogCategory(db, 'device', req.params.id);
      const category = updateCatalogCategory(db, 'device', req.params.id, { name: req.body?.name });
      auditAdminChange(db, req, {
        entityType: 'device_category',
        entityId: category.id,
        action: 'update',
        summary: `Изменена категория устройств #${category.id}`,
        details: buildAuditDetails({ before, after: category }),
      });
      return res.json({ category });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Категория не найдена.' : 'Не удалось обновить категорию.',
        categoryWriteErrorMessage
      );
    }
  });

  router.delete('/api/devices/categories/:id', requireRight(db, 'devices_edit'), (req, res) => {
    try {
      const before = getCatalogCategory(db, 'device', req.params.id);
      const deleted = deleteCatalogCategory(db, 'device', req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Категория не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'device_category',
        entityId: before.id,
        action: 'delete',
        summary: `Удалена категория устройств «${before.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось удалить категорию.', categoryWriteErrorMessage);
    }
  });

  router.get('/api/devices', requireAnyRight(db, ['devices_read', 'tasks_read']), (req, res) => {
    try {
      const query = String(req.query.q || '').trim();
      const categoryId = parseCategoryFilter(req.query.category_id);
      let { page, limit, offset } = parsePaginationQuery(req);
      let result = listDevices(db, { query, categoryId, offset, limit });
      const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
      if (page > totalPages) {
        page = totalPages;
        offset = (page - 1) * limit;
        result = listDevices(db, { query, categoryId, offset, limit });
      }
      return res.json({
        devices: result.devices,
        total: result.total,
        page,
        limit,
      });
    } catch (error) {
      console.error('List devices error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить устройства.' });
    }
  });

  router.post('/api/devices', requireRight(db, 'devices_create'), express.json(), (req, res) => {
    try {
      const device = createDevice(db, {
        name: req.body?.name,
        description: req.body?.description,
        category_id: req.body?.category_id,
        ...catalogMoneyFromBody(req.body),
      });
      auditAdminChange(db, req, {
        entityType: 'device',
        entityId: device.id,
        action: 'create',
        summary: `Создано устройство «${device.name}»`,
        details: buildAuditDetails({ before: null, after: device }),
      });
      return res.status(201).json({ device });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось создать устройство.', deviceWriteErrorMessage);
    }
  });

  router.put('/api/devices/:id', requireRight(db, 'devices_edit'), express.json(), (req, res) => {
    try {
      const before = getDevice(db, req.params.id);
      const device = updateDevice(db, req.params.id, {
        name: req.body?.name,
        description: req.body?.description,
        category_id: req.body?.category_id,
        ...catalogMoneyFromBody(req.body),
      });
      auditAdminChange(db, req, {
        entityType: 'device',
        entityId: device.id,
        action: 'update',
        summary: `Изменено устройство #${device.id}`,
        details: buildAuditDetails({ before, after: device }),
      });
      return res.json({ device });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Устройство не найдено.' : 'Не удалось обновить устройство.',
        deviceWriteErrorMessage
      );
    }
  });

  router.delete('/api/devices/:id', requireRight(db, 'devices_delete'), (req, res) => {
    try {
      const before = getDevice(db, req.params.id);
      const deleted = deleteDevice(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Устройство не найдено.' });
      auditAdminChange(db, req, {
        entityType: 'device',
        entityId: before.id,
        action: 'delete',
        summary: `Удалено устройство «${before.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось удалить устройство.', deviceWriteErrorMessage);
    }
  });

  router.get(
    '/api/devices/:id/images/:imageId',
    requireAnyRight(db, ['devices_read', 'tasks_read']),
    (req, res) => sendCatalogImageFile(res, db, 'device', req.params.id, req.params.imageId)
  );

  router.post(
    '/api/devices/:id/images',
    requireAnyRight(db, ['devices_edit', 'tasks_edit']),
    handleCatalogImageUpload,
    (req, res) => {
      try {
        const before = getDevice(db, req.params.id);
        if (!before) return res.status(404).json({ message: 'Устройство не найдено.' });
        saveUploadedCatalogImages(db, 'device', before.id, uploadedImageFiles(req));
        const device = getDevice(db, before.id);
        auditAdminChange(db, req, {
          entityType: 'device',
          entityId: device.id,
          action: 'update',
          summary: `Добавлены фото устройства «${device.name}»`,
          details: buildAuditDetails({ before, after: device }),
        });
        return res.status(201).json({ device });
      } catch (error) {
        return respondWriteError(
          res,
          error,
          error.message === 'NOT_FOUND' ? 'Устройство не найдено.' : 'Не удалось загрузить изображение.',
          (code) => catalogImageErrorMessage(code) || deviceWriteErrorMessage(code)
        );
      }
    }
  );

  router.delete(
    '/api/devices/:id/images/:imageId',
    requireAnyRight(db, ['devices_edit', 'tasks_edit']),
    (req, res) => {
      try {
        const before = getDevice(db, req.params.id);
        if (!before) return res.status(404).json({ message: 'Устройство не найдено.' });
        deleteCatalogImage(db, 'device', before.id, req.params.imageId);
        const device = getDevice(db, before.id);
        auditAdminChange(db, req, {
          entityType: 'device',
          entityId: device.id,
          action: 'update',
          summary: `Удалено фото устройства «${device.name}»`,
          details: buildAuditDetails({ before, after: device }),
        });
        return res.json({ device });
      } catch (error) {
        return respondWriteError(
          res,
          error,
          error.message === 'NOT_FOUND' ? 'Изображение не найдено.' : 'Не удалось удалить изображение.',
          (code) => catalogImageErrorMessage(code) || deviceWriteErrorMessage(code)
        );
      }
    }
  );

  router.get('/api/services/categories', requireAnyRight(db, ['services_read', 'tasks_read']), (_req, res) => {
    try {
      return res.json({ categories: listCatalogCategories(db, 'service') });
    } catch (error) {
      console.error('List service categories error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить категории.' });
    }
  });

  router.post('/api/services/categories', requireRight(db, 'services_edit'), express.json(), (req, res) => {
    try {
      const category = createCatalogCategory(db, 'service', { name: req.body?.name });
      auditAdminChange(db, req, {
        entityType: 'service_category',
        entityId: category.id,
        action: 'create',
        summary: `Создана категория услуг «${category.name}»`,
        details: buildAuditDetails({ before: null, after: category }),
      });
      return res.status(201).json({ category });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось создать категорию.', categoryWriteErrorMessage);
    }
  });

  router.put('/api/services/categories/:id', requireRight(db, 'services_edit'), express.json(), (req, res) => {
    try {
      const before = getCatalogCategory(db, 'service', req.params.id);
      const category = updateCatalogCategory(db, 'service', req.params.id, { name: req.body?.name });
      auditAdminChange(db, req, {
        entityType: 'service_category',
        entityId: category.id,
        action: 'update',
        summary: `Изменена категория услуг #${category.id}`,
        details: buildAuditDetails({ before, after: category }),
      });
      return res.json({ category });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Категория не найдена.' : 'Не удалось обновить категорию.',
        categoryWriteErrorMessage
      );
    }
  });

  router.delete('/api/services/categories/:id', requireRight(db, 'services_edit'), (req, res) => {
    try {
      const before = getCatalogCategory(db, 'service', req.params.id);
      const deleted = deleteCatalogCategory(db, 'service', req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Категория не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'service_category',
        entityId: before.id,
        action: 'delete',
        summary: `Удалена категория услуг «${before.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось удалить категорию.', categoryWriteErrorMessage);
    }
  });

  router.get('/api/services', requireAnyRight(db, ['services_read', 'tasks_read']), (req, res) => {
    try {
      const query = String(req.query.q || '').trim();
      const categoryId = parseCategoryFilter(req.query.category_id);
      let { page, limit, offset } = parsePaginationQuery(req);
      let result = listServices(db, { query, categoryId, offset, limit });
      const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
      if (page > totalPages) {
        page = totalPages;
        offset = (page - 1) * limit;
        result = listServices(db, { query, categoryId, offset, limit });
      }
      return res.json({
        services: result.services,
        total: result.total,
        page,
        limit,
      });
    } catch (error) {
      console.error('List services error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить услуги.' });
    }
  });

  router.post('/api/services', requireRight(db, 'services_create'), express.json(), (req, res) => {
    try {
      const service = createService(db, {
        name: req.body?.name,
        description: req.body?.description,
        category_id: req.body?.category_id,
        ...catalogMoneyFromBody(req.body),
      });
      auditAdminChange(db, req, {
        entityType: 'service',
        entityId: service.id,
        action: 'create',
        summary: `Создана услуга «${service.name}»`,
        details: buildAuditDetails({ before: null, after: service }),
      });
      return res.status(201).json({ service });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось создать услугу.', serviceWriteErrorMessage);
    }
  });

  router.put('/api/services/:id', requireRight(db, 'services_edit'), express.json(), (req, res) => {
    try {
      const before = getService(db, req.params.id);
      const service = updateService(db, req.params.id, {
        name: req.body?.name,
        description: req.body?.description,
        category_id: req.body?.category_id,
        ...catalogMoneyFromBody(req.body),
      });
      auditAdminChange(db, req, {
        entityType: 'service',
        entityId: service.id,
        action: 'update',
        summary: `Изменена услуга #${service.id}`,
        details: buildAuditDetails({ before, after: service }),
      });
      return res.json({ service });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Услуга не найдена.' : 'Не удалось обновить услугу.',
        serviceWriteErrorMessage
      );
    }
  });

  router.delete('/api/services/:id', requireRight(db, 'services_delete'), (req, res) => {
    try {
      const before = getService(db, req.params.id);
      const deleted = deleteService(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Услуга не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'service',
        entityId: before.id,
        action: 'delete',
        summary: `Удалена услуга «${before.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось удалить услугу.', serviceWriteErrorMessage);
    }
  });

  router.get(
    '/api/services/:id/images/:imageId',
    requireAnyRight(db, ['services_read', 'tasks_read']),
    (req, res) => sendCatalogImageFile(res, db, 'service', req.params.id, req.params.imageId)
  );

  router.post(
    '/api/services/:id/images',
    requireAnyRight(db, ['services_edit', 'tasks_edit']),
    handleCatalogImageUpload,
    (req, res) => {
      try {
        const before = getService(db, req.params.id);
        if (!before) return res.status(404).json({ message: 'Услуга не найдена.' });
        saveUploadedCatalogImages(db, 'service', before.id, uploadedImageFiles(req));
        const service = getService(db, before.id);
        auditAdminChange(db, req, {
          entityType: 'service',
          entityId: service.id,
          action: 'update',
          summary: `Добавлены фото услуги «${service.name}»`,
          details: buildAuditDetails({ before, after: service }),
        });
        return res.status(201).json({ service });
      } catch (error) {
        return respondWriteError(
          res,
          error,
          error.message === 'NOT_FOUND' ? 'Услуга не найдена.' : 'Не удалось загрузить изображение.',
          (code) => catalogImageErrorMessage(code) || serviceWriteErrorMessage(code)
        );
      }
    }
  );

  router.delete(
    '/api/services/:id/images/:imageId',
    requireAnyRight(db, ['services_edit', 'tasks_edit']),
    (req, res) => {
      try {
        const before = getService(db, req.params.id);
        if (!before) return res.status(404).json({ message: 'Услуга не найдена.' });
        deleteCatalogImage(db, 'service', before.id, req.params.imageId);
        const service = getService(db, before.id);
        auditAdminChange(db, req, {
          entityType: 'service',
          entityId: service.id,
          action: 'update',
          summary: `Удалено фото услуги «${service.name}»`,
          details: buildAuditDetails({ before, after: service }),
        });
        return res.json({ service });
      } catch (error) {
        return respondWriteError(
          res,
          error,
          error.message === 'NOT_FOUND' ? 'Изображение не найдено.' : 'Не удалось удалить изображение.',
          (code) => catalogImageErrorMessage(code) || serviceWriteErrorMessage(code)
        );
      }
    }
  );

  router.get('/api/tasks/categories', requireRight(db, 'tasks_read'), (_req, res) => {
    try {
      return res.json({ categories: listTaskCategories(db) });
    } catch (error) {
      console.error('List task categories error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить категории.' });
    }
  });

  router.post('/api/tasks/categories', requireRight(db, 'tasks_edit'), express.json(), (req, res) => {
    try {
      const category = createTaskCategory(db, { name: req.body?.name });
      auditAdminChange(db, req, {
        entityType: 'task_category',
        entityId: category.id,
        action: 'create',
        summary: `Создана категория задач «${category.name}»`,
        details: buildAuditDetails({ before: null, after: category }),
      });
      return res.status(201).json({ category });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось создать категорию.', categoryWriteErrorMessage);
    }
  });

  router.put('/api/tasks/categories/:id', requireRight(db, 'tasks_edit'), express.json(), (req, res) => {
    try {
      const before = getTaskCategory(db, req.params.id);
      const category = updateTaskCategory(db, req.params.id, { name: req.body?.name });
      auditAdminChange(db, req, {
        entityType: 'task_category',
        entityId: category.id,
        action: 'update',
        summary: `Изменена категория задач #${category.id}`,
        details: buildAuditDetails({ before, after: category }),
      });
      return res.json({ category });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Категория не найдена.' : 'Не удалось обновить категорию.',
        categoryWriteErrorMessage
      );
    }
  });

  router.delete('/api/tasks/categories/:id', requireRight(db, 'tasks_edit'), (req, res) => {
    try {
      const before = getTaskCategory(db, req.params.id);
      const deleted = deleteTaskCategory(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Категория не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'task_category',
        entityId: before.id,
        action: 'delete',
        summary: `Удалена категория задач «${before.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось удалить категорию.', categoryWriteErrorMessage);
    }
  });

  router.get('/api/tasks/employees', requireAnyRight(db, ['tasks_read', 'settings_read']), (_req, res) => {
    try {
      const employees = listEmployeeUsers(db).map(mapEmployee);
      employees.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      return res.json({ employees });
    } catch (error) {
      console.error('List task employees error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить сотрудников.' });
    }
  });

  router.get('/api/tasks/locations', requireRight(db, 'tasks_read'), (req, res) => {
    try {
      return res.json({ locations: listLocationsForViewer(db, taskViewer(req)) });
    } catch (error) {
      console.error('List task locations error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить локации.' });
    }
  });

  // Registered before '/api/tasks/:id' so Express does not treat it as a task id.
  router.get('/api/tasks/payment-types', requireRight(db, 'tasks_read'), (_req, res) => {
    try {
      return res.json({ payment_types: listPaymentTypes(db) });
    } catch (error) {
      console.error('List task payment types error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить типы оплаты.' });
    }
  });

  router.get('/api/tasks/clients', requireRight(db, 'tasks_read'), async (req, res) => {
    try {
      const query = String(req.query.q || '').trim();
      if (query.length < 2) {
        return res.json({ clients: [] });
      }
      const clients = await searchClients(query, { limit: 20 });
      return res.json({ clients: clients.map(mapTaskClient) });
    } catch (error) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error('Search task clients error:', error);
      return res.status(500).json({ message: 'Не удалось найти клиентов REGOS.' });
    }
  });

  router.get('/api/tasks', requireRight(db, 'tasks_read'), (req, res) => {
    try {
      const query = String(req.query.q || '').trim();
      const status = String(req.query.status || '').trim();
      const categoryId = String(req.query.category_id || '').trim();
      const locationId = String(req.query.location_id || '').trim();
      const viewer = taskViewer(req);
      let { page, limit, offset } = parsePaginationQuery(req);
      let result = listTasks(db, {
        query,
        status: status || undefined,
        categoryId: categoryId || undefined,
        locationId: locationId || undefined,
        viewer,
        offset,
        limit,
      });
      const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
      if (page > totalPages) {
        page = totalPages;
        offset = (page - 1) * limit;
        result = listTasks(db, {
          query,
          status: status || undefined,
          categoryId: categoryId || undefined,
          locationId: locationId || undefined,
          viewer,
          offset,
          limit,
        });
      }
      return res.json({
        tasks: result.tasks,
        total: result.total,
        page,
        limit,
      });
    } catch (error) {
      const mapped = taskWriteErrorMessage(error.message);
      if (mapped) return res.status(400).json({ message: mapped });
      console.error('List tasks error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить задачи.' });
    }
  });

  router.get('/api/tasks/:id', requireRight(db, 'tasks_read'), (req, res) => {
    const task = visibleTask(req);
    if (!task) return res.status(404).json({ message: 'Задача не найдена.' });
    return res.json({ task });
  });

  router.post('/api/tasks/:id/devices', requireRight(db, 'tasks_edit'), express.json(), (req, res) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = addTaskDevice(db, req.params.id, {
        device_id: req.body?.device_id,
        action: req.body?.action,
        notes: req.body?.notes,
      });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task.id,
        action: 'update',
        summary: `Добавлено устройство в задачу #${task.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.status(201).json({ task });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось добавить устройство.',
        taskWriteErrorMessage
      );
    }
  });

  router.put('/api/tasks/:id/devices/:lineId', requireRight(db, 'tasks_edit'), express.json(), (req, res) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = updateTaskDevice(db, req.params.id, req.params.lineId, {
        quantity: req.body?.quantity,
      });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task.id,
        action: 'update',
        summary: `Изменено количество устройства в задаче #${task.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Строка задачи не найдена.' : 'Не удалось обновить устройство.',
        taskWriteErrorMessage
      );
    }
  });

  router.delete('/api/tasks/:id/devices/:lineId', requireRight(db, 'tasks_edit'), (req, res) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = deleteTaskDevice(db, req.params.id, req.params.lineId);
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task.id,
        action: 'update',
        summary: `Удалено устройство из задачи #${task.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Строка задачи не найдена.' : 'Не удалось удалить устройство.',
        taskWriteErrorMessage
      );
    }
  });

  router.post('/api/tasks/:id/services', requireRight(db, 'tasks_edit'), express.json(), (req, res) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = addTaskService(db, req.params.id, {
        service_id: req.body?.service_id,
        notes: req.body?.notes,
      });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task.id,
        action: 'update',
        summary: `Добавлена услуга в задачу #${task.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.status(201).json({ task });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось добавить услугу.',
        taskWriteErrorMessage
      );
    }
  });

  router.put('/api/tasks/:id/services/:lineId', requireRight(db, 'tasks_edit'), express.json(), (req, res) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = updateTaskService(db, req.params.id, req.params.lineId, {
        quantity: req.body?.quantity,
      });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task.id,
        action: 'update',
        summary: `Изменено количество услуги в задаче #${task.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Строка задачи не найдена.' : 'Не удалось обновить услугу.',
        taskWriteErrorMessage
      );
    }
  });

  router.delete('/api/tasks/:id/services/:lineId', requireRight(db, 'tasks_edit'), (req, res) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = deleteTaskService(db, req.params.id, req.params.lineId);
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task.id,
        action: 'update',
        summary: `Удалена услуга из задачи #${task.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Строка задачи не найдена.' : 'Не удалось удалить услугу.',
        taskWriteErrorMessage
      );
    }
  });

  router.post('/api/tasks/:id/discount', requireRight(db, 'tasks_edit'), express.json(), (req, res) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = applyTaskDiscount(db, req.params.id, req.body || {});
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task.id,
        action: 'update',
        summary: `Изменена скидка в задаче #${task.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось применить скидку.',
        taskWriteErrorMessage
      );
    }
  });

  router.post(
    '/api/tasks/:id/payments',
    requireRight(db, 'tasks_payment_create'),
    express.json(),
    (req, res) => {
      try {
        const before = requireVisibleTask(req, res);
        if (!before) return;
        const payment = createTaskPayment(db, before.id, {
          payment_type_id: req.body?.payment_type_id,
          amount: req.body?.amount,
          currency: req.body?.currency,
          note: req.body?.note,
          created_by_user_id: sessionUserId(req),
        });
        const task = visibleTask(req);
        auditAdminChange(db, req, {
          entityType: 'task',
          entityId: before.id,
          action: 'update',
          summary: `Принята оплата ${payment.amount} ${payment.currency} по задаче #${before.id}`,
          details: buildAuditDetails({ before, after: task }),
        });
        return res.status(201).json({ task });
      } catch (error) {
        return respondWriteError(
          res,
          error,
          error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось принять оплату.',
          taskWriteErrorMessage
        );
      }
    }
  );

  router.delete(
    '/api/tasks/:id/payments/:paymentId',
    requireRight(db, 'tasks_payment_delete'),
    (req, res) => {
      try {
        const before = requireVisibleTask(req, res);
        if (!before) return;
        const payment = getTaskPayment(db, before.id, req.params.paymentId);
        if (!payment) return res.status(404).json({ message: 'Оплата не найдена.' });
        deleteTaskPayment(db, before.id, payment.id);
        const task = visibleTask(req);
        auditAdminChange(db, req, {
          entityType: 'task',
          entityId: before.id,
          action: 'update',
          summary: `Удалена оплата ${payment.amount} ${payment.currency} по задаче #${before.id}`,
          details: buildAuditDetails({ before, after: task }),
        });
        return res.json({ task });
      } catch (error) {
        return respondWriteError(
          res,
          error,
          error.message === 'NOT_FOUND' ? 'Оплата не найдена.' : 'Не удалось удалить оплату.',
          taskWriteErrorMessage
        );
      }
    }
  );

  router.post(
    '/api/tasks/:id/refunds',
    requireRight(db, 'tasks_edit'),
    requireRight(db, 'tasks_payment_create'),
    express.json(),
    (req, res) => {
      try {
        const before = requireVisibleTask(req, res);
        if (!before) return;
        const result = refundTaskLine(
          db,
          before.id,
          {
            kind: req.body?.kind,
            line_id: req.body?.line_id,
            quantity: req.body?.quantity,
            payment_type_id: req.body?.payment_type_id,
            amount: req.body?.amount,
            currency: req.body?.currency,
            note: req.body?.note,
            created_by_user_id: sessionUserId(req),
          },
          taskViewer(req)
        );
        const { task, payment, line_name, kind, quantity } = result;
        const kindLabel = kind === 'device' ? 'устройство' : 'услуга';
        auditAdminChange(db, req, {
          entityType: 'task',
          entityId: before.id,
          action: 'update',
          summary: `Возврат ${quantity}× ${kindLabel} «${line_name}» — ${payment.amount} ${payment.currency} по задаче #${before.id}`,
          details: buildAuditDetails({ before, after: task }),
        });
        return res.status(201).json({ task });
      } catch (error) {
        return respondWriteError(
          res,
          error,
          error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось оформить возврат.',
          taskWriteErrorMessage
        );
      }
    }
  );

  router.post('/api/tasks', requireRight(db, 'tasks_create'), express.json(), (req, res) => {
    try {
      const task = createTask(db, req.body || {}, {
        requireLocation: true,
        viewer: taskViewer(req),
      });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task.id,
        action: 'create',
        summary: `Создана задача «${task.title}»`,
        details: buildAuditDetails({ before: null, after: task }),
      });
      return res.status(201).json({ task });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось создать задачу.', taskWriteErrorMessage);
    }
  });

  router.put('/api/tasks/:id', requireRight(db, 'tasks_edit'), express.json(), (req, res) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = updateTask(db, req.params.id, req.body || {}, {
        requireLocation: true,
        viewer: taskViewer(req),
      });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task.id,
        action: 'update',
        summary: `Изменена задача #${task.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось обновить задачу.',
        taskWriteErrorMessage
      );
    }
  });

  router.delete('/api/tasks/:id', requireRight(db, 'tasks_delete'), (req, res) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const deleted = deleteTask(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Задача не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: before.id,
        action: 'delete',
        summary: `Удалена задача «${before.title}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось удалить задачу.', taskWriteErrorMessage);
    }
  });
}

module.exports = {
  registerTaskRoutes,
};
