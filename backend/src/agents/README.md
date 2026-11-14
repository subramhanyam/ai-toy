# Agent definitions

`assistant.mjs` defines the ESP32 companion and streams text from the OpenAI
Agents SDK. `chat-session.mjs` owns one client's history, limits,
cancellation and turn lifecycle. Each browser has an independent conversation;
the ESP32 has its own conversation initiated by tap input. Device conversation
events pass through the relay to all connected browser monitors.

Use `@openai/agents` from these backend modules. Keep `OPENAI_API_KEY` in the
server environment, never in the browser dashboard or ESP32 firmware.

SDK tracing is disabled for this prototype; the debug UI shows tool calls and
results directly. Runs are limited to six model turns, 1,200 output tokens per
model call and two minutes. A conversation allows 30 successful turns and a
120 KB history budget before requiring a new chat. History is not persisted
across reconnects. Failed or cancelled turns are not added to history.

Reference: [Running agents](https://developers.openai.com/api/docs/guides/agents/running-agents).
