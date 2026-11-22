// POST /api/integrations/meta-crm/manual-send
//
// The ONLY path that delivers a Lead Quality → Meta CRM event.
// Selecting or clearing a status never sends; this explicit action
// does, after the client shows the backend-generated preview
// (GET .../preview). Agent+ (same writers who may save the
// status); agents on Meta tables are additionally restricted to
// their own assigned leads, mirroring the save path.
//
// Flow:
//   1. re-assemble the preview from LIVE db state;
//   2. refuse gated states (400 + fresh preview, never a send);
//   3. refuse a stale preview_id (409 + fresh preview);
//   4. enqueue through the existing durable outbox (idempotent via
//      the ledger unique key — double taps collapse to one row);
//   5. schedule the targeted prompt drain (Meta stays OUTSIDE the
//      request path; the cron remains the fallback).
//
// Never fabricates identifiers: the payload is built by the shared
// builder at drain time from the committed ledger row. Never
// returns tokens. Retired CAPI untouched.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { isRunOwnedByUser } from "@/lib/flows/workspace-ownership";
import { enqueueLeadQualityEvent } from "@/lib/meta-crm/feedback";
import {
  assembleLeadQualityPreview,
  resolveManualFromQuality,
} from "@/lib/meta-crm/preview";

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await requireRole("agent");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const flowId = typeof body?.flow_id === "string" ? body.flow_id.trim() : "";
    const runId = typeof body?.run_id === "string" ? body.run_id.trim() : "";
    const previewId =
      typeof body?.preview_id === "string" ? body.preview_id.trim() : "";
    if (!flowId || !runId) {
      return NextResponse.json(
        { error: "flow_id and run_id are required." },
        { status: 400 },
      );
    }
    if (!previewId) {
      return NextResponse.json(
        { error: "preview_id is required. Fetch the preview first." },
        { status: 400 },
      );
    }

    // Same tenant + ownership rules as the status save path: the
    // run must belong to this account + flow, and agents on Meta
    // tables may only send for their own assigned leads.
    const { data: kindRow, error: kindErr } = await supabase
      .from("flows")
      .select("kind")
      .eq("id", flowId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (kindErr) throw kindErr;
    if (!kindRow) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }
    if (role === "agent" && (kindRow as { kind?: string | null }).kind === "meta_lead_ads") {
      const { resolveViewerCaps } = await import("@/lib/inbox/assignment-access");
      const caps = await resolveViewerCaps(supabase, accountId, userId, role);
      if (!caps.canManageAssignments) {
        const owned = await isRunOwnedByUser(supabase, {
          accountId,
          flowId,
          runId,
          userId,
        });
        if (!owned) {
          return NextResponse.json({ error: "Run not found." }, { status: 404 });
        }
      }
    }

    // Re-assemble from live state: the preview the user saw may be
    // stale (status/dataset/lead changed underneath).
    const preview = await assembleLeadQualityPreview(supabase, {
      accountId,
      flowId,
      runId,
    });
    if (!preview.sendable || !preview.previewId) {
      return NextResponse.json(
        {
          error: preview.message,
          reason: preview.reason,
          preview,
        },
        { status: 400 },
      );
    }
    if (preview.previewId !== previewId) {
      return NextResponse.json(
        {
          error:
            "The preview changed (status, dataset, or lead). Review the fresh preview and send again.",
          reason: "stale_preview",
          preview,
        },
        { status: 409 },
      );
    }

    // Chain from_quality off the lead's latest sent row so repeat
    // sends of an unchanged status collapse to "unchanged" instead
    // of fabricating new transitions.
    const fromQuality = await resolveManualFromQuality(supabase, {
      accountId,
      runId,
    });
    const outcome = await enqueueLeadQualityEvent(supabaseAdmin(), {
      accountId,
      flowId,
      runId,
      fromQuality,
      toQuality: preview.status,
      eventTimeIso: new Date().toISOString(),
      actorUserId: userId,
    });

    const { scheduleCrmDrainSoon } = await import("@/lib/meta-crm/trigger");
    if (outcome.enqueued) {
      // Targeted prompt drain for just this row; the pending-only
      // gate inside the drain keeps an already-sent duplicate from
      // ever being re-sent by a concurrent tap.
      scheduleCrmDrainSoon({ accountId, eventIds: [outcome.eventId] });
      const fresh = await assembleLeadQualityPreview(supabase, {
        accountId,
        flowId,
        runId,
      });
      return NextResponse.json({
        ok: true,
        queued: true,
        eventId: outcome.eventId,
        deduplicated: outcome.deduplicated,
        preview: fresh,
      });
    }

    // Unchanged (the latest ledger row already records this exact
    // status) or another skip — never a send, reported honestly.
    if (outcome.reason === "no_meta_lead" || outcome.reason === "disabled") {
      const fresh = await assembleLeadQualityPreview(supabase, {
        accountId,
        flowId,
        runId,
      });
      return NextResponse.json(
        { error: fresh.message, reason: fresh.reason, preview: fresh },
        { status: 400 },
      );
    }
    const fresh = await assembleLeadQualityPreview(supabase, {
      accountId,
      flowId,
      runId,
    });
    return NextResponse.json({
      ok: true,
      queued: false,
      deduplicated: true,
      reason: outcome.reason,
      preview: fresh,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
