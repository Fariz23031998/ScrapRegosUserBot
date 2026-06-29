const path = require('path');
const express = require('express');
const {
  createEmployeeUser,
  updateEmployeeUser,
  convertCustomerToEmployee,
  deleteEmployeeUser,
  listBotUsers,
} = require('./bot-users-db');
const { RIGHTS } = require('./user-rights');
const { listOrderLogs, mapOrderLogRow } = require('./order-logs');
const {
  getAdminCredentials,
  isAuthenticated,
  setSessionCookie,
  clearSessionCookie,
  requireAdminAuth,
} = require('./bot-admin-auth');

function parseRightsBody(body = {}) {
  const rights = {};
  for (const key of Object.keys(RIGHTS)) {
    if (body[key] !== undefined) {
      rights[key] = body[key] ? 1 : 0;
    }
  }
  return rights;
}

function mapUserResponse(user) {
  return {
    id: user.id,
    role: user.role,
    phone: user.phone,
    display_name: user.display_name,
    first_name: user.first_name,
    last_name: user.last_name,
    username: user.username,
    telegram_id: user.telegram_id,
    linked_at: user.linked_at,
    is_linked: user.is_linked,
    rights: user.rights,
  };
}

function sendPublicFile(res, publicDir, filename) {
  return res.sendFile(path.join(publicDir, filename));
}

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

