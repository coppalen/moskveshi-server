require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = path.join(__dirname, 'data', 'db.json');

const SITE_NAME = process.env.SITE_NAME || 'москвещи';
const PAYMENT_CARD = process.env.PAYMENT_CARD || '2200 7021 1871 3952';
const CONTACT_TELEGRAM = process.env.CONTACT_TELEGRAM || '@kadwss';
const DATABASE_URL = process.env.DATABASE_URL || '';

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    })
  : null;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function now() {
  return new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

function uid(prefix = '') {
  return prefix + crypto.randomBytes(12).toString('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function maskEmail(email) {
  const e = String(email || '');
  if (!e.includes('@')) return 'скрыто';
  const [name, domain] = e.split('@');
  const left = name.length <= 2 ? `${name.slice(0, 1)}*` : `${name.slice(0, 2)}***`;
  return `${left}@${domain}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));
  } catch {
    return false;
  }
}

function defaultDb() {
  return {
    version: 2,
    createdAt: now(),
    users: [],
    sessions: [],
    products: [
      {
        id: 'p1',
        name: 'Куртка зимняя',
        category: 'Одежда',
        price: 4500,
        image: '',
        imageData: '',
        description: 'Теплая куртка для зимы, состояние хорошее.',
        createdAt: now(),
        updatedAt: now()
      },
      {
        id: 'p2',
        name: 'Кроссовки Nike',
        category: 'Обувь',
        price: 3200,
        image: '',
        imageData: '',
        description: 'Удобные кроссовки, размер 42.',
        createdAt: now(),
        updatedAt: now()
      },
      {
        id: 'p3',
        name: 'iPhone 12',
        category: 'Техника',
        price: 28000,
        image: '',
        imageData: '',
        description: 'Смартфон в рабочем состоянии.',
        createdAt: now(),
        updatedAt: now()
      },
      {
        id: 'p4',
        name: 'Детский велосипед',
        category: 'Детские товары',
        price: 6500,
        image: '',
        imageData: '',
        description: 'Велосипед для ребенка, почти новый.',
        createdAt: now(),
        updatedAt: now()
      }
    ],
    topups: [],
    orders: []
  };
}

function normalizeDb(db) {
  if (!db || typeof db !== 'object') db = defaultDb();
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.sessions)) db.sessions = [];
  if (!Array.isArray(db.products)) db.products = [];
  if (!Array.isArray(db.topups)) db.topups = [];
  if (!Array.isArray(db.orders)) db.orders = [];

  for (const product of db.products) {
    if (typeof product.image !== 'string') product.image = '';
    if (typeof product.imageData !== 'string') product.imageData = '';
  }

  return db;
}

async function initStorage() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const existing = await pool.query('SELECT data FROM app_state WHERE key = $1', ['main']);

  if (existing.rowCount === 0) {
    await pool.query(
      'INSERT INTO app_state (key, data) VALUES ($1, $2::jsonb)',
      ['main', JSON.stringify(defaultDb())]
    );
  }
}

async function readDb() {
  if (pool) {
    const result = await pool.query('SELECT data FROM app_state WHERE key = $1', ['main']);
    if (result.rowCount === 0) {
      const db = defaultDb();
      await writeDb(db);
      return db;
    }
    return normalizeDb(result.rows[0].data);
  }

  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb(), null, 2), 'utf8');
  }

  return normalizeDb(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
}

async function writeDb(db) {
  db = normalizeDb(db);

  if (pool) {
    await pool.query(
      `INSERT INTO app_state (key, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      ['main', JSON.stringify(db)]
    );
    return;
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function publicUser(user, showEmail = false) {
  return {
    id: user.id,
    name: user.name,
    email: showEmail ? user.email : maskEmail(user.email),
    role: user.role,
    blocked: !!user.blocked,
    balance: Number(user.balance || 0),
    cart: user.cart || [],
    createdAt: user.createdAt
  };
}

async function createAdminIfNeeded() {
  const db = await readDb();

  if (db.users.some(u => u.role === 'admin')) return;

  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.warn('⚠️ ADMIN_EMAIL / ADMIN_PASSWORD не заданы. Администратор не создан.');
    return;
  }

  const { salt, hash } = hashPassword(password);

  db.users.push({
    id: uid('u_'),
    name: 'Администратор',
    email,
    passwordHash: hash,
    salt,
    role: 'admin',
    blocked: false,
    balance: 0,
    cart: [],
    createdAt: now(),
    updatedAt: now()
  });

  await writeDb(db);
  console.log(`✅ Admin created: ${email}`);
}

async function requireAuth(req, res, next) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Требуется вход в аккаунт.' });

    const db = await readDb();
    const session = db.sessions.find(s => s.token === token);
    if (!session) return res.status(401).json({ error: 'Сессия не найдена.' });

    const user = db.users.find(u => u.id === session.userId);
    if (!user) return res.status(401).json({ error: 'Пользователь не найден.' });
    if (user.blocked) return res.status(403).json({ error: 'Аккаунт заблокирован.' });

    req.db = db;
    req.user = user;
    req.token = token;

    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Доступ только для администратора.' });
  }
  next();
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('Telegram не настроен:', text);
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });

    const data = await response.json();

    if (!data.ok) {
      console.error('Telegram error:', data);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Telegram send error:', err);
    return false;
  }
}

