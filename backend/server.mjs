import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { createBackend } from './src/transport/websocket-server.mjs';
import { loadConfig } from './src/config.mjs';
import { summarizeVoiceAudit } from './src/agents/voice-audit.mjs';

const page = await readFile(new URL('./public/index.html', import.meta.url));
const config = loadConfig();
if (config.voiceAuditFile) {
  try {
    const summary = summarizeVoiceAudit(config.voiceAuditFile);
    if (summary.unconfirmed.length) console.warn(`Voice audit: ${summary.unconfirmed.length} previous session(s) lack confirmed closure or final usage. Run npm run voice:report in backend.`);
  } catch { console.warn('Previous voice-session audit could not be read.'); }
}
const backend = createBackend(config, { page });
const port = Number(process.env.PORT || 3000);
backend.server.listen(port, '0.0.0.0', () => {
  console.log(`WebSocket LED dashboard: http://localhost:${port}/`);
  for (const group of Object.values(networkInterfaces())) for (const info of group || [])
    if (info.family === 'IPv4' && !info.internal) console.log(`Wi-Fi dashboard: http://${info.address}:${port}/`);
});
let shutdown;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (shutdown) return;
  shutdown = backend.close().then(result => {
    if (result.unconfirmed) console.error(`Voice shutdown: ${result.unconfirmed} session finalization(s) unconfirmed; inspect the local audit log.`);
    process.exit(result.unconfirmed ? 1 : 0);
  }).catch(() => { console.error('Server shutdown did not complete cleanly.'); process.exit(1); });
});
