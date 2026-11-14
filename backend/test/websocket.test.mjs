import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createBackend } from '../src/transport/websocket-server.mjs';
import { LocalRelay } from '../src/transport/relay.mjs';

const config = { deviceToken: 'a'.repeat(64), sessionSecret: 'b'.repeat(64), dashboardPassword: '', cloud: false };
async function setup(options = {}, relay, chatRunner) {
  const app = createBackend({ ...config, ...options }, { ...(relay ? { relay } : {}), chatRunner });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const sockets = [];
  async function socket(role, headers = {}) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/ws?role=' + role, { headers });
    sockets.push(ws); ws.inbox = [];
    ws.on('message', text => { ws.inbox.push(JSON.parse(text)); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return ws;
  }
  return { base, socket, app, async close() { for (const ws of sockets) ws.terminate(); await app.close(); } };
}
async function message(ws, predicate) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const index = ws.inbox.findIndex(predicate);
    if (index >= 0) return ws.inbox.splice(index, 1)[0];
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Expected socket event not received');
}
const report = (id = '') => ({ type: 'state', id, enabled: false, interval: 237, ip: '192.168.0.26', uptime: 20, rssi: -40 });

test('device tap input runs once on its backend and streams to monitors on another instance', async () => {
  const relay = new LocalRelay(); let runs = 0;
  const run = async ({ message, emit }) => {
    runs++; assert.equal(message, 'Blink the LED 3 times a second.');
    emit({ type: 'chat.tool_call', callId: 'tool', name: 'set_led', arguments: { enabled: true, interval: 167 } });
    emit({ type: 'chat.tool_result', callId: 'tool', name: 'set_led', result: { ok: true, interval: 167 } });
    emit({ type: 'chat.delta', delta: 'Blinking three times per second.' });
    return [{ role: 'assistant', content: 'Done' }];
  };
  const a = await setup({}, relay, run), b = await setup({}, relay, run);
  try {
    const device = await a.socket('device', { Authorization: `Bearer ${config.deviceToken}` });
    const browser = await b.socket('browser');
    device.send(JSON.stringify({ type: 'tap.status', count: 3 }));
    assert.equal((await message(browser, e => e.type === 'tap.status')).phase, 'counting');
    device.send(JSON.stringify({ type: 'tap.input', id: 'tap-test', count: 3 }));
    const started = await message(browser, e => e.type === 'chat.started');
    assert.equal(started.source, 'device'); assert.equal(started.message, 'Blink the LED 3 times a second.');
    assert.equal((await message(browser, e => e.type === 'chat.tool_result')).result.ok, true);
    assert.match((await message(browser, e => e.type === 'chat.delta')).delta, /three/);
    await message(browser, e => e.type === 'chat.done');
    await message(device, e => e.type === 'input.ready');
    device.send(JSON.stringify({ type: 'tap.input', id: 'tap-test', count: 3 }));
    device.send(JSON.stringify({ type: 'tap.input', id: 'bad-count', count: 0 }));
    await message(device, e => e.type === 'error');
    assert.equal(runs, 1);
  } finally { await a.close(); await b.close(); }
});

test('commands push immediately and remain unconfirmed until device acknowledgement', async () => {
  const f = await setup();
  try {
    const device = await f.socket('device', { Authorization: `Bearer ${config.deviceToken}` });
    const browser = await f.socket('browser');
    await message(device, e => e.type === 'get_state');
    device.send(JSON.stringify(report()));
    await message(browser, e => e.type === 'state');
    browser.send(JSON.stringify({ type: 'command', id: 'command-1', enabled: false, interval: 237 }));
    const command = await message(device, e => e.type === 'command');
    assert.equal(command.id, 'command-1');
    assert.equal(browser.inbox.some(e => e.id === 'command-1'), false);
    device.send(JSON.stringify(report(command.id)));
    const ack = await message(browser, e => e.id === 'command-1');
    assert.equal(ack.enabled, false); assert.equal(ack.interval, 237);
    device.close(); await message(browser, e => e.type === 'offline');
  } finally { await f.close(); }
});

test('a shared relay routes device and browser on separate backend instances', async () => {
  const relay = new LocalRelay(), a = await setup({}, relay), b = await setup({}, relay);
  try {
    const device = await a.socket('device', { Authorization: `Bearer ${config.deviceToken}` });
    const browser = await b.socket('browser');
    browser.send(JSON.stringify({ type: 'command', id: 'cross-instance', enabled: false, interval: 237 }));
    await message(device, e => e.id === 'cross-instance');
    device.send(JSON.stringify(report('cross-instance')));
    assert.equal((await message(browser, e => e.id === 'cross-instance')).interval, 237);
  } finally { await a.close(); await b.close(); }
});

test('invalid settings and binary frames never reach the device', async () => {
  const f = await setup();
  try {
    const device = await f.socket('device', { Authorization: `Bearer ${config.deviceToken}` });
    const browser = await f.socket('browser');
    for (const interval of [49, 2001, 50.5]) {
      browser.send(JSON.stringify({ type: 'command', id: 'bad', enabled: true, interval }));
      await message(browser, e => e.type === 'error');
    }
    browser.send(Buffer.from('binary'));
    await message(browser, e => e.type === 'error');
    assert.equal(device.inbox.some(e => e.type === 'command'), false);
  } finally { await f.close(); }
});

test('device token, browser login and browser origin are checked on upgrade', async () => {
  const f = await setup({ dashboardPassword: 'dashboard-test-password' });
  async function rejected(path, headers = {}) {
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(f.base.replace('http:', 'ws:') + path, { headers });
      ws.on('unexpected-response', (_, res) => { const status = res.statusCode; res.destroy(); ws.terminate(); resolve(status); });
      ws.on('error', () => {});
      ws.on('open', () => { ws.terminate(); reject(Error('Unexpected authorization')); });
    });
  }
  try {
    assert.equal(await rejected('/api/ws?role=device'), 401);
    assert.equal(await rejected('/api/ws?role=browser'), 401);
    const login = await fetch(f.base + '/api/ws', { method: 'POST', body: new URLSearchParams({ password: 'dashboard-test-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const browser = await f.socket('browser', { Cookie: cookie }); assert.equal(browser.readyState, WebSocket.OPEN);
    assert.equal(await rejected('/api/ws?role=browser', { Cookie: cookie, Origin: 'https://untrusted.example' }), 403);
  } finally { await f.close(); }
});
