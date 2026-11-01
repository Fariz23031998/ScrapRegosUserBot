import type { Db } from '../types/db';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { addCatalogImage, countCatalogImages, getCatalogImage, MAX_IMAGE_BYTES, MAX_IMAGES_PER_ENTITY, resolveCatalogImageFile } from '../db/catalog-images';
import { createClient, getClientById } from '../integrations/regos-crm';

export function parsePaginationQuery(req: Request) {
  const allowedLimits = [10, 25, 50, 100];
  let limit = Number(req.query.limit) || 25;
  if (!allowedLimits.includes(limit)) {
    limit = 25;
  }
  const page = Math.max(Number(req.query.page) || 1, 1);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

export function employeeLabel(user?: any) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return (
    user.display_name ||
    fullName ||
    user.admin_login ||
    (user.username ? `@${user.username}` : null) ||
    `Сотрудник #${user.id}`
  );
}

export function mapEmployee(user?: any) {
  return {
    id: user.id,
    name: employeeLabel(user),
    display_name: user.display_name || null,
    phone: user.phone || null,
    job_title: user.job_title || null,
    schedule: user.schedule || null,
  };
}

export function mapTaskClient(client?: any) {
  return {
    id: client.id,
    name: client.name || null,
    phone: client.phone || null,
    email: client.email || null,
    external_id: client.external_id || null,
    photo_url: client.photo_url || null,
  };
}

export async function createMappedTaskClient(body: any = {}) {
  const created = await createClient({
    name: body.name,
    phone: body.phone,
    email: body.email,
    description: body.description,
    external_id: body.external_id,
  });
  let fetched: any = null;
  try {
    fetched = await getClientById(created.id);
  } catch {
    fetched = null;
  }
  return mapTaskClient(
    fetched || {
      id: created.id,
      name: body.name || null,
      phone: body.phone || null,
      email: body.email || null,
    }
  );
}

export function catalogMoneyFromBody(body: any = {}) {
  return {
    cost_amount: body.cost_amount,
    cost_currency: body.cost_currency,
    price_uzs: body.price_uzs,
    price_usd: body.price_usd,
    manager_sale_percent: body.manager_sale_percent,
    technician_score: body.technician_score,
  };
}

