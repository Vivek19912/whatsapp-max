# Meta Lead Ads integration

Capture leads from Facebook / Instagram **Instant Forms** and surface them
in the existing **Workspace** — one table per enabled form — alongside your
WhatsApp flow leads. No parallel lead UI, no new contact pipeline: a lead
becomes a normal `flow_runs` row with the form answers as its columns.

> Looking to send **conversion events** back to Meta? That is a separate
> capability — see [Meta Conversions API](./meta-capi.md). Both live under
> Settings › Integrations › **Meta** (tabs: *Lead capture* and *Conversions
> API*) and share the one deployment-level Meta app.

## How it works

```
Admin (Settings › Integrations › Meta → Lead capture)
        │  OAuth (code → short-lived → long-lived user token)
        ▼
meta_lead_connections  ── encrypted user token
        │  discover + select Pages
        ▼
meta_lead_pages        ── encrypted Page token, leadgen subscription
        │  sync + enable forms
        ▼
meta_lead_forms        ── enabled form → virtual Workspace flow
                                (flows.kind = 'meta_lead_ads')
        ▲
        │  Meta POSTs {object:'page', entry:[{changes:[{field:'leadgen'}]}]}
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

## One shared Meta App, many customers

This is a **multi-tenant** integration built on **one Meta Developer App
shared by every customer on the deployment**. There is a single App ID,
App Secret, webhook URL, OAuth redirect URI and verify token — configured
once per deployment, not per customer. Customers never create their own
app; they only **authorize** the shared app against their own Meta account.

| Concern | Scope | Where |
| --- | --- | --- |
| App ID / Secret / verify token / Graph version | Deployment (shared) | env vars |
| Webhook URL, OAuth redirect URI, `leadgen` subscription | Deployment (shared) | App Dashboard |
| Meta user authorization + long-lived token | **Per customer account** | `meta_lead_connections` |
| Facebook Pages + encrypted Page tokens | **Per customer account** | `meta_lead_pages` |
| Instant Forms | **Per customer account** | `meta_lead_forms` |
| Leads (submissions + Workspace rows) | **Per customer account** | `meta_lead_submissions` / `flow_runs` |

Isolation guarantees:

- Every table carries `account_id` and is guarded by RLS
  (`is_account_member`); server/webhook writes use the service role.
- Tokens are AES-256-GCM encrypted and never returned to the browser.
- The `leadgen` webhook is a single shared endpoint; the tenant is
  resolved **server-side from the Page id** and never taken from the
  payload. An unknown Page is logged and ignored.
- **A Facebook Page may be connected to only one account.** Selecting a
  Page that is already connected elsewhere is rejected with a generic,
  non-identifying conflict; enforced in the route *and* by a global unique
  index on `meta_lead_pages.page_id` (migration `120`). This keeps the
  Page → account lookup unambiguous so no lead is ever dropped.
- Disconnecting one customer removes only that customer's authorization
  and Pages; other customers are untouched. Historical leads are kept.

## Onboarding multiple customers

The shared app must be published before *arbitrary* customers (people who
are not admins/testers/developers of the app) can authorize it:

1. **Business Verification** — verify the business that owns the Meta App
   (Business Settings → Security Center). Required for advanced access to
   lead data.
2. **App Review / Advanced Access** — request advanced access for the
   permissions the integration needs (`leads_retrieval`,
   `pages_manage_metadata`, `pages_show_list`,
   `pages_read_engagement`, `business_management`). In **Development
   mode** only the app's own admins/testers can authorize; every customer
   would fail the consent step.
3. **Switch the app to Live mode** (App Dashboard toggle) once the above
   are approved.
4. **Data handling** — Meta requires a link to a privacy policy and
   (for apps handling user data) a data-deletion callback/instructions.
5. Only after the app is Live can you repeat the per-customer steps in the
   checklist below for each new customer. **No new app, env change or
   App-Dashboard change is needed per customer** — they reuse the shared
   app, webhook URL and redirect URI.

To onboard a further customer: their Cub account **admin** opens
**Settings › Integrations › Meta → Lead capture → Connect Meta account**, then
selects their Pages, syncs forms and enables the forms they want. Done.

## Environment variables

All four are **required**; if any is missing the integration is disabled
(routes return `501`, the settings panel shows “Not configured”).

| Variable | Purpose |
| --- | --- |
| `META_LEAD_ADS_APP_ID` | The Meta App's numeric App ID. |
| `META_LEAD_ADS_APP_SECRET` | App Secret — verifies inbound webhook HMACs. Server-only. |
| `META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN` | Any long random string; typed into the App Dashboard webhook config and echoed back to Meta's GET challenge. |
| `META_GRAPH_VERSION` | e.g. `v21.0`. **Never hardcoded** — pin a currently-supported version. Validated against `^v\d+\.\d+$`. |

Optionally set `NEXT_PUBLIC_SITE_URL` so OAuth returns to the canonical host.

`META_LEAD_ADS_APP_SECRET` may differ from the WhatsApp `META_APP_SECRET`;
use whichever app owns the Pages/forms you connect.

## Meta App Dashboard setup

1. **Create / pick an app** (Business type) at
   <https://developers.facebook.com/apps>.
2. **Add the Webhooks product** → object **Page** → subscribe to the
   **`leadgen`** field. Callback URL:
   `https://<your-host>/api/integrations/meta-lead-ads/webhook`
   Verify token: the value of `META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN`.
