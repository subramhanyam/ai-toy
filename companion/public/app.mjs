import { decodeMuLaw, toBase64, fromBase64 } from './audio-codec.mjs';
const $ = id => document.getElementById(id);
let port, reader, writer, readTask, writeChain = Promise.resolve(), writes = 0;
let context, mic, worklet, source, gain, mute, usbConnected = false, backendConnected = false;
let phase = 'closed', sequence = 0, acknowledged = -1, nextPlay = 0, closing = false;
let elapsedTimer, startedAt = 0, latestSeconds = null, intentionalDisconnect = false;
let startupTimer;
let wantConversation = false, openId = null, attachmentEpoch = 0, attaching = false, peripheralsReady = false;
const sounds = new Set(), transcript = new Map();
const status = text => { $('status').textContent = text; };
function controls() {
  $('connect').hidden = !!port; $('disconnect').hidden = !port;
  $('start').disabled = !peripheralsReady || !usbConnected || !backendConnected || phase !== 'closed';
  $('end').disabled = !['starting', 'active', 'error'].includes(phase);
  $('start').hidden = phase !== 'closed'; $('end').hidden = phase === 'closed';
  $('orb').classList.toggle('active', phase === 'active');
  $('sessionState').textContent = ({ closed: 'Conversation off', starting: 'Starting...', active: 'Microphone live', ending: 'Ending...', error: 'Connection problem' })[phase];
}
function send(event) {
  if (!writer) return Promise.reject(Error('USB is disconnected.'));
  if (writes >= 32) return Promise.reject(Error('USB cannot keep up. End and restart the conversation.'));
  const target = writer; writes++;
  const result = writeChain.then(async () => {
    if (event.type === 'voice.audio' && (!wantConversation || event.openId !== openId)) return;
    if (event.type === 'voice.open' && (!wantConversation || event.openId !== openId)) return;
    let timer;
    try {
      await Promise.race([target.write(new TextEncoder().encode(JSON.stringify(event) + '\n')),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('USB writing stalled. Disconnect USB; the backend will end the session when input stops.')), 1500); })]);
    } catch (error) { void target.abort?.().catch(() => {}); throw error; }
    finally { clearTimeout(timer); }
  });
  writeChain = result.catch(() => {}).finally(() => { writes--; }); return result;
}
function stopCapture() {
  worklet?.port.postMessage({ type: 'stop' });
  mic?.getAudioTracks().forEach(track => { track.enabled = false; });
}
function silence() {
  for (const sound of sounds) { try { sound.stop(); } catch {} }
  sounds.clear(); nextPlay = 0;
}
function stopClock() { clearInterval(elapsedTimer); elapsedTimer = null; }
function watchMicrophone(stream) {
  for (const track of stream.getAudioTracks()) {
    for (const event of ['ended', 'mute']) track.addEventListener(event, () => { peripheralsReady = false; if (wantConversation) fail('Microphone became unavailable. The conversation is ending. Reconnect peripherals if needed.'); controls(); });
    track.addEventListener('unmute', () => { if (track.readyState !== 'ended' && worklet && context?.state !== 'closed') { peripheralsReady = true; controls(); } });
  }
}
function watchAudioContext() {
  context.addEventListener('statechange', () => { if (wantConversation && phase === 'active' && context.state !== 'running') fail('Audio processing stopped. The conversation is ending.'); });
}
function fail(message) {
  wantConversation = false;
  clearTimeout(startupTimer);
  stopCapture(); silence(); stopClock(); phase = 'error'; status(message); controls();
  if (writer) void send({ type: 'voice.close', openId }).catch(() => {});
}
function addText(event) {
  $('empty')?.remove(); const key = event.role + ':' + event.itemId;
  let body = transcript.get(key);
  if (!body) {
    const box = document.createElement('div'); box.className = 'utterance ' + event.role;
    const name = document.createElement('strong'); name.textContent = event.role === 'user' ? 'You' : 'Companion';
    body = document.createElement('span'); box.append(name, body); $('transcript').append(box); transcript.set(key, body);
  }
  body.textContent += event.delta; $('transcript').scrollTop = $('transcript').scrollHeight;
}
function receive(event) {
  if (event.type.startsWith('voice.') && event.openId && openId && event.openId !== openId) return;
  if (event.type === 'peripheral.status') {
    usbConnected = true; backendConnected = !!event.connected;
    $('connection').textContent = backendConnected ? 'ESP32 online / USB connected' : 'USB connected / ESP32 offline';
    if (!backendConnected) {
      wantConversation = false; clearTimeout(startupTimer);
      stopCapture(); silence(); stopClock(); phase = 'closed';
      status('ESP32 backend disconnected. Microphone is off. Wait for Wi-Fi before starting again.');
    } else if (phase === 'closed') status('Ready. Start a conversation when you want to talk.');
    controls(); return;
  }
  if (event.type === 'voice.status') {
    if ((event.state === 'active' || event.state === 'starting') && !wantConversation) {
      stopCapture(); silence();
      if (writer) void send({ type: 'voice.close', openId: event.openId }).catch(() => {});
      return;
    }
    const alreadyActive = phase === 'active' && event.state === 'active';
    phase = event.state;
    if (phase === 'closed' || phase === 'ending') wantConversation = false;
    if (phase !== 'starting') clearTimeout(startupTimer);
    if (phase === 'active' && !alreadyActive) {
      sequence = 0; acknowledged = -1; latestSeconds = null; startedAt = Date.now();
      mic?.getAudioTracks().forEach(track => { track.enabled = true; });
      worklet?.port.postMessage({ type: 'start' });
      stopClock(); elapsedTimer = setInterval(() => { $('duration').textContent = Math.floor((Date.now() - startedAt) / 1000) + ' s connected'; }, 1000);
    } else if (!alreadyActive) { stopCapture(); silence(); if (phase === 'closed') stopClock(); }
    if (event.maxSeconds && $('limit')) $('limit').textContent = `Auto-end limit: ${event.maxSeconds % 60 ? event.maxSeconds + ' seconds' : event.maxSeconds / 60 + ' minutes'} per conversation.`;
    status(event.message || (phase === 'closed' ? 'Conversation ended. Microphone is off.' : 'Starting conversation...')); controls(); return;
  }
  if (event.type === 'voice.usage') {
    if (Number.isFinite(event.seconds)) latestSeconds = event.seconds;
    $('duration').textContent = latestSeconds === null ? 'Final usage unavailable' : `${latestSeconds.toFixed(1)} s ${event.final ? 'billed voice duration' : 'voice usage so far'}`;
    if (event.final) status('Conversation ended. Microphone is off.'); return;
  }
  if (event.type === 'voice.error') { fail(event.message); return; }
  if (event.type === 'voice.ack') { acknowledged = Math.max(acknowledged, event.seq); return; }
  if (event.type === 'voice.clear') { silence(); return; }
  if (event.type === 'voice.transcript') { addText(event); return; }
  if (event.type !== 'voice.audio' || !context || phase !== 'active') return;
  // Capture stays active while the speaker plays: neither direction gates the other.
  const bytes = fromBase64(event.audio), buffer = context.createBuffer(1, bytes.length, 8000);
  const samples = buffer.getChannelData(0); for (let i = 0; i < bytes.length; i++) samples[i] = decodeMuLaw(bytes[i]);
  const sound = context.createBufferSource(); sound.buffer = buffer; sound.connect(gain);
  const start = Math.max(context.currentTime + 0.06, nextPlay); nextPlay = start + buffer.duration;
  if (nextPlay - context.currentTime > 1.5) { fail('Speaker playback fell behind. End and restart the conversation.'); return; }
  sounds.add(sound); sound.onended = () => sounds.delete(sound); sound.start(start);
}
async function readSerial() {
  const decoder = new TextDecoder(); let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      pending += decoder.decode(value, { stream: true }); let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        const start = line.lastIndexOf('@{'); if (start < 0) continue;
        try { receive(JSON.parse(line.slice(start + 1))); } catch { fail('Invalid USB frame. Reconnect the peripherals.'); }
      }
      if (pending.length > 8192) { pending = ''; fail('USB frame overflow. Reconnect the peripherals.'); }
    }
  } catch { if (!intentionalDisconnect) fail('USB disconnected. Microphone is off; the backend will close when it detects device loss.'); }
  finally {
    usbConnected = false; backendConnected = false; peripheralsReady = false; stopCapture(); silence(); stopClock(); reader?.releaseLock();
    if (!intentionalDisconnect) fail('USB reading stopped. Disconnect USB, refresh this page, then reconnect.');
    controls();
  }
}
async function endConversation() {
  wantConversation = false;
  if (phase === 'closed' || phase === 'ending') return;
  clearTimeout(startupTimer);
  stopCapture(); silence(); phase = 'ending'; status('Ending conversation and collecting final usage...'); controls();
  try { await send({ type: 'voice.close', openId }); }
  catch { phase = 'error'; stopClock(); status('Could not send End over USB. Final usage is unconfirmed; the backend will close on device disconnect.'); controls(); }
}
async function disconnect() {
  if (closing) return; closing = true; intentionalDisconnect = true;
  peripheralsReady = false;
  attachmentEpoch++;
  await endConversation();
  if (phase === 'ending') for (let i = 0; i < 160 && phase === 'ending'; i++) await new Promise(resolve => setTimeout(resolve, 100));
  stopCapture(); silence(); stopClock();
  mic?.getTracks().forEach(track => track.stop()); worklet?.disconnect(); source?.disconnect(); mute?.disconnect();
  if (context && context.state !== 'closed') await context.close(); context = null;
  if (reader) { try { await reader.cancel(); await readTask; } catch {} reader = null; }
  if (writer) { await writeChain; writer.releaseLock(); writer = null; }
  if (port) { try { await port.close(); } catch {} port = null; }
  usbConnected = false; backendConnected = false; phase = 'closed'; closing = false;
  $('connection').textContent = 'USB disconnected'; controls();
}
$('connect').addEventListener('click', async () => {
  if (attaching || closing || port) return;
  if (!navigator.serial || !navigator.mediaDevices) { status('Use desktop Chrome or Edge on localhost for USB and microphone access.'); return; }
  $('connect').disabled = true; intentionalDisconnect = false; attaching = true; peripheralsReady = false;
  const attachment = ++attachmentEpoch;
  try {
    context = new AudioContext(); await context.resume(); gain = context.createGain(); gain.gain.value = Number($('volume').value); gain.connect(context.destination);
    if (attachment !== attachmentEpoch) return;
    const selected = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x10c4, usbProductId: 0xea60 }] });
    if (attachment !== attachmentEpoch) return;
    port = selected;
    await port.open({ baudRate: 921600, bufferSize: 16384, flowControl: 'none' });
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    writer = port.writable.getWriter(); reader = port.readable.getReader(); readTask = readSerial();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (attachment !== attachmentEpoch) { stream.getTracks().forEach(track => track.stop()); return; }
    mic = stream;
    mic.getAudioTracks().forEach(track => { track.enabled = false; });
    watchMicrophone(mic); watchAudioContext();
    await context.audioWorklet.addModule('/capture-worklet.mjs');
    if (attachment !== attachmentEpoch) return;
    worklet = new AudioWorkletNode(context, 'usb-capture'); source = context.createMediaStreamSource(mic); mute = context.createGain(); mute.gain.value = 0;
    source.connect(worklet); worklet.connect(mute); mute.connect(context.destination);
    worklet.port.onmessage = ({ data }) => {
      if (data.type !== 'audio' || phase !== 'active' || !wantConversation) return;
      if (sequence - acknowledged > 100) { fail('Audio acknowledgements stopped. End and reconnect.'); return; }
      void send({ type: 'voice.audio', openId, seq: sequence++, audio: toBase64(data.bytes) }).catch(error => fail(error.message));
    };
    peripheralsReady = true;
    await send({ type: 'voice.close' }); await send({ type: 'peripheral.hello' }); controls();
  } catch (error) { if (attachment === attachmentEpoch) { await disconnect(); status('Could not connect: ' + error.message); } }
  finally { attaching = false; $('connect').disabled = false; }
});
$('disconnect').addEventListener('click', () => void disconnect());
$('start').addEventListener('click', async () => {
  if (phase !== 'closed' || !backendConnected || !peripheralsReady) return;
  wantConversation = true; openId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  phase = 'starting'; status('Preparing microphone...'); controls();
  try {
    await context.resume();
    if (!wantConversation || phase !== 'starting') return;
    status('Sending Start to ESP32...');
    startupTimer = setTimeout(() => { if (phase === 'starting') fail('No startup confirmation received. Disconnect USB, refresh, and reconnect. Check the local debug dashboard for the backend stage.'); }, 25000);
    await send({ type: 'voice.open', openId });
  }
  catch (error) { fail(error.message); }
});
$('end').addEventListener('click', () => void endConversation());
$('volume').addEventListener('input', () => { if (gain) gain.gain.value = Number($('volume').value); });
$('clear').addEventListener('click', () => { transcript.clear(); $('transcript').replaceChildren(); });
function leavePage() {
  if (attaching) { attachmentEpoch++; peripheralsReady = false; }
  wantConversation = false; clearTimeout(startupTimer); stopCapture(); silence(); stopClock();
  if (phase !== 'closed') phase = 'ending';
  if (writer) void send({ type: 'voice.close', openId }).catch(() => {});
  controls();
}
window.addEventListener('pagehide', leavePage);
document.addEventListener?.('freeze', leavePage);
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  leavePage(); phase = 'closed'; status('Page restored. Microphone is off; start a new conversation to continue.'); controls();
});
navigator.serial?.addEventListener('disconnect', () => void disconnect());
controls();
