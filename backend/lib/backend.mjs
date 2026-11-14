import { createServer } from 'node:http';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { LocalRelay, RedisRelay } from './relay.mjs';

function equal(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
function sign(value, secret) { return createHmac('sha256', secret).update(value).digest('base64url'); }
function authorized(req, config) {
  if (!config.dashboardPassword) return true;
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('led_session='));
  if (!cookie) return false;
  const [expires, signature] = cookie.slice(12).split('.');
  return /^\d+$/.test(expires) && Number(expires) > Date.now() && equal(signature, sign(expires, config.sessionSecret));
}
function originAllowed(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch { return false; }
}
function validSettings(value) {
  return value && typeof value.enabled === 'boolean' && Number.isInteger(value.interval) && value.interval >= 50 && value.interval <= 2000;
}
function validId(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id); }
function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    if (ws.bufferedAmount > 65536) return ws.close(1013, 'Client too slow');
    ws.send(JSON.stringify(message));
  }
}

export function createBackend(config, { relay = config.redisUrl ? new RedisRelay(config.redisUrl, config.deviceToken) : new LocalRelay(), page = null } = {}) {
  const browsers = new Set(); let device = null;
  const attempts = new Map();
  const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (page && path === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Frame-Options': 'DENY' }); return res.end(page);
    }
    if (path !== '/api/ws') return json(res, 404, { error: 'Not found' });
    if (req.method === 'GET') return json(res, 200, { transport: 'websocket', loginRequired: !!config.dashboardPassword && !authorized(req, config) });
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    if (!originAllowed(req)) return json(res, 403, { error: 'Origin rejected' });
    try {
      let text = '';
      for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 1024) return json(res, 413, { error: 'Body too large' }); }
      const password = new URLSearchParams(text).get('password');
      const key = req.socket.remoteAddress || 'client', now = Date.now();
      // A signed session protects the dashboard; device connections use a separate token.
      for (const [ip, entry] of attempts) if (now - entry.start > 60000) attempts.delete(ip);
      const entry = attempts.get(key) || { start: now, count: 0 };
      if (entry.count >= 10) return json(res, 429, { error: 'Wait one minute before retrying' });
      if (config.dashboardPassword && !equal(password, config.dashboardPassword)) {
        entry.count++; attempts.set(key, entry); return json(res, 401, { error: 'Incorrect access password' });
      }
      attempts.delete(key);
      const expires = String(now + 86400000);
      res.setHeader('Set-Cookie', `led_session=${expires}.${sign(expires, config.sessionSecret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${config.cloud ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    } catch { return json(res, 400, { error: 'Invalid request' }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  const broadcast = event => { for (const ws of browsers) send(ws, event); };
  const routeControl = event => { if (device) send(device, event); };
  const routeEvent = event => broadcast(event);
  const unavailable = () => { for (const ws of wss.clients) ws.close(1013, 'Relay reconnecting'); };
  relay.on('control', routeControl); relay.on('event', routeEvent); relay.on('unavailable', unavailable);
  const publish = (method, event) => relay[method](event).catch(unavailable);
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    const url = new URL(req.url, 'http://localhost');
    const isDevice = url.searchParams.get('role') === 'device';
    if (url.pathname !== '/api/ws' || !originAllowed(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const allowed = isDevice ? equal(req.headers.authorization, `Bearer ${config.deviceToken}`) : authorized(req, config);
    if (!allowed) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    try {
      await Promise.race([relay.ready, new Promise((_, reject) => { const t = setTimeout(() => reject(Error('Relay timeout')), 5000); t.unref(); })]);
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, ws => { ws.isDevice = isDevice; wss.emit('connection', ws); });
    } catch { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); }
  });
  wss.on('connection', ws => {
    ws.alive = true; ws.on('pong', () => { ws.alive = true; }); ws.on('error', () => {});
    if (ws.isDevice) {
      if (device) { device.replaced = true; device.close(4000, 'Device replaced'); }
      device = ws; ws.connectionId = randomUUID();
      send(ws, { type: 'get_state' });
    } else { browsers.add(ws); publish('control', { type: 'get_state' }); }
    ws.on('message', (data, binary) => {
      try {
        if (binary) throw Error('Text messages only');
        const event = JSON.parse(data.toString());
        if (ws.isDevice) {
          if (device !== ws || event.type !== 'state' || !validSettings(event) ||
              (event.id !== '' && !validId(event.id)) || typeof event.ip !== 'string' || event.ip.length > 45 ||
              !Number.isFinite(event.rssi) || !Number.isFinite(event.uptime)) throw Error('Invalid device state');
          publish('event', { type: 'state', enabled: event.enabled, interval: event.interval, id: event.id,
            ip: event.ip, rssi: event.rssi, uptime: event.uptime, online: true, connectionId: ws.connectionId });
        } else if (event.type === 'command') {
          if (!validSettings(event) || !validId(event.id)) throw Error('Invalid command: interval must be 50..2000 ms');
          const now = Date.now();
          if (now - (ws.windowStart || 0) >= 1000) { ws.windowStart = now; ws.commandCount = 0; }
          if (++ws.commandCount > 40) throw Error('Too many commands');
          publish('control', { type: 'command', id: event.id, enabled: event.enabled, interval: event.interval });
        } else if (event.type === 'get_state') publish('control', { type: 'get_state' });
        else throw Error('Unknown event');
      } catch (error) { send(ws, { type: 'error', message: error.message }); }
    });
    ws.on('close', () => {
      browsers.delete(ws);
      if (ws.isDevice && device === ws) {
        device = null;
        if (!ws.replaced) publish('event', { type: 'offline', connectionId: ws.connectionId });
      }
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
  }, 10000);
  heartbeat.unref();
  return { server, relay, async close() {
    clearInterval(heartbeat);
    relay.off('control', routeControl); relay.off('event', routeEvent); relay.off('unavailable', unavailable);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await relay.close();
  } };
}
