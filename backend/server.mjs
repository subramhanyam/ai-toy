import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { createBackend } from './lib/backend.mjs';
import { loadConfig } from './lib/config.mjs';

const page = await readFile(new URL('./public/index.html', import.meta.url));
const backend = createBackend(loadConfig(), { page });
const port = Number(process.env.PORT || 3000);
backend.server.listen(port, '0.0.0.0', () => {
  console.log(`WebSocket LED dashboard: http://localhost:${port}/`);
  for (const group of Object.values(networkInterfaces())) for (const info of group || [])
    if (info.family === 'IPv4' && !info.internal) console.log(`Wi-Fi dashboard: http://${info.address}:${port}/`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await backend.close(); process.exit(0); });