function formatRub(value) {
  return `${Number(value || 0).toLocaleString('ru-RU')} ₽`;
}

function validateImageData(imageData) {
  if (!imageData) return '';
  const value = String(imageData);

  if (!value.startsWith('data:image/')) {
    throw new Error('Можно загружать только изображения.');
  }

  if (value.length > 7_500_000) {
    throw new Error('Фото слишком большое. Загрузите изображение до 5 МБ.');
  }

  return value;
}

/* CONFIG */

app.get('/api/config', (req, res) => {
  res.json({
    siteName: SITE_NAME,
    paymentCard: PAYMENT_CARD,
    contactTelegram: CONTACT_TELEGRAM,
    databaseMode: pool ? 'postgres' : 'json'
  });
});

/* AUTH */

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const db = await readDb();

  const name = String(req.body.name || '').trim();
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');

  if (!name) return res.status(400).json({ error: 'Укажите имя.' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Укажите корректный email.' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов.' });

  if (db.users.some(u => u.email === email)) {
    return res.status(409).json({ error: 'Такой email уже зарегистрирован.' });
  }

  const { salt, hash } = hashPassword(password);

  const user = {
    id: uid('u_'),
    name,
    email,
    passwordHash: hash,
    salt,
    role: 'user',
    blocked: false,
    balance: 0,
    cart: [],
    createdAt: now(),
    updatedAt: now()
  };

  db.users.push(user);

  const token = uid('sess_');
  db.sessions.push({ token, userId: user.id, createdAt: now() });

  await writeDb(db);

  await sendTelegram(
    '🆕 <b>Новая регистрация на москвещи</b>\n' +
    `Пользователь: ${user.name}\n` +
    `Email: ${maskEmail(user.email)}\n` +
    `Дата регистрации: ${user.createdAt}\n` +
    'Пароль: скрыт и хранится только в виде хеша'
  );

  res.json({ token, user: publicUser(user, true) });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const db = await readDb();

  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const user = db.users.find(u => u.email === email);

  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    return res.status(401).json({ error: 'Неверный email или пароль.' });
  }

  if (user.blocked) return res.status(403).json({ error: 'Аккаунт заблокирован.' });

  const token = uid('sess_');
  db.sessions.push({ token, userId: user.id, createdAt: now() });

  await writeDb(db);

  res.json({ token, user: publicUser(user, true) });
}));

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user, true) });
});

app.post('/api/auth/logout', requireAuth, asyncHandler(async (req, res) => {
  const db = req.db;
  db.sessions = db.sessions.filter(s => s.token !== req.token);
  await writeDb(db);
  res.json({ ok: true });
}));

/* PRODUCTS */

app.get('/api/products', asyncHandler(async (req, res) => {
  const db = await readDb();
  res.json({ products: db.products });
}));

app.post('/api/admin/products', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const db = req.db;

  const name = String(req.body.name || '').trim();
  const category = String(req.body.category || '').trim();
  const price = Number(req.body.price);
  const image = String(req.body.image || '').trim();
  const imageData = validateImageData(req.body.imageData || '');
  const description = String(req.body.description || '').trim();

  if (!name) return res.status(400).json({ error: 'Укажите название товара.' });
  if (!category) return res.status(400).json({ error: 'Укажите категорию.' });
  if (!price || price <= 0) return res.status(400).json({ error: 'Укажите корректную цену.' });

  const product = {
    id: uid('p_'),
    name,
    category,
    price,
    image,
    imageData,
    description,
    createdAt: now(),
    updatedAt: now()
  };

  db.products.unshift(product);
  await writeDb(db);

  res.json({ product });
}));

