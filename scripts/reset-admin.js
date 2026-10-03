'use strict';
// Сброс пароля администратора (или любого сотрудника) из консоли сервера:
//   docker compose exec app node scripts/reset-admin.js <логин>
// Выводит временный пароль; при входе система потребует сменить его.
const { q, pool } = require('../src/db');
const pw = require('../src/security/password');

(async () => {
  const login = process.argv[2];
  if (!login) { console.error('Укажите логин: node scripts/reset-admin.js admin'); process.exit(1); }
  const temp = pw.generatePassword();
  const r = await q(`UPDATE users SET password_hash=$2, must_change_password=true, failed_logins=0, locked_until=NULL, blocked=false, updated_at=now()
    WHERE lower(login)=lower($1) RETURNING id, role`, [login, await pw.hashPassword(temp)]);
  if (!r.rowCount) { console.error(`Пользователь «${login}» не найден`); process.exit(1); }
  await q('DELETE FROM sessions WHERE user_id=$1', [r.rows[0].id]);
  await q("INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (NULL, 'console_reset_password', 'user', $1, $2)", [String(r.rows[0].id), JSON.stringify({ login })]);
  console.log(`Пароль пользователя «${login}» сброшен. Временный пароль: ${temp}`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
