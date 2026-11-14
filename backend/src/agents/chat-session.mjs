import { streamAssistant } from './assistant.mjs';

export function createChatSession({ config, relay, emit, run = streamAssistant }) {
  let history = [], active = null, turns = 0;
  return {
    handle(event) {
      if (event.type === 'chat.cancel') { active?.controller.abort(); return; }
      if (event.type === 'chat.reset') {
        if (active) return emit({ type: 'chat.rejected', message: 'Stop the current response first.' });
        history = []; turns = 0; emit({ type: 'chat.reset' }); return;
      }
      if (event.type !== 'chat.send') return;
      if (active) return emit({ type: 'chat.rejected', message: 'A response is already running.' });
      if (typeof event.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(event.id) || typeof event.message !== 'string' || !event.message.trim() || event.message.length > 4000)
        return emit({ type: 'chat.rejected', message: 'Enter a message of 1 to 4000 characters.' });
      if (turns >= 30 || JSON.stringify(history).length > 120000)
        return emit({ type: 'chat.rejected', message: 'Conversation limit reached. Start a new chat.' });
      const turn = { id: event.id, controller: new AbortController() }; active = turn;
      const push = value => emit({ ...value, id: turn.id });
      push({ type: 'chat.started', message: event.message.trim() });
      const timer = setTimeout(() => turn.controller.abort(), 120000);
      Promise.resolve().then(() => run({ config, relay, history, message: event.message.trim(), emit: push, signal: turn.controller.signal }))
        .then(next => { if (!turn.controller.signal.aborted) { history = next; turns++; } })
        .catch(error => {
          if (!turn.controller.signal.aborted) push({ type: 'chat.error', message: /OPENAI_API_KEY/.test(error.message) ? 'Set OPENAI_API_KEY on the backend to enable chat.' : 'The response failed. Check the backend API key, model access, quota and network.' });
        })
        .finally(() => {
          clearTimeout(timer); active = null;
          push({ type: 'chat.done', stopped: turn.controller.signal.aborted });
        });
    },
    close() { active?.controller.abort(); history = []; },
  };
}
