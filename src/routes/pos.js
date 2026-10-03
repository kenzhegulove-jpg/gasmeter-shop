'use strict';
const express = require('express');
const config = require('../config');
const { q } = require('../db');
const { HttpError, bad, str, safeEqual } = require('../util');
const { expirePending } = require('../orders');

/**
 * Интеграция с кассой: касса после оплаты передаёт номер заказа (из QR), сумму и номер чека.
 * Авторизация — заголовок X-Api-Key (POS_API_KEY). Если ключ не задан, интеграция выключена.
 */
const r = express.Router();
r.post('/payments', async (req, res) => {
  if (!config.posApiKey || !safeEqual(req.get('x-api-key'), config.posApiKey)) throw new HttpError(401, 'Неверный ключ API', 'api_key');
  const m = str(req.body?.qr, 200).match(/^QGA:(\d+):([A-Za-z0-9_-]+)$/);
  const num = m ? Number(m[1]) : Number(req.body?.orderNum) || 0;
  const amount = Number(req.body?.amount);
  const receipt = str(req.body?.receiptNumber, 50);
  if (!num || !receipt || !Number.isFinite(amount)) throw bad('Нужны qr (или orderNum), amount, receiptNumber');
  await expirePending();
  const o = (await q('SELECT num, token, price, status FROM orders WHERE num=$1', [num])).rows[0];
  if (!o || (m && !safeEqual(o.token, m[2]))) throw new HttpError(404, 'Заказ не найден', 'not_found');
  if (o.status !== 'pending') throw new HttpError(409, `Заказ в статусе ${o.status}`, 'status');
  if (Math.abs(o.price - amount) > 0.001) throw new HttpError(409, `Сумма не совпадает: к оплате ${o.price}`, 'amount');
  await q("UPDATE orders SET status='paid', paid_at=now(), paid_source='pos', receipt_number=$2 WHERE num=$1 AND status='pending'", [num, receipt]);
  res.json({ ok: true, num, status: 'paid' });
});
module.exports = r;
