// ============================================================
// Meta CRM feedback — prompt post-commit drain trigger.
//
// The durable outbox (`meta_crm_events`) is drained by the existing
// five-minute Meta Lead Ads cron sweep (fallback, unchanged). This
// module adds promptness: after a CRM event is COMMITTED, schedule
// a bounded drain that runs AFTER the HTTP response via Next.js
// `after()` — the same tracked background primitive the WhatsApp
// webhook, Sheets sync, and WhatsApp queue already use. A detached
// fire-and-forget promise may be aborted when the request ends, so
// it is never used here.
//
// Guarantees preserved:
//   * Meta API calls stay OUTSIDE the request path: the route
//     returns first; the drain runs post-response and can never
//     roll back or delay the committed DB writes.
//   * The drain is the same idempotent per-row-isolated
//     `drainCrmEventsQueue` the cron uses — overlapping runs
//     collapse safely via the pending/next_retry_at selection.
//   * Outside a request scope (unit tests, cron-inline callers)
//     `after()` throws; that is swallowed and the cron fallback
//     covers the rows. Never throws to callers.
//
// Meta-only. No new env vars; no new cron schedule.
// ============================================================

import { after } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";

import { CRM_DRAIN_LIMIT, drainCrmEventsQueue } from "./feedback";

/**
 * Schedule a bounded prompt drain after the response. Call from a
 * CRM feedback write path AFTER its DB writes committed. Safe
 * outside request scope (becomes a no-op covered by the cron
 * fallback).
 */
export function scheduleCrmDrainSoon(opts: { accountId?: string; eventIds?: string[] } = {}): void {
  try {
    after(() => {
      drainCrmEventsQueue(supabaseAdmin(), {
        limit: CRM_DRAIN_LIMIT,
        ...(opts.accountId ? { onlyAccountId: opts.accountId } : {}),
        // Targeted drain for manual sends: restrict to the just
        // committed row(s) so one tap can never sweep unrelated
        // rows early. The pending-only gate inside the drain still
        // applies, so an already-sent duplicate is never re-sent.
        ...(opts.eventIds && opts.eventIds.length > 0 ? { eventIds: opts.eventIds } : {}),
      }).catch((err) => {
        console.error(
          "[meta-crm] prompt drain failed (cron fallback covers):",
          err instanceof Error ? err.message : err,
        );
      });
    });
  } catch {
    // Not in a request scope — the five-minute cron drain covers it.
  }
}
