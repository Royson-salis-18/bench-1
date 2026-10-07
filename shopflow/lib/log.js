import { SERVICE } from './config.js';

// One JSON object per line on stdout/stderr: what `docker logs` and any log shipper expect.
function emit(level, msg, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: SERVICE, msg, ...fields });
  (level === 'error' || level === 'fatal' ? process.stderr : process.stdout).write(line + '\n');
}
export const log = {
  debug: (m, f) => process.env.LOG_LEVEL === 'debug' && emit('debug', m, f),
  info: (m, f) => emit('info', m, f),
  warn: (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
  fatal: (m, f) => emit('fatal', m, f),
};
