# Desktop → CallVault click-to-dial over WebSocket

Self-hosted, no polling, no Firebase/FCM, no Google credentials.

## Why this exists

The original implementation inserted a `dial_requests` row and left the
phone to discover it. The Android app only looked while its UI was open,
plus a 15-minute WorkManager job, so every request created with the app
closed stayed `pending` (production: 19 pending, 0 delivered ever).

Delivery is now a single authenticated WebSocket held by a CallVault
foreground service. The backend pushes an **id-only signal**; the phone
performs one authoritative API read before anything can reach the dialer.

## Pieces

| Piece | Location | Role |
|---|---|---|
| Next.js routes | `src/app/api/dial-requests/route.ts`, `src/app/api/v1/dial-requests/**` | Create the durable row, notify the sidecar, expose the one-shot read + acks |
| Signal contract | `src/lib/dial/ws-events.ts` | Ids-only event shape, expiry and replay rules |
| Sidecar nudge | `src/lib/dial/notify-ws.ts` | Loopback POST to the sidecar after insert |
| WebSocket sidecar | `scripts/dial-ws-server.mjs` | Authenticates the Supabase token, keeps one socket per user, pushes id-only signals, fans persisted statuses out to browser sockets, answers consume requests |
| Browser status socket | app opens `wss://.../ws/dial?client=browser` | Same auth as phones; receives `status_snapshot` + `status` events only |
| Android socket | `DialSocketClient.kt`, `DialSocketService.kt` | Persistent connection + reconnect/backoff |
| Android handler | `DialEventProcessor.kt`, `DialEventPolicy.kt`, `DialOpenDispatcher.kt` | Authoritative fetch, validation, dedupe, ACTION_DIAL |

## Flow

1. Workspace `POST /api/dial-requests` inserts `pending` row (unchanged API).
2. The route calls the sidecar on `127.0.0.1:3001` with `request_id`,
   `account_id`, `user_id` only. Fire-and-forget; an outage leaves the row
   pending for the next connect.
3. Sidecar verifies the row still belongs to that account/user and is
   pending + unexpired, then sends
   `{type:"dial_request", request_id, expires_at, created_at}`.
4. Phone sends `{type:"received", request_id}`. The sidecar atomically
   marks the row delivered (pending → delivered is one conditional
   write, so exactly one delivery can win) and answers on the same
   socket with `{type:"consume", request_id, phone_number, expires_at,
   created_at}`. Duplicates get `{type:"consume_rejected"}`. The
   consume reply is the fast path: it replaces the extra HTTPS GET
   with one WebSocket round trip. No consume within a few seconds
   (old server, lost frame) → the phone falls back to the one-shot
   `GET /api/v1/dial-requests/{id}` as before.
5. Phone validates the consumed payload (live status, unexpired,
   dialable — same policy gate as the GET path) and opens
   `ACTION_DIAL`. On success it acks `opened` over the existing HTTP
   endpoint (one-time consumption). An unusable consume payload is
   reported as `{type:"failed"}`, which marks the row failed.
6. The v1 ack handler tells the sidecar about every persisted
   transition (`POST /internal/status-event`, loopback, shared
   secret); the sidecar re-reads the row and pushes
   `{type:"status", request_id, status}` to the user's browser
   tabs, which flip Queued → Delivered → Opened live, no polling.
   Browsers also get a `status_snapshot` of recent rows on every
   connect, so a reconnect recovers without any HTTP status read.
7. If Android blocks the background launch (no overlay grant, locked
   app, OEM restriction) the phone posts a notification instead —
   and reports that honestly in Settings/logs; it never claims
   delivery succeeded.

Wire messages (all JSON, 4 KB cap, unknown types ignored):
- phone → server: `{type:"received", request_id}`,
  `{type:"failed", request_id}` (undialable number or unusable
  consume payload; still consumes nothing twice)
- server → phone: `{type:"ready", ...}`, `{type:"dial_request", ...}`,
  `{type:"consume", request_id, phone_number, expires_at, created_at, sent_at}`,
  `{type:"consume_rejected", request_id}`
- server → browser: `{type:"ready", ...}`,
  `{type:"status_snapshot", requests:[{request_id→id, status, expires_at, created_at}]}`,
  `{type:"status", request_id, status, at}`
- browser → server: nothing (display-only; ignored). Browser
  sockets require `?client=browser` plus the same session auth and
  are exempt from device takeover; nginx access logging stays off
  for `/ws/dial` so bearer tokens never land in access logs.

**Replay rules:** only `pending` rows are replayed on connect. `delivered`
rows are never replayed, so a reconnect cannot reopen the dialer for a
request the phone already acknowledged.

**Device takeover:** a newer connection for the same user replaces the
older one (`4001` other device, `4002` same device). The replaced socket
does not reconnect, so two phones cannot both open the dialer.

## Backend configuration

Add to `.env.local` (and the production environment):

