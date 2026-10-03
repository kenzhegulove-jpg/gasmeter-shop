'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseRegistry, cleanAddress, parseDate } = require('../src/tu-import');
const { makeRegistry } = require('./helpers');

test('разбор выгрузки реестра ТУ из 1С', async () => {
  const buf = await makeRegistry([
    { owner: 'Тестов Иван Петрович', address: 'Республика Казахстан, Астана г., ул. Тестовая, 1 ЖИЛОЙ ФОНД ', iin: '900101300123', number: '01-гор-2026-000002770' },
    { owner: 'ТОО "Тест"', address: 'Республика Казахстан, Астана г., ул. Тестовая, 2', iin: '200740021049', number: '01-гор-2026-000002771', gas: 220 },
    { owner: 'Без ИИН', address: 'Астана', iin: '123', number: '01-гор-2026-000002772' },
  ]);
  const r = await parseRegistry(buf, 'test.xlsx');
  assert.strictEqual(r.branch, 'Тестовый производственный филиал');
  assert.strictEqual(r.records.length, 2);
  assert.strictEqual(r.errors.length, 1);
  const [a, b] = r.records;
  assert.strictEqual(a.tu_last6, '002770');
  assert.strictEqual(a.address, 'Астана г., ул. Тестовая, 1');
  assert.strictEqual(a.is_legal, false);
  assert.strictEqual(b.is_legal, true);
  assert.strictEqual(b.gas_flow, 220);
});

test('очистка адреса и разбор даты', () => {
  assert.strictEqual(cleanAddress('Республика Казахстан, Астана г., Коктем ул., 10 ЖИЛОЙ ФОНД '), 'Астана г., Коктем ул., 10');
  assert.strictEqual(parseDate('05.01.2026 9:10:45').toISOString(), '2026-01-05T04:10:45.000Z');
  assert.strictEqual(parseDate('мусор'), null);
});
