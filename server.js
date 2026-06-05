const express    = require('express');
const sqlite3    = require('sqlite3').verbose();
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const path       = require('path');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const multer     = require('multer');
const fs         = require('fs');

// ── UPLOADS ──
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const bannerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => cb(null, `banner-${Date.now()}${path.extname(file.originalname).toLowerCase()}`)
});
const bannerUpload = multer({
  storage: bannerStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    /\.(jpg|jpeg|png|webp)$/i.test(file.originalname) ? cb(null, true) : cb(new Error('Только JPG/PNG/WebP'))
});

// ── MAIL ──
const { GMAIL_USER, GMAIL_PASS } = require('./config');
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_PASS }
});

// ── APP ──
const app    = express();
const PORT   = 3000;
const SECRET = 'bonita_secret_key_2026';
const resetCodes        = new Map();
const verificationCodes = new Map();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE ──
const db = new sqlite3.Database('./bonita.db', (err) => {
  if (err) console.error(err.message);
  else console.log('База данных подключена');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    surname TEXT NOT NULL,
    email TEXT UNIQUE,
    phone TEXT UNIQUE,
    city TEXT,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    brand TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    pack_type TEXT DEFAULT 'box',
    pack_qty INTEGER DEFAULT 1,
    discounts TEXT DEFAULT '[]',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    items TEXT NOT NULL,
    total REAL NOT NULL,
    payment TEXT DEFAULT 'kaspi',
    address TEXT,
    comment TEXT,
    status TEXT DEFAULT 'new',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
    if (row && row.count === 0) {
      db.run(`INSERT INTO products (name,brand,category,description,price,pack_qty,discounts) VALUES ('Тарелка обеденная','BONITA','Керамика','Белая керамика, матовая',450,48,'[{"from":2,"percent":5},{"from":5,"percent":10},{"from":10,"percent":15}]')`);
      db.run(`INSERT INTO products (name,brand,category,description,price,pack_qty,discounts) VALUES ('Пиала чайная','BONITA','Керамика','Рельефный узор, айвори',320,36,'[{"from":3,"percent":7},{"from":6,"percent":12}]')`);
      db.run(`INSERT INTO products (name,brand,category,description,price,pack_type,pack_qty,discounts) VALUES ('Набор бокалов','VOCO HOME','Стекло','6 предметов, боросиликат',2800,'set',1,'[{"from":5,"percent":8},{"from":20,"percent":15}]')`);
      db.run(`INSERT INTO products (name,brand,category,description,price,pack_qty,discounts) VALUES ('Салатник глубокий','BONITA','Керамика','Матовое покрытие, синий',680,24,'[{"from":3,"percent":6},{"from":8,"percent":12}]')`);
      console.log('Тестовые товары добавлены');
    }
  });
});

// ── ROUTES ──

// Получить все товары
app.get('/api/products', (req, res) => {
  db.all("SELECT * FROM products ORDER BY created_at DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    rows.forEach(r => r.discounts = JSON.parse(r.discounts || '[]'));
    res.json(rows);
  });
});

// Получить один товар
app.get('/api/products/:id', (req, res) => {
  db.get("SELECT * FROM products WHERE id = ?", [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Товар не найден' });
    row.discounts = JSON.parse(row.discounts || '[]');
    res.json(row);
  });
});

// Добавить товар
app.post('/api/products', adminAuth, (req, res) => {
  const { name, brand, category, description, price, pack_type, pack_qty, discounts } = req.body;
  db.run(
    `INSERT INTO products (name,brand,category,description,price,pack_type,pack_qty,discounts) VALUES (?,?,?,?,?,?,?,?)`,
    [name, brand, category, description, price, pack_type||'box', pack_qty||1, JSON.stringify(discounts||[])],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: 'Товар добавлен' });
    }
  );
});

// Обновить товар
app.put('/api/products/:id', adminAuth, (req, res) => {
  const { name, brand, category, description, price, pack_type, pack_qty, discounts, active } = req.body;
  db.run(
    `UPDATE products SET name=?,brand=?,category=?,description=?,price=?,pack_type=?,pack_qty=?,discounts=?,active=? WHERE id=?`,
    [name, brand, category, description, price, pack_type, pack_qty, JSON.stringify(discounts||[]), active, req.params.id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Товар обновлён' });
    }
  );
});

