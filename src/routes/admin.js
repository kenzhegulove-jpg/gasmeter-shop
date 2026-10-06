'use strict';
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { q, tx } = require('../db');
const { HttpError, bad, str, digits } = require('../util');
const { requireRole } = require('../security/session');
const pw = require('../security/password');
const { parseRegistry } = require('../tu-import');
const { expirePending } = require('../orders');
const { isRegion } = require('../regions');
const { audit } = require('../audit');
const config = require('../config');
const { getSettings, updateSettings } = require('../settings');
const { stockMatrix, moveStock } = require('../stock');
const { parseFilters, salesPage, salesWorkbook } = require('../sales');
const { siteQrSvg, siteQrPng, siteQrPoster } = require('../site-qr');

const r = express.Router();
// Финансист: только просмотр и выгрузка отчетов (GET), все остальное — только администратор
const FINANCE_READ = [/^\/reports\//, /^\/sales(\/export\.xlsx)?$/, /^\/stock(\/moves)?$/, /^\/points$/];
r.use((req, res, next) => (req.method === 'GET' && FINANCE_READ.some(rx => rx.test(req.path))
  ? requireRole('admin', 'finance') : requireRole('admin'))(req, res, next));

const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const tuUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 50 } });

/* ---------- Точки продаж ---------- */
r.get('/points', async (_req, res) => {
  const { rows } = await q(`SELECT p.*, (SELECT count(*)::int FROM users u WHERE u.point_id=p.id AND NOT u.blocked) AS sellers
    FROM points p ORDER BY p.active DESC, p.region, p.address`);
  res.json(rows);
});

function pointBody(b) {
  const d = { region: str(b.region, 100), address: str(b.address, 300), hours: str(b.hours, 100), active: b.active !== false };
  if (!isRegion(d.region)) throw bad('Выберите город или область', 'region');
  if (!d.address) throw bad('Укажите адрес', 'address');
  return d;
}
r.post('/points', async (req, res) => {
  const d = pointBody(req.body || {});
  const { rows } = await q('INSERT INTO points (region, address, hours, active) VALUES ($1,$2,$3,$4) RETURNING *', [d.region, d.address, d.hours, d.active]);
  await audit(req, 'point_create', 'point', rows[0].id, d);
  res.status(201).json(rows[0]);
});
r.put('/points/:id', async (req, res) => {
  const d = pointBody(req.body || {});
  const { rows } = await q('UPDATE points SET region=$2, address=$3, hours=$4, active=$5, updated_at=now() WHERE id=$1 RETURNING *', [Number(req.params.id), d.region, d.address, d.hours, d.active]);
  if (!rows[0]) throw new HttpError(404, 'Точка не найдена');
  await audit(req, 'point_update', 'point', rows[0].id, d);
  res.json(rows[0]);
});

/* ---------- Продавцы ---------- */
r.get('/sellers', async (_req, res) => {
  const { rows } = await q(`SELECT u.id, u.role, u.full_name, u.login, u.point_id, u.blocked, u.must_change_password, u.last_login_at, u.locked_until > now() AS locked,
      p.region AS point_region, p.address AS point_address
    FROM users u LEFT JOIN points p ON p.id=u.point_id WHERE u.role IN ('seller','finance') ORDER BY u.blocked, u.role DESC, u.full_name`);
  res.json(rows);
});

