# WebSocket LED control

One ESP32, a Node.js backend, and an optional browser dashboard for debugging.
Commands and acknowledgements travel over persistent WebSockets. There are no
periodic HTTP requests for LED state. Socket ping/pong messages detect dead
connections; they do not poll for commands.

## Production deployment

- Dashboard: **https://ai-toy-eight.vercel.app**
- Repository: https://github.com/subramhanyam/ai-toy
- Vercel project: `subramhanyam/ai-toy`, root directory `backend`.
- The ESP32 is configured to connect to production over verified WSS.
- The free Upstash relay is connected, with automatic plan upgrades disabled.

The dashboard password is saved only in the ignored local secrets file. Copy
it from the original laptop without printing it:

```powershell
(Get-Content .tools\server-secrets.json -Raw | ConvertFrom-Json).dashboardPassword | Set-Clipboard
```

Production was deployed with Vercel CLI. GitHub automatic deployment linking
has not completed: Vercel could not connect its Git integration to this repository.
CLI deployments work independently; run `vercel deploy --prod --yes --regions bom1`
from the repository root after pushing changes.

## Project files

- `firmware/esp32-led/`: ESP32 sketch and TLS trust bundle.
- `scripts/provision-device.ps1`: USB configuration for the backend URL and token.
- `backend/lib/`: WebSocket routing, authentication and optional cloud relay.
- `backend/public/index.html`: responsive switch/slider debug UI.
- `backend/api/ws.js`: Vercel HTTP/WebSocket server entry point.
- `backend/server.mjs`: local server using the same backend.
- `backend/test/`: automated socket tests and hardware validation.

Firmware and tests belong in Git for this project. Vercel deploys only the
`backend` directory. Set Vercel's Root Directory to **`backend`**. Secrets,
dependency installs and generated builds are ignored.

## Run locally

Requires Node.js 22.x:

```powershell
# From the repository root:
npm run setup
npm start
```

Open the Wi-Fi URL printed by the server, currently `http://192.168.0.22:3000/`,
on your iPad. The ESP32 initiates its own connection to `/api/ws?role=device`.
The browser connects to `/api/ws?role=browser`. GPIO 2 drives the onboard LED.

Locally, both connections use the same server, and Redis is unnecessary.
The device token and signing secret are generated once into the ignored
`.tools/server-secrets.json`. Device authentication is always required. Set
`DASHBOARD_PASSWORD` to enable dashboard login locally. The server reads normal
environment variables; to use a local `.env` file, run
`node --env-file=.env server.mjs` from `backend`.

## Firmware

Arduino board: `esp32:esp32:esp32`; libraries: **WebSockets 2.7.2** and
**ArduinoJson 7.4.3**. `ca_bundle.h` contains a Mozilla trust bundle generated
with Espressif's certificate-bundle tool, used for verified WSS connections.
The existing Wi-Fi credentials, backend URL and device token are retained in NVS.

Compile `firmware/esp32-led` and write its application at `0x10000` with esptool
`--chip esp32 --port COM3 --baud 460800 --no-stub write-flash` using the existing
partition layout. No board reset or reflash is needed merely to change the URL:

```powershell
# From the repository root, with the board attached by USB:
.\scripts\provision-device.ps1 -BackendUrl 'http://192.168.0.22:3000'
```

USB serial is 115200 baud. `STATUS` shows connection and LED settings.
`BACKEND<TAB>https-url<TAB>device-token` saves backend settings and restarts.
`WIFI<TAB>ssid<TAB>password` saves Wi-Fi settings and restarts. Plain HTTP/WS
is restricted to private LAN configuration; internet connections use verified
TLS and NTP time synchronization. Credentials never appear in the browser UI.

## Protocol and behavior

Browser -> backend -> ESP32:

```json
{"type":"command","id":"unique-command-id","enabled":true,"interval":100}
```

The board applies GPIO settings in its main loop, then pushes a `state` event
with the same ID, enabled state, interval, IP, uptime and signal strength.
The browser shows confirmation latency only after that acknowledgement arrives.
Intervals must be integer milliseconds from 50 to 2000. The switch disables
blinking and forces the LED low when off.

