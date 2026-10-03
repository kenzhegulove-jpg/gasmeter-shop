'use strict';
const express = require('express');
const config = require('../config');
const { q, tx } = require('../db');
const { HttpError, bad, str, clientIp, sha256 } = require('../util');
const { verifyCaptcha } = require('../security/captcha');
const { lockedFor, registerFail, resetFails } = require('../security/locks');
const { createSession, destroySession } = require('../security/session');
const pw = require('../security/password');
const { audit } = require('../audit');

const r = express.Router();
const L = config.login;

r.get('/password-policy', (_req, res) => res.json(pw.policy()));

r.post('/login', async (req, res) => {
  const ip = clientIp(req);
  const login = str(req.body?.login, 64);
  const password = String(req.body?.password || '');

  const ipLock = await lockedFor('login_ip', ip);
  if (ipLock) throw new HttpError(429, `Слишком много попыток входа. Повторите через ${ipLock} мин.`, 'locked');
  if (!(await verifyCaptcha(req.body?.captchaId, req.body?.captchaText))) throw bad('Неверный код с картинки. Введите новый код.', 'captcha');

  const u = (await q('SELECT * FROM users WHERE lower(login)=lower($1)', [login])).rows[0];
  if (u?.locked_until && new Date(u.locked_until) > new Date()) {
    const m = Math.ceil((new Date(u.locked_until) - Date.now()) / 60000);
    throw new HttpError(429, `Учетная запись временно заблокирована после ${L.maxFails} неудачных попыток. Повторите через ${m} мин.`, 'locked');
  }
  const ok = u && (await pw.verifyPassword(password, u.password_hash));
  if (!ok) {
    await registerFail('login_ip', ip, L.ipMaxFails, L.lockMin);
    if (u) {
      const upd = await q(`UPDATE users SET failed_logins = failed_logins + 1,
          locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE NULL END
        WHERE id=$1 RETURNING failed_logins, locked_until`, [u.id, L.maxFails, L.lockMin]);
      if (upd.rows[0].locked_until) {
        await q('UPDATE users SET failed_logins=0 WHERE id=$1', [u.id]);
        await audit(req, 'login_locked', 'user', u.id, null, null);
        throw new HttpError(429, `Учетная запись заблокирована на ${L.lockMin} минут после ${L.maxFails} неудачных попыток.`, 'locked');
      }
      throw new HttpError(401, `Неверный логин или пароль. Осталось попыток: ${L.maxFails - upd.rows[0].failed_logins}.`, 'bad_credentials');
    }
    throw new HttpError(401, 'Неверный логин или пароль.', 'bad_credentials');
  }
  if (u.blocked) throw new HttpError(403, 'Учетная запись заблокирована. Обратитесь к администратору.', 'blocked');

  await q('UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [u.id]);
  await resetFails('login_ip', ip);
  await createSession(res, req, u.id);
  await audit(req, 'login', 'user', u.id, null, u.id);
  res.json({ ok: true });
});

r.post('/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

r.get('/me', async (req, res) => {
  if (!req.user) throw new HttpError(401, 'Требуется вход в систему', 'auth');
  const u = req.user;
  let point = null;
  if (u.point_id) point = (await q('SELECT id, region, address, hours FROM points WHERE id=$1', [u.point_id])).rows[0] || null;
  res.set('Cache-Control', 'no-store').json({
    id: u.id, role: u.role, fullName: u.full_name, login: u.login, point,
    mustChangePassword: u.mustChange,
    passwordExpired: !u.must_change_password && u.mustChange,
  });
});

/** Смена своего логина и/или пароля (обязательна при первом входе и по истечении срока) */
r.post('/change-credentials', async (req, res) => {
  if (!req.user) throw new HttpError(401, 'Требуется вход в систему', 'auth');
  const current = String(req.body?.currentPassword || '');
  const newLogin = req.body?.newLogin != null ? str(req.body.newLogin, 64) : null;
  const newPassword = req.body?.newPassword ? String(req.body.newPassword) : null;

  await tx(async c => {
    const u = (await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [req.user.id])).rows[0];
    if (!(await pw.verifyPassword(current, u.password_hash))) throw bad('Текущий пароль указан неверно', 'current_password');
    const mustChange = u.must_change_password || pw.isExpired(u.password_changed_at);
    if (mustChange && !newPassword) throw bad('Задайте новый пароль', 'password_required');

    const login = newLogin || u.login;
    if (newLogin && newLogin.toLowerCase() !== u.login.toLowerCase()) {
      const le = pw.validateLogin(newLogin);
      if (le) throw bad(le, 'login_format');
      const exists = await c.query('SELECT 1 FROM users WHERE lower(login)=lower($1) AND id<>$2', [newLogin, u.id]);
      if (exists.rowCount) throw bad('Такой логин уже занят', 'login_taken');
    }
    if (newPassword) {
      const errs = pw.validatePassword(newPassword, login);
      if (errs.length) throw bad('Пароль не соответствует требованиям: ' + errs.join('; ').toLowerCase(), 'password_policy', { errors: errs });
      if (await pw.isReused(c, u.id, u.password_hash, newPassword)) throw bad(`Новый пароль совпадает с одним из ${config.password.history} последних`, 'password_reused');
      const hash = await pw.hashPassword(newPassword);
      await c.query('INSERT INTO password_history (user_id, password_hash) VALUES ($1,$2)', [u.id, u.password_hash]);
      await c.query('UPDATE users SET password_hash=$2, must_change_password=false, password_changed_at=now(), updated_at=now() WHERE id=$1', [u.id, hash]);
      // Завершаем остальные сессии пользователя
      await c.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash <> $2', [u.id, sha256(req.cookies.gm_sid)]);
    } else if (newLogin && newLogin !== u.login) {
      // При смене только логина пароль не должен содержать новый логин
      if (current.toLowerCase().includes(newLogin.toLowerCase())) throw bad('Текущий пароль содержит новый логин — задайте новый пароль', 'password_policy');
    }
    if (newLogin && newLogin !== u.login) await c.query('UPDATE users SET login=$2, updated_at=now() WHERE id=$1', [u.id, newLogin]);
  });
  await audit(req, 'change_credentials', 'user', req.user.id, { login: !!newLogin, password: !!newPassword });
  res.json({ ok: true });
});

module.exports = r;
