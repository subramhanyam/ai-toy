import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';

const base = process.argv[2] || 'http://192.168.0.22:3000';
const endpoint = base.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/ws?role=browser';
async function connect() {
  const ws = new WebSocket(endpoint); ws.inbox = [];
  ws.on('message', text => ws.inbox.push({ ...JSON.parse(text), receivedAt: performance.now() }));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
}
async function wait(ws, predicate) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const index = ws.inbox.findIndex(predicate);
    if (index >= 0) return ws.inbox.splice(index, 1)[0];
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw Error('Timed out waiting for board acknowledgement');
}
let seq = 0;
async function command(ws, enabled, interval) {
  const id = `hardware-${Date.now()}-${++seq}`, started = performance.now();
  ws.send(JSON.stringify({ type: 'command', id, enabled, interval }));
  const state = await wait(ws, event => event.type === 'state' && event.id === id);
  assert.equal(state.enabled, enabled); assert.equal(state.interval, interval);
  return state.receivedAt - started;
}
const ws = await connect();
const original = await wait(ws, event => event.type === 'state');
const times = [];
try {
  for (const [enabled, interval] of [[false,100],[true,50],[true,2000],[true,237],[false,237],[true,100]]) {
    const elapsed = await command(ws, enabled, interval); times.push(elapsed);
    console.log(`PASS: ESP32 acknowledged enabled=${enabled}, interval=${interval} ms in ${Math.round(elapsed)} ms`);
  }
  const second = await connect();
  try {
    const state = await wait(second, event => event.type === 'state');
    assert.equal(state.enabled, true); assert.equal(state.interval, 100);
    const elapsed = await command(second, false, 550); times.push(elapsed);
    await wait(ws, event => event.type === 'state' && event.enabled === false && event.interval === 550);
    console.log('PASS: second browser/reconnection reads actual state; changes reach both browsers');
  } finally { second.close(); }
} finally {
  await command(ws, original.enabled, original.interval);
  console.log('Original settings restored and acknowledged');
  ws.close();
}
times.sort((a,b) => a-b);
console.log(`Hardware round-trip: median ${Math.round(times[Math.floor(times.length/2)])} ms; maximum ${Math.round(times.at(-1))} ms (${times.length} commands).`);
