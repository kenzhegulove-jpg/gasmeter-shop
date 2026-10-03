'use strict';
const { q } = require('./db');
const { expirePending } = require('./orders');

/** Фоновое обслуживание: отмена просроченных заказов, очистка капч, сессий и устаревших блокировок */
function startJobs(log = console) {
  const run = async () => {
    try {
      await expirePending();
      await q('DELETE FROM captchas WHERE expires_at < now()');
      await q("DELETE FROM sessions WHERE last_seen_at < now() - interval '1 day'");
      await q("DELETE FROM attempt_locks WHERE (locked_until IS NULL OR locked_until < now()) AND updated_at < now() - interval '1 day'");
    } catch (e) { log.error('jobs:', e.message); }
  };
  run();
  return setInterval(run, 30000);
}
module.exports = { startJobs };
