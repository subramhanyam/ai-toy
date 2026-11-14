import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadConfig() {
  const cloud = !!process.env.VERCEL;
  let local = {};
  if (!cloud) {
    const folder = fileURLToPath(new URL('../../.tools/', import.meta.url));
    mkdirSync(folder, { recursive: true });
    const file = folder + 'server-secrets.json';
    try { local = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      local = { deviceToken: randomBytes(32).toString('hex'), sessionSecret: randomBytes(32).toString('hex') };
      writeFileSync(file, JSON.stringify(local), { flag: 'wx', mode: 0o600 });
    }
  }
  const config = { cloud, deviceToken: process.env.DEVICE_TOKEN || local.deviceToken,
    sessionSecret: process.env.SESSION_SECRET || local.sessionSecret,
    dashboardPassword: process.env.DASHBOARD_PASSWORD || '', redisUrl: process.env.REDIS_URL || '',
    openaiModel: process.env.OPENAI_MODEL || '' };
  if (config.deviceToken?.length < 32 || !config.deviceToken || config.sessionSecret?.length < 32 || !config.sessionSecret)
    throw Error('DEVICE_TOKEN and SESSION_SECRET must have at least 32 characters');
  if (cloud && (config.dashboardPassword.length < 16 || !config.redisUrl))
    throw Error('Vercel requires DASHBOARD_PASSWORD (16+ characters) and REDIS_URL for cross-instance routing');
  return config;
}