async function sellerBody(b, id) {
  const d = { role: b.role === 'finance' ? 'finance' : 'seller', fullName: str(b.fullName, 200), login: str(b.login, 64), pointId: Number(b.pointId) || 0 };
  if (d.fullName.split(/\s+/).length < 2) throw bad('Укажите ФИО полностью', 'full_name');
  const le = pw.validateLogin(d.login);
  if (le) throw bad(le, 'login_format');
  const dup = await q('SELECT 1 FROM users WHERE lower(login)=lower($1) AND id <> $2', [d.login, id || 0]);
  if (dup.rowCount) throw bad('Такой логин уже занят', 'login_taken');
  if (d.role === 'seller') {
    const p = await q('SELECT 1 FROM points WHERE id=$1 AND active', [d.pointId]);
    if (!p.rowCount) throw bad('Выберите действующую точку продаж', 'point');
  } else d.pointId = null;
  return d;
}
r.post('/sellers', async (req, res) => {
  const d = await sellerBody(req.body || {});
  const temp = pw.generatePassword();
  const { rows } = await q(`INSERT INTO users (role, full_name, login, password_hash, point_id, must_change_password)
    VALUES ($5,$1,$2,$3,$4,true) RETURNING id`, [d.fullName, d.login, await pw.hashPassword(temp), d.pointId, d.role]);
  await audit(req, 'seller_create', 'user', rows[0].id, { login: d.login, role: d.role, pointId: d.pointId });
  res.status(201).json({ id: rows[0].id, tempPassword: temp });
});
r.put('/sellers/:id', async (req, res) => {
  const id = Number(req.params.id);
  const d = await sellerBody(req.body || {}, id);
  const { rowCount } = await q("UPDATE users SET role=$5, full_name=$2, login=$3, point_id=$4, updated_at=now() WHERE id=$1 AND role IN ('seller','finance')", [id, d.fullName, d.login, d.pointId, d.role]);
  if (rowCount) await q('DELETE FROM sessions WHERE user_id=$1', [id]); // роль/точка могли измениться
  if (!rowCount) throw new HttpError(404, 'Сотрудник не найден');
  await audit(req, 'seller_update', 'user', id, { login: d.login, pointId: d.pointId });
  res.json({ ok: true });
});
r.post('/sellers/:id/block', async (req, res) => {
  const id = Number(req.params.id), blocked = req.body?.blocked === true;
  const { rowCount } = await q("UPDATE users SET blocked=$2, updated_at=now() WHERE id=$1 AND role IN ('seller','finance')", [id, blocked]);
  if (!rowCount) throw new HttpError(404, 'Сотрудник не найден');
  if (blocked) await q('DELETE FROM sessions WHERE user_id=$1', [id]);
  await audit(req, blocked ? 'seller_block' : 'seller_unblock', 'user', id);
  res.json({ ok: true });
});
r.post('/sellers/:id/reset-password', async (req, res) => {
  const id = Number(req.params.id);
  const temp = pw.generatePassword();
  const { rowCount } = await q(`UPDATE users SET password_hash=$2, must_change_password=true, failed_logins=0, locked_until=NULL, updated_at=now()
    WHERE id=$1 AND role IN ('seller','finance')`, [id, await pw.hashPassword(temp)]);
  if (!rowCount) throw new HttpError(404, 'Сотрудник не найден');
  await q('DELETE FROM sessions WHERE user_id=$1', [id]);
  await audit(req, 'seller_reset_password', 'user', id);
  res.json({ tempPassword: temp });
});

