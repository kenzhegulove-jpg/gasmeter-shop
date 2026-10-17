'use strict';
const { q } = require('./db');
const { expirePending } = require('./orders');

/** Фоновое обслуживание: отмена просроченных заказов, очистка капч, сессий и устаревших блокировок */
let lastRetention = 0;
function startJobs(log = console) {
  const run = async () => {
    try {
      await expirePending();
      await q('DELETE FROM captchas WHERE expires_at < now()');
      await q("DELETE FROM sessions WHERE last_seen_at < now() - interval '1 day'");
      await q("DELETE FROM captcha_passes WHERE expires_at < now()");
      // Сроки хранения: фото документов получателя — 3 года, фото кассовых чеков — 5 лет
      if (Date.now() - lastRetention > 3600000) {
        lastRetention = Date.now();
        const d = await q("DELETE FROM recipient_docs WHERE created_at < now() - interval '3 years'");
        const p = await q("DELETE FROM receipt_photos WHERE created_at < now() - interval '5 years'");
        if (d.rowCount || p.rowCount) log.log(`Удалено по сроку хранения: фото документов ${d.rowCount}, фото чеков ${p.rowCount}`);
      }
      await q("DELETE FROM attempt_locks WHERE (locked_until IS NULL OR locked_until < now()) AND updated_at < now() - interval '1 day'");
    } catch (e) { log.error('jobs:', e.message); }
  };
  run();
  return setInterval(run, 30000);
}
module.exports = { startJobs };
