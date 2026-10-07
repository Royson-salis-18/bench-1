// Twelve-factor config: every operational knob comes from the environment, with a
// sane production default. Scenarios change these values (or the data / topology
// around them) -- never the code.
export const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
export const envInt = (k, d) => {
  const v = Number.parseInt(env(k, ''), 10);
  return Number.isFinite(v) ? v : d;
};
export const envFloat = (k, d) => {
  const v = Number.parseFloat(env(k, ''));
  return Number.isFinite(v) ? v : d;
};
export const envBool = (k, d) => {
  const v = env(k, undefined);
  if (v === undefined) return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
export const SERVICE = env('SERVICE_NAME', 'service');
