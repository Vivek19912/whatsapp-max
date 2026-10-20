# Meta Lead Ads integration

Capture leads from Facebook / Instagram **Instant Forms** and surface them
in the existing **Workspace** — one table per enabled form — alongside your
WhatsApp flow leads. No parallel lead UI, no new contact pipeline: a lead
becomes a normal `flow_runs` row with the form answers as its columns.

> Looking to send **conversion events** back to Meta? That is a separate
> capability — see [Meta Conversions API](./meta-capi.md). Both live under
> Settings › Integrations › **Meta** (tabs: *Lead capture* and *Conversions
> API*) and share the one deployment-level Meta app.

## Connect with Facebook (recommended)

Each workspace connects its own Pages through **Connect with Facebook**.
The admin authorizes Pages in the shared app, then explicitly selects which
authorized Pages to connect. Tokens are exchanged server-side, encrypted with
AES-256-GCM, and never returned to the browser:

1. **Connect with Facebook** starts a server-side authorization-code flow bound
   to the signed-in workspace with a one-time hashed OAuth state.
2. The callback validates the state, checks that the token belongs to the
   shared app, discovers manageable Pages, and stores a short-lived
   Page-selection session.
3. The admin selects Pages; each Page is verified, installed for `leadgen`,
   and persisted under the same account.
4. **Load My Forms**, enable forms, and submit a test lead.

### Manual setup (legacy fallback)

The legacy path remains for existing connections. An account admin pastes
three values once:

| Value | Where to find it |
| --- | --- |
| **Dataset / Pixel ID** | Meta Events Manager → Data sources → your dataset. |
| **System User access token** | Meta Business Settings → Users → System users → assign the Page + dataset → Generate token. |
| **Facebook Page ID** | The numeric Page id (Page → About → Page transparency, or the Page URL settings). |

A legacy foreign-app token can still read/import through polling, but it
cannot install this shared app's webhook. Saving verifies the readable stages
and reports subscription failures with Graph diagnostics — **polling still
imports leads**, so setup is not blocked.

```
Admin (Settings › Integrations › Meta → Lead capture)
        │  Connect with Facebook (or legacy manual values)
        ▼
meta_lead_oauth_states/sessions ── one-time handshake only
        │  verify app + select Pages explicitly
        ▼
meta_lead_connections  ── encrypted token + scopes/expiry/app id
        │  verify Page + subscribe (with Graph diagnostics)
        ▼
meta_lead_pages        ── encrypted Page token, last sync/poll
        │  "Load My Forms" → enable forms
        ▼
meta_lead_forms        ── enabled form → virtual Workspace flow
                                (flows.kind = 'meta_lead_ads')
        ▲                       │
        │                       ├─ historical import (cursor)
        │                       └─ polling every cron run
        │  OR the Page webhook
   /api/integrations/meta-lead-ads/webhook
        │  verify HMAC → record idempotently → after() retrieve lead
        ▼
meta_lead_submissions  ── idempotency + retry bookkeeping
        │  normalize field_data → answers
        ▼
flow_runs (virtual flow) + optional contact (only when a phone exists)
```

- **Virtual flow per form.** Enabling a form calls `ensureVirtualFlow`, which
  creates/refreshes a `flows` row (`kind='meta_lead_ads'`, `status='archived'`,
  `trigger_type='manual'`) with one `collect_input` node per question plus a
  leading **Source** column. Because it is archived + manual, the
  conversational engines never dispatch it, but the Workspace — which lists
  every flow — shows it as a table.
- **Workspace, unchanged.** Columns, filters, search, pagination, pin/hide,
  header colors and inline field editing all work exactly as for a WhatsApp
  flow. Meta tables hide the “Edit in flow builder” links (there is no
  builder for an Instant Form).
- **Contacts.** A contact is created only when the lead carries a phone
  number (`contacts.phone` is NOT NULL). Dedupe reuses the same helpers as
  the rest of the CRM. **No WhatsApp message or conversation is ever
  created** on lead arrival.
- **Standard fields.** `full_name` (or `first_name`+`last_name`), `phone_number`
  and `email` are read from the same keys Meta returns in `field_data`; they
  are also projected onto the Workspace system Name/Phone columns. When the
  phone is absent or unusable (for example a Meta Testing Tool placeholder)
  no contact exists, so the table shows the name/phone Meta supplied as a
  read-only fallback; contact data always wins, and absent fields stay blank.
  The raw answers remain visible in their own question columns.
