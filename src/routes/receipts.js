'use strict';
const express = require('express');
const { q } = require('../db');
const { HttpError } = require('../util');
const { requireRole } = require('../security/session');

/** Просмотр фото кассового чека: администратор, финансист, продавец */
const r = express.Router();
r.get('/:num', requireRole('admin', 'finance', 'seller'), async (req, res) => {
  const { rows } = await q('SELECT mime, data FROM receipt_photos WHERE order_num=$1', [Number(req.params.num) || 0]);
  if (!rows[0]) throw new HttpError(404, 'Фото чека не найдено');
  res.set('Content-Type', rows[0].mime).set('Cache-Control', 'private, no-store').send(rows[0].data);
});
module.exports = r;
