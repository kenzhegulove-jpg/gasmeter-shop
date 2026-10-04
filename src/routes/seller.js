'use strict';
const express = require('express');
const { q, tx } = require('../db');
const { HttpError, bad, digits, isIIN, str } = require('../util');
const { requireRole } = require('../security/session');
const { expirePending, getOrder, staffOrder, ORDER_SELECT } = require('../orders');
const { audit } = require('../audit');
const { getSettings } = require('../settings');
const { moveStock, stockMatrix } = require('../stock');
const { parseFilters, salesPage, salesWorkbook } = require('../sales');

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

  const settings = await getSettings();
  await tx(async c => {
    const o = (await c.query('SELECT status, point_id, product_id FROM orders WHERE num=$1 FOR UPDATE', [num])).rows[0];
    if (!o) throw new HttpError(404, 'Заказ не найден');
    if (o.status !== 'paid') throw new HttpError(409, 'Выдать можно только оплаченный заказ', 'status');
    // Списание с остатка точки, на которую оформлен заказ
    if (settings.stockEnabled) await moveStock(c, { pointId: o.point_id, productId: o.product_id, delta: -1, reason: 'issue', orderNum: num, userId: req.user.id });
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
  // Можно ли вернуть в остаток: только если при выдаче было списание по учёту
  const tracked = (await q("SELECT 1 FROM stock_moves WHERE order_num=$1 AND reason='issue'", [rows[0].num])).rowCount > 0;
  res.json({ ...staffOrder(rows[0], req.user), stockTracked: tracked });
});

const REASONS = ['Неисправность счетчика', 'Отказ покупателя', 'Ошибка при выдаче', 'Другое'];

r.post('/orders/:num/return', async (req, res) => {
  const num = Number(req.params.num) || 0;
  const reason = str(req.body?.reason, 100);
  const comment = str(req.body?.comment, 1000);
  if (!REASONS.includes(reason)) throw bad('Выберите причину возврата', 'reason');
  if (reason === 'Другое' && !comment) throw bad('Опишите причину в комментарии', 'comment');
  if (req.body?.confirmed !== true) throw bad('Подтвердите приём счетчика, паспорта и чека', 'confirm');
  // Неисправный счётчик в остаток не возвращается
  const wantStock = req.body?.returnToStock === true && reason !== 'Неисправность счетчика';
  const result = await tx(async c => {
    const u = await c.query(`UPDATE orders SET status='returned', returned_at=now(), returned_by=$2, return_reason=$3, return_comment=$4
      WHERE num=$1 AND status='issued' RETURNING tu_number, point_id, product_id`, [num, req.user.id, reason, comment || null]);
    if (!u.rowCount) throw new HttpError(409, 'Возврат возможен только для выданного счетчика', 'status');
    const o = u.rows[0];
    // Возвращаем в остаток, только если при выдаче было списание по учёту
    let toStock = false;
    if (wantStock) {
      const issued = await c.query("SELECT 1 FROM stock_moves WHERE order_num=$1 AND reason='issue'", [num]);
      if (issued.rowCount) { await moveStock(c, { pointId: o.point_id, productId: o.product_id, delta: 1, reason: 'return', orderNum: num, userId: req.user.id }); toStock = true; }
    }
    await c.query('UPDATE orders SET return_to_stock=$2 WHERE num=$1', [num, toStock]);
    return { tuNumber: o.tu_number, returnedToStock: toStock };
  });
  await audit(req, 'order_returned', 'order', num, { reason, toStock: result.returnedToStock });
  res.json({ ok: true, ...result });
});

/* ---------- Отчёты продавца (только своя точка) ---------- */
r.get('/summary', async (req, res) => {
  await expirePending();
  const f = parseFilters(req.query, req.user.point_id);
  const P = [req.user.point_id, f.from, f.to];
  const RANGE = col => `${col} >= ($2::date)::timestamp AT TIME ZONE 'Asia/Almaty' AND ${col} < ($3::date + 1)::timestamp AT TIME ZONE 'Asia/Almaty'`;
  const k = (await q(`SELECT
      count(*) FILTER (WHERE o.issued_at IS NOT NULL AND ${RANGE('o.issued_at')})::int AS issued,
      COALESCE(sum(o.price) FILTER (WHERE o.issued_at IS NOT NULL AND o.status='issued' AND ${RANGE('o.issued_at')}),0) AS revenue,
      count(*) FILTER (WHERE o.returned_at IS NOT NULL AND ${RANGE('o.returned_at')})::int AS returned,
      count(*) FILTER (WHERE o.status='paid')::int AS paid_waiting,
      count(*) FILTER (WHERE o.status='pending')::int AS pending
    FROM orders o WHERE o.point_id=$1`, P)).rows[0];
  const byProduct = (await q(`SELECT o.product_name, count(*)::int AS issued, COALESCE(sum(o.price),0) AS revenue
    FROM orders o WHERE o.point_id=$1 AND o.status='issued' AND ${RANGE('o.issued_at')}
    GROUP BY o.product_name ORDER BY issued DESC`, P)).rows;
  const s = await getSettings();
  let stock = null;
  if (s.stockEnabled) {
    const names = new Map((await q('SELECT id, name FROM products')).rows.map(x => [x.id, x.name]));
    stock = (await stockMatrix({ pointId: req.user.point_id })).map(x => ({ ...x, productName: names.get(x.product_id), low: x.available <= s.lowStockThreshold }));
  }
  res.json({ from: f.from, to: f.to, kpi: k, byProduct, stock, lowStockThreshold: s.lowStockThreshold });
});

r.get('/sales', async (req, res) => {
  res.json(await salesPage(parseFilters(req.query, req.user.point_id)));
});

r.get('/sales/export.xlsx', async (req, res) => {
  const f = parseFilters(req.query, req.user.point_id);
  const pt = (await q('SELECT region, address FROM points WHERE id=$1', [req.user.point_id])).rows[0];
  const { wb, count } = await salesWorkbook(f, `Реестр продаж: ${pt.region}, ${pt.address}`);
  await audit(req, 'sales_export', 'point', req.user.point_id, { from: f.from, to: f.to, rows: count });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .set('Content-Disposition', `attachment; filename="sales_${f.from}_${f.to}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

module.exports = r;
