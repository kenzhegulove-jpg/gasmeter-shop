'use strict';
const config = require('../config');
const { q } = require('../db');
const { HttpError, sha256, randomToken, clientIp } = require('../util');
const { isExpired } = require('./password');

const COOKIE = 'gm_sid';

async function createSession(res, req, userId) {
  const token = randomToken(32);
  await q('INSERT INTO sessions (token_hash, user_id, ip, user_agent) VALUES ($1,$2,$3,$4)', [sha256(token), userId, clientIp(req), String(req.get('user-agent') || '').slice(0, 300)]);
  res.cookie(COOKIE, token, { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/', maxAge: config.login.sessionHours * 3600000 });
}

async function destroySession(req, res) {
  const t = req.cookies?.[COOKIE];
  if (t) await q('DELETE FROM sessions WHERE token_hash=$1', [sha256(t)]);
  res.clearCookie(COOKIE, { path: '/' });
}

/** Загружает пользователя по cookie сессии (с учётом абсолютного и простойного таймаута) */
async function loadUser(req, _res, next) {
  const t = req.cookies?.[COOKIE];
  if (!t) return next();
  const r = await q(`
    UPDATE sessions s SET last_seen_at = now()
    FROM users u
    WHERE s.token_hash = $1 AND u.id = s.user_id
      AND s.created_at > now() - make_interval(hours => $2)
      AND s.last_seen_at > now() - make_interval(mins => $3)
      AND NOT u.blocked
    RETURNING u.id, u.role, u.full_name, u.login, u.point_id, u.must_change_password, u.password_changed_at`,
    [sha256(t), config.login.sessionHours, config.login.idleMin]);
  const u = r.rows[0];
  if (u) {
    u.mustChange = u.must_change_password || isExpired(u.password_changed_at);
    req.user = u;
  }
  next();
}

/** Требует роль; пока пароль не сменён — доступ к разделам закрыт */
const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Требуется вход в систему', 'auth'));
  if (req.user.mustChange) return next(new HttpError(403, 'Необходимо сменить пароль', 'must_change_password'));
  if (!roles.includes(req.user.role)) return next(new HttpError(403, 'Недостаточно прав', 'forbidden'));
  next();
};

module.exports = { createSession, destroySession, loadUser, requireRole };
