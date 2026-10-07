import pg from 'pg';
import { env, envInt } from './config.js';
import { log } from './log.js';

// Return BIGINT/NUMERIC as numbers: safe for the magnitudes in these systems.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

/** Pool sizing, timeouts and credentials all come from <PREFIX>_* env vars. */
export function createPool(prefix, { database, defaults = {} } = {}) {
  const pool = new pg.Pool({
    host: env(`${prefix}_HOST`, 'localhost'),
    port: envInt(`${prefix}_PORT`, 5432),
    user: env(`${prefix}_USER`, 'app'),
    password: env(`${prefix}_PASSWORD`, 'app'),
    database: env(`${prefix}_NAME`, database),
    max: envInt(`${prefix}_POOL_MAX`, defaults.max ?? 10),
    connectionTimeoutMillis: envInt(`${prefix}_CONNECT_TIMEOUT_MS`, 2000), // waiting for a free pooled connection
    idleTimeoutMillis: 30000,
    statement_timeout: envInt(`${prefix}_STATEMENT_TIMEOUT_MS`, 10000),
  });
  pool.on('error', (e) => log.error('idle pg client error', { err: e.message }));
  return pool;
}

export const pingPool = (pool) => pool.query('select 1');
export const poolStats = (pool) => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
