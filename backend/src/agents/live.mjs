import OpenAI from 'openai';
import { LiveWS } from 'openai/resources/live/ws';
import { streamAssistant } from './assistant.mjs';

export function liveConfiguration(config) {
  return {
    model: config.liveModel || 'gpt-live-1', store: false,
    instructions: 'You are a friendly ESP32 voice companion. Listen naturally, including while speaking. Keep replies brief. Delegate every hardware question or change to the backend. You cannot observe or control the LED yourself. Wait for the backend result before claiming a change succeeded, and clearly describe unconfirmed results. Use the backend for reasoning and other tasks when needed.',
    audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } },
    delegation: { type: 'client' },
  };
}
export function makeLiveConnection() { return new LiveWS(new OpenAI(), { reconnect: false }); }

export function createVoiceSession({ config, relay, send, monitor, makeConnection = makeLiveConnection, runAgent = streamAssistant,
  inputTimeoutMs = 3000, startupTimeoutMs = 20000, closeTimeoutMs = 15000,
  maxDurationMs = Math.min(config.voiceMaxSeconds || 300, config.cloud ? 240 : Infinity) * 1000,
  beforeOpen, audit = () => {} }) {
  let connection = null, state = 'closed', epoch = 0, sessionId = '', inputSeq = 0, outputSeq = 0;
  let startupTimer, closeTimer, durationTimer, sessionController, disposed = false;
  let output = [], queuedBytes = 0, audioMs = 0, seconds = null, history = [], tasks = [], taskRunning = false;
  let nextAudioAt = null;
  let lastInputAt = 0;
  let stage = 'closed';
  let startSent = false, closeSent = false, closeReason = '', openId = null, requestedAt = null, activeAt = null;
  let closedPromise = Promise.resolve(null), resolveClosed;
  let captionCounter = 0, captions = [], captionState = {}, completedTasks = 0;
  const seenDelegations = new Set();
  const notify = event => { try { monitor(event); } catch {} };
  let sendFailed = false;
  const safeSend = (event, replyId = openId) => {
    if (disposed) return;
    try { if (send({ ...event, openId: replyId }) !== false) return; } catch {}
    if (!sendFailed) { sendFailed = true; queueMicrotask(() => end('device_send_failed')); }
  };
  function status(next, message = '') {
    state = next;
    safeSend({ type: 'voice.status', state: next, message, model: config.liveModel || 'gpt-live-1', maxSeconds: maxDurationMs / 1000 });
    notify({ type: 'voice.status', state: next, message });
  }
  function clearAudio() { output = []; queuedBytes = 0; nextAudioAt = null; safeSend({ type: 'voice.clear' }); }
  function finalized(final, reason = '', closureConfirmed = final) {
    if (state === 'closed') return;
    const complete = resolveClosed; resolveClosed = null;
    clearTimeout(startupTimer); clearTimeout(closeTimer); clearTimeout(durationTimer);
    sessionController?.abort(); tasks = [];
    const old = connection; connection = null; epoch++;
    try { if (!final && old?.socket?.platformSocket?.terminate) old.socket.platformSocket.terminate(); else old?.close(); } catch {}
    clearAudio();
    stage = 'closed';
    status('closed', closureConfirmed ? (final ? 'Conversation ended.' : 'Conversation ended; final billed duration is unavailable.') : 'Connection ended; final billed duration could not be confirmed.');
    const usage = { type: 'voice.usage', seconds, final, reason };
    safeSend(usage); notify(usage);
    const record = { event: 'closed', openId, sessionId: sessionId || null, model: config.liveModel || 'gpt-live-1', requestedAt, activeAt,
      endedAt: new Date().toISOString(), closeReason: closeReason || 'remote', apiReason: reason, seconds, finalized: closureConfirmed, usageFinal: final, startSent };
    try { audit(record); } catch { notify({ type: 'voice.audit_error', message: 'Session ended, but its local audit record could not be saved.' }); }
    complete?.(record);
  }
  function requestRemoteClose() {
    if (closeSent || !connection) return;
    closeSent = true;
    try { connection.send({ type: 'session.close' }); } catch { finalized(false, 'transport_closed'); }
  }
  function end(reason = 'user') {
    if (state === 'closed' || state === 'ending') return closedPromise;
    closeReason = reason;
    clearTimeout(startupTimer); clearTimeout(durationTimer);
    sessionController?.abort(); tasks = []; clearAudio(); stage = 'ending'; status('ending', 'Ending conversation...');
    if (!connection || !startSent) { finalized(false, 'cancelled_before_session_start'); return closedPromise; }
    const current = epoch;
    // Keep the listener/socket alive until session.closed provides final usage.
    closeTimer = setTimeout(() => { if (current === epoch) finalized(false, 'finalization_timeout'); }, closeTimeoutMs);
    // A pending close must keep Node alive long enough to collect final usage.
    if (activeAt) requestRemoteClose(); // Otherwise wait for session.started.
    return closedPromise;
  }
  function fail(message) {
    safeSend({ type: 'voice.error', message }); notify({ type: 'voice.error', message }); end('error');
  }
  function acknowledgePreviousClose(replyId) {
    void closedPromise.then(() => {
      if (!disposed && state === 'closed') safeSend({ type: 'voice.status', state: 'closed', message: 'The previous conversation has ended. Click Start for a new conversation.' }, replyId);
    });
  }
  function appendCaption(role, event) {
    const previous = captionState[role];
    let entry = previous;
    if (!entry || event.start_ms - entry.end > 1200 || event.end_ms < entry.start || entry.text.length + event.delta.length > 4000) {
      entry = { role, id: `${sessionId}-${role}-${++captionCounter}`, text: '', start: event.start_ms, end: event.end_ms };
      captions.push(entry); captionState[role] = entry;
    }
    entry.text += event.delta; entry.end = Math.max(entry.end, event.end_ms);
    while (captions.length > 100 || captions.reduce((n, item) => n + item.text.length, 0) > 20000) captions.shift();
    for (let n = 0; n < event.delta.length; n += 120) safeSend({ type: 'voice.transcript', role, itemId: entry.id, delta: event.delta.slice(n, n + 120), startMs: event.start_ms, endMs: event.end_ms });
    notify({ type: 'voice.transcript', role, itemId: entry.id, delta: event.delta, startMs: event.start_ms, endMs: event.end_ms });
  }
  async function drainTasks(current) {
    if (taskRunning || current !== epoch || state !== 'active') return;
    taskRunning = true;
    try {
      while (tasks.length && current === epoch && state === 'active') {
        const delegation = tasks.shift(), id = delegation.id;
        // Transcript fragments may arrive just after delegation metadata. It has
        // no task text, so give those fragments a short opportunity to arrive.
        await new Promise(resolve => setTimeout(resolve, 150));
        if (current !== epoch || state !== 'active') break;
        const context = captions.slice().sort((a, b) => a.start - b.start).map(e => `${e.role}: ${e.text}`).join('\n');
        const message = 'Handle only the latest user request below. Earlier completed actions and backend results are context; do not repeat them. If the current transcript is incomplete or ambiguous, ask a short clarification instead of changing hardware.\nLive conversation:\n' + context;
        notify({ type: 'chat.started', id, message: 'Live delegation to backend agent' });
        const taskController = new AbortController();
        const taskSignal = sessionController.signal;
        const abort = () => taskController.abort(); taskSignal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, 45000); let text = '';
        try {
          const nextHistory = await runAgent({ config, relay, history, message, signal: taskController.signal, emit: e => {
            if (e.type === 'chat.delta') text += e.delta;
            if (current === epoch && state === 'active') notify({ ...e, id });
          } });
          if (current !== epoch || state !== 'active') break;
          history = nextHistory;
          // Commentary is limited to 500 tokens. A <=384-byte UTF-8 prefix
          // stays below that bound even for text with inefficient tokenization.
          let content = '';
          for (const char of (text.trim() || 'The backend completed without a spoken result; do not claim an unverified hardware change.')) {
            if (Buffer.byteLength(content + char) > 384) break; content += char;
          }
          connection.send({ type: 'session.commentary.append', delegation_id: id, content });
          notify({ type: 'chat.done', id, stopped: false }); completedTasks++;
          if (completedTasks >= 30 || JSON.stringify(history).length > 120000) end('history_limit');
        } catch {
          if (current === epoch && state === 'active') {
            connection.send({ type: 'session.commentary.append', delegation_id: id, content: 'The backend could not finish or confirm this task. Explain that the action is unconfirmed; do not retry it automatically.' });
            notify({ type: 'chat.error', id, message: 'Delegated task failed or timed out.' });
            notify({ type: 'chat.done', id, stopped: true });
          }
        } finally { clearTimeout(timer); taskSignal.removeEventListener('abort', abort); }
      }
    } finally { if (current === epoch) taskRunning = false; }
  }
  function eventHandler(event, current) {
    if (current !== epoch) return;
    if (event.type === 'session.started') {
      clearTimeout(startupTimer); sessionId = event.session.id;
      activeAt = new Date().toISOString();
      try { audit({ event: 'started', openId, sessionId, model: config.liveModel || 'gpt-live-1', requestedAt, activeAt }); }
      catch { fail('The session audit could not be saved. Conversation is ending.'); return; }
      if (state === 'ending') { requestRemoteClose(); return; }
      stage = 'active';
      lastInputAt = performance.now();
      status('active', 'Conversation active. You can speak while the assistant speaks.');
      durationTimer = setTimeout(() => end('duration_limit'), maxDurationMs);
      durationTimer.unref();
    } else if (event.type === 'session.closed') {
      const validFinalUsage = Number.isFinite(event.usage?.seconds) && event.usage.seconds >= 0;
      if (validFinalUsage) seconds = event.usage.seconds;
      finalized(validFinalUsage, event.reason || 'closed', true);
    } else if (event.type === 'session.usage.updated') {
      if (Number.isFinite(event.usage?.seconds)) seconds = event.usage.seconds;
      safeSend({ type: 'voice.usage', seconds, final: false }); notify({ type: 'voice.usage', seconds, final: false });
    } else if (state !== 'active') return;
    else if (event.type === 'session.output_audio.delta') {
      const bytes = Buffer.from(event.delta, 'base64');
      if (queuedBytes + bytes.length > 16000) { fail('Speaker audio fell behind. End and restart the conversation.'); return; }
      output.push({ bytes, offset: 0 }); queuedBytes += bytes.length;
    } else if (event.type === 'session.input_transcript.delta') appendCaption('user', event);
    else if (event.type === 'session.output_transcript.delta') appendCaption('assistant', event);
    else if (event.type === 'session.delegation.created' && event.delegation.target === 'client') {
      const id = event.delegation.id;
      if (seenDelegations.has(id)) return;
      if (seenDelegations.size >= 100 || tasks.length >= 4) { fail('Too many pending tasks. End and start a new conversation.'); return; }
      seenDelegations.add(id); tasks.push({ id, offset: event.offset_ms });
      void drainTasks(current).catch(() => fail('Backend delegation failed.'));
    }
  }
  function connect(current) {
    if (disposed || current !== epoch || state !== 'starting') return;
    try {
      stage = 'opening_socket'; status('starting', 'Backend received Start. Connecting to GPT-Live...');
      connection = makeConnection(); const socket = connection;
      socket.on('event', e => { if (current !== epoch) return; if (e.type === 'error') fail('Live API error: ' + (e.error?.code || 'unknown_error')); else eventHandler(e, current); });
      socket.on('error', () => { if (current === epoch && state !== 'ending') fail('Live connection failed. End and try again.'); });
      socket.socket.on('open', () => {
        if (current !== epoch || state !== 'starting') return;
        stage = 'waiting_session_started'; status('starting', 'GPT-Live connected. Waiting for conversation startup...');
        startSent = true;
        try { socket.send({ type: 'session.start', session: liveConfiguration(config) }); }
        catch { finalized(false, 'startup_send_failed'); }
      });
      socket.socket.on('close', () => { if (current === epoch && state !== 'closed') finalized(false, 'transport_closed'); });
    } catch { fail('Could not open the Live connection.'); }
  }
  const pump = setInterval(() => {
    if (state !== 'active') return;
    if (performance.now() - lastInputAt > inputTimeoutMs) { fail('Microphone stream stopped. Conversation is ending.'); return; }
    if (!output.length) return;
    const now = performance.now();
    if (nextAudioAt === null || now - nextAudioAt > 500) nextAudioAt = now;
    // Windows may round a 20ms timer to ~31ms. Drain by the audio clock, not
    // one frame per callback, or continuous full-duplex playback drifts behind.
    for (let n = 0; n < 8 && output.length && nextAudioAt <= now; n++) {
      const front = output[0], bytes = front.bytes.subarray(front.offset, front.offset + 160);
      audioMs += bytes.length / 8; nextAudioAt += bytes.length / 8;
      safeSend({ type: 'voice.audio', audio: bytes.toString('base64'), itemId: sessionId, responseId: sessionId, seq: outputSeq++, endMs: audioMs });
      front.offset += bytes.length; queuedBytes -= bytes.length;
      if (front.offset === front.bytes.length) output.shift();
    }
  }, 20);
  pump.unref();
  return {
    handle(event) {
      if (disposed) return;
      try {
        if (event.type === 'voice.close') {
          if (event.openId && openId && event.openId !== openId) return;
          if (state === 'closed') status('closed'); else end(); return;
        }
        if (event.type === 'voice.open') {
          if (event.openId !== undefined && (typeof event.openId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(event.openId))) return;
          if (event.openId && event.openId === openId && (state === 'active' || state === 'starting')) { status(state, 'Conversation request already received.'); return; }
          if (event.openId && event.openId !== openId && state !== 'closed') {
            safeSend({ type: 'voice.status', state: 'ending', message: 'Closing the previous conversation. Start again after it ends.' }, event.openId);
            end('new_client_request'); acknowledgePreviousClose(event.openId); return;
          }
          if (state === 'active') { safeSend({ type: 'voice.error', message: 'A conversation is already active. End it before starting again.' }); return; }
          if (state === 'starting') { status('starting', 'Backend received Start. Still waiting for GPT-Live startup.'); return; }
          if (state === 'ending') { status('ending', 'The previous conversation is still ending. Please wait.'); return; }
          if (!process.env.OPENAI_API_KEY) { safeSend({ type: 'voice.error', message: 'OPENAI_API_KEY is not configured on the backend.' }, event.openId || null); return; }
          openId = event.openId || null; sessionId = ''; startSent = false; closeSent = false; closeReason = ''; sendFailed = false;
          requestedAt = new Date().toISOString(); activeAt = null;
          closedPromise = new Promise(resolve => { resolveClosed = resolve; });
          output = []; queuedBytes = 0; inputSeq = 0; outputSeq = 0; audioMs = 0; seconds = null;
          nextAudioAt = null;
          captions = []; captionState = {}; captionCounter = 0; history = []; tasks = []; completedTasks = 0; taskRunning = false; seenDelegations.clear();
          sessionController = new AbortController(); const current = ++epoch;
          stage = beforeOpen ? 'waiting_previous_close' : 'opening_socket'; status('starting', 'Preparing conversation...');
          startupTimer = setTimeout(() => { if (current === epoch && state === 'starting') fail('Live session startup timed out.'); }, startupTimeoutMs);
          startupTimer.unref();
          if (beforeOpen) Promise.resolve().then(beforeOpen).then(() => connect(current)).catch(() => { if (current === epoch) fail('The previous voice session could not be closed.'); });
          else connect(current);
          return;
        }
        if (event.type === 'voice.audio') {
          if (event.openId && openId && event.openId !== openId) return;
          if (state === 'ending' || state === 'closed') return;
          if (state !== 'active' || event.seq !== inputSeq || typeof event.audio !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.audio) || Buffer.from(event.audio, 'base64').length !== 160) throw Error('Invalid or missing audio frame. End and restart the conversation.');
          inputSeq++;
          lastInputAt = performance.now();
          connection.send({ type: 'session.input_audio.append', audio: event.audio });
          safeSend({ type: 'voice.ack', seq: event.seq }); return;
        }
        throw Error('Unsupported voice command. Use Start conversation and End conversation.');
      } catch { fail('Voice transport or audio failed. End and restart the conversation.'); }
    },
    snapshot() { return { type: 'voice.diagnostic', state, stage, openId, inputFrames: inputSeq, queuedAudioMs: queuedBytes / 8 }; },
    shutdown(reason = 'server_shutdown') { return end(reason); },
    close() { disposed = true; clearInterval(pump); return end('device_disconnected'); },
  };
}