function createBotAdminRouter(db) {
  const router = express.Router();
  const publicDir = path.join(__dirname, '..', 'public', 'bot-admin');

  router.get('/login', (_req, res) => sendPublicFile(res, publicDir, 'login.html'));
  router.get('/login.css', (_req, res) => sendPublicFile(res, publicDir, 'login.css'));
  router.get('/login.js', (_req, res) => sendPublicFile(res, publicDir, 'login.js'));

  router.get('/api/session', (req, res) => {
    if (!getAdminCredentials()) {
      return res.status(503).json({ message: 'Admin credentials are not configured.' });
    }
    if (!isAuthenticated(req)) {
      return res.status(401).json({ message: 'Требуется вход в систему.' });
    }
    return res.json({ ok: true });
  });

  router.post('/api/login', express.json(), (req, res) => {
    const creds = getAdminCredentials();
    if (!creds) {
      return res.status(503).json({
        message:
          'Admin credentials are not configured. Set BOT_ADMIN_LOGIN and BOT_ADMIN_PASSWORD in .env and restart the server.',
      });
    }

    const login = String(req.body?.login || '').trim();
    const password = String(req.body?.password || '');
    if (login !== creds.login || password !== creds.password) {
      return res.status(401).json({ message: 'Неверный логин или пароль.' });
    }

    setSessionCookie(res, creds);
    return res.json({ ok: true });
  });

  router.post('/api/logout', (req, res) => {
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  router.get('/rights-meta', requireAdminAuth, (_req, res) => {
    res.json({
      rights: Object.entries(RIGHTS).map(([key, value]) => ({
        key,
        label: value.label,
      })),
    });
  });

  router.get('/api/users', requireAdminAuth, (req, res) => {
    const role = String(req.query.role || '').trim();
    const query = String(req.query.q || '').trim();
    let { page, limit, offset } = parsePaginationQuery(req);
    const options = { offset, limit };
    if (role === 'employee' || role === 'customer') {
      options.role = role;
    }
    if (query) {
      options.query = query;
    }
    let result = listBotUsers(db, options);
    const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
    if (page > totalPages) {
      page = totalPages;
      options.offset = (page - 1) * limit;
      result = listBotUsers(db, options);
    }
    res.json({
      users: result.users.map(mapUserResponse),
      total: result.total,
      page,
      limit,
    });
  });

  router.get('/api/order-logs', requireAdminAuth, (req, res) => {
    const query = String(req.query.q || '').trim();
    let { page, limit, offset } = parsePaginationQuery(req);
    let result = listOrderLogs(db, { query: query || undefined, offset, limit });
    const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
    if (page > totalPages) {
      page = totalPages;
      offset = (page - 1) * limit;
      result = listOrderLogs(db, { query: query || undefined, offset, limit });
    }
    res.json({
      logs: result.logs.map(mapOrderLogRow),
      total: result.total,
      page,
      limit,
    });
  });

  router.post('/api/users', requireAdminAuth, express.json(), (req, res) => {
    try {
      const phone = String(req.body?.phone || '').trim();
      if (!phone) {
        return res.status(400).json({ message: 'Укажите номер телефона.' });
      }
      const user = createEmployeeUser(db, {
        phone,
        displayName: req.body?.display_name,
        rights: parseRightsBody(req.body?.rights || req.body),
      });
      return res.status(201).json({ user: mapUserResponse(user) });
    } catch (error) {
      if (error.message === 'PHONE_EXISTS') {
        return res.status(409).json({ message: 'Пользователь с таким телефоном уже существует.' });
      }
      console.error('Create employee error:', error);
      return res.status(500).json({ message: 'Не удалось создать пользователя.' });
    }
  });

  router.put('/api/users/:id', requireAdminAuth, express.json(), (req, res) => {
    try {
      const userId = Number(req.params.id);
      const user = updateEmployeeUser(db, userId, {
        phone: req.body?.phone,
        displayName: req.body?.display_name,
        rights: req.body?.rights ? parseRightsBody(req.body.rights) : parseRightsBody(req.body),
      });
      return res.json({ user: mapUserResponse(user) });
    } catch (error) {
      if (error.message === 'NOT_FOUND') {
        return res.status(404).json({ message: 'Пользователь не найден.' });
      }
      if (error.message === 'PHONE_EXISTS') {
        return res.status(409).json({ message: 'Пользователь с таким телефоном уже существует.' });
      }
      console.error('Update employee error:', error);
      return res.status(500).json({ message: 'Не удалось обновить пользователя.' });
    }
  });

  router.post('/api/users/:id/promote', requireAdminAuth, express.json(), (req, res) => {
    try {
      const userId = Number(req.params.id);
      const user = convertCustomerToEmployee(db, userId, {
        displayName: req.body?.display_name,
        rights: parseRightsBody(req.body?.rights || req.body),
      });
      return res.json({ user: mapUserResponse(user) });
    } catch (error) {
      if (error.message === 'NOT_FOUND') {
        return res.status(404).json({ message: 'Пользователь не найден.' });
      }
      if (error.message === 'NOT_CUSTOMER') {
        return res.status(400).json({ message: 'Можно назначить сотрудником только клиента.' });
      }
      console.error('Promote customer error:', error);
      return res.status(500).json({ message: 'Не удалось назначить сотрудником.' });
    }
  });

  router.delete('/api/users/:id', requireAdminAuth, (req, res) => {
    try {
      const userId = Number(req.params.id);
      deleteEmployeeUser(db, userId);
      return res.json({ ok: true });
    } catch (error) {
      if (error.message === 'NOT_FOUND') {
        return res.status(404).json({ message: 'Пользователь не найден.' });
      }
      if (error.message === 'HAS_ORDERS') {
        return res.status(409).json({ message: 'Нельзя удалить сотрудника с созданными заказами.' });
      }
      console.error('Delete employee error:', error);
      return res.status(500).json({ message: 'Не удалось удалить пользователя.' });
    }
  });

  router.get('/order-logs', (req, res) => {
    if (!isAuthenticated(req)) {
      return res.redirect('/bot-admin/login');
    }
    return sendPublicFile(res, publicDir, 'order-logs.html');
  });

  router.get('/', (req, res) => {
    if (!isAuthenticated(req)) {
      return res.redirect('/bot-admin/login');
    }
    return sendPublicFile(res, publicDir, 'index.html');
  });

  router.use(requireAdminAuth, express.static(publicDir, { index: false }));

  return router;
}

module.exports = {
  createBotAdminRouter,
};