- **Source attribution.** Meta reports the Lead node's `platform` as `fb` or
  `ig` (long names are accepted too) and it becomes **Facebook** or
  **Instagram**. When Meta omits `platform` — Meta Testing Tool leads have no
  platform and `is_organic: true` — the Source stays **Other** rather than
  guessing a channel. Instagram is additionally inferred only from an
  explicit Instagram question key.

## Historical import + continuous sync

Enabling a form starts a **bounded historical import** of the leads Meta
already holds for that form. The Graph pagination cursor is persisted
(`meta_lead_forms.import_cursor`), so:

- the first batch returns quickly;
- the cron resumes an interrupted import on its next run;
- **Import leads** can be clicked again at any time (duplicates are skipped);
- `imported_count` counts only **new** leads.

New leads arrive through either path:

1. **Webhook** — only when app-level `leadgen` is enabled **and** the Page
   readback contains the shared app with `leadgen`.
2. **Polling** — the cron reads the latest leads for enabled forms across
   tenants with a fair round-robin selector. This is the fallback when the
   token lacks `pages_manage_metadata`/`ads_management`, uses another app,
   or when Meta refuses the subscription for any other reason.

Both paths feed the **same** idempotent pipeline, so running both is safe.
Polling is the fallback that must not depend on the webhook: if
`meta_lead_pages.webhook_verified` is false, a lead only appears
automatically when the cron endpoint below is actually scheduled.

### Scheduling the poll (required)

Nothing polls by itself. Pick **one** scheduler for the deployment:

- **Self-hosted EC2/VPS (production `whatsappmax.in`):** after deploying,
  run the installer with the real public URL (the script's default URL is
  different):

  ```bash
  bash scripts/setup-automation-cron.sh /path/to/app https://whatsappmax.in
  crontab -l | grep meta-lead-ads-cron
  ```

  It installs a separate `*/5 * * * *` line that calls
  `GET /api/integrations/meta-lead-ads/cron` with `x-cron-secret`. A
  separate line keeps a slow/failing Graph poll from delaying the
  per-minute automations/reminders/flows/sheets drains.

- **Vercel:** `vercel.json` lists the same path on a `*/5` schedule.
  Vercel sends `Authorization: Bearer $CRON_SECRET`; the route accepts it.

Do not run both schedulers against the same deployment. Verify manually:

```bash
curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" \
  https://whatsappmax.in/api/integrations/meta-lead-ads/cron
```

`sync.forms` is the number of enabled forms swept; `sync.received` counts
new rows. An empty `forms` means no form is enabled (or no account has
connected a Page). A `503` means the integration is not configured on
that server.

## Reusing Conversions API credentials

If the **Conversions API** tab already has a dataset and token, the Lead
Capture setup can reuse them:

- the Dataset ID is prefilled;
- leaving the token field blank copies the stored CAPI token **server-side**
  into `meta_lead_connections` (it is never sent to the browser).

The copy is one-time: after setup, changing or disconnecting one capability
does not touch the other.

## One shared Meta App, many customers

This is a **multi-tenant** integration built on **one Meta Developer App
shared by every customer on the deployment**. The deployment only needs the
shared webhook (one callback URL + verify token) and a Graph version.
Customers never create their own app; they create a System User token and
paste it into Settings.

| Concern | Scope | Where |
| --- | --- | --- |
| App ID / Secret / verify token / Graph version | Deployment (shared) | env vars |
| Webhook URL + `leadgen` subscription | Deployment (shared) | App Dashboard |
| Dataset ID + System User token | **Per customer account** | `meta_lead_connections` |
| Facebook Pages + encrypted Page tokens | **Per customer account** | `meta_lead_pages` |
| Instant Forms + import state | **Per customer account** | `meta_lead_forms` |
| Leads (submissions + Workspace rows) | **Per customer account** | `meta_lead_submissions` / `flow_runs` |

Isolation guarantees:

- Every table carries `account_id` and is guarded by RLS
  (`is_account_member`); server/webhook writes use the service role.
- Tokens are AES-256-GCM encrypted and never returned to the browser.
- The `leadgen` webhook is a single shared endpoint; the tenant is
  resolved **server-side from the Page id** and never taken from the
  payload. An unknown Page is logged and ignored.
