'use strict';
const express = require('express');
const { q } = require('../db');
const { HttpError } = require('../util');
const { requireRole } = require('../security/session');
const { expirePending } = require('../orders');
const { getSettings } = require('../settings');
const { stockMatrix } = require('../stock');
const { parseFilters, salesPage, salesWorkbook } = require('../sales');
const { audit } = require('../audit');

/**
 * Кабинет менеджера производителя: только просмотр и выгрузка по товарам своего производителя.
 * Данные обезличены: без ФИО, ИИН, адресов, получателей и фото. Номер ТУ показывается.
 * Ответы повторяют формат /api/admin, чтобы использовать те же экраны отчетов.
 */
const r = express.Router();
r.use(requireRole('manufacturer'));
r.use(async (req, _res, next) => {
  const m = (await q(`SELECT m.id, m.name, m.active FROM users u JOIN manufacturers m ON m.id=u.manufacturer_id WHERE u.id=$1`, [req.user.id])).rows[0];
  if (!m || !m.active) return next(new HttpError(403, 'Производитель не найден или отключен. Обратитесь к администратору.', 'forbidden'));
  req.mfr = m;
  next();
});

function period(req) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
  return [from, to];
}
const PERIOD_SQL = "o.created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Almaty' AND o.created_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Almaty'";
const MFR_SQL = 'o.product_id IN (SELECT id FROM products WHERE manufacturer_id = $3)';

/** Продажи и возвраты по моделям производителя */
r.get('/reports/summary', async (req, res) => {
  await expirePending();
  const p = [...period(req), req.mfr.id];
  const kpi = (await q(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status='issued')::int AS issued,
      count(*) FILTER (WHERE status='paid')::int AS paid,
      count(*) FILTER (WHERE status='pending')::int AS pending,
      count(*) FILTER (WHERE status='returned')::int AS returned,
      count(*) FILTER (WHERE status='cancelled')::int AS cancelled,
      COALESCE(sum(price) FILTER (WHERE status IN ('paid','issued')),0) AS revenue
    FROM orders o WHERE ${PERIOD_SQL} AND ${MFR_SQL}`, p)).rows[0];
  const byPoint = (await q(`SELECT pt.id, pt.region, pt.address, count(o.*)::int AS total,
      count(*) FILTER (WHERE o.status='issued')::int AS issued,
      count(*) FILTER (WHERE o.status='returned')::int AS returned,
      COALESCE(sum(o.price) FILTER (WHERE o.status IN ('paid','issued')),0) AS revenue
    FROM orders o JOIN points pt ON pt.id=o.point_id WHERE ${PERIOD_SQL} AND ${MFR_SQL}
    GROUP BY pt.id ORDER BY total DESC`, p)).rows;
  const byProduct = (await q(`SELECT o.product_name, count(*) FILTER (WHERE o.status='issued')::int AS issued,
      count(*) FILTER (WHERE o.status='returned')::int AS returned,
      COALESCE(sum(o.price) FILTER (WHERE o.status='issued'),0) AS revenue
    FROM orders o WHERE ${PERIOD_SQL} AND ${MFR_SQL} GROUP BY o.product_name ORDER BY issued DESC`, p)).rows;
  const recent = (await q(`SELECT o.num, o.created_at, o.tu_number, o.product_name, o.status, o.serial_number, pt.region AS point_region
    FROM orders o JOIN points pt ON pt.id=o.point_id WHERE ${PERIOD_SQL} AND ${MFR_SQL} ORDER BY o.created_at DESC LIMIT 15`, p)).rows;
  res.json({ from: p[0], to: p[1], manufacturer: req.mfr.name, kpi, byPoint, byProduct, recent });
});

/** Реестр по серийным номерам (обезличенный) */
r.get('/sales', async (req, res) => {
  res.json(await salesPage(parseFilters(req.query, null, { manufacturerId: req.mfr.id, anonymous: true })));
});
r.get('/sales/export.xlsx', async (req, res) => {
  const f = parseFilters(req.query, null, { manufacturerId: req.mfr.id, anonymous: true });
  const { wb, count } = await salesWorkbook(f, `Реестр продаж: ${req.mfr.name}`);
  await audit(req, 'sales_export', 'manufacturer', req.mfr.id, { from: f.from, to: f.to, rows: count });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .set('Content-Disposition', `attachment; filename="sales_${f.from}_${f.to}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

/** Остатки товаров производителя по точкам */
r.get('/stock', async (req, res) => {
  await expirePending();
  const s = await getSettings();
  const points = (await q('SELECT id, region, address FROM points WHERE active ORDER BY region, address')).rows;
  const products = (await q('SELECT id, name FROM products WHERE active AND manufacturer_id=$1 ORDER BY sort, id', [req.mfr.id])).rows;
  const ids = new Set(products.map(p => p.id));
  const cells = (await stockMatrix()).filter(c => ids.has(c.product_id));
  res.json({ settings: { stockEnabled: s.stockEnabled, lowStockThreshold: s.lowStockThreshold }, points, products, cells });
});
r.get('/stock/moves', async (req, res) => {
  const pointId = Number(req.query.pointId) || null;
  const params = [req.mfr.id];
  if (pointId) params.push(pointId);
  const { rows } = await q(`SELECT m.id, m.point_id, m.product_id, m.delta, m.balance, m.reason, m.order_num, m.created_at,
      pt.region AS point_region, pt.address AS point_address, pr.name AS product_name
    FROM stock_moves m JOIN points pt ON pt.id=m.point_id JOIN products pr ON pr.id=m.product_id
    WHERE pr.manufacturer_id=$1 ${pointId ? 'AND m.point_id=$2' : ''} ORDER BY m.created_at DESC LIMIT 200`, params);
  res.json(rows);
});

r.get('/points', async (_req, res) => {
  res.json((await q('SELECT id, region, address FROM points WHERE active ORDER BY region, address')).rows);
});

module.exports = r;
