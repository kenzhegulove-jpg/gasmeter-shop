'use strict';
const { q } = require('./db');
const { clientIp } = require('./util');

async function audit(req, action, entity, entityId, details, userId) {
  await q('INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [userId !== undefined ? userId : req.user?.id || null, action, entity || null, entityId == null ? null : String(entityId), details ? JSON.stringify(details) : null, clientIp(req)]);
}
module.exports = { audit };