```bash
DIAL_WS_INTERNAL_SECRET=<32+ random characters>
DIAL_WS_INTERNAL_URL=http://127.0.0.1:3001
DIAL_WS_PORT=3001
DIAL_WS_HOST=127.0.0.1
```

Generate the secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The sidecar refuses to start without `DIAL_WS_INTERNAL_SECRET`, the
Supabase URL, anon key, and service-role key.

### Run the sidecar

```bash
npm run dial-ws
```

Under pm2:

```bash
pm2 start scripts/dial-ws-server.mjs --name wacrm-dial-ws
pm2 save
```

Keep it loopback-only (`DIAL_WS_HOST=127.0.0.1`) and expose it through nginx.

### nginx

```nginx
location /ws/dial {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    # Bearer tokens travel in ?access_token= (browsers cannot set WS
    # headers); keep them out of the access log.
    access_log off;
}
```

Health check (loopback only): `curl http://127.0.0.1:3001/healthz`.

## Android requirements

- WhatsApp Max session connected and **WACRM upload / dial integration**
  enabled.
- `DialSocketService` running (persistent low-importance notification).
- **Battery optimisation off** for CallVault (Settings → the “Allow
  background” button). Vivo may still kill a foreground service; this is
  the main remaining OEM risk.
- **Display over other apps** granted *and* “Open the dialer automatically”
  enabled for a prompt-less background open. Without either, the request
  arrives as a notification (still delivered, but one tap).
- App lock on + locked means the notification path waits for unlock. A
  lead’s number is never flashed past the lock screen.

## Verification

```bash
# backend
npm run typecheck
npx vitest run src/lib/dial src/app/api/dial-requests src/app/api/v1/dial-requests

# android
gradlew.bat testDebugUnitTest
gradlew.bat assembleDebug

# device (sanitized)
adb logcat -s CV:Dial CV:DialWs
```

Expected log sequence for one desktop click (consume fast path):

```
CV:DialWs  WebSocket connected (auth accepted)
CV:DialWs  Signal 09d72071 received
CV:Dial    Dial 09d72071: signal_to_dialer_ms=812 (received+120ms, open+692ms, path=consume, 12 digits)
CV:Dial    Dial 09d72071: dialer opened (background, 12 digits)
CV:Dial    Dial 09d72071: opened + consumed
```

With the GET fallback (no consume within the timeout) the timing
line reads `(received+4000ms+, open+…, path=fetch)` instead. Either path keeps
the same server-side guarantees: only `pending` rows are consumed
once, by the owning user's authenticated device.

### Measuring desktop-to-dialer latency (physical device only)

No simulator or emulator numbers count. For each of ≥10 real
desktop clicks on the Vivo (app backgrounded, auto-open granted):

1. On desktop, note the wall-clock click time (or take the
   server's `[dial-requests] created … insert_ms=` log line).
2. On device: `adb logcat -s CV:Dial CV:DialWs` and copy the
   `signal_to_dialer_ms=` line for the matching request id prefix
   (first 8 chars shown; ids match 1:1).
3. Confirm the native dialer opened with the exact number and that
   no call was placed (ACTION_DIAL only prefills).
4. Confirm the Workspace cell moved Queued → Delivered → Opened
   with no tap on the phone and no page refresh.

Report per-run `signal_to_dialer_ms` plus the path tag, then:
P50/P95 across the 10 runs, the consume-vs-fetch split, the
delivery success rate, and any duplicate-dialer count (expected 0:
`consume_rejected` + process dedupe + one-time server consume).
Clock note: `signal_to_dialer_ms` is measured with the device's
monotonic clock (`elapsedRealtime`), so no device/server clock sync
is needed; server-side `insert_ms`/`notify` timings use server
`Date.now()` and are reported separately — do not mix the two
bases when computing P50/P95.

DB expectations: `pending → delivered` immediately, then `opened` with
`opened_at` / `consumed_at` set after the dialer launch.

## Endpoint summary

| Endpoint | Used by | Notes |
|---|---|---|
| `POST /api/dial-requests` | Workspace | Creates the row, nudges the sidecar |
| `GET /api/dial-requests?id=` | Workspace | Single explicit read (never polled); lazily expires stale rows |
| `GET /api/v1/dial-requests` | legacy | Still available, no longer polled by the app |
| `GET /api/v1/dial-requests/{id}` | CallVault | One-shot authoritative read (410 when expired) |
| `POST/PATCH /api/v1/dial-requests/{id}` | CallVault | Ack `delivered`/`opened`/…; 409 replay, 410 expired; every success fans a status event out to browsers |
| `POST /internal/status-event` | WACRM route (loopback, shared secret) | Re-reads the row and broadcasts the persisted status to the user's browser tabs |
| `GET /healthz` (sidecar) | ops | `{ok, connections, browsers}` |

Never uses `ACTION_CALL`, `CALL_PHONE`, or automatic placement. Recording,
upload, call-event, SIM and retention behaviour is untouched.
