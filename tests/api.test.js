'use strict';
// Интеграционный тест API. Нужна отдельная тестовая БД:
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/gasmeter_test npm test
// Без TEST_DATABASE_URL тест пропускается.
const test = require('node:test');
const assert = require('node:assert');

const url = process.env.TEST_DATABASE_URL;
if (!url) { test('API (пропущено: не задан TEST_DATABASE_URL)', { skip: true }, () => {}); return; }
process.env.DATABASE_URL = url;
process.env.NODE_ENV = 'test';

const { migrate, q, pool } = require('../src/db');
const { createApp } = require('../src/app');
const pw = require('../src/security/password');
const { makeRegistry } = require('./helpers');

let base, server;
const jar = {};
async function call(who, method, path, body, form) {
  const headers = { 'X-Requested-With': 'fetch' };
  if (jar[who]) headers.Cookie = jar[who];
  let payload;
  if (form) payload = form; else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + path, { method, headers, body: payload });
  const c = r.headers.get('set-cookie'); if (c) jar[who] = c.split(';')[0];
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
  return { status: r.status, data };
}
const captcha = async () => (await call('anon', 'GET', '/api/captcha')).data.id;
// Минимальный корректный JPEG (1×1) — для фото кассового чека
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const photoForm = (buf = JPEG, name = 'receipt.jpg') => { const fd = new FormData(); fd.append('photo', new Blob([buf]), name); return fd; };
const pay = (who, num, buf) => call(who, 'POST', `/api/seller/orders/${num}/pay`, undefined, photoForm(buf));