app.put('/api/admin/products/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const db = req.db;
  const product = db.products.find(p => p.id === req.params.id);

  if (!product) return res.status(404).json({ error: 'Товар не найден.' });

  product.name = String(req.body.name || product.name).trim();
  product.category = String(req.body.category || product.category).trim();
  product.price = Number(req.body.price || product.price);
  product.description = String(req.body.description || '').trim();
  product.image = String(req.body.image || '').trim();

  if (req.body.imageData) {
    product.imageData = validateImageData(req.body.imageData);
  }

  if (req.body.clearImage === true) {
    product.image = '';
    product.imageData = '';
  }

  product.updatedAt = now();

  await writeDb(db);

  res.json({ product });
}));

app.delete('/api/admin/products/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const db = req.db;
  const exists = db.products.some(p => p.id === req.params.id);

  if (!exists) return res.status(404).json({ error: 'Товар не найден.' });

  db.products = db.products.filter(p => p.id !== req.params.id);

  db.users.forEach(u => {
    u.cart = (u.cart || []).filter(i => i.productId !== req.params.id);
  });

  await writeDb(db);

  res.json({ ok: true });
}));

/* CART */

app.get('/api/cart', requireAuth, (req, res) => {
  const db = req.db;
  const cart = (req.user.cart || []).map(item => {
    const product = db.products.find(p => p.id === item.productId);
    return product ? { ...item, product } : null;
  }).filter(Boolean);

  res.json({ cart });
});

app.post('/api/cart/add', requireAuth, asyncHandler(async (req, res) => {
  const db = req.db;
  const productId = String(req.body.productId || '');
  const product = db.products.find(p => p.id === productId);

  if (!product) return res.status(404).json({ error: 'Товар не найден.' });

  if (!req.user.cart) req.user.cart = [];

  const item = req.user.cart.find(i => i.productId === productId);

  if (item) item.qty += 1;
  else req.user.cart.push({ productId, qty: 1 });

  req.user.updatedAt = now();

  await writeDb(db);

  res.json({ ok: true, cart: req.user.cart });
}));

app.patch('/api/cart/:productId', requireAuth, asyncHandler(async (req, res) => {
  const db = req.db;
  const qty = Number(req.body.qty);

  if (!req.user.cart) req.user.cart = [];

  const item = req.user.cart.find(i => i.productId === req.params.productId);

  if (!item) return res.status(404).json({ error: 'Позиция корзины не найдена.' });

  if (qty <= 0) {
    req.user.cart = req.user.cart.filter(i => i.productId !== req.params.productId);
  } else {
    item.qty = qty;
  }

  req.user.updatedAt = now();

  await writeDb(db);

  res.json({ ok: true, cart: req.user.cart });
}));

app.delete('/api/cart/:productId', requireAuth, asyncHandler(async (req, res) => {
  const db = req.db;

  req.user.cart = (req.user.cart || []).filter(i => i.productId !== req.params.productId);
  req.user.updatedAt = now();

  await writeDb(db);

  res.json({ ok: true, cart: req.user.cart });
}));

/* BALANCE */

app.get('/api/balance', requireAuth, (req, res) => {
  const topups = req.db.topups.filter(t => t.userId === req.user.id);
  const orders = req.db.orders.filter(o => o.userId === req.user.id);

  res.json({
    balance: Number(req.user.balance || 0),
    topups,
    orders
  });
});

