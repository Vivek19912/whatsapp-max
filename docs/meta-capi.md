# Meta Conversions API (CAPI) integration

Send **conversion events** (Lead, Contact, Schedule, CompleteRegistration,
Purchase) from WhatsApp Max to a customer's **own** Meta dataset, so Meta can
optimise their ad delivery. This is a **separate capability** from
[Direct Meta Lead Ads](./meta-lead-ads.md): lead capture is inbound (Meta →
Workspace), Conversions API is outbound (WhatsApp Max → Meta). Either can be
configured, changed or removed without affecting the other.

Both share the one deployment-level Meta app (App ID, App Secret, Graph
version) — see the "One shared Meta App, many customers" section of the
Lead Ads doc.

## What it does

```
Domain action in WhatsApp Max                  Customer's Meta dataset
───────────────────────────                    ───────────────────────
Meta Instant Form lead ingested  ─┐
WhatsApp flow run completed      ─┼─► mapping ─► POST /{dataset_id}/events
Workspace column set to a value  ─┘   (enabled)   with hashed user_data
```

Mappings are configured in **Settings › Integrations › Meta → Conversions API**.
A mapping says: *when **\<this real domain action\>** happens, send **\<this
Meta event\>**.*

### The only trigger sources (nothing invented)

| Trigger | Fires when | Notes |
| --- | --- | --- |
| **Meta Instant Form lead received** | a `leadgen` submission is ingested into the Workspace | fired from lead processing (`process-lead.ts`) |
| **WhatsApp flow completed** | a flow run ends as `completed` | fired from the flow engine's completion path only — never for `handed_off` / `failed` / `timed_out` |
| **Workspace column set to a value** | a Workspace cell is changed to a specific value (e.g. `Stage = Booking Confirmed`) | fired from the workspace-values route **and** the Travel CRM lead sync, **only on an actual change** to a non-empty value — never on a re-save of the same value, never on clear |

Status edits made through conversational flow-answer overrides do **not**
fire Conversions API events: overrides are display edits to submitted
answers, not lead-status transitions.

There is deliberately **no** "page view", no UI-click and no artificial stage
source. A user can map the "Workspace column" trigger to any column + value
they actually use (including an explicit "confirmed" stage) to send `Purchase`
— but see the Purchase rule below.

## appsecret_proof

`appsecret_proof` is an **optional** Graph argument. When sent it must be
`HMAC-SHA256(access_token, <App Secret of the app that issued the token>)`. A
customer's System User token can belong to **their own** Meta app, so the shared
platform `META_LEAD_ADS_APP_SECRET` is not necessarily the matching secret;
using it produced:

> Invalid appsecret_proof provided in the API argument

CAPI therefore **never** derives the proof from the platform secret:

- If the customer supplied their app's **App Secret**, the proof is computed
  from the exact token in that request with that secret.
- If they did **not**, no `appsecret_proof` parameter is sent (never a proof
  computed with a mismatched secret). The app only needs it if the owning app
  is configured to *require* app secret proof.

## Data, privacy and correctness

- **Hashed PII.** `email`, `phone`, `first/last name` and `external_id` are
  SHA-256-hashed (lowercase hex) after Meta's normalisation (email trim +
  lowercase; phone digits-only; names lowercased/alnum). Click identifiers
  (`ctwa_clid`, `fbc`, `fbp`) are sent **un-hashed**, exactly as Meta requires.
- **Only fields we hold** are sent — never the whole lead payload.
- **`Purchase` needs a real value.** A Purchase mapping must have a value > 0
  and a currency; it is **never** inferred from a qualified lead. A Purchase
  that is triggered without valid criteria is recorded as **`skipped`** on the
  ledger and **not sent** — we never invent an amount or a zero-value Purchase.
- **No WhatsApp messages** are ever created by Conversions API events.

## Reliability

- **Idempotent by event id.** Every delivery is keyed
  `UNIQUE(account_id, event_id)`. The `event_id` is derived from the mapping +
  flow run (+ column + from-value → to-value for workspace transitions, never
  wall-clock time), so a logical conversion is enqueued and sent **at most
  once**. Concurrent duplicates of the same transition, retries and duplicate
  webhook deliveries all collapse to one event.
- **Retries reuse the stored payload** (same `event_id`), so Meta de-duplicates
  rather than double-counting. Bounded backoff: 1m → 2m → 4m → 8m, capped at
  30m, max 5 attempts.
- **Re-qualification.** Because a from → to transition fires once per mapping
  and lead, returning to an earlier status and setting it again (e.g.
  Qualified → Lost → Qualified) resolves to the same event id and does not
  send again. To report a genuine re-qualification, configure a distinct value
  (for example a "Re-Qualified" stage) or a separate mapping.
- **Empty match data is skipped.** A production event with no customer
  matching data (email, phone, name, or click ID) is recorded as `skipped`
  with a clear reason instead of being sent. Test events with a Test Event
  Code are unaffected.
- **The ledger is the truth.** Each delivery is `pending` / `sent` / `failed` /
  `skipped`, with attempts and last error. `sent` means Meta returned
  `events_received >= 1` — it does **not** by itself prove attribution in Ads
  Manager.
- **Test events are labelled.** Sending a test uses the account's Test Event
  Code and is stored `is_test = true`; the UI shows it as a TEST and never as a
  production conversion.

## Event mappings validation

