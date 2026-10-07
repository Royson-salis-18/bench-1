import Redis from 'ioredis';
import { env, envInt } from './config.js';
import { log } from './log.js';

export function createRedis(prefix) {
  const r = new Redis({
    host: env(`${prefix}_HOST`, 'localhost'),
    port: envInt(`${prefix}_PORT`, 6379),
    connectTimeout: 2000,
    commandTimeout: envInt(`${prefix}_COMMAND_TIMEOUT_MS`, 1000),
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    retryStrategy: (n) => Math.min(n * 200, 2000),
  });
  r.on('error', (e) => log.warn('redis error', { err: e.message }));
  return r;
}