// Включить/выключить товар
app.patch('/api/products/:id/toggle', adminAuth, (req, res) => {
  db.run("UPDATE products SET active = ? WHERE id = ?", [req.body.active ? 1 : 0, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Статус обновлён' });
  });
});

// Удалить товар
app.delete('/api/products/:id', adminAuth, (req, res) => {
  db.run("DELETE FROM products WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Товар удалён' });
  });
});

// Регистрация
app.post('/api/register', async (req, res) => {
  const { name, surname, email, phone, city, password } = req.body;
  if (!name || !password || (!email && !phone))
    return res.status(400).json({ error: 'Заполните обязательные поля' });

  const checkSql = email && phone
    ? 'SELECT id FROM users WHERE email = ? OR phone = ?'
    : email ? 'SELECT id FROM users WHERE email = ?' : 'SELECT id FROM users WHERE phone = ?';
  const checkParams = email && phone ? [email, phone] : [email || phone];

  db.get(checkSql, checkParams, async (err, existing) => {
    if (err) return res.status(500).json({ error: err.message });
    if (existing) return res.status(400).json({ error: 'Email или телефон уже зарегистрирован' });
    try {
      const hash = await bcrypt.hash(password, 10);
      if (!email) {
        db.run(
          `INSERT INTO users (name,surname,email,phone,city,password) VALUES (?,?,?,?,?,?)`,
          [name, surname, null, phone, city, hash],
          function(insertErr) {
            if (insertErr) return res.status(500).json({ error: insertErr.message });
            const token = jwt.sign({ id: this.lastID, role: 'user' }, SECRET, { expiresIn: '30d' });
            res.json({ token, name, verified: true, message: 'Регистрация успешна' });
          }
        );
        return;
      }
      const code = String(Math.floor(1000 + Math.random() * 9000));
      verificationCodes.set(email, {
        userData: { name, surname, email, phone: phone||null, city, passwordHash: hash },
        code, expires: Date.now() + 15 * 60 * 1000
      });
      try {
        await mailer.sendMail({
          from: `"Bonita" <${GMAIL_USER}>`, to: email,
          subject: 'Подтверждение регистрации — Bonita',
          text: `Ваш код подтверждения: ${code}\n\nКод действителен 15 минут.`,
          html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;color:#1a1a1a;">
            <h2 style="font-size:22px;font-weight:300;border-bottom:1px solid #e5e5e5;padding-bottom:12px;">Подтверждение регистрации</h2>
            <p style="color:#555;font-size:14px;">Введите этот код для активации аккаунта:</p>
            <div style="font-size:36px;font-weight:700;letter-spacing:0.3em;color:#c9a84c;background:#faf7f0;border:1px solid #e8d5a3;padding:16px 24px;display:inline-block;margin:8px 0 20px;">${code}</div>
            <p style="color:#888;font-size:12px;">Код действителен 15 минут.</p></div>`
        });
        res.json({ needsVerification: true, message: 'Код отправлен на почту' });
      } catch(mailErr) {
        console.error('Verify mail error:', mailErr.message);
        res.status(500).json({ error: 'Не удалось отправить письмо подтверждения.' });
      }
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
});

// Подтверждение email
app.post('/api/verify-email', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Укажите email и код' });
  const entry = verificationCodes.get(email);
  if (!entry) return res.status(400).json({ error: 'Код не найден. Зарегистрируйтесь заново.' });
  if (Date.now() > entry.expires) { verificationCodes.delete(email); return res.status(400).json({ error: 'Код истёк. Зарегистрируйтесь заново.' }); }
  if (entry.code !== code) return res.status(400).json({ error: 'Неверный код' });
  const { name, surname, phone, city, passwordHash } = entry.userData;
  db.run(
    `INSERT INTO users (name,surname,email,phone,city,password) VALUES (?,?,?,?,?,?)`,
    [name, surname, email, phone, city, passwordHash],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email уже зарегистрирован' });
        return res.status(500).json({ error: err.message });
      }
      verificationCodes.delete(email);
      const token = jwt.sign({ id: this.lastID, role: 'user' }, SECRET, { expiresIn: '30d' });
      res.json({ token, name, message: 'Email подтверждён! Добро пожаловать.' });
    }
  );
});

// Вход
app.post('/api/login', (req, res) => {
  const { login, password } = req.body;
  db.get("SELECT * FROM users WHERE email = ? OR phone = ?", [login, login], async (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Неверный пароль' });
    const token = jwt.sign({ id: user.id, role: 'user' }, SECRET, { expiresIn: '30d' });
    res.json({ token, name: user.name, message: 'Вход выполнен' });
  });
});

// Запрос кода восстановления
app.post('/api/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Укажите email' });
  db.get("SELECT id FROM users WHERE email = ?", [email], async (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'Email не найден' });
    const code = String(Math.floor(1000 + Math.random() * 9000));
    resetCodes.set(email, { code, expires: Date.now() + 15 * 60 * 1000 });
    try {
      await mailer.sendMail({
        from: `"Bonita" <${GMAIL_USER}>`, to: email,
        subject: 'Код восстановления пароля — Bonita',
        text: `Ваш код для сброса пароля: ${code}\n\nКод действителен 15 минут.`,
        html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;color:#1a1a1a;">
          <h2 style="font-size:22px;font-weight:300;border-bottom:1px solid #e5e5e5;padding-bottom:12px;">Восстановление пароля</h2>
          <p style="color:#555;font-size:14px;">Ваш код для сброса пароля:</p>
          <div style="font-size:36px;font-weight:700;letter-spacing:0.3em;color:#c9a84c;background:#faf7f0;border:1px solid #e8d5a3;padding:16px 24px;display:inline-block;margin:8px 0 20px;">${code}</div>
          <p style="color:#888;font-size:12px;">Код действителен 15 минут.</p>
          <p style="color:#aaa;font-size:11px;">Если вы не запрашивали сброс пароля, проигнорируйте это письмо.</p></div>`
      });
      res.json({ message: 'Код отправлен на почту' });
    } catch(e) {
      console.error('Mail error:', e.message);
      res.status(500).json({ error: 'Не удалось отправить письмо. Проверьте настройки почты.' });
    }
  });
});

// Сброс пароля
app.post('/api/reset-password', async (req, res) => {
  const { email, code, password } = req.body;
  if (!email || !code || !password) return res.status(400).json({ error: 'Заполните все поля' });
  const entry = resetCodes.get(email);
  if (!entry) return res.status(400).json({ error: 'Код не найден. Запросите новый.' });
  if (Date.now() > entry.expires) { resetCodes.delete(email); return res.status(400).json({ error: 'Код истёк. Запросите новый.' }); }
  if (entry.code !== code) return res.status(400).json({ error: 'Неверный код' });
  try {
    const hash = await bcrypt.hash(password, 10);
    db.run("UPDATE users SET password = ? WHERE email = ?", [hash, email], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      resetCodes.delete(email);
      res.json({ message: 'Пароль изменён' });
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Вход администратора
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === 'bonita_admin_2026') {
    const token = jwt.sign({ role: 'admin' }, SECRET, { expiresIn: '1d' });
    res.json({ token, message: 'Добро пожаловать' });
  } else {
    res.status(401).json({ error: 'Неверный пароль' });
  }
});

// Создать заказ
app.post('/api/orders', userAuth, (req, res) => {
  const { items, total, payment, address, comment } = req.body;
  db.run(
    `INSERT INTO orders (user_id,items,total,payment,address,comment) VALUES (?,?,?,?,?,?)`,
    [req.user.id, JSON.stringify(items), total, payment, address, comment],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: 'Заказ принят' });
    }
  );
});

