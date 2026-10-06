'use strict';
const crypto = require('crypto');
const config = require('./config');
const { q, pool } = require('./db');
const { shortName, dear, noticeText } = require('./util');

/** Отмена неоплаченных заказов, у которых истёк срок брони (по умолчанию 2 часа) */
const expirePending = client =>
  (client || pool).query("UPDATE orders SET status='cancelled', cancelled_at=now() WHERE status='pending' AND expires_at < now()");

const ORDER_SELECT = `
  SELECT o.*, t.iin, t.owner_name, t.address, t.is_legal, t.branch,
         p.region AS point_region, p.address AS point_address, p.hours AS point_hours,
         ui.full_name AS issued_by_name, ur.full_name AS returned_by_name,
         EXISTS (SELECT 1 FROM receipt_photos rp WHERE rp.order_num = o.num) AS has_receipt_photo
  FROM orders o
  JOIN tu_records t ON t.tu_number = o.tu_number
  JOIN points p ON p.id = o.point_id
  LEFT JOIN users ui ON ui.id = o.issued_by
  LEFT JOIN users ur ON ur.id = o.returned_by`;

async function getOrder(num) {
  await expirePending();
  const r = await q(`${ORDER_SELECT} WHERE o.num = $1`, [num]);
  return r.rows[0] || null;
}

/** Данные заказа для покупателя — без полного ФИО и ИИН */
function publicOrder(o) {
  return {
    num: o.num, status: o.status, createdAt: o.created_at, expiresAt: o.expires_at, now: new Date(),
    productId: o.product_id, productName: o.product_name, price: o.price,
    ownerName: shortName(o.owner_name, o.is_legal), tuNumber: o.tu_number, address: o.address,
    point: { region: o.point_region, address: o.point_address, hours: o.point_hours },
  };
}

/** Данные заказа для продавца */
function staffOrder(o, user) {
  return {
    ...publicOrder(o),
    ownerFullName: o.owner_name, iin: o.iin, isLegal: o.is_legal, branch: o.branch, pointId: o.point_id,
    otherPoint: user?.role === 'seller' && o.point_id !== user.point_id,
    paidAt: o.paid_at, receiptNumber: o.receipt_number, paidSource: o.paid_source, hasReceiptPhoto: o.has_receipt_photo,
    issuedAt: o.issued_at, issuedBy: o.issued_by_name, serialNumber: o.serial_number, recipient: o.recipient,
    proxy: o.recipient === 'proxy' ? { number: o.proxy_number, date: o.proxy_date, iin: o.proxy_iin } : null,
    returnedAt: o.returned_at, returnedBy: o.returned_by_name, returnReason: o.return_reason,
    notice: noticeText(o), dear: dear(o.owner_name, o.is_legal),
  };
}

// Подписанный «билет» успешной проверки ИИН + ТУ: без него заказ не оформить
function signTicket(tuNumber) {
  const payload = Buffer.from(JSON.stringify({ tu: tuNumber, exp: Date.now() + config.check.ticketMin * 60000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyTicket(ticket) {
  const [payload, sig] = String(ticket || '').split('.');
  if (!payload || !sig) return null;
  const expect = crypto.createHmac('sha256', config.secret).update(payload).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data.tu : null;
  } catch { return null; }
}

module.exports = { expirePending, getOrder, publicOrder, staffOrder, signTicket, verifyTicket, ORDER_SELECT };
