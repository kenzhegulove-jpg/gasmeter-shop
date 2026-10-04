'use strict';
const ExcelJS = require('exceljs');
const { q } = require('./db');
const { digits, str } = require('./util');

/**
 * Реестр продаж: выданные счётчики (по дате выдачи) за период, включая те, по которым позже оформлен возврат.
 * Фильтры: точка, статус (all | issued | returned), поиск по № заказа, ИИН, № ТУ, серийному номеру.
 */
function parseFilters(src, forcedPointId) {
  const d = s => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
  const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
  const from = d(src.from) || new Date(Date.now() + 5 * 3600000 - 29 * 86400000).toISOString().slice(0, 10);
  const to = d(src.to) || today;
  return {
    from, to,
    pointId: forcedPointId || Number(src.pointId) || null,
    status: ['issued', 'returned'].includes(src.status) ? src.status : 'all',
    search: str(src.q, 100),
    page: Math.max(0, Number(src.page) || 0),
  };
}

function whereClause(f) {
  const params = [f.from, f.to];
  const w = ["o.issued_at IS NOT NULL",
    "o.issued_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Almaty'",
    "o.issued_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Almaty'"];
  if (f.pointId) { params.push(f.pointId); w.push(`o.point_id = $${params.length}`); }
  if (f.status === 'issued') w.push("o.status = 'issued'");
  if (f.status === 'returned') w.push("o.status = 'returned'");
  if (f.search) {
    const dg = digits(f.search);
    params.push(`%${f.search.toLowerCase()}%`);
    const i = params.length;
    let s = `lower(o.tu_number) LIKE $${i} OR lower(coalesce(o.serial_number,'')) LIKE $${i} OR lower(t.owner_name) LIKE $${i}`;
    if (dg.length >= 4) { params.push(`${dg}%`); s += ` OR t.iin LIKE $${params.length} OR o.num::text LIKE $${params.length}`; }
    w.push(`(${s})`);
  }
  return { sql: w.join(' AND '), params };
}

const SELECT = `
  SELECT o.num, o.issued_at, o.product_name, o.serial_number, o.price, o.status, o.tu_number, o.recipient,
         o.proxy_number, o.proxy_date, o.proxy_iin, o.receipt_number, o.returned_at, o.return_reason, o.return_to_stock,
         t.iin, t.owner_name, t.address, t.branch,
         pt.id AS point_id, pt.region AS point_region, pt.address AS point_address,
         ui.full_name AS seller_name
  FROM orders o
  JOIN tu_records t ON t.tu_number = o.tu_number
  JOIN points pt ON pt.id = o.point_id
  LEFT JOIN users ui ON ui.id = o.issued_by`;

async function salesPage(f, pageSize = 50) {
  const { sql, params } = whereClause(f);
  const totals = (await q(`SELECT count(*)::int AS count,
      count(*) FILTER (WHERE o.status='issued')::int AS issued,
      count(*) FILTER (WHERE o.status='returned')::int AS returned,
      COALESCE(sum(o.price) FILTER (WHERE o.status='issued'),0) AS revenue
    FROM orders o JOIN tu_records t ON t.tu_number=o.tu_number WHERE ${sql}`, params)).rows[0];
  const rows = (await q(`${SELECT} WHERE ${sql} ORDER BY o.issued_at DESC LIMIT ${pageSize} OFFSET ${f.page * pageSize}`, params)).rows;
  return { filters: f, totals, pageSize, rows };
}

const local = d => (d ? new Date(new Date(d).getTime() + 5 * 3600000) : null); // Excel не хранит часовой пояс

async function salesWorkbook(f, title) {
  const { sql, params } = whereClause(f);
  const rows = (await q(`${SELECT} WHERE ${sql} ORDER BY o.issued_at`, params)).rows;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Реестр продаж');
  ws.addRow([title]).font = { bold: true, size: 13 };
  ws.addRow([`Период: ${f.from.split('-').reverse().join('.')} — ${f.to.split('-').reverse().join('.')}`]);
  ws.addRow([]);
  const cols = [
    ['№', 6], ['Дата выдачи', 17], ['№ заказа', 11], ['Товар', 32], ['Серийный №', 18], ['Цена, ₸', 11],
    ['Владелец ТУ', 32], ['ИИН/БИН', 15], ['Номер ТУ', 24], ['Адрес установки', 44], ['Регион точки', 20], ['Адрес точки', 30],
    ['Продавец', 28], ['Получатель', 14], ['Доверенность', 26], ['Чек №', 12], ['Статус', 10], ['Дата возврата', 17], ['Причина возврата', 24],
  ];
  const head = ws.addRow(cols.map(c => c[0]));
  head.font = { bold: true };
  head.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F8F7' } }; c.border = { bottom: { style: 'thin' } }; });
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c[1]; });
  rows.forEach((o, i) => {
    ws.addRow([i + 1, local(o.issued_at), o.num, o.product_name, o.serial_number, o.price, o.owner_name, o.iin, o.tu_number, o.address,
      o.point_region, o.point_address, o.seller_name, o.recipient === 'proxy' ? 'Представитель' : 'Владелец',
      o.recipient === 'proxy' ? `№ ${o.proxy_number} от ${o.proxy_date ? new Date(o.proxy_date).toLocaleDateString('ru-RU') : ''}, ИИН ${o.proxy_iin}` : '',
      o.receipt_number, o.status === 'returned' ? 'Возврат' : 'Выдан', local(o.returned_at), o.return_reason]);
  });
  const issued = rows.filter(o => o.status === 'issued');
  ws.addRow([]);
  ws.addRow(['', 'Итого выдано:', issued.length, '', '', issued.reduce((a, o) => a + o.price, 0)]).font = { bold: true };
  ws.addRow(['', 'Возвратов:', rows.length - issued.length]).font = { bold: true };
  ws.getColumn(2).numFmt = 'dd.mm.yyyy hh:mm';
  ws.getColumn(18).numFmt = 'dd.mm.yyyy hh:mm';
  ws.getColumn(6).numFmt = '# ##0';
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  return { wb, count: rows.length };
}

module.exports = { parseFilters, salesPage, salesWorkbook };