On connection, `get_state` requests the board's actual settings. Settings live
on the board and are saved two seconds after a change. On reconnection the board
reports its current state; the server does not overwrite it with defaults.
Unacknowledged commands are not replayed or queued across disconnects. A timeout
is shown as unconfirmed. The next connection reloads actual state.

Network work runs in a separate FreeRTOS task so TLS/network delays do not stop
the blink loop. Both endpoints reconnect automatically. A powered-off board is
detected by socket closure or heartbeat timeout, not by periodic HTTP polling.

## Deploy to Vercel

1. Import the Git repository. Set **Root Directory `backend`**, **Framework
   Other**, **Node.js 22.x**, **Output Directory `public`**, **Build Command
   empty** and **Install Command `npm ci`**. `vercel.json` contains these settings.
2. For cloud routing, connect a Redis provider supporting **TCP/TLS Pub/Sub**.
   Set `REDIS_URL` to its `rediss://...` connection string. This is different
   from the old HTTP REST URL/token; those variables are no longer used.
3. Set Production environment variables:

   | Variable | Value |
   | --- | --- |
   | `DEVICE_TOKEN` | Existing local device token, at least 32 characters |
   | `SESSION_SECRET` | Separate random secret, at least 32 characters |
   | `DASHBOARD_PASSWORD` | Dashboard login password, at least 16 characters |
   | `REDIS_URL` | Redis TCP/TLS connection URL with Pub/Sub support |

4. Use separate device tokens/Redis namespaces for preview environments so
   previews do not control the production board. Channels are scoped by a hash
   of `DEVICE_TOKEN`.
5. Deploy. Use the stable production domain. Its WebSocket upgrade requests
   must be reachable without an interactive Vercel login; the app still checks
   the dashboard session and device token. Redeploy after environment changes.
6. Run the USB provisioning script with
   `-BackendUrl 'https://your-project.vercel.app'`, using the same local token
   configured as Vercel's `DEVICE_TOKEN`. Open that HTTPS URL, sign in and verify
   the board reports online. You can then disconnect USB, use suitable battery
   power and shut down the laptop.

To copy the existing device token without printing it:

```powershell
(Get-Content .tools\server-secrets.json -Raw | ConvertFrom-Json).deviceToken | Set-Clipboard
```

To generate a new session secret:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" | Set-Clipboard
```

### Why a cloud relay?

Vercel may put the board's socket and the browser's socket on different function
instances. An in-memory socket map alone cannot route between those instances.
Redis Pub/Sub pushes commands and state between them; it does not store desired
settings or carry audio in this LED prototype. Local use has direct routing.
The backend deliberately requires a relay in Vercel mode rather than silently
depending on the two sockets sharing an instance.

Vercel closes sockets at the function's maximum duration (configured here at
300 seconds). Reconnection recreates the socket and requests current board state.
The production deployment and Redis relay have been verified using the physical board.

## Tests

```powershell
# From the repository root:
npm test
# With the real board online:
npm run test:hardware -- http://192.168.0.22:3000
```

Tests cover command acknowledgements, two-backend relay routing, invalid input,
device authentication, dashboard login and cross-origin connection rejection.
Hardware checks cover on/off, both speed limits, round-trip latency and browser
reconnection. They restore the original board settings when finished.

Verified locally on the physical ESP32: seven commands had a 14 ms median and
27 ms maximum acknowledgement round-trip. The board reconnected after a backend
restart and retained its LED settings. These are local test results, not an
internet latency guarantee. Cross-instance routing was tested with a shared relay;
the Redis/Vercel path was subsequently verified with the physical ESP32: seven
commands had a 60 ms median and 69 ms maximum acknowledgement round-trip.

For authenticated cloud hardware checks, set `DASHBOARD_PASSWORD` in the test
process environment and run `npm run test:hardware -- https://ai-toy-eight.vercel.app`.
The test logs in and keeps its session cookie in memory; it never prints credentials.

Obsolete polling source files have been removed. Automatic approval review
blocked recursive deletion of older generated artifacts under `build/` and
`.tools/python/`; those directories remain ignored by Git.

References: [Vercel WebSockets](https://vercel.com/docs/functions/websockets),
[ws](https://github.com/websockets/ws),
[Arduino WebSockets](https://github.com/Links2004/arduinoWebSockets).
