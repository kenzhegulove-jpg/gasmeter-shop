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

module.exports = { createCaptcha, verifyCaptcha };
