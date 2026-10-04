'use strict';
const { q } = require('./db');
const { HttpError } = require('./util');

/**
 * Учёт остатков. on_hand — сколько штук физически на точке (включая забронированные).
 * Забронировано — заказы этого товара на этой точке в статусах «Ожидает оплаты» и «Оплачен».
 * Доступно к заказу = on_hand − забронировано.
 */
const RESERVED = `(SELECT count(*)::int FROM orders o WHERE o.point_id = s.point_id AND o.product_id = s.product_id AND o.status IN ('pending','paid'))`;

/** Остатки по всем действующим точкам и товарам (с нулями для отсутствующих строк) */
async function stockMatrix({ pointId, activeProductsOnly = true } = {}) {
  const r = await q(`
    WITH s AS (
      SELECT pt.id AS point_id, pr.id AS product_id, COALESCE(st.on_hand, 0) AS on_hand, st.updated_at
      FROM points pt CROSS JOIN products pr
      LEFT JOIN stock st ON st.point_id = pt.id AND st.product_id = pr.id
      WHERE pt.active ${activeProductsOnly ? 'AND pr.active' : ''} ${pointId ? 'AND pt.id = $1' : ''}
    )
    SELECT s.point_id, s.product_id, s.on_hand, ${RESERVED} AS reserved, s.updated_at
    FROM s ORDER BY s.point_id, s.product_id`, pointId ? [pointId] : []);
  return r.rows.map(x => ({ ...x, available: Math.max(0, x.on_hand - x.reserved) }));
}

/** Доступное количество товара по точкам */
async function availabilityByPoint(productId) {
  const r = await q(`
    SELECT s.point_id, s.on_hand, ${RESERVED} AS reserved
    FROM stock s JOIN points pt ON pt.id = s.point_id
    WHERE s.product_id = $1 AND pt.active`, [productId]);
  const m = new Map();
  for (const x of r.rows) m.set(x.point_id, Math.max(0, x.on_hand - x.reserved));
  return m;
}

/** Суммарно доступно по каждому товару на всех действующих точках */
async function availabilityByProduct() {
  const r = await q(`
    SELECT s.product_id, SUM(GREATEST(0, s.on_hand - ${RESERVED}))::int AS available
    FROM stock s JOIN points pt ON pt.id = s.point_id WHERE pt.active GROUP BY s.product_id`);
  return new Map(r.rows.map(x => [x.product_id, x.available]));
}

/**
 * Внутри транзакции: блокирует строку остатка точки (для защиты последней штуки от двойной продажи)
 * и возвращает доступное количество.
 */
async function lockAvailable(client, pointId, productId) {
  await client.query('INSERT INTO stock (point_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [pointId, productId]);
  const s = (await client.query('SELECT on_hand FROM stock WHERE point_id=$1 AND product_id=$2 FOR UPDATE', [pointId, productId])).rows[0];
  const reserved = (await client.query("SELECT count(*)::int AS n FROM orders WHERE point_id=$1 AND product_id=$2 AND status IN ('pending','paid')", [pointId, productId])).rows[0].n;
  return { onHand: s.on_hand, reserved, available: s.on_hand - reserved };
}

/** Движение остатка (внутри транзакции): меняет on_hand и пишет журнал */
async function moveStock(client, { pointId, productId, delta, reason, orderNum = null, userId = null, comment = null }) {
  await client.query('INSERT INTO stock (point_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [pointId, productId]);
  const r = await client.query('UPDATE stock SET on_hand = on_hand + $3, updated_at = now() WHERE point_id=$1 AND product_id=$2 RETURNING on_hand', [pointId, productId, delta]);
  const balance = r.rows[0].on_hand;
  if (balance < 0 && (reason === 'receipt' || reason === 'correction')) throw new HttpError(400, 'Остаток не может быть отрицательным', 'negative');
  await client.query('INSERT INTO stock_moves (point_id, product_id, delta, balance, reason, order_num, user_id, comment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [pointId, productId, delta, balance, reason, orderNum, userId, comment]);
  return balance;
}

module.exports = { stockMatrix, availabilityByPoint, availabilityByProduct, lockAvailable, moveStock };
