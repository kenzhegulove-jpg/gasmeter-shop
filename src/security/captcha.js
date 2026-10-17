'use strict';
const crypto = require('crypto');
const svgCaptcha = require('svg-captcha');
const { q } = require('../db');
const { sha256 } = require('../util');
const config = require('../config');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function createCaptcha() {
  const c = svgCaptcha.create({ size: 5, ignoreChars: '0oO1lIi', noise: 3, color: true, background: '#f4f6f7', width: 150, height: 50 });
  const id = crypto.randomUUID();
  await q("INSERT INTO captchas (id, answer_hash, expires_at) VALUES ($1, $2, now() + interval '5 minutes')", [id, sha256(c.text.toLowerCase())]);
  return { id, svg: c.data };
}

/** Одноразовая проверка: капча удаляется при любой попытке */
async function verifyCaptcha(id, text) {
  if (!UUID.test(String(id || '')) || !text) return false;
  const r = await q('DELETE FROM captchas WHERE id=$1 RETURNING answer_hash, expires_at > now() AS valid', [id]);
  const row = r.rows[0];
  if (config.testMode && row && String(text) === 'TEST') return true;
  return !!row && row.valid && row.answer_hash === sha256(String(text).trim().toLowerCase());
}

/**
 * Пропуск капчи: после успешной проверки ИИН + ТУ покупатель 15 минут не вводит капчу
 * для того же ИИН. Пропуск удаляется при неудачной проверке.
 */
async function issueCaptchaPass(iin, minutes) {
  const token = require('crypto').randomBytes(24).toString('base64url');
  await q("INSERT INTO captcha_passes (token_hash, iin, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))", [sha256(token), iin, minutes]);
  return token;
}
async function checkCaptchaPass(token, iin) {
  if (!token || typeof token !== 'string' || token.length > 100) return false;
  const r = await q('SELECT 1 FROM captcha_passes WHERE token_hash=$1 AND iin=$2 AND expires_at > now()', [sha256(token), iin]);
  return r.rowCount > 0;
}
const dropCaptchaPass = token => (token && typeof token === 'string' ? q('DELETE FROM captcha_passes WHERE token_hash=$1', [sha256(token)]) : null);

module.exports = { createCaptcha, verifyCaptcha, issueCaptchaPass, checkCaptchaPass, dropCaptchaPass };