- **A Facebook Page may be connected to only one account.** Connecting a
  Page that is already connected elsewhere is rejected with a generic,
  non-identifying conflict; enforced in the route *and* by a global unique
  index on `meta_lead_pages.page_id` (migration `120`). This keeps the
  Page → account lookup unambiguous so no lead is ever dropped.
- Disconnecting one customer removes only that customer's credentials,
  Pages and form enablement; other customers are untouched. Historical
  leads are kept.

## Environment variables

All four are **required**; if any is missing the integration is disabled
(routes return `501`, the settings panel shows “Not configured”).

| Variable | Purpose |
| --- | --- |
| `META_LEAD_ADS_APP_ID` | The shared Meta App's numeric App ID. |
| `META_LEAD_ADS_APP_SECRET` | App Secret — verifies inbound webhook HMACs. Server-only. |
| `META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN` | Any long random string; typed into the App Dashboard webhook config and echoed back to Meta's GET challenge. |
| `META_GRAPH_VERSION` | e.g. `v21.0`. **Never hardcoded** — pin a currently-supported version. Validated against `^v\d+\.\d+$`. |

OAuth tokens are issued by the shared app and verified with `debug_token`.
Legacy manual System User tokens may belong to another app. Graph calls
authenticate with the token alone; the platform App Secret is **never** used
to compute an `appsecret_proof` for a customer token (that would fail with
`Invalid appsecret_proof` when the token belongs to a different app). Only a
token from the shared app can install the shared app's webhook.

## Graph API calls

Only fields that exist on the target node are requested. In particular the
Page read (`GET /{page-id}`) asks for `id,name,access_token` — **never
`tasks`**, which belongs to the `/me/accounts` user edge and makes Graph
reject the whole call with `#100 Tried accessing nonexistent field (tasks)`.

The same rule applies to the Lead node: `GET /{lead-id}` (and the
`/{form-id}/leads` edge) request only `id,created_time,field_data,form_id,
platform,ad_id,ad_name,campaign_name,is_organic`. `page_id` is **not** a Lead
field — asking for it fails the read with
`#100 Tried accessing nonexistent field (page_id)`, so the submission is
recorded but no Workspace row is ever created. The Page is already known from
the form/submission, so it is never re-requested from the Lead.

| Call | Purpose | Token |
| --- | --- | --- |
| `GET /{page-id}?fields=id,name,access_token` | Verify the Page + obtain a Page token | System User |
| `GET /{dataset-id}?fields=id,name` | Verify dataset reachability | System User |
| `GET /{page-id}/leadgen_forms?fields=id,name,status,locale&limit=100` | Load My Forms (follows pagination) | Page |
| `GET /{form-id}?fields=id,name,status,locale,questions` | Refresh form questions on enable | Page |
| `GET /{form-id}/leads?fields=…&limit=50` | Historical import + polling | Page |
| `GET /{lead-id}?fields=…` | Retrieve a full submission | Page |
| `GET /{app-id}/subscriptions` | Check app-level `leadgen` configuration | App token |
| `POST /{page-id}/subscribed_apps` | Install the app on the Page for `leadgen` | Page (shared app) |
| `GET /{page-id}/subscribed_apps?fields=id,name,subscribed_fields` | Verify our app id has `leadgen` | Page |
| `GET /oauth/access_token` + `debug_token` | OAuth code exchange, app/token/scope verification | App secret, then app token |
| `GET /me/accounts?fields=id,name,tasks` | Discover manageable Pages without requesting Page tokens | OAuth user token |

`Save & verify`, **Run diagnostics**, and OAuth Page selection run separate
capability checks (token app, app-level webhook, Page access, dataset access,
form listing, lead retrieval, Page installation). A webhook failure keeps
polling active and reports the Graph code/subcode/type instead of a generic
success.

## Meta App Dashboard setup

1. **Create / pick an app** (Business type) at
   <https://developers.facebook.com/apps>.
2. **Add the Webhooks product** → object **Page** → subscribe to the
   **`leadgen`** field. Callback URL:
   `https://<your-host>/api/integrations/meta-lead-ads/webhook`
   Verify token: the value of `META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN`.
   **Manual action:** enabling app-level `leadgen` cannot be done by code;
   confirm it in the dashboard before expecting real-time delivery.
