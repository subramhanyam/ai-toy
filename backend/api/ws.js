import { createBackend } from '../lib/backend.mjs';
import { loadConfig } from '../lib/config.mjs';

// Export an HTTP server so Vercel can deliver WebSocket upgrade requests.
const backend = createBackend(loadConfig());
export default backend.server;
