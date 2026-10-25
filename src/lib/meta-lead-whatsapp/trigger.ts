// ============================================================
// Meta Lead Ads → WhatsApp auto-send — prompt post-commit drain.
//
// The durable outbox (`meta_lead_whatsapp_queue`) is drained by
// the existing five-minute meta-lead-ads cron (fallback,
// unchanged). This module adds promptness: after a Meta lead is
// processed and enqueued, schedule a bounded drain that runs
// AFTER the HTTP response via Next.js `after()` — the same
// tracked background primitive the WhatsApp webhook, broadcasts,
// and Meta Sheets drain already use. A detached fire-and-forget
// promise is never used here (it may be aborted when the request
// ends); `after()` hands the callback to the runtime.
//
// Guarantees preserved:
//   * Meta API calls stay OUTSIDE the request path: the route
//     returns first; the drain runs post-response and can never
//     roll back or delay the committed lead.
//   * The drain is the same idempotent, claim-guarded,
//     per-account-scoped `drainWhatsappQueue` the cron uses —
//     overlapping runs (webhook + click + cron) collapse safely.
//   * Outside a request scope (unit tests, cron-inline callers)
//     `after()` throws; that is swallowed and the cron fallback
//     covers the rows. Never throws to callers.
//
// Meta-only. No Flow Tables imports; no new env vars; no new cron.
// ============================================================

import { after } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";

import { drainWhatsappQueue } from "./queue";

/** Bounded rows per prompt drain (same budget as the cron sweep). */
export const PROMPT_DRAIN_LIMIT = 20;

/**
 * Schedule a bounded prompt drain after the response. Call from a
 * Meta lead ingestion path AFTER its DB writes committed. Safe
 * outside request scope (becomes a no-op covered by the cron
 * fallback).
 */
export function scheduleWhatsappDrainSoon(
  opts: { accountId?: string } = {},
): void {
  try {
    after(() => {
      drainWhatsappQueue(supabaseAdmin(), {
        limit: PROMPT_DRAIN_LIMIT,
        ...(opts.accountId ? { onlyAccountId: opts.accountId } : {}),
      }).catch((err) => {
        console.error(
          "[meta-whatsapp] prompt drain failed (cron fallback covers):",
          err instanceof Error ? err.message : err,
        );
      });
    });
  } catch {
    // Not in a request scope — the five-minute cron drain covers it.
  }
}