3. **Add the Facebook Login product** and whitelist the production OAuth
   callback:
   `https://whatsappmax.in/api/integrations/meta-lead-ads/oauth/callback`.
4. **Permissions for OAuth and webhook installation**:
   `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`,
   `leads_retrieval`, and `ads_management`, plus an eligible Page role and
   dataset access. These require Business Verification, Advanced Access/App
   Review, and Live mode before public onboarding. Code changes alone do not
   grant these approvals.
5. Set the four env vars in the deployment / secrets manager and redeploy.

## In-app flow

1. **Settings › Integrations › Meta → Lead capture.** Click **Connect with
   Facebook**, authorize Pages, then select the Pages to connect.
2. **Load My Forms.** This reads each selected Page's Instant Forms and stores
   them.
3. **Enable a form.** Its questions are refreshed, a Workspace table is
   created, and the historical import starts.
4. **Run diagnostics** checks configuration, token/app ownership, app-level
   webhook configuration, token → Page read, dataset access, form access,
   lead retrieval and Page installation, and prints the exact failing stage.
   Diagnostics do **not** prove a live lead was received — only a real
   submission can.

## Workspace display: headers, duplicates, and option labels

- **Duplicate identity columns are hidden by default** on Meta tables only.
  When an Instant Form asks for a standard field (e.g. `Full name`,
  `Phone number`), that question still renders as its own column, but the
  matching system column (`Name`, `Phone Number`) already shows the same
  value. The dynamic duplicate is hidden on first view; use the Columns
  menu to bring it back. Flow Tables are unaffected.
- **Custom header names** (Rename Header / Restore Original Name) are
  stored per workspace + form + column key, never touch stored answers,
  and survive refreshes and new imports.
- **Multiple-choice answers** render the option's human-readable label
  when the stored raw value exactly matches the option's key from the
  form's stored metadata. When a known choice question (option
  metadata present, or persisted type `CUSTOM`) has no matching key —
  including older forms whose options were never synced —
  underscore-separated values render with spaces (`davinci_resolve`
  → `davinci resolve`). Anything else — free text, answers without
  underscores, standard-typed questions (`FULL_NAME`,
  `PHONE_NUMBER`, `EMAIL`, …), unknown types — renders verbatim.
  Stored answers and API values are never rewritten.

## Testing with a real lead

1. Enable a form (it appears in the Workspace selector).
2. In Meta's **Lead Ads Testing Tool** (App Dashboard → Webhooks →
   Test, or the Ads Manager preview) submit a test lead for that form, or
   use the Page's form preview.
3. Within a few seconds the lead appears as a row in that form's Workspace
   table. If it does not, check the diagnostics panel and the server logs for
   `[meta-lead-ads]` entries. The cron's polling path picks it up even when
   the webhook is not subscribed.

## Two-company staging verification

Use two separate staging Meta test assets and two WhatsApp Max workspaces:

1. Company A connects Page A/Form A through OAuth; Company B connects Page
   B/Form B through OAuth.
2. Submit a test lead for Form A and verify it appears only in Workspace A.
3. Submit a test lead for Form B and verify it appears only in Workspace B.
4. Verify cross-workspace reads by Page/form/submission id return 404 or are
   blocked, replayed webhooks do not duplicate rows, disconnecting A leaves B
   unaffected, and polling continues to serve both tenants.
5. Do not use production customer credentials or real lead PII for staging.

## Reliability

- **Idempotent.** `meta_lead_submissions` is unique on
  `(account_id, meta_lead_id)`; duplicate webhook deliveries, imports and
  polls are ignored.
- **Bounded retries.** A failed Graph retrieval is retried with backoff
  (1m → 2m → 4m → 8m, capped at 30m, max 5 attempts). The webhook always
  acks `200` quickly (processing is deferred with `after()`), so Meta is
  never made to re-deliver a whole batch.
- **Bounded imports.** Each call imports at most a few Graph pages; the
  cursor is saved after every page. The cron resumes `importing` forms.
- **Fair multi-tenant polling.** The scheduler serves enabled forms
  round-robin by account (`meta_lead_forms_for_poll`, default 20 forms per
  run), preserving per-form cursors, deduplication, retries, and tenant
  credential isolation. One tenant's backlog cannot permanently starve other
  tenants.
