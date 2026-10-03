'use strict';
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const config = require('./config');

types.setTypeParser(1700, v => (v === null ? null : parseFloat(v))); // numeric
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));   // bigint

const pool = new Pool({ connectionString: config.databaseUrl, max: 15 });

const q = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, q, tx, migrate };
