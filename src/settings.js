'use strict';
const config = require('./config');
const { q } = require('./db');

/**
 * Настройки, которые администратор меняет в кабинете.
 * Значение из .env используется только как начальное, пока администратор не сохранил своё.
 */
const SCHEMA = {
  allowLegalEntities: { type: 'boolean', def: () => config.allowLegalEntities },
  stockEnabled:       { type: 'boolean', def: () => false },
  lowStockThreshold:  { type: 'integer', def: () => 5, min: 0, max: 1000 },
};

async function getSettings(client) {
  const r = await (client || { query: q }).query('SELECT key, value FROM settings');
  const s = Object.fromEntries(Object.entries(SCHEMA).map(([k, d]) => [k, d.def()]));
  for (const row of r.rows) if (row.key in SCHEMA) s[row.key] = row.value;
  return s;
}

/** Сохраняет переданные ключи; возвращает список изменённых {key, from, to} */
async function updateSettings(patch, userId) {
  const before = await getSettings();
  const changed = [];
  for (const [key, d] of Object.entries(SCHEMA)) {
    if (!(key in (patch || {}))) continue;
    let v = patch[key];
    if (d.type === 'boolean') v = v === true;
    if (d.type === 'integer') {
      v = Math.round(Number(v));
      if (!Number.isFinite(v) || v < d.min || v > d.max) throw Object.assign(new Error(`Недопустимое значение: ${key}`), { status: 400, code: 'settings' });
    }
    if (before[key] === v) continue;
    await q(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`, [key, JSON.stringify(v), userId]);
    changed.push({ key, from: before[key], to: v });
  }
  return changed;
}

module.exports = { getSettings, updateSettings };
