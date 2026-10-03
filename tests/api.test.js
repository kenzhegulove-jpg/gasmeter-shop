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
  r = await call('seller', 'POST', `/api/seller/orders/${num}/pay`, { receiptNumber: '777' });
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

test('CSRF: запрос без заголовка отклоняется', async () => {
  const r = await fetch(base + '/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(r.status, 403);
});