export function deviceWriteErrorMessage(code?: any) {
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

export function serviceWriteErrorMessage(code?: any) {
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

export function categoryWriteErrorMessage(code?: any) {
  if (code === 'INVALID_CATEGORY_NAME') return 'Укажите название категории.';
  return null;
}

export function locationWriteErrorMessage(code?: any) {
  if (code === 'INVALID_LOCATION_NAME') return 'Укажите название филиала.';
  if (code === 'INVALID_LOCATION_USERS') return 'Выберите хотя бы одного сотрудника с доступом к филиалу.';
  if (code === 'INVALID_LOCATION_ADDRESS') return 'Слишком длинный адрес филиала.';
  return null;
}

export function paymentTypeWriteErrorMessage(code?: any) {
  if (code === 'INVALID_PAYMENT_TYPE_NAME') return 'Укажите название типа оплаты.';
  if (code === 'INVALID_PAYMENT_TYPE_ACCOUNT') return 'Выберите счёт для типа оплаты.';
  if (code === 'SYSTEM_PAYMENT_TYPE') return 'Системный тип оплаты нельзя изменить или удалить.';
  return null;
}

export function accountWriteErrorMessage(code?: any) {
  if (code === 'INVALID_ACCOUNT_NAME') return 'Укажите название счёта.';
  if (code === 'INVALID_ACCOUNT_CURRENCY') return 'Валюта счёта: UZS или USD.';
  if (code === 'ACCOUNT_IN_USE') return 'Счёт используется и не может быть удалён.';
  return null;
}

export function taskWriteErrorMessage(code?: any) {
  const messages = {
    INVALID_TASK_TITLE: 'Укажите название задачи.',
    INVALID_TASK_NOTES: 'Слишком длинные заметки задачи.',
    INVALID_TASK_ADDRESS: 'Слишком длинный адрес.',
    INVALID_TASK_DISTANCE: 'Некорректная дистанция.',
    INVALID_TASK_DISTANCE_SCORE: 'Баллы за дистанции: число не меньше 0.',
    INVALID_SCORE_PER_KM: 'Балл за километр: число не меньше 0.',
    INVALID_TASK_CLIENT: 'Некорректные данные клиента.',
    INVALID_TASK_STATUS: 'Некорректный статус задачи.',
    INVALID_TASK_CATEGORY: 'Некорректная категория задачи.',
    INVALID_TASK_LOCATION: 'Выберите филиал, к которому у вас есть доступ.',
    INVALID_TASK_MANAGER: 'Менеджер должен быть сотрудником выбранного филиала.',
    INVALID_TASK_TECHNICIAN: 'Техник должен быть сотрудником выбранного филиала.',
    INVALID_TASK_PLAN: 'Некорректные дата и время начала или окончания задачи.',
    INVALID_TASK_PLAN_RANGE: 'Ориентировочное окончание не может быть раньше начала.',
    INVALID_TASK_DEVICES: 'Некорректный список устройств.',
    INVALID_TASK_DEVICE: 'Некорректное устройство в задаче.',
    INVALID_TASK_ACTION: 'Укажите действие: установка, ремонт или продажа.',
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
    INVALID_TASK_STATUS_TRANSITION: 'Статус задачи можно менять только вперёд: Новая → В работе → Выполнена.',
    TASK_CART_LOCKED: 'Проведённую задачу нельзя изменить.',
    TASK_NOT_DONE: 'Возврат доступен только для выполненной задачи.',
    TASK_NOT_POSTED: 'Возврат доступен только после проведения задачи.',
    TASK_NOT_REPAIR: 'Возврат устройства доступен только для задач типа «Ремонт».',
    TASK_HAS_REFUNDS: 'Нельзя отменить проведение: по задаче есть возвраты.',
    TASK_HAS_DEVICE_RETURNS: 'Нельзя отменить проведение: по задаче есть возвраты устройств.',
    INVALID_TASK_RETURN_LINE: 'Выберите устройство для возврата.',
    INVALID_TASK_RETURN_QUANTITY: 'Укажите количество для возврата устройства.',
    INVALID_TASK_RETURN_NOTE: 'Слишком длинный комментарий к возврату устройства.',
    INVALID_TASK_RETURN_STATUS: 'Некорректный фильтр возврата устройств.',
    TASK_RETURN_SERIALS_REQUIRED: 'Укажите серийные номера для возврата устройства.',
    INVALID_TASK_RETURN_SERIAL:
      'Серийный номер не найден, уже возвращён или не относится к этому устройству.',
    SERIALS_LOCKED: 'Нельзя уменьшить количество: серийные номера уже напечатаны или возвращены.',
    PRINT_SERIALS_EMPTY: 'Нет серийных номеров для печати.',
    INVALID_PRINT_KIND: 'Можно печатать этикетку, чек или счёт.',
    INVALID_PRINT_TEMPLATE: 'Некорректный шаблон печати.',
    INVALID_PRINT_TOKEN: 'Слишком длинный токен Print Service.',
    PRINT_GATEWAY_DISABLED: 'Print Service выключен. Задайте токен и включите шлюз в настройках.',
    PRINT_PRINTER_REQUIRED: 'Выберите принтер.',
    PRINT_PRINTER_UNAVAILABLE: 'Этот принтер недоступен: агент офлайн или принтер выключен.',
  };
  return (messages as Record<string, string>)[code] || null;
}

export function catalogImageErrorMessage(code?: any) {
  if (code === 'INVALID_IMAGE_TYPE') return 'Загрузите изображение JPEG, PNG, WebP или GIF.';
  if (code === 'INVALID_IMAGE_SIZE') return 'Изображение слишком большое. Максимум 5 МБ.';
  if (code === 'IMAGE_LIMIT_REACHED') return 'Можно прикрепить не больше 8 изображений.';
  if (code === 'INVALID_IMAGE_ENTITY') return 'Некорректный тип каталога.';
  return null;
}

export const catalogImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_ENTITY },
});

export function handleCatalogImageUpload(req: Request, res: Response, next: NextFunction) {
  catalogImageUpload.array('image', MAX_IMAGES_PER_ENTITY)(req, res, (error: any) => {
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

export function sendCatalogImageFile(res: Response, db: Db, entityType?: any, entityId?: any, imageId?: any) {
  const row = getCatalogImage(db, entityType, entityId, imageId);
  if (!row) return res.status(404).json({ message: 'Изображение не найдено.' });
  const file = resolveCatalogImageFile(row);
  if (!file) return res.status(404).json({ message: 'Изображение не найдено.' });
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  return res.sendFile(file.filePath);
}

export function uploadedImageFiles(req: Request) {
  return Array.isArray(req.files) ? req.files : [];
}

export function saveUploadedCatalogImages(db: Db, entityType?: any, entityId?: any, files?: any) {
  const incoming = Array.isArray(files) ? files : [];
  if (!incoming.length) throw new Error('INVALID_IMAGE_TYPE');
  const remaining = MAX_IMAGES_PER_ENTITY - Number(countCatalogImages(db, entityType, entityId));
  if (remaining <= 0 || incoming.length > remaining) throw new Error('IMAGE_LIMIT_REACHED');
  for (const file of incoming) {
    addCatalogImage(db, entityType, entityId, {
      buffer: file.buffer,
      originalName: file.originalname,
    });
  }
}

export function respondWriteError(res: Response, error: Error, fallbackMessage?: any, mapMessage?: any) {
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