- `name` required (unique per account).
- `source_action` must be one of the three triggers above.
- Meta event name: a standard event (`Lead`, `Contact`,
  `CompleteRegistration`, `Schedule`, `Purchase`) or a valid custom name
  (`[A-Za-z][A-Za-z0-9_]{0,49}`).
- Workspace trigger requires both a column and a value.
- `Purchase` (or any mapping flagged value-bearing) requires value > 0 **and** a
  3-letter currency.

## Recommended status presets

Settings → Conversions API → Events to send → **Add recommended status
events** creates disabled presets from the workspace's actual stored Stage
values — never enabled, never `Purchase`:

- `Stage = Qualified` → custom event `QualifiedLead`
- `Stage = Contacted` → standard event `Contact` (optional)
- `Stage = Converted` → custom event `ConvertedLead` (no value)

Rules enforced by the presets endpoint and UI:

- Presets match only exact stored values; a missing value is reported with
  the workspace's available Stage values instead of guessing.
- `Converted` is never mapped to `Purchase` without evidence of a real
  payment plus a configured amount and currency.
- If lead ingestion already sends the standard `Lead` event, changing a
  qualification preset to send `Lead` as well will count two Leads for the
  same person — prefer the custom `QualifiedLead` event.

## API surface

| Route | Method | Who | Purpose |
| --- | --- | --- | --- |
| `/api/integrations/meta-capi/status` | GET | member | safe config + recent deliveries (token never returned) |
| `/api/integrations/meta-capi/config` | GET/PUT/DELETE | admin | store/verify/clear dataset + token + test code + action source |
| `/api/integrations/meta-capi/mappings` | GET/POST | member / admin | list / create event mappings |
| `/api/integrations/meta-capi/mappings/[id]` | PATCH/DELETE | admin | update / remove a mapping |
| `/api/integrations/meta-capi/test-event` | POST | admin | send one labelled TEST event |
| `/api/integrations/meta-capi/deliveries` | GET | member | recent delivery ledger |
| `/api/integrations/meta-capi/retry` | POST | admin | retry one delivery (`delivery_id`) or sweep due failures |
| `/api/integrations/meta-capi/presets` | POST | admin | create disabled status presets from stored Stage values |
| `/api/integrations/meta-capi/cron` | GET | cron secret | global retry sweep (point a scheduler at it) |

## Configuration (per customer)

1. **Settings › Integrations › Meta → Conversions API → Step 1.** Paste the
   numeric **Dataset / Pixel ID** from Meta Events Manager.
2. **Step 2.** Paste a **System User access token** (Business Settings) that can
   access that dataset. Both halves are **verified against Meta** before the
   integration is marked connected. The token is encrypted at rest and never
   returned to the browser.
   If the token was issued by a **different Meta app** than the platform app,
   also paste that app's **App Secret**. It is only ever used to compute
   `appsecret_proof`, is encrypted at rest, and is never returned to the
   browser. With no App Secret we send **no proof at all** — the platform
   `META_LEAD_ADS_APP_SECRET` is never used for a customer token (see
   "appsecret_proof" below).
3. **Step 3 (optional).** Paste a **Test Event Code** (Events Manager → Test
   Events) and click **Send test event** to confirm end-to-end. Test events are
   labelled and are not production conversions.
4. **Step 4.** Add one or more **event mappings**.

Save & verify checks two separate stages and reports which one failed:
token authentication first (`GET /me`, proves nothing about the dataset),
then dataset metadata access (`GET /{dataset_id}`). A dataset `#100` after
a successful token check means the valid token cannot see that dataset — it
is never reported as an invalid token. Failures include Meta's error code
and subcode (never tokens or secrets).

## Environment / platform

Only needs `META_GRAPH_VERSION`. It deliberately does **not** use the Lead Ads
app credentials: a customer's System User token can belong to their own Meta
app, so an `appsecret_proof` computed with the platform
`META_LEAD_ADS_APP_SECRET` is rejected by Meta. If `META_GRAPH_VERSION` is
missing, the Conversions API panel shows "Unavailable on this server" and its
routes return `501`.

## Database

Migration `121_meta_capi.sql` creates, tenant-scoped and RLS-guarded:

- `meta_capi_config` — one row per account: dataset id, **encrypted** token,
  status, test event code, action source, wizard step.
- `meta_capi_event_mappings` — configurable action → Meta event mappings.
- `meta_capi_deliveries` — the idempotent delivery ledger
  (`UNIQUE(account_id, event_id)`), retries included.

Config + mappings are readable by members and writable by admins; deliveries are
read-only to members (server writes only). The access token is never exposed to
the browser.

## Manual steps checklist (per customer)

- [ ] Create a dataset/pixel in Meta Events Manager and note its id.
- [ ] Create (or reuse) a System User with access to that dataset and generate
      a token.
- [ ] In Settings › Integrations › Meta → Conversions API: save the dataset and
      token (both verified). If the token belongs to a different Meta app, also
      save that app's App Secret; otherwise leave it blank. Add an optional Test
      Event Code and send a test event.
- [ ] Add the event mappings you want and enable them.
- [ ] Confirm real events appear under the dataset's event activity (a test event
      only proves connectivity, not production tracking).

## Not claimed

- This integration does **not** prove ad attribution or ROAS — that is Meta's
  Ads Manager reporting.
- Automated tests use **mocked** Meta responses; a real `events_received`
  confirmation for a given customer requires their own dataset + token.
- The "App not active" / Live-mode prerequisite that applies to the shared Meta
  app is documented in `meta-lead-ads.md` and applies here too.
