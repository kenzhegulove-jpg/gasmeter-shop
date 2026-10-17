'use strict';
const ExcelJS = require('exceljs');
const { q } = require('./db');
const { digits, str } = require('./util');

/**
 * Реестр продаж: выданные счётчики (по дате выдачи) за период, включая те, по которым позже оформлен возврат.
 * Фильтры: точка, статус (all | issued | returned), поиск по № заказа, ИИН, № ТУ, серийному номеру.
 * Для менеджера производителя: только товары его производителя и обезличенные данные
 * (без ФИО, ИИН, адреса, получателя и фото) — опции manufacturerId и anonymous.
 */
function parseFilters(src, forcedPointId, opts = {}) {
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
    manufacturerId: opts.manufacturerId || null,
    anonymous: !!opts.anonymous,
  };
}

function whereClause(f) {
  const params = [f.from, f.to];
  const w = ["o.issued_at IS NOT NULL",
    "o.issued_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Almaty'",
    "o.issued_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Almaty'"];
  if (f.pointId) { params.push(f.pointId); w.push(`o.point_id = $${params.length}`); }
  if (f.manufacturerId) { params.push(f.manufacturerId); w.push(`o.product_id IN (SELECT id FROM products WHERE manufacturer_id = $${params.length})`); }
  if (f.status === 'issued') w.push("o.status = 'issued'");
  if (f.status === 'returned') w.push("o.status = 'returned'");
  if (f.search) {
    const dg = digits(f.search);
    params.push(`%${f.search.toLowerCase()}%`);
    const i = params.length;
    let s = `lower(o.tu_number) LIKE $${i} OR lower(coalesce(o.serial_number,'')) LIKE $${i}`;
    if (!f.anonymous) s += ` OR lower(t.owner_name) LIKE $${i}`;
    if (dg.length >= 4) {
      params.push(`${dg}%`);
      s += f.anonymous ? ` OR o.num::text LIKE $${params.length}` : ` OR t.iin LIKE $${params.length} OR o.num::text LIKE $${params.length}`;
    }
    w.push(`(${s})`);
  }
  return { sql: w.join(' AND '), params };
}

const SELECT = `
  SELECT o.num, o.issued_at, o.product_name, o.serial_number, o.price, o.status, o.tu_number, o.recipient, o.relation,
         o.proxy_number, o.proxy_date, o.proxy_iin, o.receipt_number, o.returned_at, o.return_reason, o.return_to_stock,
         t.iin, t.owner_name, t.address, t.branch,
         pt.id AS point_id, pt.region AS point_region, pt.address AS point_address,
         ui.full_name AS seller_name, mf.name AS manufacturer_name,
         EXISTS (SELECT 1 FROM receipt_photos rp WHERE rp.order_num = o.num) AS has_receipt_photo,
         (SELECT count(*)::int FROM recipient_docs rd WHERE rd.order_num = o.num) AS recipient_docs
  FROM orders o
  JOIN tu_records t ON t.tu_number = o.tu_number
  JOIN points pt ON pt.id = o.point_id
  LEFT JOIN products pr ON pr.id = o.product_id
  LEFT JOIN manufacturers mf ON mf.id = pr.manufacturer_id
  LEFT JOIN users ui ON ui.id = o.issued_by`;

/** Поля, которые видит менеджер производителя */
const ANON_FIELDS = ['num', 'issued_at', 'product_name', 'manufacturer_name', 'serial_number', 'price', 'status', 'tu_number',
  'point_id', 'point_region', 'point_address', 'returned_at', 'return_reason'];
const anonymize = o => Object.fromEntries(ANON_FIELDS.map(k => [k, o[k]]));