/* ---------- Товары ---------- */
r.get('/products', async (_req, res) => {
  const { rows } = await q(`SELECT p.*, COALESCE(array_agg(ph.position ORDER BY ph.position) FILTER (WHERE ph.id IS NOT NULL), '{}') AS photos
    FROM products p LEFT JOIN product_photos ph ON ph.product_id=p.id GROUP BY p.id ORDER BY p.sort, p.id`);
  res.json(rows);
});
function productBody(b) {
  const d = { name: str(b.name, 200), description: str(b.description, 3000), price: Number(digits(b.price)), active: b.active !== false, sort: Number(b.sort) || 0 };
  const specs = Array.isArray(b.specs) ? b.specs.filter(s => Array.isArray(s) && s[0]).slice(0, 20).map(([k, v]) => [str(k, 80), str(v, 120)]) : [];
  if (!d.name) throw bad('Укажите название', 'name');
  if (!(d.price > 0) || d.price > 10000000) throw bad('Укажите цену', 'price');
  return { ...d, specs: JSON.stringify(specs) };
}
r.post('/products', async (req, res) => {
  const d = productBody(req.body || {});
  const { rows } = await q('INSERT INTO products (name, description, price, active, sort, specs) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [d.name, d.description, d.price, d.active, d.sort, d.specs]);
  await audit(req, 'product_create', 'product', rows[0].id, { name: d.name, price: d.price });
  res.status(201).json({ id: rows[0].id });
});
r.put('/products/:id', async (req, res) => {
  const d = productBody(req.body || {});
  const { rowCount } = await q('UPDATE products SET name=$2, description=$3, price=$4, active=$5, sort=$6, specs=$7, updated_at=now() WHERE id=$1', [Number(req.params.id), d.name, d.description, d.price, d.active, d.sort, d.specs]);
  if (!rowCount) throw new HttpError(404, 'Товар не найден');
  await audit(req, 'product_update', 'product', req.params.id, { name: d.name, price: d.price, active: d.active });
  res.json({ ok: true });
});

function imageMime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
r.post('/products/:id/photos', photoUpload.single('photo'), async (req, res) => {
  const id = Number(req.params.id);
  if (!req.file) throw bad('Выберите файл', 'file');
  const mime = imageMime(req.file.buffer);
  if (!mime) throw bad('Допустимые форматы: JPG, PNG, WEBP', 'mime');
  const pos = await tx(async c => {
    const p = await c.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [id]);
    if (!p.rowCount) throw new HttpError(404, 'Товар не найден');
    const used = (await c.query('SELECT position FROM product_photos WHERE product_id=$1', [id])).rows.map(x => x.position);
    const free = [0, 1, 2, 3].find(x => !used.includes(x));
    if (free === undefined) throw bad('У товара уже 4 фото', 'limit');
    await c.query('INSERT INTO product_photos (product_id, position, mime, data) VALUES ($1,$2,$3,$4)', [id, free, mime, req.file.buffer]);
    return free;
  });
  await audit(req, 'product_photo_add', 'product', id, { position: pos });
  res.status(201).json({ position: pos });
});
r.delete('/products/:id/photos/:pos', async (req, res) => {
  const id = Number(req.params.id), pos = Number(req.params.pos);
  await tx(async c => {
    await c.query('DELETE FROM product_photos WHERE product_id=$1 AND position=$2', [id, pos]);
    // Сдвигаем оставшиеся фото, чтобы позиции шли подряд (0 — главное фото)
    const rest = (await c.query('SELECT id FROM product_photos WHERE product_id=$1 ORDER BY position', [id])).rows;
    for (let i = 0; i < rest.length; i++) await c.query('UPDATE product_photos SET position=$2 WHERE id=$1', [rest[i].id, i + 10]);
    await c.query('UPDATE product_photos SET position=position-10 WHERE product_id=$1', [id]);
  });
  await audit(req, 'product_photo_delete', 'product', id, { position: pos });
  res.json({ ok: true });
});

/* ---------- База ТУ ---------- */
r.get('/tu', async (req, res) => {
  await expirePending();
  const raw = str(req.query.q, 100);
  const d = digits(raw);
  const page = Math.max(0, Number(req.query.page) || 0);
  const params = [];
  let where = '';
  if (raw) {
    params.push(`%${raw.toLowerCase()}%`);
    where = `WHERE lower(t.tu_number) LIKE $1 OR lower(t.owner_name) LIKE $1`;
    if (d.length >= 4) { params.push(`${d}%`); where += ` OR t.iin LIKE $2`; }
  }
  const total = (await q(`SELECT count(*)::int AS n FROM tu_records t ${where}`, params)).rows[0].n;
  const { rows } = await q(`SELECT t.tu_number, t.iin, t.owner_name, t.address, t.branch, t.issued_at, t.gas_flow, t.is_legal, t.loaded_at,
      (SELECT o.status FROM orders o WHERE o.tu_number=t.tu_number AND o.status IN ('pending','paid','issued') LIMIT 1) AS order_status
    FROM tu_records t ${where} ORDER BY t.loaded_at DESC, t.tu_number LIMIT 50 OFFSET ${page * 50}`, params);
  res.json({ total, page, rows });
});

r.get('/tu/imports', async (_req, res) => {
  const { rows } = await q(`SELECT i.id, i.folder, i.files, i.rows_read, i.added, i.duplicates, i.errors, i.created_at, u.full_name AS user_name
    FROM tu_imports i LEFT JOIN users u ON u.id=i.user_id ORDER BY i.created_at DESC LIMIT 20`);
  res.json(rows);
});