app.post('/api/balance/topup-request', requireAuth, asyncHandler(async (req, res) => {
  const db = req.db;

  const amount = Number(req.body.amount);
  const method = String(req.body.method || 'Перевод на карту').trim();
  const comment = String(req.body.comment || '').trim();

  if (!amount || amount < 100) {
    return res.status(400).json({ error: 'Минимальная сумма заявки 100 ₽.' });
  }

  const topup = {
    id: uid('top_'),
    userId: req.user.id,
    amount,
    method,
    comment,
    status: 'pending',
    adminComment: '',
    createdAt: now(),
    processedAt: null
  };

  db.topups.unshift(topup);

  await writeDb(db);

  await sendTelegram(
    '💳 <b>Новая заявка на пополнение баланса</b>\n' +
    `Пользователь: ${req.user.name}\n` +
    `Email: ${maskEmail(req.user.email)}\n` +
    `Сумма: ${formatRub(amount)}\n` +
    `Карта для оплаты: ${PAYMENT_CARD}\n` +
    `Способ оплаты: ${method}\n` +
    `Комментарий: ${comment || 'нет'}`
  );

  res.json({ topup });
}));

/* ORDERS */

app.post('/api/orders/checkout', requireAuth, asyncHandler(async (req, res) => {
  const db = req.db;
  const cart = req.user.cart || [];

  if (!cart.length) return res.status(400).json({ error: 'Корзина пустая.' });

  const items = [];
  let total = 0;

  for (const cartItem of cart) {
    const product = db.products.find(p => p.id === cartItem.productId);

    if (!product) continue;

    const qty = Number(cartItem.qty || 1);
    const lineTotal = Number(product.price) * qty;

    items.push({
      productId: product.id,
      name: product.name,
      price: Number(product.price),
      qty,
      lineTotal
    });

    total += lineTotal;
  }

  if (!items.length) return res.status(400).json({ error: 'В корзине нет доступных товаров.' });

  if (Number(req.user.balance || 0) < total) {
    return res.status(400).json({ error: 'Недостаточно средств на балансе.' });
  }

  req.user.balance = Number(req.user.balance || 0) - total;
  req.user.cart = [];
  req.user.updatedAt = now();

  const order = {
    id: uid('ord_'),
    userId: req.user.id,
    items,
    total,
    status: 'new',
    statusText: 'Новый заказ',
    createdAt: now(),
    updatedAt: now()
  };

  db.orders.unshift(order);

  await writeDb(db);

  await sendTelegram(
    '🛒 <b>Новая покупка на москвещи</b>\n' +
    `Покупатель: ${req.user.name}\n` +
    `Email: ${maskEmail(req.user.email)}\n` +
    `Сумма: ${formatRub(total)}\n` +
    `Остаток баланса: ${formatRub(req.user.balance)}\n\n` +
    '<b>Товары:</b>\n' +
    items.map(i => `• ${i.name} × ${i.qty} — ${formatRub(i.lineTotal)}`).join('\n')
  );

  res.json({ order, balance: req.user.balance });
}));

/* ADMIN */

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = req.db.users.map(u => publicUser(u, true));
  res.json({ users });
});

app.patch('/api/admin/users/:id/block', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const db = req.db;
  const target = db.users.find(u => u.id === req.params.id);

  if (!target) return res.status(404).json({ error: 'Пользователь не найден.' });
  if (target.role === 'admin') return res.status(400).json({ error: 'Нельзя заблокировать администратора.' });

  target.blocked = !!req.body.blocked;
  target.updatedAt = now();

  await writeDb(db);

  await sendTelegram(
    '⚠️ <b>Изменен статус пользователя</b>\n' +
    `Пользователь: ${target.name}\n` +
    `Email: ${maskEmail(target.email)}\n` +
    `Статус: ${target.blocked ? 'заблокирован' : 'разблокирован'}`
  );

  res.json({ user: publicUser(target, true) });
}));

app.get('/api/admin/topups', requireAuth, requireAdmin, (req, res) => {
  const topups = req.db.topups.map(t => {
    const u = req.db.users.find(user => user.id === t.userId);
    return { ...t, user: u ? publicUser(u, true) : null };
  });

  res.json({ topups });
});

app.post('/api/admin/topups/:id/approve', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const db = req.db;
  const topup = db.topups.find(t => t.id === req.params.id);

  if (!topup) return res.status(404).json({ error: 'Заявка не найдена.' });
  if (topup.status !== 'pending') return res.status(400).json({ error: 'Заявка уже обработана.' });

  const target = db.users.find(u => u.id === topup.userId);

  if (!target) return res.status(404).json({ error: 'Пользователь не найден.' });

  topup.status = 'approved';
  topup.adminComment = String(req.body.adminComment || '').trim();
  topup.processedAt = now();

  target.balance = Number(target.balance || 0) + Number(topup.amount);
  target.updatedAt = now();

  await writeDb(db);

  await sendTelegram(
    '✅ <b>Пополнение баланса одобрено</b>\n' +
    `Пользователь: ${target.name}\n` +
    `Email: ${maskEmail(target.email)}\n` +
    `Сумма: ${formatRub(topup.amount)}\n` +
    `Новый баланс: ${formatRub(target.balance)}`
  );

  res.json({ topup, user: publicUser(target, true) });
}));