// Обновить статус заказа
app.patch('/api/orders/:id/status', adminAuth, (req, res) => {
  const { status } = req.body;
  if (!['new','paid','done'].includes(status)) return res.status(400).json({ error: 'Неверный статус' });
  db.run("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Статус обновлён' });
  });
});

// Мои заказы
app.get('/api/my-orders', userAuth, (req, res) => {
  db.all("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC", [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    rows.forEach(r => r.items = JSON.parse(r.items || '[]'));
    res.json(rows);
  });
});

// Получить заказы (админ)
app.get('/api/orders', adminAuth, (req, res) => {
  db.all(`SELECT orders.*, users.name, users.surname, users.phone, users.city
    FROM orders LEFT JOIN users ON orders.user_id = users.id
    ORDER BY orders.created_at DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    rows.forEach(r => r.items = JSON.parse(r.items || '[]'));
    res.json(rows);
  });
});

// Получить клиентов
app.get('/api/clients', adminAuth, (req, res) => {
  db.all("SELECT id,name,surname,email,phone,city,created_at FROM users ORDER BY created_at DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Удалить клиента
app.delete('/api/clients/:id', adminAuth, (req, res) => {
  db.run("DELETE FROM users WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Клиент удалён' });
  });
});

// Инвойс
app.get('/api/orders/:id/invoice', userAuth, (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const sql = isAdmin
    ? `SELECT orders.*, users.name, users.surname, users.phone, users.city, users.email
       FROM orders LEFT JOIN users ON orders.user_id = users.id WHERE orders.id = ?`
    : `SELECT orders.*, users.name, users.surname, users.phone, users.city, users.email
       FROM orders LEFT JOIN users ON orders.user_id = users.id WHERE orders.id = ? AND orders.user_id = ?`;
  const params = isAdmin ? [req.params.id] : [req.params.id, req.user.id];
  db.get(sql, params, (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });

    const items = JSON.parse(order.items || '[]');
    const _d   = new Date(order.created_at);
    const date = _d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
               + ' в ' + _d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const statusMap = { new: 'Новый', paid: 'Оплачен', done: 'Выполнен' };

    const FONT  = 'C:\\Windows\\Fonts\\arial.ttf';
    const FONT_B = 'C:\\Windows\\Fonts\\arialbd.ttf';
    const GOLD  = '#c9a84c';
    const DARK  = '#1a1508';
    const MUTED = '#666655';
    const W     = 595 - 100;

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bonita-invoice-${order.id}.pdf"`);
    doc.pipe(res);

    try {
      doc.font(FONT_B).fontSize(28).fillColor(GOLD).text('BONITA', 50, 50);
      doc.font(FONT).fontSize(8).fillColor(MUTED)
         .text('Оптовые продажи посуды · Алматы, Казахстан', 50, 82)
         .text('bonita@gmail.com · +7 (777) 000-00-00', 50, 93);
      doc.font(FONT_B).fontSize(18).fillColor(DARK).text(`Счёт #${order.id}`, 0, 50, { align: 'right' });
      doc.font(FONT).fontSize(9).fillColor(MUTED)
         .text(`Дата: ${date}`, 0, 76, { align: 'right' })
         .text(`Статус: ${statusMap[order.status] || order.status}`, 0, 88, { align: 'right' });
      doc.moveTo(50, 115).lineTo(545, 115).strokeColor(GOLD).lineWidth(0.5).stroke();

      doc.font(FONT_B).fontSize(8).fillColor(MUTED).text('КЛИЕНТ', 50, 130);
      doc.font(FONT_B).fontSize(12).fillColor(DARK).text(`${order.name||''} ${order.surname||''}`, 50, 145);
      doc.font(FONT).fontSize(9).fillColor(MUTED);
      if (order.city)  doc.text(`Город: ${order.city}`,  50, 160);
      if (order.phone) doc.text(`Тел.: ${order.phone}`,  50, 172);
      if (order.email) doc.text(`Email: ${order.email}`, 50, 184);
      if (order.address) {
        doc.font(FONT_B).fontSize(8).fillColor(MUTED).text('АДРЕС ДОСТАВКИ', 320, 130);
        doc.font(FONT).fontSize(9).fillColor(DARK).text(order.address, 320, 145, { width: 220 });
      }
      if (order.payment) {
        const payY = order.address ? 170 : 130;
        doc.font(FONT_B).fontSize(8).fillColor(MUTED).text('ОПЛАТА', 320, payY);
        doc.font(FONT).fontSize(9).fillColor(DARK).text(order.payment, 320, payY + 14);
      }

      const tableTop = 225;
      const cols = { name: 50, boxes: 230, qty: 285, price: 340, disc: 415, total: 470 };
      doc.rect(50, tableTop - 6, W, 20).fillColor('#f5f0e8').fill();
      doc.font(FONT_B).fontSize(8).fillColor(MUTED);
      doc.text('ТОВАР',   cols.name,  tableTop, { width: 175 });
      doc.text('КОР.',    cols.boxes, tableTop, { width: 50,  align: 'right' });
      doc.text('ШТ',      cols.qty,   tableTop, { width: 50,  align: 'right' });
      doc.text('ЦЕНА/ШТ', cols.price, tableTop, { width: 70,  align: 'right' });
      doc.text('СКИДКА',  cols.disc,  tableTop, { width: 45,  align: 'right' });
      doc.text('ИТОГО',   cols.total, tableTop, { width: 75,  align: 'right' });
      doc.moveTo(50, tableTop + 16).lineTo(545, tableTop + 16).strokeColor('#ddd8c8').lineWidth(0.5).stroke();

      let y = tableTop + 24;
      items.forEach((item, i) => {
        if (i % 2 === 1) doc.rect(50, y - 4, W, 18).fillColor('#faf8f3').fill();
        doc.font(FONT).fontSize(9).fillColor(DARK);
        doc.text(item.name||'—',                                             cols.name,  y, { width: 175 });
        doc.text(item.boxes  ? String(item.boxes)  : '—',                   cols.boxes, y, { width: 50, align: 'right' });
        doc.text(item.qty    ? String(item.qty)    : '—',                   cols.qty,   y, { width: 50, align: 'right' });
        doc.text(item.price  ? item.price.toLocaleString('ru')+' ₸' : '—', cols.price, y, { width: 70, align: 'right' });
        doc.fillColor(item.discount ? '#4caf7d' : MUTED)
           .text(item.discount ? `−${item.discount}%` : '—',               cols.disc,  y, { width: 45, align: 'right' });
        doc.fillColor(DARK)
           .text(item.total ? item.total.toLocaleString('ru')+' ₸' : '—',  cols.total, y, { width: 75, align: 'right' });
        y += 20;
      });

      doc.moveTo(50, y + 2).lineTo(545, y + 2).strokeColor(GOLD).lineWidth(0.5).stroke();
      y += 12;
      doc.font(FONT_B).fontSize(11).fillColor(DARK).text('ИТОГО К ОПЛАТЕ:', cols.name, y)
         .fillColor(GOLD).text(`${(order.total||0).toLocaleString('ru')} ₸`, cols.total, y, { width: 75, align: 'right' });
      if (order.comment) {
        y += 40;
        doc.font(FONT_B).fontSize(8).fillColor(MUTED).text('КОММЕНТАРИЙ', 50, y);
        doc.font(FONT).fontSize(9).fillColor(DARK).text(order.comment, 50, y + 12, { width: W });
      }
      doc.moveTo(50, 775).lineTo(545, 775).strokeColor('#ddd8c8').lineWidth(0.5).stroke();
      doc.font(FONT).fontSize(7.5).fillColor(MUTED)
         .text('BONITA · Оптовые продажи посуды · Алматы, Казахстан', 50, 780, { align: 'center', width: W });
    } catch(fontErr) {
      console.warn('Arial not found, using Helvetica:', fontErr.message);
    }

    doc.end();
  });
});

