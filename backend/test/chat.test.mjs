import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { RunContext, Usage } from '@openai/agents';
import { WebSocket } from 'ws';
import { LocalRelay } from '../src/transport/relay.mjs';
import { createLedTools, requestDevice } from '../src/tools/led.mjs';
import { createChatSession } from '../src/agents/chat-session.mjs';
import { createBackend } from '../src/transport/websocket-server.mjs';
import { streamAssistant } from '../src/agents/assistant.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const state = (id = '', interval = 237) => ({ type: 'state', id, enabled: true, interval, ip: '192.168.0.26', rssi: -40, uptime: 20 });

test('LED tool exposes arguments, preserves current settings, and waits for matching acknowledgement', async () => {
  const relay = new LocalRelay(), events = [], commands = [];
  relay.on('control', command => { commands.push(command); if (command.type === 'get_state') relay.event(state()); });
  const tool = createLedTools(relay, event => events.push(event))[1];
  const pending = tool.invoke(new RunContext(), JSON.stringify({ enabled: null, interval: 100 }));
  await tick();
  const command = commands.find(c => c.type === 'command');
  assert.equal(command.enabled, true);
  assert.equal(events[0].name, 'set_led');
  relay.event(state('wrong-id', 100)); await tick();
  assert.equal(events.length, 1);
  relay.event(state(command.id, 100));
  assert.equal(JSON.parse(await pending).ok, true);
  assert.equal(events[1].callId, events[0].callId);
  assert.equal(events[1].result.interval, 100);
  assert.equal(relay.listenerCount('event'), 0);
});

test('device timeout, cancellation and disconnect never report success or leak listeners', async () => {
  const relay = new LocalRelay();
  await assert.rejects(requestDevice(relay, { type: 'get_state' }, undefined, 15), /unconfirmed/);
  const controller = new AbortController();
  const pending = requestDevice(relay, { type: 'get_state' }, controller.signal);
  controller.abort(); await assert.rejects(pending, /stopped/);
  const offline = requestDevice(relay, { type: 'get_state' });
  relay.event({ type: 'offline' }); await assert.rejects(offline, /disconnected/);
  assert.equal(relay.listenerCount('event'), 0);
  assert.equal(relay.listenerCount('unavailable'), 0);
});

test('chat rejects overlapping runs, preserves completed history and cancels safely', async () => {
  const events = [], inputs = [];
  let release;
  const session = createChatSession({ config: {}, relay: new LocalRelay(), emit: e => events.push(e),
    run: async input => { inputs.push(input); input.emit({ type: 'chat.delta', delta: 'Hello' }); await new Promise(resolve => { release = resolve; input.signal.addEventListener('abort', resolve, { once: true }); }); return [{ role: 'assistant', content: 'Hello' }]; } });
  session.handle({ type: 'chat.send', id: 'one', message: 'Hi' }); await tick();
  session.handle({ type: 'chat.send', id: 'two', message: 'Hi again' });
  assert.equal(events.at(-1).type, 'chat.rejected');
  release(); await tick();
  session.handle({ type: 'chat.send', id: 'three', message: 'Next' }); await tick();
  assert.equal(inputs[1].history[0].content, 'Hello');
  session.handle({ type: 'chat.cancel' }); await tick();
  assert.equal(events.at(-1).stopped, true);
  session.handle({ type: 'chat.reset' });
  assert.equal(events.at(-1).type, 'chat.reset');
  session.close();
});

test('real Agents SDK streams tool calls and text through authenticated WebSocket transport', async () => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only-no-network';
  let calls = 0;
  const model = {
    async *getStreamedResponse(request) {
      if (++calls === 1) {
        yield { type: 'response_done', response: { id: 'mock-response', usage: new Usage(), output: [{ type: 'function_call', callId: 'sdk-call', name: 'set_led', arguments: '{"enabled":true,"interval":100}' }] } };
      } else {
        assert.ok(JSON.stringify(request.input).includes('function_call_result'));
        yield { type: 'output_text_delta', delta: 'LED ' };
        yield { type: 'output_text_delta', delta: 'confirmed.' };
        yield { type: 'response_done', response: { id: 'mock-response', usage: new Usage(), output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'LED confirmed.' }] }] } };
      }
    },
    async getResponse() { throw Error('Expected streaming'); },
  };
  const config = { deviceToken: 'a'.repeat(64), sessionSecret: 'b'.repeat(64), dashboardPassword: 'test-dashboard-password', openaiModel: model };
  let runError;
  const app = createBackend(config, { chatRunner: async input => {
    try { return await streamAssistant(input); } catch (error) { runError = error; throw error; }
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let browser, device;
  try {
    device = new WebSocket(base.replace('http:', 'ws:') + '/api/ws?role=device', { headers: { Authorization: `Bearer ${config.deviceToken}` } });
    device.on('message', data => { const c = JSON.parse(data); if (c.type === 'get_state') device.send(JSON.stringify(state())); if (c.type === 'command') device.send(JSON.stringify(state(c.id, c.interval))); });
    await once(device, 'open');
    const login = await fetch(base + '/api/ws', { method: 'POST', body: new URLSearchParams({ password: config.dashboardPassword }) });
    browser = new WebSocket(base.replace('http:', 'ws:') + '/api/ws?role=browser', { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } });
    const events = [];
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Chat did not finish')), 3000);
      browser.on('message', data => { const e = JSON.parse(data); events.push(e); if (e.type === 'chat.done') { clearTimeout(timer); resolve(); } });
    });
    await once(browser, 'open');
    browser.send(JSON.stringify({ type: 'chat.send', id: 'sdk-turn', message: 'Blink at 100ms' }));
    await done;
    assert.equal(events.some(e => e.type === 'chat.error'), false, runError?.stack || JSON.stringify(events));
    assert.equal(events.find(e => e.type === 'chat.tool_call').name, 'set_led');
    assert.equal(events.find(e => e.type === 'chat.tool_result').result.ok, true);
    assert.equal(events.filter(e => e.type === 'chat.delta').map(e => e.delta).join(''), 'LED confirmed.');
    assert.equal(calls, 2);
  } finally {
    browser?.terminate(); device?.terminate(); await app.close();
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});