app.post('/api/admin/topups/:id/reject', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const db = req.db;
  const topup = db.topups.find(t => t.id === req.params.id);

  if (!topup) return res.status(404).json({ error: 'Заявка не найдена.' });
  if (topup.status !== 'pending') return res.status(400).json({ error: 'Заявка уже обработана.' });

  const target = db.users.find(u => u.id === topup.userId);

  topup.status = 'rejected';
  topup.adminComment = String(req.body.adminComment || '').trim();
  topup.processedAt = now();

  await writeDb(db);

  await sendTelegram(
    '❌ <b>Пополнение баланса отклонено</b>\n' +
    `Пользователь: ${target ? target.name : 'не найден'}\n` +
    `Email: ${target ? maskEmail(target.email) : '-'}\n` +
    `Сумма: ${formatRub(topup.amount)}\n` +
    `Комментарий: ${topup.adminComment || 'нет'}`
  );

  res.json({ topup });
}));

app.get('/api/admin/orders', requireAuth, requireAdmin, (req, res) => {
  const onlyActive = String(req.query.active || '') === '1';

  let orders = req.db.orders.map(o => {
    const u = req.db.users.find(user => user.id === o.userId);
    return { ...o, user: u ? publicUser(u, true) : null };
  });

  if (onlyActive) {
    orders = orders.filter(o => ['new', 'processing'].includes(o.status));
  }

  res.json({ orders });
});

app.patch('/api/admin/orders/:id/status', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const db = req.db;
  const order = db.orders.find(o => o.id === req.params.id);

  if (!order) return res.status(404).json({ error: 'Заказ не найден.' });

  const status = String(req.body.status || '');
  const statusMap = {
    new: 'Новый заказ',
    processing: 'В работе',
    completed: 'Выполнен',
    cancelled: 'Отменен'
  };

  if (!statusMap[status]) {
    return res.status(400).json({ error: 'Неверный статус заказа.' });
  }

  order.status = status;
  order.statusText = statusMap[status];
  order.updatedAt = now();

  await writeDb(db);

  const target = db.users.find(u => u.id === order.userId);

  await sendTelegram(
    '📦 <b>Статус заказа изменен</b>\n' +
    `Заказ: ${order.id.slice(-6).toUpperCase()}\n` +
    `Покупатель: ${target ? target.name : 'не найден'}\n` +
    `Email: ${target ? maskEmail(target.email) : '-'}\n` +
    `Сумма: ${formatRub(order.total)}\n` +
    `Новый статус: ${order.statusText}`
  );

  res.json({ order });
}));

app.post('/api/admin/telegram/test', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const ok = await sendTelegram(
    '✅ <b>Тест Telegram-уведомлений</b>\n' +
    'Сервер москвещи успешно подключен к Telegram.'
  );

  if (!ok) return res.status(400).json({ error: 'Не получилось отправить сообщение. Проверьте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID.' });

  res.json({ ok: true });
}));

app.get('/api/health', asyncHandler(async (req, res) => {
  res.json({
    ok: true,
    service: 'moskveshi-server',
    db: pool ? 'postgres' : 'json',
    time: now()
  });
}));

app.use((req, res) => {
  res.status(404).json({ error: 'Маршрут не найден.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Ошибка сервера.' });
});

(async () => {
  try {
    await initStorage();
    await createAdminIfNeeded();

    app.listen(PORT, () => {
      console.log(`✅ ${SITE_NAME} server started: http://localhost:${PORT}`);
      console.log(`📦 Storage mode: ${pool ? 'PostgreSQL DATABASE_URL' : 'local JSON file'}`);
      if (!pool) {
        console.log('⚠️ DATABASE_URL не указан. На Render Free данные в JSON могут пропадать после перезапуска.');
      }
    });
  } catch (err) {
    console.error('❌ Startup error:', err);
    process.exit(1);
  }
})();
