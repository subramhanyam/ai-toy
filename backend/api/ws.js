import { createBackend } from '../src/transport/websocket-server.mjs';
import { loadConfig } from '../src/config.mjs';

// Export an HTTP server so Vercel can deliver WebSocket upgrade requests.
const backend = createBackend(loadConfig());
export default backend.server;
