'use strict';
const express = require('express');
const config = require('../config');
const { q, tx } = require('../db');
const { HttpError, bad, digits, isIIN, shortName, dear, randomToken, safeEqual, clientIp, fmtMinutes } = require('../util');
const { createCaptcha, verifyCaptcha } = require('../security/captcha');
const { lockedFor, registerFail, resetFails } = require('../security/locks');
const { expirePending, getOrder, publicOrder, signTicket, verifyTicket } = require('../orders');
const { orderPdf, orderQrSvg } = require('../pdf');
const { REGION_ORDER } = require('../regions');
const { getSettings } = require('../settings');
const { availabilityByPoint, availabilityByProduct, lockAvailable } = require('../stock');

const r = express.Router();

r.get('/catalog', async (_req, res) => {
  const { rows } = await q(`
    SELECT p.id, p.name, p.description, p.price, p.specs,
           COALESCE(array_agg(ph.position ORDER BY ph.position) FILTER (WHERE ph.id IS NOT NULL), '{}') AS photos
    FROM products p LEFT JOIN product_photos ph ON ph.product_id = p.id
    WHERE p.active GROUP BY p.id ORDER BY p.sort, p.id`);
  const s = await getSettings();
  if (s.stockEnabled) {
    await expirePending();
    const av = await availabilityByProduct();
    for (const p of rows) { p.available = av.get(p.id) || 0; p.inStock = p.available > 0; }
  } else rows.forEach(p => { p.inStock = true; });
  res.json(rows);
});

r.get('/products/:id/photos/:pos', async (req, res) => {
  const { rows } = await q('SELECT mime, data FROM product_photos WHERE product_id=$1 AND position=$2', [Number(req.params.id) || 0, Number(req.params.pos) || 0]);
  if (!rows[0]) throw new HttpError(404, 'Фото не найдено');
  res.set('Content-Type', rows[0].mime).set('Cache-Control', 'public, max-age=300').send(rows[0].data);
});

/** Точки выдачи; с productId и включённым учётом остатков — только точки, где товар есть в наличии */
r.get('/points', async (req, res) => {
  let { rows } = await q('SELECT id, region, address, hours FROM points WHERE active ORDER BY address');
  const s = await getSettings();
  const productId = Number(req.query.productId) || 0;
  if (s.stockEnabled && productId) {
    await expirePending();
    const av = await availabilityByPoint(productId);
    rows = rows.filter(p => (av.get(p.id) || 0) > 0).map(p => ({ ...p, available: av.get(p.id) }));
  }
  res.json({ regions: REGION_ORDER, points: rows, stockEnabled: s.stockEnabled });
});

r.get('/captcha', async (_req, res) => {
  res.set('Cache-Control', 'no-store').json(await createCaptcha());
});

const NOT_FOUND_MSG = 'Вам пока нельзя купить счетчик. Проверьте ИИН и последние 6 цифр номера ТУ.';

/** Проверка права на покупку: ИИН + последние 6 цифр номера ТУ + CAPTCHA */
r.post('/check', async (req, res) => {
  const iin = digits(req.body?.iin);
  const tu6 = digits(req.body?.tu6);
  const ip = clientIp(req);
  const C = config.check;

  const lockMsg = m => new HttpError(429, `Превышено количество попыток. Повторите через ${m} мин.`, 'locked', { retryMin: m });
  const ipLock = await lockedFor('check_ip', ip);
  if (ipLock) throw lockMsg(ipLock);
  if (!isIIN(iin)) throw bad('ИИН должен состоять из 12 цифр', 'iin_format');
  if (tu6.length !== 6) throw bad('Введите последние 6 цифр номера ТУ', 'tu6_format');
  const iinLock = await lockedFor('check_iin', iin);
  if (iinLock) throw lockMsg(iinLock);
  if (!(await verifyCaptcha(req.body?.captchaId, req.body?.captchaText))) throw bad('Неверный код с картинки. Введите новый код.', 'captcha');

  const { rows } = await q('SELECT tu_number, owner_name, address, is_legal, gas_flow FROM tu_records WHERE iin=$1 AND tu_last6=$2', [iin, tu6]);
  if (!rows.length) {
    const f1 = await registerFail('check_iin', iin, C.iinMaxFails, C.lockMin);
    await registerFail('check_ip', ip, C.ipMaxFails, C.lockMin);
    await q('INSERT INTO check_log (iin, ip, result) VALUES ($1,$2,$3)', [iin, ip, f1.locked ? 'fail_locked' : 'fail']);
    if (f1.locked) throw lockMsg(C.lockMin);
    throw new HttpError(404, NOT_FOUND_MSG, 'not_found', { attemptsLeft: f1.left });
  }
  await resetFails('check_iin', iin);
  await expirePending();
  const settings = await getSettings();

  const options = [];
  let reason = null;
  for (const t of rows) {
    if (t.is_legal && !settings.allowLegalEntities) { reason = reason || 'legal'; continue; }
    if (config.maxGasFlow != null && t.gas_flow != null && t.gas_flow > config.maxGasFlow) { reason = reason || 'gas'; continue; }
    const a = await q("SELECT status, CEIL(EXTRACT(EPOCH FROM (expires_at - now()))/60)::int AS min_left FROM orders WHERE tu_number=$1 AND status IN ('pending','paid','issued')", [t.tu_number]);
    if (a.rows[0]) { reason = a.rows[0].status === 'pending' ? { pending: a.rows[0].min_left } : reason || 'bought'; continue; }
    options.push({ ticket: signTicket(t.tu_number), tuNumber: t.tu_number, address: t.address, name: shortName(t.owner_name, t.is_legal), dear: dear(t.owner_name, t.is_legal) });
  }
  await q('INSERT INTO check_log (iin, ip, result) VALUES ($1,$2,$3)', [iin, ip, options.length ? 'ok' : 'blocked']);
  if (!options.length) {
    if (reason?.pending) throw new HttpError(409, `По данному ТУ уже оформлен заказ, ожидающий оплаты. Если его не оплатят, он будет отменён через ${fmtMinutes(reason.pending)}.`, 'pending', { minutesLeft: reason.pending });
    if (reason === 'legal') throw new HttpError(403, 'Покупка по ТУ, выданным юридическим лицам, недоступна.', 'legal');
    if (reason === 'gas') throw new HttpError(403, 'Для объекта с таким расходом газа бытовой счетчик не подходит. Обратитесь в газовую компанию.', 'gas');
    throw new HttpError(409, 'На данное ТУ уже приобретен счетчик. По одному ТУ можно купить только один счетчик.', 'already_bought');
  }
  res.json({ options });
});

