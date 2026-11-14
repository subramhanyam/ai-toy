import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise DOM updates without network or a browser installation.
test('chat UI appends streaming text, renders tool JSON as text, and marks interrupted tools unconfirmed', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const nodes = new Map();
  class Element {
    children = []; textContent = ''; value = ''; style = { setProperty() {} };
    classList = { toggle() {}, remove() {}, add() {} };
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener() {}
    remove() {}
    focus() {}
    setAttribute() {}
  }
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) nodes.set(id, new Element());
  const document = { getElementById: id => nodes.get(id), createElement: () => new Element() };
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/connect\(\);\s*$/, '');
  const context = vm.createContext({ document, console, setTimeout, clearTimeout });
  vm.runInContext(script, context);
  vm.runInContext("chatConnected(true);chatTurn='turn';chatBusy=true;", context);
  const receive = event => { context.input = event; vm.runInContext('receiveChat(input)', context); };
  receive({ type: 'chat.delta', id: 'turn', delta: 'Hello ' });
  receive({ type: 'chat.delta', id: 'turn', delta: '<script>text only</script>' });
  assert.equal(nodes.get('chatLog').children[0].children[1].textContent, 'Hello <script>text only</script>');
  receive({ type: 'chat.tool_call', id: 'turn', callId: 'call', name: 'set_led', arguments: { enabled: true, interval: 100 } });
  const card = nodes.get('chatLog').children[1];
  assert.match(card.children[1].textContent, /"interval": 100/);
  receive({ type: 'chat.tool_result', id: 'turn', callId: 'call', result: { ok: true, interval: 100 } });
  assert.match(card.children[0].textContent, /Confirmed/);
  receive({ type: 'chat.tool_call', id: 'turn', callId: 'pending', name: 'get_led_state', arguments: {} });
  vm.runInContext('chatConnected(false)', context);
  assert.match(nodes.get('chatLog').children[2].children[0].textContent, /Unconfirmed/);
  assert.equal(nodes.get('sendChat').disabled, true);
  vm.runInContext('chatConnected(true)', context);
  assert.match(nodes.get('chatLog').children.at(-1).children[1].textContent, /new conversation/);
  receive({ type: 'chat.reset' });
  assert.equal(nodes.get('chatLog').children.length, 0);
  receive({ type: 'chat.started', source: 'device', id: 'tap-1', message: 'Blink the LED 3 times a second.' });
  assert.equal(nodes.get('chatLog').children[0].children[0].textContent, 'ESP32 input');
  receive({ type: 'chat.tool_call', source: 'device', id: 'tap-1', callId: 'tool-1', name: 'set_led', arguments: { interval: 167 } });
  receive({ type: 'chat.tool_result', source: 'device', id: 'tap-1', callId: 'tool-1', result: { ok: true, interval: 167 } });
  assert.match(nodes.get('chatLog').children[1].children[0].textContent, /Confirmed/);
  receive({ type: 'chat.delta', source: 'device', id: 'tap-1', delta: 'Done.' });
  assert.equal(nodes.get('chatLog').children[2].children[1].textContent, 'Done.');
  receive({ type: 'chat.done', source: 'device', id: 'tap-1' });
  assert.match(nodes.get('message').textContent, /Ready for more taps/);
});
