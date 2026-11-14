import { randomUUID } from 'node:crypto';
import { tool } from '@openai/agents';
import { z } from 'zod';

// Subscribe before publishing: an acknowledgement can arrive immediately locally.
export function requestDevice(relay, command, signal, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let timer, settled = false;
    const cleanup = () => { clearTimeout(timer); relay.off('event', event); relay.off('unavailable', unavailable); signal?.removeEventListener('abort', abort); };
    const finish = (error, state) => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(state); };
    const event = state => {
      if (state.type === 'offline') return finish(Error('ESP32 disconnected; command is unconfirmed.'));
      if (state.type === 'state' && (command.type === 'get_state' || state.id === command.id)) finish(null, state);
    };
    const unavailable = () => finish(Error('Device relay unavailable; command is unconfirmed.'));
    const abort = () => finish(Error('Request stopped; an already sent command may still execute.'));
    relay.on('event', event); relay.on('unavailable', unavailable);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(Error('No ESP32 acknowledgement within 5 seconds; command is unconfirmed.')), timeout);
    if (signal?.aborted) return abort();
    Promise.resolve().then(() => { if (settled) return; signal?.throwIfAborted(); return relay.control(command); }).catch(error => finish(error));
  });
}

export function createLedTools(relay, emit, signal) {
  function visible(name, description, parameters, execute) {
    return tool({ name, description, parameters, async execute(args) {
      signal?.throwIfAborted();
      const callId = randomUUID();
      emit({ type: 'chat.tool_call', callId, name, arguments: args });
      let result;
      try { result = { ok: true, ...await execute(args) }; }
      catch (error) { result = { ok: false, error: error.message }; }
      emit({ type: 'chat.tool_result', callId, name, result });
      return JSON.stringify(result);
    } });
  }
  return [
    visible('get_led_state', 'Read the actual onboard LED settings from the ESP32.', z.object({}),
      () => requestDevice(relay, { type: 'get_state' }, signal)),
    visible('set_led', 'Enable or disable blinking and change the LED interval. Null preserves the current setting. Off forces LED low. Interval is milliseconds per on/off half-cycle, 50 to 2000.',
      z.object({ enabled: z.boolean().nullable(), interval: z.number().int().min(50).max(2000).nullable() }),
      async args => {
        const current = args.enabled === null || args.interval === null
          ? await requestDevice(relay, { type: 'get_state' }, signal) : null;
        const command = { type: 'command', id: randomUUID(), enabled: args.enabled ?? current.enabled, interval: args.interval ?? current.interval };
        const state = await requestDevice(relay, command, signal);
        if (state.enabled !== command.enabled || state.interval !== command.interval) throw Error('ESP32 reported different settings; requested change is unconfirmed.');
        return state;
      }),
  ];
}
