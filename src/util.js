'use strict';
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const bad = (msg, code = 'bad_request', extra) => new HttpError(400, msg, code, extra);

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const digits = s => String(s ?? '').replace(/\D/g, '');
const isIIN = s => /^\d{12}$/.test(String(s ?? ''));
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

// ИИН/БИН: 5-я цифра 4, 5 или 6 — юридическое лицо (БИН)
const isBIN = iin => /^\d{4}[456]/.test(iin);

/** «Иванова Анна Сергеевна» → «Анна И.»; для юрлиц — наименование как есть */
function shortName(fullName, legal) {
  if (legal) return fullName;
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[1]} ${parts[0][0]}.`;
}
function dear(fullName, legal) {
  if (legal) return 'Уважаемый покупатель';
  const p = String(fullName).trim().split(/\s+/).slice(2).join(' ').toLowerCase();
  if (/(вна|қызы|кызы)$/.test(p)) return 'Уважаемая';
  if (/(вич|ұлы|улы|оглы)$/.test(p)) return 'Уважаемый';
  return 'Уважаемый(-ая)';
}
const fmtMoney = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function noticeText(o) {
  return `${dear(o.owner_name, o.is_legal)}${o.is_legal ? '' : ' ' + shortName(o.owner_name, o.is_legal)}, напоминаем, что прибор учета приобретается по специальной скидочной цене для населения и подлежит установке по адресу: ${o.address}. Владелец объекта будет уведомлен, что прибор учета приобретен по цене ${fmtMoney(o.price)} тенге с НДС.`;
}

/** 135 → «2 ч 15 мин», 40 → «40 мин» */
function fmtMinutes(m) {
  m = Math.max(1, Math.round(m));
  const h = Math.floor(m / 60), r = m % 60;
  return h ? `${h} ч${r ? ` ${r} мин` : ''}` : `${r} мин`;
}

const clientIp = req => req.ip || req.socket?.remoteAddress || '';

module.exports = { HttpError, bad, sha256, digits, isIIN, isBIN, randomToken, safeEqual, str, shortName, dear, fmtMoney, noticeText, clientIp, fmtMinutes };