/** Загрузка реестра ТУ: несколько файлов .xlsx (содержимое выбранной папки) */
r.post('/tu/import', tuUpload.array('files', 50), async (req, res) => {
  const fileName = f => Buffer.from(f.originalname, 'latin1').toString('utf8').split('/').pop();
  const files = (req.files || []).filter(f => /\.xlsx$/i.test(fileName(f)) && !fileName(f).startsWith('~$'));
  if (!files.length) throw bad('В папке нет файлов .xlsx', 'no_files');
  const folder = str(req.body?.folder, 200) || 'без названия';
  const details = [];
  let rowsRead = 0, errors = 0;
  const all = new Map();
  let dupInFiles = 0;
  for (const f of files) {
    const name = fileName(f);
    try {
      const p = await parseRegistry(f.buffer, name);
      rowsRead += p.records.length + p.errors.length;
      errors += p.errors.length;
      for (const rec of p.records) { if (all.has(rec.tu_number)) dupInFiles++; else all.set(rec.tu_number, { ...rec, source_file: name }); }
      details.push({ file: name, branch: p.branch, records: p.records.length, errors: p.errors.slice(0, 50) });
    } catch (e) {
      errors++;
      details.push({ file: name, error: e.message });
    }
  }
  const records = [...all.values()];
  const result = await tx(async c => {
    const imp = await c.query('INSERT INTO tu_imports (user_id, folder, files) VALUES ($1,$2,$3) RETURNING id', [req.user.id, folder, files.length]);
    const importId = imp.rows[0].id;
    let added = 0;
    for (let i = 0; i < records.length; i += 500) {
      const chunk = records.slice(i, i + 500);
      const cols = ['tu_number', 'tu_last6', 'iin', 'owner_name', 'address', 'branch', 'issued_at', 'gas_flow', 'is_legal', 'source_file'];
      const ins = await c.query(`INSERT INTO tu_records (${cols.join(',')}, import_id)
        SELECT *, $11::int FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::timestamptz[], $8::numeric[], $9::bool[], $10::text[])
        ON CONFLICT (tu_number) DO NOTHING`,
        [chunk.map(x => x.tu_number), chunk.map(x => x.tu_last6), chunk.map(x => x.iin), chunk.map(x => x.owner_name), chunk.map(x => x.address),
         chunk.map(x => x.branch), chunk.map(x => x.issued_at), chunk.map(x => x.gas_flow), chunk.map(x => x.is_legal),
         chunk.map(x => x.source_file), importId]);
      added += ins.rowCount;
    }
    const duplicates = records.length - added + dupInFiles;
    await c.query('UPDATE tu_imports SET rows_read=$2, added=$3, duplicates=$4, errors=$5, details=$6 WHERE id=$1', [importId, rowsRead, added, duplicates, errors, JSON.stringify(details)]);
    return { id: importId, folder, files: files.length, rowsRead, added, duplicates, errors, details };
  });
  await audit(req, 'tu_import', 'tu_import', result.id, { folder, files: files.length, added: result.added, duplicates: result.duplicates, errors });
  res.json(result);
});

/* ---------- Отчёты ---------- */
function period(req) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
  return [from, to];
}
const PERIOD_SQL = "o.created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Almaty' AND o.created_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Almaty'";

