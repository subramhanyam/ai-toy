import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const assets = new Map([['/', ['index.html', 'text/html']], ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/audio-codec.mjs', ['audio-codec.mjs', 'text/javascript']], ['/capture-worklet.mjs', ['capture-worklet.mjs', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
export function createCompanionServer() { return createServer(async (req, res) => {
  const asset = assets.get(new URL(req.url, 'http://localhost').pathname);
  // This server is a static USB peripheral UI. It has no API proxy, backend
  // URL, API key or WebSocket client. CSP blocks browser network connections.
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; worker-src 'self'; media-src 'self' blob:; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('Permissions-Policy', 'microphone=(self), serial=(self), camera=()');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' || !asset) { res.writeHead(404); res.end('Not found'); return; }
  try { const body = await readFile(new URL('./public/' + asset[0], import.meta.url)); res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' }); res.end(body); }
  catch { res.writeHead(500); res.end('Unable to load app'); }
}); }
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createCompanionServer();
  server.listen(Number(process.env.COMPANION_PORT || 4173), '127.0.0.1', () => console.log('USB companion: http://localhost:4173 (Chrome or Edge)'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
