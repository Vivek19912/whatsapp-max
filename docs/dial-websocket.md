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
| WebSocket sidecar | `scripts/dial-ws-server.mjs` | Authenticates the Supabase token, keeps one socket per user, pushes + replays pending |
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
4. Phone parses the id, calls `GET /api/v1/dial-requests/{id}` with the
   user token. The number comes from this response, never from the socket.
5. Phone replies `{type:"received", request_id}`; the sidecar marks the row
   `delivered`.
6. Phone opens `ACTION_DIAL`. On success it acks `opened` over the existing
   HTTP endpoint (one-time consumption).
7. If Android blocks the background launch (no overlay grant, locked app,
   OEM restriction) the phone posts a notification instead — and reports
   that honestly in Settings/logs; it never claims delivery succeeded.

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

Expected log sequence for one desktop click:

```
CV:DialWs  WebSocket connected (auth accepted)
CV:DialWs  Signal 09d72071 received
CV:Dial    Dial 09d72071: dialer opened (background, 12 digits)
CV:Dial    Dial 09d72071: opened + consumed
```

DB expectations: `pending → delivered` immediately, then `opened` with
`opened_at` / `consumed_at` set after the dialer launch.

## Endpoint summary

| Endpoint | Used by | Notes |
|---|---|---|
| `POST /api/dial-requests` | Workspace | Creates the row, nudges the sidecar |
| `GET /api/dial-requests?id=` | Workspace | Single explicit read (never polled); lazily expires stale rows |
| `GET /api/v1/dial-requests` | legacy | Still available, no longer polled by the app |
| `GET /api/v1/dial-requests/{id}` | CallVault | One-shot authoritative read (410 when expired) |
| `POST/PATCH /api/v1/dial-requests/{id}` | CallVault | Ack `delivered`/`opened`/…; 409 replay, 410 expired |
| `GET /healthz` (sidecar) | ops | Connection count |

Never uses `ACTION_CALL`, `CALL_PHONE`, or automatic placement. Recording,
upload, call-event, SIM and retention behaviour is untouched.
