# USB companion (local development)

This app supplies the ESP32's temporary microphone, speaker and display over
USB serial. It does not connect to the backend or OpenAI. Its localhost server
serves static files, and CSP blocks browser network connections.

## Start and End a conversation

1. Keep the ESP32 connected by USB and on the home Wi-Fi.
2. Start the local backend with `npm start` from the repository root. It loads
   `backend/.env` without printing the key. Start the USB UI with
   `npm run companion` in another terminal.
3. The board is configured for `http://192.168.0.22:3000`. If needed, configure
   it with `scripts/provision-device.ps1 -BackendUrl http://192.168.0.22:3000`.
4. Open **http://localhost:4173** in desktop Chrome or Edge. Choose
   **Connect USB & microphone**, select the CP210x board and allow the mic.
   This connects peripherals; the microphone track stays disabled.
5. Click **Start conversation**. Capture begins only after `session.started`.
   Speak naturally; microphone input continues while assistant audio plays.
6. Click **End conversation**. Capture and playback stop immediately. The
   backend sends `session.close`, waits for `session.closed`, and displays
   the final API-reported voice duration. Silence during an active session
   is billable. Agents SDK backend token usage is billed separately.

The debug dashboard is **http://localhost:3000**. It receives status, captions,
backend agent output and tool arguments/results, but no audio. Headphones help
prevent speaker echo entering the microphone. Browser permission and audible
speaker checks require a hands-on test; browser automation is unavailable in
this workspace.

Wake-word detection is not implemented. Refreshing/reconnecting starts a new
conversation. A missing continuous microphone stream automatically ends Live
after three seconds, so closing the USB app cannot leave a billable session
running indefinitely. Final duration is marked unconfirmed if finalization
fails or the upstream socket closes without `session.closed`.

This iteration is **local only**. Do not commit, push or deploy without explicit
user instruction. Existing staged changes from the user's soft reset are kept.

## Session cleanup and cost safeguards

- Refresh, tab closure and page freeze stop capture immediately and attempt USB
  End. Restoring a page from the back/forward cache never resumes a session.
- If the End message is lost, three seconds without microphone audio frames
  triggers server-side closure. Ordinary silence still sends frames and is
  billable; this is a connection watchdog, not silence detection.
- Microphone loss, audio-context suspension, USB read/write failure and missing
  audio frames stop capture and request End. Start stays disabled until the
  microphone and USB setup is complete.
- A late startup message after End cannot restart capture. Request IDs isolate
  old messages; repeated Start for the same request is idempotent.
- Device replacement on the same local backend waits for the old upstream
  session to close before opening another. No automatic Live reconnect occurs.
- End during startup waits for an already-submitted startup request to settle,
  then sends `session.close`; it never enables the mic in between.
- End waits for `session.closed` and final cumulative usage. After 15 seconds
  without confirmation, the upstream transport is forcibly released and usage
  is recorded as unconfirmed rather than zero.
- A five-minute auto-end request is a backstop even with a healthy mic stream.
  `VOICE_MAX_SECONDS` in `backend/.env` configures 10 to 3600 seconds; restart
  the backend after changing it. Future cloud mode limits this to four minutes
  because Vercel can recycle its five-minute device socket sooner.
- Graceful server shutdown waits for upstream closure before exiting and
  aborts pending delegated work. End cannot undo an LED command already sent.

Local audit events are saved to ignored `.tools/voice-sessions.jsonl`, without
keys, recordings or transcripts. Start records preserve evidence across a
crash; close records distinguish confirmed closure from final usage. Run:

```powershell
npm --prefix backend run voice:report
```

The report sums only confirmed final voice usage once per session. It flags
unfinished or unconfirmed sessions and incomplete log lines. Backend model
charges are separate. On restart, unmatched sessions trigger a warning.

A hard process kill, laptop power loss/sleep or complete network outage can
prevent any local cleanup code from running. Exact provider closure/billing
cannot be guaranteed in those cases; the audit marks missing confirmation for
review. Prefer End, wait for final usage, then stop or restart servers. Do not
interpret an interrupted connection as proof of zero additional charges.

## Architecture

Laptop mic/speaker/display <-> USB <-> ESP32 <-> local backend <-> GPT-Live

The backend uses the official OpenAI `LiveWS` client with `gpt-live-1` and
client delegation. It collects independently timed user/assistant captions.
`session.delegation.created` contains metadata, not task text; the backend
builds context from those captions and runs the existing Agents SDK agent.
That agent executes LED tools through ESP32 acknowledgements, then returns a
verified summary to Live using `session.commentary.append` with the matching
delegation ID. The voice model communicates that result naturally.

Audio uses G.711 mu-law, 8 kHz mono (`audio/pcmu`, explicit rate 8000). This
keeps USB/Wi-Fi bandwidth manageable, at telephone audio quality. Output is
paced by elapsed audio time, compensating for Windows timer granularity.
There are no input commits, manual response triggers, or separate STT calls.
Both caption streams come from Live. The key stays on the backend; session
recording storage is disabled.

## USB protocol

921600 baud, 8N1, no hardware flow control. Outgoing app commands are newline
JSON, at most 511 bytes. Device-to-app machine frames start with `@` before
JSON and a newline; diagnostic and ROM boot lines are ignored.

- `peripheral.hello`: query USB/backend connectivity.
- `voice.open`: Start. Opens a new Live session and awaits `session.started`.
- `voice.audio`: 160 bytes of base64 PCMU (20 ms), with sequential `seq`.
  Stream continuously, including silence, while active.
- `voice.ack`: backend acknowledgement of each input frame.
- `voice.close`: End. Stop input; finalize the upstream session.
- Returned `voice.audio`: ordered output with stream ID, sequence and end time.
- `voice.transcript`: independent user/assistant deltas and grouping IDs.
- `voice.status`, `voice.clear`, `voice.error`: lifecycle and playback controls.
- `voice.usage`: cumulative seconds; use the latest value, never sum updates.
  `final: true` means the API supplied final usage on `session.closed`.

Queues are bounded. Missing frames or overflow end the conversation instead
of silently dropping speech. No audio recordings are stored by the app.

## Verified locally

Automated checks cover codec/resampling, USB-only app isolation, Start/End
microphone gating, concurrent input/output, timed caption grouping, delayed
timer catch-up, lost-microphone session cleanup, final usage, session restarts,
delegation deduplication, and the real Agents SDK/tool acknowledgement loop.

A synthesized LED request and a spoken interjection were streamed through the
physical ESP32 to a local backend. The board confirmed the LED tool; user and
assistant captions, returned audio during continuous input, and final usage
after End were verified. The debug monitor received no audio and restored the
original LED settings. This does not exercise the browser's actual microphone
or audible speaker output.

## Model access checked on 2026-11-15

The authenticated models list included `gpt-live-1` and `gpt-live-transcribe`.
A `gpt-live-1` session started and closed successfully. Session probes for
`gpt-live-1.1`, `gpt-live-1-mini`, and `gpt-live-1.1-quip` returned `invalid_model`
for this project. ChatGPT releases do not establish API access. The default
is the confirmed `gpt-live-1`; `OPENAI_LIVE_MODEL` can explicitly override it.

Official references:

- [GPT-Live guide](https://developers.openai.com/api/docs/guides/live)
- [WebSocket startup/audio](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)
- [Client delegation](https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client)
- [Captions, lifecycle and graceful close](https://developers.openai.com/api/docs/guides/live-conversations)
- [GPT-Live-1.1 ChatGPT release](https://deploymentsafety.openai.com/gpt-live-1-1/alignment)