3. **Facebook Login for Business** → add the Valid OAuth Redirect URI:
   `https://<your-host>/api/integrations/meta-lead-ads/callback`
4. **Permissions** (requested at consent):
   `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`,
   `leads_retrieval`, `business_management`.
5. Set the four env vars in the deployment / secrets manager and redeploy.

## In-app flow

1. **Settings › Integrations › Meta → Lead capture → Connect Meta account.** You are
   redirected to Meta; on success you return to the panel.
2. **Select Pages.** Selecting a Page verifies its Page token, subscribes the
   app to `leadgen`, and stores the token **encrypted**. The panel refuses to
   mark a Page “webhook verified” on OAuth alone — the subscription is
   re-read from Graph and must be confirmed. A Page already connected to
   another account is rejected up front (and any half-open subscription is
   rolled back), so a failed attempt leaves no partial record.
3. **Sync + enable forms.** Sync pulls the Page's Instant Forms; toggling a
   form **on** refreshes its questions from Graph and materializes (or
   refreshes) its Workspace table.
4. **Run diagnostics** checks configuration, token validity, granted
   permissions and each Page's webhook subscription. Diagnostics do **not**
   prove a live lead was received — only a real submission can.

## Testing with a real lead

1. Enable a form (it appears in the Workspace selector).
2. In Meta's **Lead Ads Testing Tool** (App Dashboard → Webhooks →
   Test, or the Ads Manager preview) submit a test lead for that form, or
   use the Page's form preview.
3. Within a few seconds the lead appears as a row in that form's Workspace
   table. If it does not, check the diagnostics panel and the server logs for
   `[meta-lead-ads]` entries.

## Reliability

- **Idempotent.** `meta_lead_submissions` is unique on
  `(account_id, meta_lead_id)`; duplicate webhook deliveries are ignored.
- **Bounded retries.** A failed Graph retrieval is retried with backoff
  (1m → 2m → 4m → 8m, capped at 30m, max 5 attempts). The webhook always
  acks `200` quickly (processing is deferred with `after()`), so Meta is
  never made to re-deliver a whole batch.
- **Retry endpoints.**
  - `POST /api/integrations/meta-lead-ads/retry` — admin. Optional body
    `{ "submission_id": "..." }` retries one; otherwise sweeps this
    account's due failures.
  - `GET /api/integrations/meta-lead-ads/cron` — protected by
    `AUTOMATION_CRON_SECRET` / `CRON_SECRET` (same as the other crons);
    sets up a global sweep. Point a scheduler at it, e.g. every 5 minutes.
- **Reauth.** Page tokens for long-lived user grants do not expire, so there
  is no refresh loop. If the user token is revoked, the connection is marked
  `needs_reauth` and the panel prompts to reconnect.

## Security notes

- Tokens are stored **AES-256-GCM-encrypted** with `ENCRYPTION_KEY` and are
  never returned to the browser.
- The OAuth `state` is encrypted **and** bound to a random nonce in an
  httpOnly cookie (10-minute TTL) — a CSRF double-check.
- Inbound webhooks are rejected unless `X-Hub-Signature-256` matches an
  HMAC-SHA256 of the **raw** body under the App Secret.
- The **account is resolved server-side** from the Page id; it is never taken
  from the webhook payload. Unknown Pages / disabled forms are ignored.
- Disconnecting removes the authorization and Page rows but **preserves
  historical leads** and disables the forms, so nothing is silently deleted.

## Manual steps checklist (to go live)

Deployment / platform (do once):

- [ ] Set `META_LEAD_ADS_APP_ID`, `META_LEAD_ADS_APP_SECRET`,
      `META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_VERSION` in prod.
- [ ] Apply migration `119_meta_lead_ads.sql`.
- [ ] Apply migration `120_meta_lead_pages_global_unique.sql`.
- [ ] Apply migration `121_meta_capi.sql` (only if you use the Conversions API —
      see [`meta-capi.md`](./meta-capi.md)).
- [ ] Configure the Page webhook (`leadgen`) + OAuth redirect URI in the App
      Dashboard.
- [ ] Complete Business Verification and request Advanced Access for the
      permissions, then **switch the app to Live mode** — required before
      any non-admin customer can connect.
- [ ] Add a privacy policy link and a data-deletion route (Meta requirement).
- [ ] Schedule the cron endpoint.

First customer:

- [ ] Connect the account and select at least one Page.
- [ ] Sync + enable a form and submit a test lead to confirm end-to-end.

Each additional customer:

- [ ] That customer's account admin connects the shared app, selects their
      Pages and enables their forms (no platform/app changes needed).