r.get('/reports/summary', async (req, res) => {
  await expirePending();
  const p = period(req);
  const kpi = (await q(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status='issued')::int AS issued,
      count(*) FILTER (WHERE status='paid')::int AS paid,
      count(*) FILTER (WHERE status='pending')::int AS pending,
      count(*) FILTER (WHERE status='returned')::int AS returned,
      count(*) FILTER (WHERE status='cancelled')::int AS cancelled,
      COALESCE(sum(price) FILTER (WHERE status IN ('paid','issued')),0) AS revenue
    FROM orders o WHERE ${PERIOD_SQL}`, p)).rows[0];
  const byPoint = (await q(`SELECT pt.id, pt.region, pt.address, count(o.*)::int AS total,
      count(*) FILTER (WHERE o.status='issued')::int AS issued,
      count(*) FILTER (WHERE o.status='returned')::int AS returned,
      COALESCE(sum(o.price) FILTER (WHERE o.status IN ('paid','issued')),0) AS revenue
    FROM orders o JOIN points pt ON pt.id=o.point_id WHERE ${PERIOD_SQL}
    GROUP BY pt.id ORDER BY total DESC`, p)).rows;
  const recent = (await q(`SELECT o.num, o.created_at, o.tu_number, o.product_name, o.status, o.serial_number, pt.region AS point_region
    FROM orders o JOIN points pt ON pt.id=o.point_id WHERE ${PERIOD_SQL} ORDER BY o.created_at DESC LIMIT 15`, p)).rows;
  res.json({ from: p[0], to: p[1], kpi, byPoint, recent });
});

const STATUS = { pending: 'Ожидает оплаты', paid: 'Оплачен', issued: 'Выдан', returned: 'Возврат', cancelled: 'Отменён' };

r.get('/reports/export.xlsx', async (req, res) => {
  await expirePending();
  const p = period(req);
  const { rows } = await q(`SELECT o.*, t.iin, t.owner_name, t.address, t.branch, pt.region AS point_region, pt.address AS point_address,
      ui.full_name AS issued_by_name, ur.full_name AS returned_by_name
    FROM orders o JOIN tu_records t ON t.tu_number=o.tu_number JOIN points pt ON pt.id=o.point_id
    LEFT JOIN users ui ON ui.id=o.issued_by LEFT JOIN users ur ON ur.id=o.returned_by
    WHERE ${PERIOD_SQL} ORDER BY o.created_at`, p);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Заказы');
  ws.columns = [
    ['№ заказа', 'num', 11], ['Дата заказа', 'created_at', 18], ['Статус', 'status', 15], ['Номер ТУ', 'tu_number', 24], ['ИИН/БИН', 'iin', 15],
    ['Владелец ТУ', 'owner_name', 32], ['Адрес установки', 'address', 45], ['Филиал', 'branch', 30], ['Товар', 'product_name', 32], ['Цена', 'price', 11],
    ['Регион точки', 'point_region', 20], ['Адрес точки', 'point_address', 30], ['Оплачен', 'paid_at', 18], ['Номер чека', 'receipt_number', 14],
    ['Выдан', 'issued_at', 18], ['Продавец', 'issued_by_name', 28], ['Серийный №', 'serial_number', 18], ['Получатель', 'recipient', 14],
    ['№ доверенности', 'proxy_number', 14], ['Дата доверенности', 'proxy_date', 14], ['ИИН доверенного', 'proxy_iin', 15],
    ['Возврат', 'returned_at', 18], ['Причина возврата', 'return_reason', 24],
  ].map(([header, key, width]) => ({ header, key, width }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  // Excel не хранит часовой пояс — переводим в местное время (UTC+5)
  const local = d => (d ? new Date(new Date(d).getTime() + 5 * 3600000) : null);
  for (const o of rows) ws.addRow({ ...o, created_at: local(o.created_at), paid_at: local(o.paid_at), issued_at: local(o.issued_at), returned_at: local(o.returned_at), status: STATUS[o.status], recipient: o.recipient === 'proxy' ? 'Представитель' : o.recipient === 'owner' ? 'Владелец' : '' });
  for (const k of ['created_at', 'paid_at', 'issued_at', 'returned_at']) ws.getColumn(k).numFmt = 'dd.mm.yyyy hh:mm';
  ws.getColumn('price').numFmt = '# ##0';
  await audit(req, 'report_export', 'report', null, { from: p[0], to: p[1], rows: rows.length });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .set('Content-Disposition', `attachment; filename="orders_${p[0]}_${p[1]}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

/* ---------- Настройки ---------- */
r.get('/settings', async (_req, res) => res.json(await getSettings()));
r.put('/settings', async (req, res) => {
  const changed = await updateSettings(req.body || {}, req.user.id);
  if (changed.length) await audit(req, 'settings_update', 'settings', null, Object.fromEntries(changed.map(c => [c.key, `${c.from} → ${c.to}`])));
  res.json(await getSettings());
});

/* ---------- Остатки по точкам ---------- */
r.get('/stock', async (_req, res) => {
  await expirePending();
  const s = await getSettings();
  const points = (await q('SELECT id, region, address FROM points WHERE active ORDER BY region, address')).rows;
  const products = (await q('SELECT id, name FROM products WHERE active ORDER BY sort, id')).rows;
  res.json({ settings: s, points, products, cells: await stockMatrix() });
});

async function stockTarget(b) {
  const pointId = Number(b.pointId) || 0, productId = Number(b.productId) || 0;
  const ok = (await q('SELECT (SELECT active FROM points WHERE id=$1) AS pt, (SELECT active FROM products WHERE id=$2) AS pr', [pointId, productId])).rows[0];
  if (!ok.pt) throw bad('Выберите действующую точку', 'point');
  if (!ok.pr) throw bad('Выберите товар', 'product');
  return { pointId, productId };
}
r.post('/stock/receipt', async (req, res) => {
  const t = await stockTarget(req.body || {});
  const qty = Math.round(Number(req.body?.qty));
  if (!(qty >= 1 && qty <= 100000)) throw bad('Количество — от 1 до 100 000', 'qty');
  const comment = str(req.body?.comment, 300) || null;
  const balance = await tx(c => moveStock(c, { ...t, delta: qty, reason: 'receipt', userId: req.user.id, comment }));
  await audit(req, 'stock_receipt', 'stock', `${t.pointId}/${t.productId}`, { qty, balance });
  res.json({ balance });
});
r.post('/stock/correction', async (req, res) => {
  const t = await stockTarget(req.body || {});
  const actual = Math.round(Number(req.body?.actual));
  if (!(actual >= 0 && actual <= 100000)) throw bad('Фактический остаток — от 0 до 100 000', 'actual');
  const comment = str(req.body?.comment, 300);
  if (!comment) throw bad('Укажите причину корректировки', 'comment');
  const balance = await tx(async c => {
    await c.query('INSERT INTO stock (point_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [t.pointId, t.productId]);
    const cur = (await c.query('SELECT on_hand FROM stock WHERE point_id=$1 AND product_id=$2 FOR UPDATE', [t.pointId, t.productId])).rows[0].on_hand;
    if (cur === actual) throw bad('Фактический остаток совпадает с учётным', 'same');
    return moveStock(c, { ...t, delta: actual - cur, reason: 'correction', userId: req.user.id, comment });
  });
  await audit(req, 'stock_correction', 'stock', `${t.pointId}/${t.productId}`, { actual, comment });
  res.json({ balance });
});
r.get('/stock/moves', async (req, res) => {
  const pointId = Number(req.query.pointId) || null;
  const { rows } = await q(`SELECT m.*, pt.region AS point_region, pt.address AS point_address, pr.name AS product_name, u.full_name AS user_name
    FROM stock_moves m JOIN points pt ON pt.id=m.point_id JOIN products pr ON pr.id=m.product_id LEFT JOIN users u ON u.id=m.user_id
    ${pointId ? 'WHERE m.point_id=$1' : ''} ORDER BY m.created_at DESC LIMIT 200`, pointId ? [pointId] : []);
  res.json(rows);
});

/* ---------- Реестр продаж ---------- */
r.get('/sales', async (req, res) => res.json(await salesPage(parseFilters(req.query))));
r.get('/sales/export.xlsx', async (req, res) => {
  const f = parseFilters(req.query);
  let title = 'Реестр продаж счетчиков газа: все точки';
  if (f.pointId) { const pt = (await q('SELECT region, address FROM points WHERE id=$1', [f.pointId])).rows[0]; if (pt) title = `Реестр продаж: ${pt.region}, ${pt.address}`; }
  const { wb, count } = await salesWorkbook(f, title);
  await audit(req, 'sales_export', 'report', null, { from: f.from, to: f.to, pointId: f.pointId, rows: count });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .set('Content-Disposition', `attachment; filename="sales_${f.from}_${f.to}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

/* ---------- QR-код сайта для точек продаж ---------- */
const siteUrl = req => config.siteUrl || `${req.protocol}://${req.get('host')}`;
r.get('/site-qr', (req, res) => res.json({ url: siteUrl(req) }));
r.get('/site-qr.svg', async (req, res) => {
  res.set('Content-Type', 'image/svg+xml').set('Content-Disposition', 'attachment; filename="qr-site.svg"').send(await siteQrSvg(siteUrl(req)));
});
r.get('/site-qr.png', async (req, res) => {
  res.set('Content-Type', 'image/png').set('Content-Disposition', 'attachment; filename="qr-site.png"').send(await siteQrPng(siteUrl(req)));
});
r.get('/site-qr.pdf', async (req, res) => {
  res.set('Content-Type', 'application/pdf').set('Content-Disposition', 'attachment; filename="qr-site-poster.pdf"').send(await siteQrPoster(siteUrl(req)));
});

/* ---------- Журнал действий ---------- */
r.get('/audit', async (_req, res) => {
  const { rows } = await q(`SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.ip, a.created_at, u.full_name AS user_name, u.login
    FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 200`);
  res.json(rows);
});

module.exports = r;