const RELATION = { spouse: 'супруг(а)', parent: 'родитель', child: 'ребенок', sibling: 'брат/сестра' };
/** «Владелец» / «Представитель» / «Родственник: супруг(а)» */
function recipientLabel(o) {
  if (o.recipient === 'proxy') return 'Представитель';
  if (o.recipient === 'relative') return `Родственник: ${RELATION[o.relation] || ''}`.trim();
  return 'Владелец';
}
function recipientDetails(o) {
  if (o.recipient === 'owner' || !o.recipient) return '';
  const parts = [];
  if (o.proxy_number) parts.push(`дов. № ${o.proxy_number} от ${o.proxy_date ? new Date(o.proxy_date).toLocaleDateString('ru-RU') : ''}`);
  if (o.proxy_iin) parts.push(`ИИН ${o.proxy_iin}`);
  if (o.recipient_docs) parts.push(`фото документа: ${o.recipient_docs}`);
  return parts.join(', ');
}

async function salesPage(f, pageSize = 50) {
  const { sql, params } = whereClause(f);
  const totals = (await q(`SELECT count(*)::int AS count,
      count(*) FILTER (WHERE o.status='issued')::int AS issued,
      count(*) FILTER (WHERE o.status='returned')::int AS returned,
      COALESCE(sum(o.price) FILTER (WHERE o.status='issued'),0) AS revenue
    FROM orders o JOIN tu_records t ON t.tu_number=o.tu_number WHERE ${sql}`, params)).rows[0];
  let rows = (await q(`${SELECT} WHERE ${sql} ORDER BY o.issued_at DESC LIMIT ${pageSize} OFFSET ${f.page * pageSize}`, params)).rows;
  if (f.anonymous) rows = rows.map(anonymize);
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
  // Колонки: [заголовок, ширина, значение, только для полного реестра]
  const cols = [
    ['№', 6, (o, i) => i + 1],
    ['Дата выдачи', 17, o => local(o.issued_at), false, 'dt'],
    ['№ заказа', 11, o => o.num],
    ['Производитель', 24, o => o.manufacturer_name || ''],
    ['Товар', 32, o => o.product_name],
    ['Серийный №', 18, o => o.serial_number],
    ['Цена, ₸', 11, o => o.price, false, 'money'],
    ['Владелец ТУ', 32, o => o.owner_name, true],
    ['ИИН/БИН', 15, o => o.iin, true],
    ['Номер ТУ', 24, o => o.tu_number],
    ['Адрес установки', 44, o => o.address, true],
    ['Регион точки', 20, o => o.point_region],
    ['Адрес точки', 30, o => o.point_address],
    ['Продавец', 28, o => o.seller_name, true],
    ['Получатель', 22, o => recipientLabel(o), true],
    ['Данные получателя', 34, o => recipientDetails(o), true],
    ['Фото чека', 11, o => (o.has_receipt_photo ? 'есть' : (o.receipt_number ? `чек № ${o.receipt_number}` : 'нет')), true],
    ['Статус', 10, o => (o.status === 'returned' ? 'Возврат' : 'Выдан')],
    ['Дата возврата', 17, o => local(o.returned_at), false, 'dt'],
    ['Причина возврата', 24, o => o.return_reason],
  ].filter(c => !(f.anonymous && c[3]));
  const head = ws.addRow(cols.map(c => c[0]));
  head.font = { bold: true };
  head.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F8F7' } }; c.border = { bottom: { style: 'thin' } }; });
  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c[1];
    if (c[4] === 'dt') col.numFmt = 'dd.mm.yyyy hh:mm';
    if (c[4] === 'money') col.numFmt = '# ##0';
  });
  rows.forEach((o, i) => ws.addRow(cols.map(c => c[2](o, i))));
  const issued = rows.filter(o => o.status === 'issued');
  const priceCol = cols.findIndex(c => c[4] === 'money');
  ws.addRow([]);
  const total = ['', 'Итого выдано:', issued.length];
  total[priceCol] = issued.reduce((a, o) => a + o.price, 0);
  ws.addRow(total).font = { bold: true };
  ws.addRow(['', 'Возвратов:', rows.length - issued.length]).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  return { wb, count: rows.length };
}

module.exports = { parseFilters, salesPage, salesWorkbook, recipientLabel };
