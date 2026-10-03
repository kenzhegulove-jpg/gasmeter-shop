'use strict';
const ExcelJS = require('exceljs');

/** Синтетический реестр ТУ в формате выгрузки 1С (без реальных персональных данных) */
async function makeRegistry(rows, org = 'Тестовый производственный филиал') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('TDSheet');
  ws.getCell('A2').value = 'Параметры:';
  ws.getCell('D2').value = 'Начало периода: 01.01.2026';
  ws.getCell('D3').value = 'Конец периода: 03.10.2026';
  ws.getCell('D4').value = `Организация: ${org}`;
  ws.getRow(6).values = ['№ п/п', 'Абонент', null, null, null, 'Адрес', 'Дата', 'ИНН', 'Номер', 'Расход газа'];
  ws.mergeCells('B6:E6');
  rows.forEach((r, i) => {
    ws.getRow(7 + i).values = [i + 1, r.owner, null, null, null, r.address, r.date || '05.01.2026 9:10:45', r.iin, r.number, r.gas ?? 3];
    ws.mergeCells(`B${7 + i}:E${7 + i}`);
  });
  ws.getRow(7 + rows.length).values = ['Итого', null, null, null, null, null, null, null, null, 100];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
module.exports = { makeRegistry };
