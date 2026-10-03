'use strict';
const config = require('./config');
const { migrate, q } = require('./db');
const { createApp } = require('./app');
const { startJobs } = require('./jobs');
const pw = require('./security/password');

async function ensureAdmin() {
  const { rows } = await q("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
  if (rows.length) return;
  if (!config.admin.password) {
    console.warn('Администратор не создан: задайте ADMIN_INITIAL_PASSWORD и перезапустите сервер.');
    return;
  }
  await q("INSERT INTO users (role, full_name, login, password_hash, must_change_password) VALUES ('admin', 'Администратор системы', $1, $2, true)",
    [config.admin.login, await pw.hashPassword(config.admin.password)]);
  console.log(`Создан администратор «${config.admin.login}». При первом входе система потребует сменить пароль.`);
}

(async () => {
  await migrate();
  await ensureAdmin();
  startJobs();
  createApp().listen(config.port, () => console.log(`Сервер запущен: http://localhost:${config.port}  (сотрудники: /staff)`));
})().catch(e => { console.error(e); process.exit(1); });
