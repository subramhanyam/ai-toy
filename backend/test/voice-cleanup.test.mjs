import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createVoiceSession } from '../src/agents/live.mjs';
import { createBackend } from '../src/transport/websocket-server.mjs';
import { LocalRelay } from '../src/transport/relay.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanups = []; afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
class Live extends EventEmitter {
  sent = []; closed = false; forced = false;
  socket = Object.assign(new EventEmitter(), { platformSocket: { terminate: () => { this.forced = true; this.close(); } } });
  send(e) { this.sent.push(e); }
  close() { this.closed = true; this.socket.emit('close'); }
  open() { this.socket.emit('open'); }
  raw(e) { this.emit('event', e); }
  start() { this.open(); this.raw({ type: 'session.started', session: { id: 'live-cleanup' } }); }
  finish(seconds = 1) { this.raw({ type: 'session.closed', reason: 'close_requested', usage: { seconds } }); }
}
function key(t) { const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-only'; t.after(() => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }); }
function fixture(options = {}) {
  const lives = [], sent = [], records = [];
  const voice = createVoiceSession({ config: {}, relay: new LocalRelay(), send: e => sent.push(e), monitor() {}, audit: r => { if (r.event === 'closed') records.push(r); },
    makeConnection: () => { const c = new Live(); lives.push(c); return c; }, ...options });
  cleanups.push(() => { void voice.close(); for (const c of lives) c.finish(); });
  const open = () => { voice.handle({ type: 'voice.open', openId: 'request-1' }); return lives.at(-1); };
  return { voice, lives, sent, records, open };
}

test('End before socket open never sends session.start, and late open is ignored', async t => {
  key(t); const f = fixture(), c = f.open();
  await f.voice.shutdown('test_cancel'); c.open();
  assert.equal(c.sent.length, 0); assert.equal(c.closed, true);
  assert.equal(f.records[0].startSent, false); assert.equal(f.records[0].apiReason, 'cancelled_before_session_start');
});

test('End after session.start waits for late session.started, never enables capture, and closes once', async t => {
  key(t); const f = fixture(), c = f.open(); c.open();
  const stopping = f.voice.shutdown('user'); f.voice.handle({ type: 'voice.close' });
  assert.equal(c.closed, false); assert.equal(c.sent.some(e => e.type === 'session.close'), false);
  const marker = f.sent.length; c.raw({ type: 'session.started', session: { id: 'late-start' } });
  assert.equal(f.sent.slice(marker).some(e => e.state === 'active'), false);
  assert.equal(c.sent.filter(e => e.type === 'session.close').length, 1);
  c.finish(0.2); const record = await stopping;
  assert.equal(record.finalized, true); assert.equal(record.seconds, 0.2);
});

test('missing final acknowledgment forces transport cleanup, records unconfirmed usage, and never retries', async t => {
  key(t); const f = fixture({ closeTimeoutMs: 20 }), c = f.open(); c.start();
  const record = await f.voice.shutdown('user');
  assert.equal(c.forced, true); assert.equal(record.finalized, false); assert.equal(record.apiReason, 'finalization_timeout');
  c.finish(10); await pause(20);
  assert.equal(f.records.length, 1); assert.equal(f.lives.length, 1);
});

test('startup timeout and a failed connection factory settle cleanup without another paid attempt', async t => {
  key(t); const f = fixture({ startupTimeoutMs: 20 }); f.open(); await pause(45);
  assert.equal(f.voice.snapshot().state, 'closed'); assert.equal(f.records.length, 1); assert.equal(f.lives.length, 1);
  const g = fixture({ makeConnection() { throw Error('failed'); } }); g.open();
  assert.equal((await g.voice.shutdown()).startSent, false);
});

test('auto-end duration limit applies even when the microphone keeps sending audio', async t => {
  key(t); const f = fixture({ maxDurationMs: 30 }), c = f.open(); c.start();
  f.voice.handle({ type: 'voice.audio', openId: 'request-1', seq: 0, audio: Buffer.alloc(160, 255).toString('base64') });
  await pause(60); assert.equal(c.sent.at(-1).type, 'session.close'); c.finish(0.1);
  assert.equal(f.records[0].closeReason, 'duration_limit'); assert.equal(f.records[0].usageFinal, true);
});

test('duplicate request IDs do not open a new API session or reset sequence; old End cannot close a new session', t => {
  key(t); const f = fixture(), c = f.open(); c.start();
  for (let seq = 0; seq < 2; seq++) {
    f.voice.handle({ type: 'voice.open', openId: 'request-1' });
    f.voice.handle({ type: 'voice.audio', openId: 'request-1', seq, audio: Buffer.alloc(160, 255).toString('base64') });
  }
  assert.equal(f.lives.length, 1); assert.equal(c.sent.filter(e => e.type === 'session.input_audio.append').length, 2);
  f.voice.handle({ type: 'voice.close', openId: 'old-request' }); assert.equal(c.sent.some(e => e.type === 'session.close'), false);
  f.voice.handle({ type: 'voice.close', openId: 'request-1' }); c.finish();
});

test('device disconnect returns a promise for finalization and retains final usage for audit', async t => {
  key(t); const f = fixture(), c = f.open(); c.start(); let completed = false;
  const closing = f.voice.close().then(r => { completed = true; return r; });
  await pause(10); assert.equal(completed, false); c.finish(2.5);
  const record = await closing; assert.equal(record.finalized, true); assert.equal(record.closeReason, 'device_disconnected');
  assert.equal(f.records[0].seconds, 2.5);
});

test('a refreshed client receives its own close acknowledgement without creating an overlapping API session', async t => {
  key(t); const f = fixture(), c = f.open(); c.start();
  f.voice.handle({ type: 'voice.open', openId: 'refreshed-page' });
  assert.ok(f.sent.some(e => e.openId === 'refreshed-page' && e.state === 'ending'));
  assert.equal(f.lives.length, 1); assert.equal(c.sent.at(-1).type, 'session.close');
  c.finish(); await pause(5);
  assert.ok(f.sent.some(e => e.openId === 'refreshed-page' && e.state === 'closed'));
  assert.equal(f.lives.length, 1);
});

test('an API close without final usage is distinguished from a confirmed final duration', async t => {
  key(t); const f = fixture(), c = f.open(); c.start();
  c.raw({ type: 'session.usage.updated', usage: { seconds: 2 } });
  const stopping = f.voice.shutdown(); c.raw({ type: 'session.closed', reason: 'close_requested' });
  const record = await stopping; assert.equal(record.finalized, true); assert.equal(record.usageFinal, false);
  assert.equal(f.sent.at(-1).final, false);
});

test('late delegated task completion after End cannot return commentary to a new session', async t => {
  key(t); let finish, aborted = false;
  const f = fixture({ runAgent: ({ signal }) => new Promise(resolve => {
    finish = resolve; signal.addEventListener('abort', () => { aborted = true; });
  }) }), c = f.open(); c.start();
  c.raw({ type: 'session.input_transcript.delta', delta: 'Blink twice', start_ms: 0, end_ms: 100 });
  c.raw({ type: 'session.delegation.created', offset_ms: 100, delegation: { id: 'task', target: 'client' } });
  await pause(180); f.voice.handle({ type: 'voice.close' }); assert.equal(aborted, true); c.finish();
  f.voice.handle({ type: 'voice.open', openId: 'request-2' }); const next = f.lives[1]; next.start();
  finish([]); await pause(15); assert.equal(next.sent.some(e => e.type === 'session.commentary.append'), false);
});

test('device output failure triggers session closure instead of leaving a billable orphan', async t => {
  key(t); const f = fixture({ send: e => e.type === 'voice.ack' ? false : true }), c = f.open(); c.start();
  f.voice.handle({ type: 'voice.audio', seq: 0, audio: Buffer.alloc(160, 255).toString('base64') }); await pause(10);
  assert.equal(c.sent.at(-1).type, 'session.close'); c.finish(); assert.equal(f.records[0].closeReason, 'device_send_failed');
});

const config = { deviceToken: 'a'.repeat(64), sessionSecret: 'b'.repeat(64), dashboardPassword: '' };
async function device(app) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/api/ws?role=device`, { headers: { Authorization: `Bearer ${config.deviceToken}` } });
  ws.on('error', () => {}); await once(ws, 'open'); return ws;
}

test('server shutdown waits for upstream session.closed and writes a credential-free local audit record', async t => {
  key(t); const dir = mkdtempSync(join(tmpdir(), 'voice-audit-')), path = join(dir, 'sessions.jsonl');
  const live = new Live(), app = createBackend({ ...config, voiceAuditFile: path }, { liveFactory: () => live }); let ws;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    ws = await device(app); ws.send(JSON.stringify({ type: 'voice.open' })); await pause(20); live.start();
    let stopped = false; const closing = app.close().then(result => { stopped = true; return result; });
    await pause(20); assert.equal(stopped, false); assert.equal(live.sent.at(-1).type, 'session.close');
    live.finish(3); assert.equal((await closing).unconfirmed, 0);
    const record = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(record => record.event === 'closed');
    assert.equal(record.closeReason, 'server_shutdown'); assert.equal(record.seconds, 3); assert.equal(record.finalized, true);
    assert.equal(readFileSync(path, 'utf8').includes('test-only'), false);
  } finally { live.finish(); ws?.terminate(); await app.close(); unlinkSync(path); rmdirSync(dir); }
});

test('device replacement waits for the old paid session to finalize before creating the new one', async t => {
  key(t); const lives = [], app = createBackend(config, { liveFactory: () => { const c = new Live(); lives.push(c); return c; } }); let first, second;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    first = await device(app); first.send(JSON.stringify({ type: 'voice.open' })); await pause(20); lives[0].start();
    second = await device(app); second.send(JSON.stringify({ type: 'voice.open' })); await pause(25);
    assert.equal(lives.length, 1); assert.equal(lives[0].sent.at(-1).type, 'session.close');
    lives[0].finish(); await pause(25); assert.equal(lives.length, 2); lives[1].start(); lives[1].finish();
  } finally { first?.terminate(); second?.terminate(); const closing = app.close(); for (const c of lives) c.finish(); await closing; }
});