- **Catch-up polling.** Each poll walks newest-first pages until a page adds
  no new leads (or a page budget is hit), so a burst larger than one page
  between sweeps is not missed.
- **Connected Pages only.** Form listing, importing and polling resolve the
  Page token only for a Page the account has connected; an unconnected Page
  can never be read with the account token (cross-tenant safety).
- **Retry / sync endpoints.**
  - `POST /api/integrations/meta-lead-ads/retry` — admin. Optional body
    `{ "submission_id": "..." }` retries one; otherwise sweeps this
    account's due failures.
  - `GET /api/integrations/meta-lead-ads/cron` — protected by
    `AUTOMATION_CRON_SECRET` / `CRON_SECRET` (same as the other crons).
    Runs retries, resumes imports and polls enabled forms. A retry-sweep
    failure is reported as `retryError` but does not stop the polling
    pass; per-form failures are isolated and counted in `sync.errors`.
    See [Scheduling the poll](#scheduling-the-poll-required) — an
    unscheduled endpoint means polling never runs.
- **Reauth.** Only a definitive token rejection (Graph `#190`, `#102` or
  `#463`, or a bare 401) marks the connection `needs_reauth`. Errors that
  Meta also labels `OAuthException` — `#100` invalid field/parameter, `#200`
  missing permission, `appsecret_proof`, rate limits, 5xx and network
  failures — never invalidate the credential. The status endpoint is
  read-only; refreshing Settings cannot change credential state. If a token
  is flagged, re-check the stored one first by leaving the token field blank
  and clicking **Save & verify** (existing leads are untouched); paste a new
  token only if Meta still rejects it. A stale cron/poll worker cannot
  overwrite a token saved after it started.

## Security notes

- Tokens are stored **AES-256-GCM-encrypted** with `ENCRYPTION_KEY` and are
  never returned to the browser.
- OAuth uses a hashed one-time state, a same-site HttpOnly state cookie, and
  account/user binding. The callback never accepts a destination account id,
  and sessions hold Page metadata only.
- Inbound webhooks are rejected unless `X-Hub-Signature-256` matches an
  HMAC-SHA256 of the **raw** body under the platform App Secret.
- The **account is resolved server-side** from the Page id; it is never taken
  from the webhook payload. Unknown Pages / disabled forms are ignored.
- Disconnecting removes the credentials and Page rows but **preserves
  historical leads** and disables the forms, so nothing is silently deleted.

## Manual steps checklist (to go live)

Deployment / platform (do once):

- [ ] Set `META_LEAD_ADS_APP_ID`, `META_LEAD_ADS_APP_SECRET`,
      `META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_VERSION` in prod.
- [ ] Apply migration `119_meta_lead_ads.sql`.
- [ ] Apply migration `120_meta_lead_pages_global_unique.sql`.
- [ ] Apply migration `121_meta_capi.sql` (only if you use the Conversions API —
      see [`meta-capi.md`](./meta-capi.md)).
- [ ] Apply migration `122_meta_capi_app_secret.sql` (CAPI only).
- [ ] Apply migration `123_meta_lead_manual_setup.sql`.
- [ ] Apply migration `124_meta_lead_oauth.sql`.
- [ ] Configure the Page webhook (`leadgen`) at app level in the App
      Dashboard. This remains a manual dashboard action.
- [ ] Whitelist the OAuth callback in Facebook Login and verify the
      production URL.
- [ ] Complete Business Verification and request Advanced Access for
      `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`,
      `leads_retrieval`, and `ads_management`, then **switch the app to Live
      mode** — required before arbitrary customers can use it.
- [ ] Add a privacy policy link and a data-deletion route (Meta requirement).
- [ ] Schedule the cron endpoint (`scripts/setup-automation-cron.sh` on
      EC2/VPS with the real public URL, or `vercel.json` on Vercel) and
      confirm `crontab -l | grep meta-lead-ads-cron`.

First customer:

- [ ] Connect with Facebook, select the customer's Page, verify app-level and
      Page-level webhook diagnostics, then **Load My Forms**.
- [ ] Enable a form and submit a test lead to confirm end-to-end (webhook or
      polling). Legacy manual setup remains available for existing connections.

Each additional customer:

- [ ] That customer's account admin uses Connect with Facebook, selects only
      their own Pages, loads forms, and enables them (no platform/app changes
      needed).
