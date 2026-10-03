'use strict';
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const { isBIN, digits } = require('./util');

/**
 * Разбор выгрузки реестра ТУ из 1С «Технические условия» (.xlsx).
 * Ожидаемая структура: строки параметров (в т.ч. «Организация: …»), строка заголовков
 * (№ п/п, Абонент, Адрес, Дата, ИНН, Номер, Расход газа), записи, строка «Итого».
 * Колонки ищутся по заголовкам, поэтому порядок колонок может меняться.
 */
const HEADERS = {
  owner: ['абонент', 'фио', 'владелец'],
  address: ['адрес'],
  date: ['дата'],
  iin: ['инн', 'иин', 'иин/бин', 'бин'],
  number: ['номер', 'номер ту'],
  gas: ['расход газа', 'расход'],
};

function cellText(cell) {
  const v = cell?.value;
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map(t => t.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
  }
  return String(v);
}

function cleanAddress(a) {
  return String(a)
    .replace(/ЖИЛОЙ\s+ФОНД/gi, '')
    .replace(/^\s*Республика\s+Казахстан\s*,\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,]+$/, '')
    .trim();
}

/** «05.01.2026 9:10:45» (время Казахстана, UTC+5) → Date */
function parseDate(v) {
  if (v instanceof Date) return v;
  const m = String(v).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, d, mo, y, h = '0', mi = '0', s = '0'] = m;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:${s.padStart(2, '0')}+05:00`;
  const dt = new Date(iso);
  return isNaN(dt) ? null : dt;
}

function parseNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

async function readRows(buffer) {
  // Потоковый режим: устойчив к служебным частям файлов 1С (рисунки, стили)
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(buffer), { sharedStrings: 'cache', worksheets: 'emit', styles: 'ignore', hyperlinks: 'ignore', entries: 'ignore' });
  const rows = [];
  for await (const ws of reader) {
    for await (const row of ws) rows.push({ n: row.number, v: (row.values || []).map(x => { const t = cellText({ value: x }); return t instanceof Date ? t : String(t).trim(); }) });
    break; // только первый лист
  }
  return rows;
}

async function parseRegistry(buffer, fileName) {
  let rows;
  try { rows = await readRows(buffer); } catch { throw new Error('Файл не читается как .xlsx'); }
  if (!rows.length) throw new Error('Лист пуст');

  let branch = '';
  let hi = -1;
  const cols = {};
  for (let i = 0; i < rows.length && hi < 0; i++) {
    const found = {};
    rows[i].v.forEach((t, c) => {
      if (typeof t !== 'string') return;
      const org = t.match(/^Организация:\s*(.+)$/i);
      if (org) branch = org[1].trim();
      const low = t.toLowerCase();
      for (const [key, names] of Object.entries(HEADERS)) if (!found[key] && names.includes(low)) found[key] = c;
    });
    if (found.owner && found.iin && found.number) { hi = i; Object.assign(cols, found); }
  }
  if (hi < 0) throw new Error('Не найдена строка заголовков (ожидаются колонки «Абонент», «ИНН», «Номер»)');
  if (!cols.address) throw new Error('Не найдена колонка «Адрес»');

  const records = [];
  const errors = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const { n, v } = rows[i];
    const get = c => (c ? v[c] ?? '' : '');
    const first = String(v.find(x => x !== '' && x != null) ?? '').toLowerCase();
    if (first.startsWith('итого')) break;
    const number = String(get(cols.number)).trim();
    const owner = String(get(cols.owner)).replace(/\s+/g, ' ').trim();
    if (!number && !owner) continue;

    const iin = digits(get(cols.iin));
    const address = cleanAddress(get(cols.address));
    const last6 = digits(number).slice(-6);

    const problems = [];
    if (!number) problems.push('нет номера ТУ');
    else if (last6.length < 6) problems.push('в номере ТУ меньше 6 цифр');
    if (iin.length !== 12) problems.push('ИИН/БИН не 12 цифр');
    if (!owner) problems.push('нет ФИО');
    if (!address) problems.push('нет адреса');
    if (problems.length) { errors.push({ file: fileName, row: n, number, reason: problems.join(', ') }); continue; }

    records.push({
      tu_number: number,
      tu_last6: last6,
      iin,
      owner_name: owner,
      address,
      branch,
      issued_at: cols.date ? parseDate(get(cols.date)) : null,
      gas_flow: cols.gas ? parseNumber(get(cols.gas)) : null,
      is_legal: isBIN(iin),
    });
  }
  return { branch, records, errors };
}

module.exports = { parseRegistry, cleanAddress, parseDate };