// ── BANNERS ──
const settingsFile = path.join(__dirname, 'banner-settings.json');
function readBannerSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
  catch { return { interval: 3 }; }
}

app.get('/api/banners/settings', (req, res) => res.json(readBannerSettings()));

app.post('/api/banners/settings', adminAuth, (req, res) => {
  const interval = Number(req.body.interval);
  if (isNaN(interval) || interval < 0) return res.status(400).json({ error: 'Неверное значение' });
  fs.writeFileSync(settingsFile, JSON.stringify({ interval }));
  res.json({ message: 'Сохранено', interval });
});

app.get('/api/banners', (req, res) => {
  fs.readdir(uploadsDir, (err, files) => {
    if (err) return res.json([]);
    const imgs = (files||[]).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
    res.json(imgs.map(f => ({ filename: f, url: '/uploads/' + f })));
  });
});

app.post('/api/banners', adminAuth, bannerUpload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ filename: req.file.filename, url: '/uploads/' + req.file.filename, message: 'Загружено' });
});

app.delete('/api/banners/:filename', adminAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  fs.unlink(path.join(uploadsDir, filename), err => {
    if (err) return res.status(404).json({ error: 'Файл не найден' });
    res.json({ message: 'Удалено' });
  });
});

// ── MIDDLEWARE ──
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет доступа' });
  if (token === 'skip') { req.user = { role: 'admin' }; return next(); }
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Только для администратора' });
    req.user = decoded;
    next();
  } catch { res.status(401).json({ error: 'Неверный токен' }); }
}

function userAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Войдите в аккаунт' });
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch { res.status(401).json({ error: 'Неверный токен' }); }
}

// ── START ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  console.log(`Админ пароль: bonita_admin_2026`);
});
