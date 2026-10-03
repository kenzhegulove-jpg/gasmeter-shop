'use strict';
const express = require('express');
const { q, tx } = require('../db');
const { HttpError, bad, digits, isIIN, str } = require('../util');
const { requireRole } = require('../security/session');
const { expirePending, getOrder, staffOrder, ORDER_SELECT } = require('../orders');
const { audit } = require('../audit');

const r = express.Router();
r.use(requireRole('seller'));

const listItem = o => ({ num: o.num, status: o.status, createdAt: o.created_at, expiresAt: o.expires_at, productName: o.product_name, ownerName: o.owner_name, tuNumber: o.tu_number, pointId: o.point_id, pointAddress: o.point_address });

/** Поиск: QR (QGA:номер:токен), номер заказа или ИИН */
r.get('/orders', async (req, res) => {
  await expirePending();
  const raw = str(req.query.q, 100);
  const qr = raw.match(/^QGA:(\d+):/i);
  const d = qr ? qr[1] : digits(raw);
  let rows = [];
  if (isIIN(d)) rows = (await q(`${ORDER_SELECT} WHERE t.iin=$1 ORDER BY o.created_at DESC LIMIT 20`, [d])).rows;
  else if (d.length >= 5 && d.length <= 9) rows = (await q(`${ORDER_SELECT} WHERE o.num=$1`, [Number(d)])).rows;
  else throw bad('Введите номер заказа или ИИН (12 цифр)', 'query');
  res.json(rows.map(listItem));
});

/** Заказы, ожидающие выдачи на точке продавца */
r.get('/orders-active', async (req, res) => {
  await expirePending();
  const { rows } = await q(`${ORDER_SELECT} WHERE o.point_id=$1 AND o.status IN ('pending','paid') ORDER BY o.created_at DESC LIMIT 50`, [req.user.point_id]);
  res.json(rows.map(listItem));
});

r.get('/orders/:num', async (req, res) => {
  const o = await getOrder(Number(req.params.num) || 0);
  if (!o) throw new HttpError(404, 'Заказ не найден');
  res.set('Cache-Control', 'no-store').json(staffOrder(o, req.user));
});

/** Подтверждение оплаты по номеру кассового чека (если касса не передаёт оплату автоматически) */
r.post('/orders/:num/pay', async (req, res) => {
  const receipt = str(req.body?.receiptNumber, 50);
  if (!receipt) throw bad('Укажите номер кассового чека', 'receipt');
  const num = Number(req.params.num) || 0;
  await expirePending();
  const u = await q("UPDATE orders SET status='paid', paid_at=now(), paid_by=$2, paid_source='seller', receipt_number=$3 WHERE num=$1 AND status='pending' RETURNING num", [num, req.user.id, receipt]);
  if (!u.rowCount) throw new HttpError(409, 'Оплату можно подтвердить только для заказа в статусе «Ожидает оплаты»', 'status');
  await audit(req, 'order_paid', 'order', num, { receipt });
  res.json(staffOrder(await getOrder(num), req.user));
});

const CHECKS = ['id', 'passport', 'stamp', 'sticker'];

r.post('/orders/:num/issue', async (req, res) => {
  const num = Number(req.params.num) || 0;
  const b = req.body || {};
  const serial = str(b.serialNumber, 64).toUpperCase();
  const recipient = b.recipient === 'proxy' ? 'proxy' : 'owner';
  const chk = b.checklist || {};
  const missing = [];
  if (!serial) missing.push('серийный номер');
  const need = recipient === 'proxy' ? [...CHECKS, 'proxy'] : CHECKS;
  if (need.some(k => chk[k] !== true)) missing.push('пункты чек-листа');
  let proxy = { number: null, date: null, iin: null };
  if (recipient === 'proxy') {
    proxy = { number: str(b.proxyNumber, 50), date: str(b.proxyDate, 10), iin: digits(b.proxyIin) };
    if (!proxy.number) missing.push('номер доверенности');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(proxy.date) || new Date(proxy.date) > new Date()) missing.push('дата доверенности');
    if (!isIIN(proxy.iin)) missing.push('ИИН доверенного лица (12 цифр)');
  }
  if (missing.length) throw bad('Не заполнено: ' + missing.join(', '), 'incomplete', { missing });

  await tx(async c => {
    const o = (await c.query('SELECT status FROM orders WHERE num=$1 FOR UPDATE', [num])).rows[0];
    if (!o) throw new HttpError(404, 'Заказ не найден');
    if (o.status !== 'paid') throw new HttpError(409, 'Выдать можно только оплаченный заказ', 'status');
    try {
      await c.query(`UPDATE orders SET status='issued', issued_at=now(), issued_by=$2, serial_number=$3, recipient=$4,
        proxy_number=$5, proxy_date=$6, proxy_iin=$7, checklist=$8 WHERE num=$1`,
        [num, req.user.id, serial, recipient, proxy.number, proxy.date, proxy.iin, JSON.stringify(Object.fromEntries(need.map(k => [k, true])))]);
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'Счетчик с таким серийным номером уже числится выданным', 'serial_taken');
      throw e;
    }
  });
  await audit(req, 'order_issued', 'order', num, { serial, recipient });
  res.json(staffOrder(await getOrder(num), req.user));
});

/** Поиск выданного счётчика для возврата */
r.get('/returns/find', async (req, res) => {
  const serial = str(req.query.serial, 64).toUpperCase();
  if (!serial) throw bad('Укажите серийный номер', 'serial');
  const { rows } = await q(`${ORDER_SELECT} WHERE o.status='issued' AND upper(o.serial_number)=$1`, [serial]);
  if (!rows[0]) throw new HttpError(404, 'Нет выданного счетчика с таким серийным номером', 'not_found');
  res.json(staffOrder(rows[0], req.user));
});

const REASONS = ['Неисправность счетчика', 'Отказ покупателя', 'Ошибка при выдаче', 'Другое'];

r.post('/orders/:num/return', async (req, res) => {
  const num = Number(req.params.num) || 0;
  const reason = str(req.body?.reason, 100);
  const comment = str(req.body?.comment, 1000);
  if (!REASONS.includes(reason)) throw bad('Выберите причину возврата', 'reason');
  if (reason === 'Другое' && !comment) throw bad('Опишите причину в комментарии', 'comment');
  if (req.body?.confirmed !== true) throw bad('Подтвердите приём счетчика, паспорта и чека', 'confirm');
  const u = await q("UPDATE orders SET status='returned', returned_at=now(), returned_by=$2, return_reason=$3, return_comment=$4 WHERE num=$1 AND status='issued' RETURNING tu_number", [num, req.user.id, reason, comment || null]);
  if (!u.rowCount) throw new HttpError(409, 'Возврат возможен только для выданного счетчика', 'status');
  await audit(req, 'order_returned', 'order', num, { reason });
  res.json({ ok: true, tuNumber: u.rows[0].tu_number });
});

module.exports = r;
