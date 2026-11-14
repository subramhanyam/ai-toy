import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { Usage } from '@openai/agents';
import { createVoiceSession, liveConfiguration } from '../src/agents/live.mjs';
import { createBackend } from '../src/transport/websocket-server.mjs';
import { LocalRelay } from '../src/transport/relay.mjs';

class FakeLive extends EventEmitter {
  socket = new EventEmitter(); sent = []; closed = false;
  send(event) { this.sent.push(event); }
  close() { this.closed = true; this.socket.emit('close'); }
  open() { this.socket.emit('open'); }
  raw(event) { this.emit('event', event); }
  start(id = 'live-test') { this.open(); this.raw({ type: 'session.started', session: { id } }); }
  finish(seconds = 1) { this.raw({ type: 'session.closed', usage: { seconds }, reason: 'client_requested' }); }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = seq => ({ type: 'voice.audio', seq, audio: Buffer.alloc(160, 255).toString('base64') });
function fixture(runAgent, options = {}) {
  const connections = [], sent = [], monitored = [];
  const voice = createVoiceSession({ config: {}, relay: new LocalRelay(), send: e => sent.push(e), monitor: e => monitored.push(e),
    makeConnection: () => { const c = new FakeLive(); connections.push(c); return c; }, runAgent, ...options });
  return { connections, sent, monitored, voice };
}
function withKey(t) { const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-only'; t.after(() => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }); }

test('documented Live startup uses client delegation and explicit PCMU rate', () => {
  assert.deepEqual(liveConfiguration({}).audio.format, { type: 'audio/pcmu', rate: 8000 });
  assert.equal(liveConfiguration({}).model, 'gpt-live-1');
  assert.equal(liveConfiguration({}).store, false);
  assert.equal(liveConfiguration({}).delegation.type, 'client');
  assert.equal(liveConfiguration({ liveModel: 'future-model' }).model, 'future-model');
});

test('full-duplex input remains live during output; End waits for final cumulative usage', async t => {
  withKey(t); const f = fixture(); f.voice.handle({ type: 'voice.open' }); const c = f.connections[0];
  c.start(); f.voice.handle(frame(0));
  c.raw({ type: 'session.output_audio.delta', delta: Buffer.alloc(320, 255).toString('base64') });
  f.voice.handle(frame(1)); await pause(65);
  assert.equal(c.sent.filter(e => e.type === 'session.input_audio.append').length, 2);
  assert.equal(f.sent.filter(e => e.type === 'voice.audio').length, 2);
  assert.equal(f.monitored.some(e => e.type === 'voice.audio'), false);
  assert.equal(c.sent.some(e => /commit|response.create/.test(e.type)), false);
  c.raw({ type: 'session.usage.updated', usage: { seconds: 2 } });
  c.raw({ type: 'session.usage.updated', usage: { seconds: 5 } });
  f.voice.handle({ type: 'voice.close' });
  assert.equal(c.sent.at(-1).type, 'session.close'); assert.equal(c.closed, false);
  const before = c.sent.length; f.voice.handle(frame(2)); assert.equal(c.sent.length, before);
  c.finish(5.4);
  assert.equal(c.closed, true); assert.equal(f.sent.at(-1).seconds, 5.4); assert.equal(f.sent.at(-1).final, true);
  f.voice.close();
});

test('overlapping speaker captions remain independent and stale sessions cannot affect a restart', t => {
  withKey(t); const f = fixture(); f.voice.handle({ type: 'voice.open' }); const c = f.connections[0]; c.start();
  c.raw({ type: 'session.input_transcript.delta', delta: 'Please blink', start_ms: 10, end_ms: 300 });
  c.raw({ type: 'session.output_transcript.delta', delta: 'Sure', start_ms: 20, end_ms: 150 });
  c.raw({ type: 'session.input_transcript.delta', delta: ' twice', start_ms: 301, end_ms: 600 });
  const captions = f.sent.filter(e => e.type === 'voice.transcript');
  assert.equal(captions[0].itemId, captions[2].itemId); assert.notEqual(captions[0].itemId, captions[1].itemId);
  f.voice.handle({ type: 'voice.close' }); c.finish();
  f.voice.handle({ type: 'voice.open' }); const next = f.connections[1]; next.start('new');
  const n = f.sent.length; c.raw({ type: 'error', error: { code: 'stale' } }); assert.equal(f.sent.length, n);
  f.voice.handle(frame(0)); assert.equal(next.sent.at(-1).type, 'session.input_audio.append');
  f.voice.close(); next.finish();
});

test('missing audio frames close the session instead of silently corrupting speech', t => {
  withKey(t); const f = fixture(); f.voice.handle({ type: 'voice.open' }); const c = f.connections[0]; c.start();
  f.voice.handle(frame(1));
  assert.equal(c.sent.some(e => e.type === 'session.input_audio.append'), false);
  assert.equal(c.sent.at(-1).type, 'session.close');
  c.finish(); f.voice.close();
});

test('every duplicate Start receives lifecycle feedback rather than leaving the USB UI waiting', t => {
  withKey(t); const f = fixture(); f.voice.handle({ type: 'voice.open' }); const c = f.connections[0];
  assert.equal(f.voice.snapshot().stage, 'opening_socket');
  f.voice.handle({ type: 'voice.open' }); assert.equal(f.connections.length, 1); assert.equal(f.sent.at(-1).state, 'starting');
  c.open(); assert.equal(f.voice.snapshot().stage, 'waiting_session_started');
  c.raw({ type: 'session.started', session: { id: 'started' } });
  f.voice.handle({ type: 'voice.open' }); assert.match(f.sent.at(-1).message, /already active/);
  f.voice.handle({ type: 'voice.close' }); f.voice.handle({ type: 'voice.open' }); assert.equal(f.sent.at(-1).state, 'ending');
  c.finish(); f.voice.close();
});

test('continuous speaker pacing catches up after timer stalls instead of accumulating latency', async t => {
  withKey(t); const f = fixture(); f.voice.handle({ type: 'voice.open' }); const c = f.connections[0]; c.start();
  const started = performance.now();
  c.raw({ type: 'session.output_audio.delta', delta: Buffer.alloc(8000, 255).toString('base64') });
  await pause(60);
  const until = performance.now() + 120; while (performance.now() < until) { /* simulate a delayed timer */ }
  await pause(260);
  const elapsed = performance.now() - started;
  const playedMs = f.sent.filter(e => e.type === 'voice.audio').at(-1).endMs;
  assert.ok(playedMs >= elapsed - 90, `audio ${playedMs}ms must keep up with elapsed ${elapsed}ms`);
  f.voice.close(); c.finish();
});

test('loss of the USB microphone stream closes the billable session even if ESP32 Wi-Fi stays connected', async t => {
  withKey(t); const f = fixture(undefined, { inputTimeoutMs: 45 }); f.voice.handle({ type: 'voice.open' }); const c = f.connections[0]; c.start();
  await pause(110);
  assert.ok(f.sent.some(e => e.type === 'voice.error' && /Microphone stream stopped/.test(e.message)));
  assert.equal(c.sent.at(-1).type, 'session.close');
  c.finish(0.1); assert.equal(f.sent.at(-1).final, true); f.voice.close();
});

test('client delegation uses transcript context once and returns Agents SDK results to the correct delegation', async t => {
  withKey(t); let calls = 0;
  const f = fixture(async ({ message, emit }) => {
    calls++; assert.match(message, /user: Blink twice/);
    emit({ type: 'chat.tool_call', name: 'set_led', callId: 'tool', arguments: { enabled: true, interval: 250 } });
    emit({ type: 'chat.tool_result', name: 'set_led', callId: 'tool', result: { ok: true } });
    emit({ type: 'chat.delta', delta: 'Confirmed two blinks per second.' }); return [];
  });
  f.voice.handle({ type: 'voice.open' }); const c = f.connections[0]; c.start();
  c.raw({ type: 'session.input_transcript.delta', delta: 'Blink twice', start_ms: 0, end_ms: 1000 });
  const event = { type: 'session.delegation.created', offset_ms: 1000, delegation: { id: 'delegation-1', target: 'client' } };
  c.raw(event); c.raw(event); await pause(220);
  assert.equal(calls, 1);
  const result = c.sent.find(e => e.type === 'session.commentary.append');
  assert.equal(result.delegation_id, 'delegation-1'); assert.match(result.content, /Confirmed/);
  assert.ok(f.monitored.some(e => e.type === 'chat.tool_result'));
  f.voice.close(); c.finish();
});

test('authenticated local device delegates through the real Agents SDK and board acknowledgement; monitor receives no audio', async t => {
  withKey(t); const relay = new LocalRelay(), live = new FakeLive(); let modelCalls = 0;
  const model = { async *getStreamedResponse() {
    if (++modelCalls === 1) yield { type: 'response_done', response: { id: 'm1', usage: new Usage(), output: [{ type: 'function_call', callId: 'led', name: 'set_led', arguments: '{"enabled":true,"interval":250}' }] } };
    else {
      yield { type: 'output_text_delta', delta: 'LED confirmed.' };
      yield { type: 'response_done', response: { id: 'm2', usage: new Usage(), output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'LED confirmed.' }] }] } };
    }
  }, async getResponse() { throw Error('Expected streaming'); } };
  const config = { deviceToken: 'a'.repeat(64), sessionSecret: 'b'.repeat(64), dashboardPassword: '', openaiModel: model };
  const a = createBackend(config, { relay, liveFactory: () => live }), b = createBackend(config, { relay });
  for (const app of [a, b]) await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let device, browser;
  try {
    device = new WebSocket(`ws://127.0.0.1:${a.server.address().port}/api/ws?role=device`, { headers: { Authorization: `Bearer ${config.deviceToken}` } });
    device.on('message', data => { const e = JSON.parse(data); if (e.type === 'command' || e.type === 'get_state') device.send(JSON.stringify({ type: 'state', id: e.id || '', enabled: e.enabled ?? false, interval: e.interval || 100, ip: '127.0.0.1', rssi: -40, uptime: 5 })); });
    await once(device, 'open');
    browser = new WebSocket(`ws://127.0.0.1:${b.server.address().port}/api/ws?role=browser`); const events = [];
    browser.on('message', data => events.push(JSON.parse(data))); await once(browser, 'open');
    browser.send(JSON.stringify({ type: 'voice.open' })); await pause(20); assert.ok(events.some(e => e.type === 'error'));
    device.send(JSON.stringify({ type: 'voice.open' })); await pause(20); live.start();
    live.raw({ type: 'session.input_transcript.delta', delta: 'Blink the LED twice per second.', start_ms: 0, end_ms: 1000 });
    live.raw({ type: 'session.delegation.created', offset_ms: 1000, delegation: { target: 'client', id: 'live-tool' } });
    live.raw({ type: 'session.output_audio.delta', delta: Buffer.alloc(320, 255).toString('base64') });
    await pause(400);
    assert.ok(events.some(e => e.type === 'chat.tool_result' && e.result.ok));
    assert.equal(events.some(e => e.type === 'voice.audio'), false);
    assert.equal(live.sent.find(e => e.type === 'session.commentary.append').content, 'LED confirmed.');
    live.finish();
  } finally { device?.terminate(); browser?.terminate(); await a.close(); await b.close(); }
});
