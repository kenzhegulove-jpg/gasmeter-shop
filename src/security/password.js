'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');

const P = config.password;
const UPPER = /[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ]/;
const LOWER = /[a-zа-яёәғқңөұүһі]/;
const DIGIT = /\d/;
const SPECIAL = /[^\p{L}\p{N}\s]/u;
const COMMON = ['password', 'qwerty', '123456', '12345678', 'admin', 'administrator', 'qazaqgaz', 'aimaq', 'пароль', 'йцукен', 'welcome', 'letmein'];
const LOGIN_RE = /^[A-Za-z0-9._-]{3,32}$/;

/** Требования к паролю — отдаются клиенту для подсказки */
function policy() {
  return {
    minLength: P.minLength,
    maxLength: P.maxLength,
    history: P.history,
    maxAgeDays: P.maxAgeDays,
    rules: [
      `не короче ${P.minLength} и не длиннее ${P.maxLength} символов`,
      'хотя бы одна заглавная и одна строчная буква',
      'хотя бы одна цифра',
      'хотя бы один спецсимвол: ! @ # $ % ^ & * и т. п.',
      'без пробелов',
      'не содержит логин',
      'не более двух одинаковых символов подряд',
      `не совпадает с ${P.history} предыдущими паролями`,
      `меняется не реже одного раза в ${P.maxAgeDays} дней`,
    ],
  };
}

/** Проверка сложности. Возвращает список нарушений (пустой — пароль подходит) */
function validatePassword(pw, login) {
  const e = [];
  if (typeof pw !== 'string' || !pw) return ['Укажите пароль'];
  if (pw.length < P.minLength) e.push(`Пароль короче ${P.minLength} символов`);
  if (pw.length > P.maxLength) e.push(`Пароль длиннее ${P.maxLength} символов`);
  if (!UPPER.test(pw)) e.push('Нет заглавной буквы');
  if (!LOWER.test(pw)) e.push('Нет строчной буквы');
  if (!DIGIT.test(pw)) e.push('Нет цифры');
  if (!SPECIAL.test(pw)) e.push('Нет спецсимвола');
  if (/\s/.test(pw)) e.push('Пароль содержит пробел');
  if (login && login.length >= 3 && pw.toLowerCase().includes(String(login).toLowerCase())) e.push('Пароль содержит логин');
  if (/(.)\1\1/u.test(pw)) e.push('Более двух одинаковых символов подряд');
  const low = pw.toLowerCase();
  if (COMMON.some(w => low.includes(w))) e.push('Пароль содержит распространённое слово');
  return e;
}

function validateLogin(login) {
  if (!LOGIN_RE.test(String(login || ''))) return 'Логин: 3–32 символа, латинские буквы, цифры, точка, дефис, подчёркивание';
  return null;
}

/** Временный пароль, удовлетворяющий политике */
function generatePassword(len = 14) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*+-=?'];
  const all = sets.join('');
  for (;;) {
    const chars = sets.map(s => s[crypto.randomInt(s.length)]);
    while (chars.length < len) chars.push(all[crypto.randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
    const pw = chars.join('');
    if (!validatePassword(pw).length) return pw;
  }
}

const hashPassword = pw => bcrypt.hash(pw, P.bcryptCost);
const verifyPassword = (pw, hash) => bcrypt.compare(String(pw || ''), hash);

/** Пароль совпадает с текущим или одним из последних N */
async function isReused(client, userId, currentHash, pw) {
  if (await verifyPassword(pw, currentHash)) return true;
  const r = await client.query('SELECT password_hash FROM password_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, Math.max(0, P.history - 1)]);
  for (const row of r.rows) if (await verifyPassword(pw, row.password_hash)) return true;
  return false;
}

function isExpired(passwordChangedAt) {
  return Date.now() - new Date(passwordChangedAt).getTime() > P.maxAgeDays * 86400000;
}

module.exports = { policy, validatePassword, validateLogin, generatePassword, hashPassword, verifyPassword, isReused, isExpired };
