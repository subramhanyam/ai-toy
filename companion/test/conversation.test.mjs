import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { decodeMuLaw, fromBase64, toBase64 } from '../public/audio-codec.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture() {
  const code = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const nodes = new Map(), windowEvents = {}, documentEvents = {};
  class Element {
    textContent = ''; value = '0.8'; children = []; listeners = {}; classList = { toggle() {} };
    addEventListener(name, fn) { this.listeners[name] = fn; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    remove() {}
  }
  for (const id of ['connect','disconnect','start','end','orb','status','sessionState','duration','limit','connection','empty','transcript','volume','clear']) nodes.set(id, new Element());
  const track = { enabled: false, stopped: false, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, stop() { this.stopped = true; } };
  const messages = [], workletMessages = []; let played = 0, stopped = 0;
  const audio = { currentTime: 1, state: 'running', listeners: {}, resume: async () => {}, close: async () => { audio.state = 'closed'; },
    addEventListener: (name, fn) => { audio.listeners[name] = fn; },
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    createBuffer: (_, len) => ({ duration: len / 8000, getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => ({ connect() {}, start() { played++; }, stop() { stopped++; } }) };
  const writer = { write: async bytes => messages.push(JSON.parse(new TextDecoder().decode(bytes))), releaseLock() {} };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const sandbox = vm.createContext({
    document: { getElementById: id => nodes.get(id), createElement: () => new Element(), addEventListener: (name, fn) => { documentEvents[name] = fn; } },
    navigator: { serial: { addEventListener() {} } }, window: { addEventListener: (name, fn) => { windowEvents[name] = fn; } },
    setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, Date, decodeMuLaw, fromBase64, toBase64,
    writerFake: writer, audioFake: audio, micFake: stream, AudioContext: function () { return audio; },
    workletFake: { port: { postMessage: e => workletMessages.push(e) }, disconnect() {} },
  });
  vm.runInContext(code.replace(/^import .*?;\n/, ''), sandbox);
  const evaluate = code => vm.runInContext(code, sandbox);
  evaluate('writer=writerFake;context=audioFake;mic=micFake;worklet=workletFake;usbConnected=true;backendConnected=true;peripheralsReady=true;controls();');
  const receive = event => { sandbox.event = event; evaluate('receive(event)'); };
  const start = async () => { await nodes.get('start').listeners.click(); receive({ type: 'voice.status', state: 'active' }); };
  const cleanup = () => { receive({ type: 'voice.status', state: 'closed' }); };
  cleanups.push(cleanup);
  return { sandbox, nodes, track, messages, workletMessages, audio, writer, stream, windowEvents, documentEvents, evaluate, receive, start, cleanup,
    get played() { return played; }, get stopped() { return stopped; } };
}

test('Start gates capture, duplicate active status preserves the stream, End ignores late startup and waits for final usage', async () => {
  const f = await fixture(); await f.nodes.get('start').listeners.click();
  assert.equal(f.messages.at(-1).type, 'voice.open'); assert.equal(f.track.enabled, false);
  f.receive({ type: 'voice.status', state: 'active' });
  assert.equal(f.track.enabled, true);
  const starts = f.workletMessages.length; f.receive({ type: 'voice.status', state: 'active' }); assert.equal(f.workletMessages.length, starts);
  f.receive({ type: 'voice.audio', audio: Buffer.alloc(160, 255).toString('base64') });
  assert.equal(f.played, 1); assert.equal(f.track.enabled, true);
  const ending = f.nodes.get('end').listeners.click(); assert.equal(f.track.enabled, false); assert.equal(f.stopped, 1);
  await ending; await tick(); assert.equal(f.messages.at(-1).type, 'voice.close');
  f.receive({ type: 'voice.status', state: 'active' }); await tick(); assert.equal(f.track.enabled, false);
  assert.equal(f.nodes.get('start').disabled, true);
  f.receive({ type: 'voice.status', state: 'closed' }); f.receive({ type: 'voice.usage', seconds: 12.5, final: true });
  assert.match(f.nodes.get('duration').textContent, /12.5 s billed/); assert.equal(f.nodes.get('start').disabled, false);
});

test('refresh, freeze and bfcache restoration stop capture and never automatically reopen Live', async () => {
  const f = await fixture(); await f.start();
  f.windowEvents.pagehide(); await tick(); assert.equal(f.track.enabled, false); assert.equal(f.messages.at(-1).type, 'voice.close');
  f.receive({ type: 'voice.status', state: 'active' }); assert.equal(f.track.enabled, false);
  f.windowEvents.pageshow({ persisted: true }); await tick(); assert.equal(f.track.enabled, false);
  assert.equal(f.messages.filter(e => e.type === 'voice.open').length, 1);
  f.receive({ type: 'voice.status', state: 'closed' });
  await f.start(); f.documentEvents.freeze(); await tick(); assert.equal(f.track.enabled, false); assert.equal(f.messages.at(-1).type, 'voice.close'); f.cleanup();
});

test('End during pending AudioContext.resume prevents a delayed Start request', async () => {
  const f = await fixture(); let resume;
  f.audio.resume = () => new Promise(resolve => { resume = resolve; });
  const starting = f.nodes.get('start').listeners.click();
  await f.nodes.get('end').listeners.click(); resume(); await starting;
  assert.equal(f.messages.some(e => e.type === 'voice.open'), false); assert.equal(f.track.enabled, false); f.cleanup();
});

test('USB/Wi-Fi reconnection and stale session messages cannot reactivate the microphone', async () => {
  const f = await fixture(); await f.start(); const oldId = f.messages.find(e => e.type === 'voice.open').openId;
  f.receive({ type: 'peripheral.status', connected: false }); assert.equal(f.track.enabled, false);
  f.receive({ type: 'peripheral.status', connected: true }); assert.equal(f.track.enabled, false);
  await f.start(); const currentId = f.messages.filter(e => e.type === 'voice.open').at(-1).openId; assert.notEqual(currentId, oldId);
  f.receive({ type: 'voice.status', state: 'closed', openId: oldId }); assert.equal(f.track.enabled, true);
  f.receive({ type: 'voice.audio', openId: oldId, audio: Buffer.alloc(160, 255).toString('base64') }); assert.equal(f.played, 0); f.cleanup();
});

test('microphone loss and audio suspension end the session', async () => {
  const f = await fixture(); f.evaluate('watchMicrophone(mic);watchAudioContext();'); await f.start();
  f.track.listeners.mute(); await tick(); assert.equal(f.track.enabled, false); assert.equal(f.messages.at(-1).type, 'voice.close'); f.cleanup();
  f.track.listeners.unmute(); await f.start(); f.audio.state = 'suspended'; f.audio.listeners.statechange(); await tick();
  assert.equal(f.track.enabled, false); assert.equal(f.messages.at(-1).type, 'voice.close'); f.cleanup();
});

test('startup timeout and a closed USB read stream cannot leave the UI stuck starting', async () => {
  const f = await fixture(); let expire;
  f.sandbox.setTimeout = (fn, ms) => { if (ms === 25000) expire = fn; return 1; }; f.sandbox.clearTimeout = () => {};
  await f.nodes.get('start').listeners.click(); expire(); await tick();
  assert.match(f.nodes.get('status').textContent, /No startup confirmation/); assert.equal(f.messages.at(-1).type, 'voice.close');
  f.sandbox.readerFake = { read: async () => ({ done: true }), releaseLock() {} };
  await f.evaluate('reader=readerFake;intentionalDisconnect=false;readSerial()');
  assert.match(f.nodes.get('status').textContent, /USB reading stopped/); f.cleanup();
});

test('disconnect during a pending microphone permission prompt stops the late stream', async () => {
  const f = await fixture(); let allowMic, finishRead;
  const reader = { read: () => new Promise(resolve => { finishRead = resolve; }), cancel: async () => finishRead({ done: true }), releaseLock() {} };
  f.sandbox.navigator.serial.requestPort = async () => ({ open: async () => {}, setSignals: async () => {}, close: async () => {},
    writable: { getWriter: () => f.writer }, readable: { getReader: () => reader } });
  f.sandbox.navigator.mediaDevices = { getUserMedia: () => new Promise(resolve => { allowMic = resolve; }) };
  const connecting = f.nodes.get('connect').listeners.click(); await tick();
  await f.nodes.get('disconnect').listeners.click(); allowMic(f.stream); await connecting;
  assert.equal(f.track.stopped, true); assert.equal(f.messages.some(e => e.type === 'voice.open'), false); f.cleanup();
});

test('a stalled USB writer aborts capture and cannot leave a pending Start running forever', async () => {
  const f = await fixture(); let expireWrite, rejectWrite, aborts = 0;
  f.sandbox.setTimeout = (fn, ms) => { if (ms === 1500) expireWrite = fn; return 1; }; f.sandbox.clearTimeout = () => {};
  f.writer.write = () => new Promise((_, reject) => { rejectWrite = reject; });
  f.writer.abort = async () => { aborts++; rejectWrite(Error('aborted')); f.writer.write = async () => { throw Error('aborted'); }; };
  const starting = f.nodes.get('start').listeners.click(); await tick(); expireWrite(); await starting; await tick();
  assert.ok(aborts >= 1); assert.equal(f.track.enabled, false); assert.match(f.nodes.get('status').textContent, /USB writing stalled/);
});

test('USB connectivity alone cannot start a paid session before microphone setup completes', async () => {
  const f = await fixture(); f.evaluate('peripheralsReady=false;controls();');
  f.receive({ type: 'peripheral.status', connected: true });
  await f.nodes.get('start').listeners.click();
  assert.equal(f.nodes.get('start').disabled, true); assert.equal(f.messages.some(e => e.type === 'voice.open'), false);
});