/** Оформление заказа по билету проверки */
r.post('/orders', async (req, res) => {
  const tu = verifyTicket(req.body?.ticket);
  if (!tu) throw bad('Время проверки истекло. Введите ИИН и номер ТУ заново.', 'ticket');
  const productId = Number(req.body?.productId), pointId = Number(req.body?.pointId);
  if (req.body?.confirmed !== true) throw bad('Подтвердите ознакомление с уведомлением', 'confirm');

  const order = await tx(async c => {
    await expirePending(c);
    const p = (await c.query('SELECT id, name, price FROM products WHERE id=$1 AND active', [productId])).rows[0];
    if (!p) throw bad('Товар недоступен', 'product');
    const pt = (await c.query('SELECT id FROM points WHERE id=$1 AND active', [pointId])).rows[0];
    if (!pt) throw bad('Выберите точку выдачи', 'point');
    const t = (await c.query('SELECT is_legal FROM tu_records WHERE tu_number=$1', [tu])).rows[0];
    const settings = await getSettings(c);
    if (t?.is_legal && !settings.allowLegalEntities) throw new HttpError(403, 'Покупка по ТУ, выданным юридическим лицам, недоступна.', 'legal');
    if (settings.stockEnabled) {
      const st = await lockAvailable(c, pt.id, p.id);
      if (st.available <= 0) throw new HttpError(409, 'На выбранной точке этот счетчик закончился. Выберите другую точку.', 'out_of_stock');
    }
    try {
      const ins = await c.query(`INSERT INTO orders (token, product_id, product_name, tu_number, point_id, price, status, expires_at, buyer_ip)
        VALUES ($1,$2,$3,$4,$5,$6,'pending', now() + make_interval(mins => $7), $8) RETURNING num, token`,
        [randomToken(9), p.id, p.name, tu, pt.id, p.price, config.orderTtlMin, clientIp(req)]);
      return ins.rows[0];
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'По этому ТУ уже оформлен заказ или куплен счетчик.', 'already_bought');
      throw e;
    }
  });
  res.status(201).json(order);
});

async function orderByToken(req) {
  const o = await getOrder(Number(req.params.num) || 0);
  if (!o || !safeEqual(o.token, req.query.t)) throw new HttpError(404, 'Заказ не найден');
  return o;
}

r.get('/orders/:num', async (req, res) => { res.set('Cache-Control', 'no-store').json(publicOrder(await orderByToken(req))); });
r.get('/orders/:num/qr.svg', async (req, res) => { res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'no-store').send(await orderQrSvg(await orderByToken(req))); });
r.get('/orders/:num/pdf', async (req, res) => {
  const o = await orderByToken(req);
  res.set('Content-Type', 'application/pdf').set('Content-Disposition', `attachment; filename="order-${o.num}.pdf"`).send(await orderPdf(o, req.query.lang === 'kk' ? 'kk' : 'ru'));
});

module.exports = r;