test.before(async () => {
  await migrate();
  await q('TRUNCATE orders, tu_records, tu_imports, sessions, audit_log, password_history, users, attempt_locks, check_log, captchas, product_photos, products, points RESTART IDENTITY CASCADE');
  await q("INSERT INTO points (region, address) VALUES ('Астана', 'ул. Тестовая, 1')");
  await q("INSERT INTO products (name, price) VALUES ('Счетчик G4', 54000)");
  await q("INSERT INTO users (role, full_name, login, password_hash, must_change_password) VALUES ('admin','Админ Тестовый','admin',$1,false)", [await pw.hashPassword('Adm1n#Strong!')]);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

test('полный сценарий: загрузка ТУ → заказ → выдача → возврат', async () => {
  let r = await call('admin', 'POST', '/api/auth/login', { login: 'admin', password: 'Adm1n#Strong!', captchaId: await captcha(), captchaText: 'TEST' });
  assert.strictEqual(r.status, 200);

  const fd = new FormData();
  fd.append('folder', 'test');
  fd.append('files', new Blob([await makeRegistry([
    { owner: 'Тестова Анна Сергеевна', address: 'Астана г., ул. Тестовая, 5', iin: '900101400123', number: '01-гор-2026-000001234' },
  ])]), 'reg.xlsx');
  r = await call('admin', 'POST', '/api/admin/tu/import', undefined, fd);
  assert.strictEqual(r.data.added, 1);

  r = await call('admin', 'POST', '/api/admin/sellers', { fullName: 'Продавцов Петр Петрович', login: 'p.prodavtsov', pointId: 1 });
  const temp = r.data.tempPassword;
  assert.ok(temp);

  // Проверка покупателя
  r = await call('anon', 'POST', '/api/check', { iin: '900101400123', tu6: '001234', captchaId: await captcha(), captchaText: 'TEST' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.options[0].name, 'Анна Т.');
  r = await call('anon', 'POST', '/api/orders', { ticket: r.data.options[0].ticket, productId: 1, pointId: 1, confirmed: true });
  assert.strictEqual(r.status, 201);
  const { num, token } = r.data;

  // Повторная покупка по тому же ТУ невозможна
  r = await call('anon', 'POST', '/api/check', { iin: '900101400123', tu6: '001234', captchaId: await captcha(), captchaText: 'TEST' });
  assert.strictEqual(r.data.code, 'pending');

  r = await call('anon', 'GET', `/api/orders/${num}?t=${token}`);
  assert.strictEqual(r.data.status, 'pending');
  // Бронь неоплаченного заказа — 2 часа
  const ttl = new Date(r.data.expiresAt) - new Date(r.data.createdAt);
  assert.ok(Math.abs(ttl - 2 * 3600000) < 5000, `срок брони ${ttl} мс`);
  r = await call('anon', 'GET', `/api/orders/${num}/pdf?t=${token}`);
  assert.strictEqual(r.status, 200);

  // Продавец: временный пароль → обязательная смена
  r = await call('seller', 'POST', '/api/auth/login', { login: 'p.prodavtsov', password: temp, captchaId: await captcha(), captchaText: 'TEST' });
  assert.strictEqual(r.status, 200);
  r = await call('seller', 'GET', `/api/seller/orders/${num}`);
  assert.strictEqual(r.data.code, 'must_change_password');
  r = await call('seller', 'POST', '/api/auth/change-credentials', { currentPassword: temp, newPassword: 'slabyi' });
  assert.strictEqual(r.data.code, 'password_policy');
  r = await call('seller', 'POST', '/api/auth/change-credentials', { currentPassword: temp, newPassword: 'Vydacha#2026kz' });
  assert.strictEqual(r.status, 200);

  r = await call('seller', 'POST', `/api/seller/orders/${num}/issue`, { serialNumber: 'X1', checklist: { id: true, passport: true, stamp: true, sticker: true } });
  assert.strictEqual(r.data.code, 'status'); // ещё не оплачен
  r = await pay('seller', num, Buffer.from('not an image'));
  assert.strictEqual(r.data.code, 'receipt_format');
  r = await pay('seller', num, Buffer.concat([JPEG, Buffer.alloc(520 * 1024)]));
  assert.strictEqual(r.status, 400); // больше 500 КБ
  r = await call('seller', 'POST', `/api/seller/orders/${num}/pay`, {});
  assert.strictEqual(r.data.code, 'receipt'); // без фото — отклонено
  r = await pay('seller', num);
  assert.strictEqual(r.data.hasReceiptPhoto, true);
  const ph = await fetch(`${base}/api/receipts/${num}`, { headers: { Cookie: jar.seller } });
  assert.strictEqual(ph.headers.get('content-type'), 'image/jpeg');
  assert.strictEqual(r.data.status, 'paid');
  assert.strictEqual(r.data.status, 'paid');
  r = await call('seller', 'POST', `/api/seller/orders/${num}/issue`, { serialNumber: 'X1', checklist: { id: true, passport: true, stamp: true } });
  assert.strictEqual(r.data.code, 'incomplete');
  r = await call('seller', 'POST', `/api/seller/orders/${num}/issue`, { serialNumber: 'x1', checklist: { id: true, passport: true, stamp: true, sticker: true } });
  assert.strictEqual(r.data.status, 'issued');

  r = await call('anon', 'POST', '/api/check', { iin: '900101400123', tu6: '001234', captchaId: await captcha(), captchaText: 'TEST' });
  assert.strictEqual(r.data.code, 'already_bought');

  r = await call('seller', 'GET', '/api/seller/returns/find?serial=X1');
  assert.strictEqual(r.data.num, num);
  r = await call('seller', 'POST', `/api/seller/orders/${num}/return`, { reason: 'Отказ покупателя', confirmed: true });
  assert.strictEqual(r.status, 200);
  r = await call('anon', 'POST', '/api/check', { iin: '900101400123', tu6: '001234', captchaId: await captcha(), captchaText: 'TEST' });
  assert.strictEqual(r.status, 200); // ТУ разблокировано
});

test('блокировка после 5 неудачных проверок и единое сообщение', async () => {
  for (let i = 1; i <= 4; i++) {
    const r = await call('anon2', 'POST', '/api/check', { iin: '111111111111', tu6: '000000', captchaId: await captcha(), captchaText: 'TEST' });
    assert.strictEqual(r.data.code, 'not_found');
    assert.strictEqual(r.data.attemptsLeft, 5 - i);
  }
  let r = await call('anon2', 'POST', '/api/check', { iin: '111111111111', tu6: '000000', captchaId: await captcha(), captchaText: 'TEST' });
  assert.strictEqual(r.data.code, 'locked');
  r = await call('anon2', 'POST', '/api/check', { iin: '111111111111', tu6: '000000', captchaId: await captcha(), captchaText: 'TEST' });
  assert.strictEqual(r.data.code, 'locked');
  // Капча обязательна
  r = await call('anon2', 'POST', '/api/check', { iin: '222222222222', tu6: '000000', captchaId: await captcha(), captchaText: 'wrong' });
  assert.strictEqual(r.data.code, 'captcha');
});

test('вход сотрудника блокируется после 5 неудачных попыток', async () => {
  for (let i = 0; i < 4; i++) {
    const r = await call('x', 'POST', '/api/auth/login', { login: 'admin', password: 'bad', captchaId: await captcha(), captchaText: 'TEST' });
    assert.strictEqual(r.status, 401);
  }
  let r = await call('x', 'POST', '/api/auth/login', { login: 'admin', password: 'bad', captchaId: await captcha(), captchaText: 'TEST' });
  assert.strictEqual(r.data.code, 'locked');
  r = await call('x', 'POST', '/api/auth/login', { login: 'admin', password: 'Adm1n#Strong!', captchaId: await captcha(), captchaText: 'TEST' });
  assert.strictEqual(r.data.code, 'locked'); // даже верный пароль — до истечения 60 минут
});

test('остатки: бронь, защита последней штуки, выдача, возврат в остаток', async () => {
  // Админ уже вошёл в первом тесте, но вход мог быть заблокирован тестом блокировки — входим заново через новую сессию
  await q("UPDATE users SET failed_logins=0, locked_until=NULL WHERE login='admin'");
  let r = await call('adm2', 'POST', '/api/auth/login', { login: 'admin', password: 'Adm1n#Strong!', captchaId: await captcha(), captchaText: 'TEST' });
  assert.strictEqual(r.status, 200);
  const fd = new FormData();
  fd.append('folder', 'stock');
  fd.append('files', new Blob([await makeRegistry([
    { owner: 'Остатков Олег Олегович', address: 'Астана г., ул. Складская, 1', iin: '850101300111', number: '01-гор-2026-000005001' },
    { owner: 'Бронина Бэлла Борисовна', address: 'Астана г., ул. Складская, 2', iin: '860101400222', number: '01-гор-2026-000005002' },
    { owner: 'ТОО "Юрлицо"', address: 'Астана г., ул. Складская, 3', iin: '200740021049', number: '01-гор-2026-000005003' },
  ])]), 'stock.xlsx');
  r = await call('adm2', 'POST', '/api/admin/tu/import', undefined, fd);
  assert.strictEqual(r.data.added, 3);

  // Включаем учёт; остатков нет → товара нет в наличии, точек для выдачи нет
  r = await call('adm2', 'PUT', '/api/admin/settings', { stockEnabled: true });
  assert.strictEqual(r.data.stockEnabled, true);
  r = await call('anon', 'GET', '/api/catalog');
  assert.strictEqual(r.data[0].inStock, false);
  r = await call('anon', 'GET', '/api/points?productId=1');
  assert.strictEqual(r.data.points.length, 0);
  const check = async (iin, tu6) => (await call('anon', 'POST', '/api/check', { iin, tu6, captchaId: await captcha(), captchaText: 'TEST' })).data;
  let c1 = await check('850101300111', '005001');
  r = await call('anon', 'POST', '/api/orders', { ticket: c1.options[0].ticket, productId: 1, pointId: 1, confirmed: true });
  assert.strictEqual(r.data.code, 'out_of_stock');

  // Приход 1 шт. → один заказ проходит, второй (другое ТУ) — уже нет
  r = await call('adm2', 'POST', '/api/admin/stock/receipt', { pointId: 1, productId: 1, qty: 1, comment: 'накладная 1' });
  assert.strictEqual(r.data.balance, 1);
  r = await call('anon', 'GET', '/api/points?productId=1');
  assert.strictEqual(r.data.points[0].available, 1);
  r = await call('anon', 'POST', '/api/orders', { ticket: c1.options[0].ticket, productId: 1, pointId: 1, confirmed: true });
  assert.strictEqual(r.status, 201);
  const num = r.data.num;
  const c2 = await check('860101400222', '005002');
  r = await call('anon', 'POST', '/api/orders', { ticket: c2.options[0].ticket, productId: 1, pointId: 1, confirmed: true });
  assert.strictEqual(r.data.code, 'out_of_stock');
  r = await call('anon', 'GET', '/api/catalog');
  assert.strictEqual(r.data[0].inStock, false); // 1 на складе, 1 в брони

  // Выдача списывает остаток
  await pay('seller', num);
  r = await call('seller', 'POST', `/api/seller/orders/${num}/issue`, { serialNumber: 'ST-1', checklist: { id: true, passport: true, stamp: true, sticker: true } });
  assert.strictEqual(r.data.status, 'issued');
  r = await call('adm2', 'GET', '/api/admin/stock');
  let cell = r.data.cells.find(x => x.point_id === 1 && x.product_id === 1);
  assert.deepStrictEqual([cell.on_hand, cell.reserved, cell.available], [0, 0, 0]);

  // Отчёты продавца и реестр продаж
  r = await call('seller', 'GET', '/api/seller/summary');
  assert.ok(r.data.kpi.issued >= 1);
  assert.ok(r.data.stock.length >= 1);
  r = await call('seller', 'GET', '/api/seller/sales');
  assert.ok(r.data.rows.some(o => o.num === num));
  r = await call('seller', 'GET', '/api/seller/sales/export.xlsx');
  assert.strictEqual(r.status, 200);
  r = await call('adm2', 'GET', '/api/admin/sales?q=ST-1');
  assert.strictEqual(r.data.rows.length, 1);
  r = await call('adm2', 'GET', '/api/admin/sales/export.xlsx');
  assert.strictEqual(r.status, 200);

  // Возврат: неисправный — не в остаток; исправный — в остаток
  r = await call('seller', 'GET', '/api/seller/returns/find?serial=ST-1');
  assert.strictEqual(r.data.stockTracked, true);
  r = await call('seller', 'POST', `/api/seller/orders/${num}/return`, { reason: 'Отказ покупателя', returnToStock: true, confirmed: true });
  assert.strictEqual(r.data.returnedToStock, true);
  r = await call('adm2', 'GET', '/api/admin/stock');
  cell = r.data.cells.find(x => x.point_id === 1 && x.product_id === 1);
  assert.strictEqual(cell.on_hand, 1);

  // Корректировка остатка и журнал движений
  r = await call('adm2', 'POST', '/api/admin/stock/correction', { pointId: 1, productId: 1, actual: 7, comment: 'инвентаризация' });
  assert.strictEqual(r.data.balance, 7);
  r = await call('adm2', 'GET', '/api/admin/stock/moves');
  assert.deepStrictEqual(r.data.map(m => m.reason).slice(0, 4), ['correction', 'return', 'issue', 'receipt']);

  // Настройка «продажа юрлицам»
  await call('adm2', 'PUT', '/api/admin/settings', { allowLegalEntities: false });
  assert.strictEqual((await check('200740021049', '005003')).code, 'legal');
  await call('adm2', 'PUT', '/api/admin/settings', { allowLegalEntities: true });
  assert.ok((await check('200740021049', '005003')).options);

  // QR-код сайта
  r = await call('adm2', 'GET', '/api/admin/site-qr.pdf');
  assert.strictEqual(r.status, 200);
  r = await call('adm2', 'GET', '/api/admin/site-qr.svg');
  assert.ok(String(r.data).includes('<svg'));
  await call('adm2', 'PUT', '/api/admin/settings', { stockEnabled: false });
});

test('остатки: одновременные заказы последней штуки — продаётся ровно одна', async () => {
  const fd = new FormData();
  fd.append('folder', 'race');
  const regs = Array.from({ length: 5 }, (_, i) => ({ owner: `Гонкин Гарри ${i}`, address: `Астана г., ул. Гонок, ${i}`, iin: `90020130${String(i).padStart(4, '0')}`, number: `01-гор-2026-00000${6000 + i}` }));
  fd.append('files', new Blob([await makeRegistry(regs)]), 'race.xlsx');
  await call('adm2', 'POST', '/api/admin/tu/import', undefined, fd);
  await call('adm2', 'PUT', '/api/admin/settings', { stockEnabled: true });
  const st = (await call('adm2', 'GET', '/api/admin/stock')).data.cells.find(x => x.point_id === 1 && x.product_id === 1);
  await call('adm2', 'POST', '/api/admin/stock/correction', { pointId: 1, productId: 1, actual: st.reserved + 1, comment: 'ровно одна свободная' });
  const tickets = [];
  for (const t of regs) {
    const r = await call('anon', 'POST', '/api/check', { iin: t.iin, tu6: t.number.slice(-6), captchaId: await captcha(), captchaText: 'TEST' });
    tickets.push(r.data.options[0].ticket);
  }
  const results = await Promise.all(tickets.map(ticket => call('anon', 'POST', '/api/orders', { ticket, productId: 1, pointId: 1, confirmed: true })));
  assert.strictEqual(results.filter(r => r.status === 201).length, 1);
  assert.strictEqual(results.filter(r => r.data.code === 'out_of_stock').length, 4);
  await call('adm2', 'PUT', '/api/admin/settings', { stockEnabled: false });
});

test('финансист: только просмотр и выгрузка отчетов', async () => {
  let r = await call('adm2', 'POST', '/api/admin/sellers', { role: 'finance', fullName: 'Финансова Фатима Фаридовна', login: 'f.finance' });
  assert.strictEqual(r.status, 201);
  const temp = r.data.tempPassword;
  await call('fin', 'POST', '/api/auth/login', { login: 'f.finance', password: temp, captchaId: await captcha(), captchaText: 'TEST' });
  r = await call('fin', 'POST', '/api/auth/change-credentials', { currentPassword: temp, newPassword: 'Otchety#2026kz' });
  assert.strictEqual(r.status, 200);
  r = await call('fin', 'GET', '/api/auth/me');
  assert.strictEqual(r.data.role, 'finance');
  // разрешено: отчеты, реестр, остатки, выгрузки, фото чеков
  for (const p of ['/api/admin/reports/summary', '/api/admin/reports/export.xlsx', '/api/admin/sales', '/api/admin/sales/export.xlsx', '/api/admin/stock', '/api/admin/stock/moves', '/api/admin/points']) {
    r = await call('fin', 'GET', p);
    assert.strictEqual(r.status, 200, p);
  }
  const anyReceipt = (await q('SELECT order_num FROM receipt_photos LIMIT 1')).rows[0].order_num;
  r = await fetch(`${base}/api/receipts/${anyReceipt}`, { headers: { Cookie: jar.fin } });
  assert.strictEqual(r.status, 200);
  // запрещено: любые изменения и служебные разделы
  const denied = [
    ['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings', { stockEnabled: true }],
    ['GET', '/api/admin/sellers'], ['POST', '/api/admin/sellers', { role: 'seller', fullName: 'Хакер Хакер', login: 'hack', pointId: 1 }],
    ['POST', '/api/admin/stock/receipt', { pointId: 1, productId: 1, qty: 5 }], ['POST', '/api/admin/points', { region: 'Астана', address: 'x' }],
    ['PUT', '/api/admin/products/1', { name: 'x', price: 1 }], ['GET', '/api/admin/tu'], ['GET', '/api/admin/audit'],
    ['GET', '/api/seller/orders-active'], ['GET', '/api/admin/site-qr.pdf'],
  ];
  for (const [m, p, b] of denied) {
    r = await call('fin', m, p, b);
    assert.strictEqual(r.status, 403, `${m} ${p}`);
  }
  // финансиста можно перевести в продавцы только с точкой
  const id = (await q("SELECT id FROM users WHERE login='f.finance'")).rows[0].id;
  r = await call('adm2', 'PUT', `/api/admin/sellers/${id}`, { role: 'seller', fullName: 'Финансова Фатима Фаридовна', login: 'f.finance' });
  assert.strictEqual(r.data.code, 'point');
});

test('CSRF: запрос без заголовка отклоняется', async () => {
  const r = await fetch(base + '/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(r.status, 403);
});
