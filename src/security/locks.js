'use strict';
const { q } = require('../db');

/** Минут до снятия блокировки (0 — не заблокировано) */
async function lockedFor(kind, key) {
  const r = await q('SELECT CEIL(EXTRACT(EPOCH FROM (locked_until - now())) / 60)::int AS m FROM attempt_locks WHERE kind=$1 AND key=$2 AND locked_until > now()', [kind, key]);
  return r.rows[0]?.m || 0;
}

/**
 * Регистрирует неудачную попытку. Неудачи считаются подряд в окне lockMin минут;
 * при достижении max ключ блокируется на lockMin минут.
 */
async function registerFail(kind, key, max, lockMin) {
  const r = await q(`
    INSERT INTO attempt_locks (kind, key, failed, updated_at) VALUES ($1, $2, 1, now())
    ON CONFLICT (kind, key) DO UPDATE SET
      failed = CASE WHEN attempt_locks.locked_until IS NOT NULL OR attempt_locks.updated_at < now() - make_interval(mins => $3)
                    THEN 1 ELSE attempt_locks.failed + 1 END,
      locked_until = NULL,
      updated_at = now()
    RETURNING failed`, [kind, key, lockMin]);
  const failed = r.rows[0].failed;
  if (failed >= max) {
    await q('UPDATE attempt_locks SET locked_until = now() + make_interval(mins => $3) WHERE kind=$1 AND key=$2', [kind, key, lockMin]);
    return { locked: true, left: 0 };
  }
  return { locked: false, left: max - failed };
}

const resetFails = (kind, key) => q('DELETE FROM attempt_locks WHERE kind=$1 AND key=$2', [kind, key]);

module.exports = { lockedFor, registerFail, resetFails };
