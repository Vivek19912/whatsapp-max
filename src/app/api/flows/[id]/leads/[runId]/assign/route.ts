import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { manualAssign } from "@/lib/lead-assignment/service";
import { hasPriorAssignment } from "@/lib/lead-assignment/table-helpers";
import { getTableConfig } from "@/lib/lead-assignment/table-config";
import { enqueueTableAssignmentNotifications } from "@/lib/lead-assignment/table-notify";
import { salespersonKeyFor } from "@/lib/meta-lead-whatsapp/assignee-sequences";
import {
  cancelLateGlobalRows,
  maybeEnqueueAssigneeSequence,
  prepareManualAssigneeHandoff,
} from "@/lib/meta-lead-whatsapp/queue";
import { ASSIGNED_TO_UNASSIGNED } from "@/lib/flows/workspace-assignee";
import { maybeEnqueueForRun } from "@/lib/meta-lead-ads/notify";
import { scheduleSheetsDrainSoon } from "@/lib/meta-lead-sheets/trigger";
import { scheduleWhatsappDrainSoon } from "@/lib/meta-lead-whatsapp/trigger";
import { supabaseAdmin } from "@/lib/flows/admin-client";

/**
 * POST /api/flows/[id]/leads/[runId]/assign — manually assign (or
 * clear) one Meta lead. Admin+.
 *
 * Reassignment is an admin-only operation: agents work their own
 * assigned leads but cannot move leads between members (that would
 * bypass per-agent ownership). Meta-gated: the service rejects
 * non-Meta flows outright, so Flow Tables can never reach this
 * path. Writes the same Assigned To workspace cell the table
 * displays, and records an audit event (actor, previous, new).
 * Never touches algorithm state, and later Meta updates won't
 * overwrite the manual owner (auto-assign skips owned rows).
 *
 * Body: { user_id: string | "Unassigned" | null }.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  try {
    const { id, runId } = await params;
    const { supabase, accountId, userId } = await requireRole("admin");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!("user_id" in body)) {
      return NextResponse.json({ error: "user_id is required." }, { status: 400 });
    }
    const user_id = body.user_id as string | null;

    // The flow's form links the audit event to its Meta table.
    const { data: flow, error: flowErr } = await supabase
      .from("flows")
      .select("meta_form_id")
      .eq("id", id)
      .eq("account_id", accountId)
      .maybeSingle();
    if (flowErr) throw flowErr;
    const formId = (flow as { meta_form_id: string | null } | null)?.meta_form_id ?? null;

    try {
      // Prior assignment history must be read BEFORE the write
      // below records this assignment's own event.
      const wasPreviouslyAssigned = await hasPriorAssignment(supabaseAdmin(), accountId, runId).catch(() => true);
      const result = await manualAssign(supabase, {
        accountId,
        flowId: id,
        runId,
        formId,
        newUserId: user_id,
        actorUserId: userId,
      });
      // A lead assigned after ingestion is notified now (unless it
      // was already notified). Clearing/Unassigning never notifies.
      // `customer_sequence` reports the manual-initial handoff with
      // the global auto-send (null when cleared).
      let customerSequence: {
        started: boolean;
        reason: string;
        cancelled_global: number;
      } | null = null;
      let legacyEmailEnqueued = false;
      if (result.current && result.current !== ASSIGNED_TO_UNASSIGNED) {
        const legacy = await maybeEnqueueForRun(supabaseAdmin(), {
          accountId,
          runId,
          assigneeUserId: result.current,
        });
        // Skip the per-table email channel only when the legacy
        // queue actually took the email — otherwise the salesperson
        // would get two emails (one per outbox). Any other legacy
        // outcome (account setting off, missing submission, error,
        // or a duplicate from an earlier assignment) falls through
        // to the per-table outbox below so Email alerts still
        // produce exactly one attempt — including for a reassigned
        // lead's new owner, whom the legacy per-submission dedup
        // can never notify.
        legacyEmailEnqueued = legacy.enqueued;
        // Manual assignments never ran through the per-table
        // outbox, so a reassigned lead's new owner would otherwise
        // get nothing: notify them here (WhatsApp + email per the
        // table's toggles).
        // A genuine initial manual assignment additionally starts
        // the new owner's salesperson sequence, if configured.
        // Reassignments never touch customer templates.
        //
        // Manual-initial handoff with the global auto-send: the lead
        // may have arrived unassigned with global rows already
        // queued. Pending global rows are cancelled first so the two
        // sequences can never mix; when a global message already sent
        // (or is in flight) the salesperson sequence is NOT started
        // and the reason is returned + recorded below.
        try {
          const isInitial =
            (result.previous == null || result.previous === ASSIGNED_TO_UNASSIGNED) &&
            !wasPreviouslyAssigned;
          const detail = await getTableConfig(supabaseAdmin(), accountId, id);
          const assignee = detail?.assignees.find((a) => a.user_id === result.current);
          if (detail && assignee && (assignee.notify_email || assignee.notify_whatsapp)) {
            await enqueueTableAssignmentNotifications(supabaseAdmin(), {
              accountId,
              detail,
              assignee,
              runId,
              formId,
              skipEmail: legacyEmailEnqueued,
            });
          }
          if (isInitial && formId) {
            const key = salespersonKeyFor({ user_id: result.current });
            if (key) {
              let handoff: {
                decision: "start-assignee" | "keep-global";
                reason: string;
                cancelled: number;
                submissionId: string | null;
              };
              try {
                handoff = await prepareManualAssigneeHandoff(supabaseAdmin(), {
                  accountId,
                  flowRunId: runId,
                });
              } catch {
                // Fail closed: without reliable queue state we must
                // not risk a mixed global + salesperson send.
                handoff = { decision: "keep-global", reason: "handoff-error", cancelled: 0, submissionId: null };
              }
              if (handoff.decision === "start-assignee") {
                const queued = await maybeEnqueueAssigneeSequence(supabaseAdmin(), {
                  accountId,
                  formId,
                  flowRunId: runId,
                  assigneeKey: key,
                });
                // Reconcile late global arrivals: an ingestion worker
                // may have committed global rows after the handoff
                // scan above. Delete them (conditional — a started
                // send always wins), then re-enqueue idempotently to
                // fill any unique-key gaps they caused. Best-effort;
                // the assignment above already succeeded.
                let lateCancelled = 0;
                let lateRaced = false;
                try {
                  if (handoff.submissionId) {
                    const late = await cancelLateGlobalRows(supabaseAdmin(), {
                      accountId,
                      submissionId: handoff.submissionId,
                    });
                    lateCancelled = late.cancelled;
                    lateRaced = late.sent > 0 || late.sending > 0;
                  }
                } catch {
                  // Reconciliation is best-effort.
                }
                let fillEnqueued = 0;
                let fillQueued = 0;
                if (lateCancelled > 0) {
                  const fill = await maybeEnqueueAssigneeSequence(supabaseAdmin(), {
                    accountId,
                    formId,
                    flowRunId: runId,
                    assigneeKey: key,
                  });
                  fillEnqueued = fill.enqueued;
                  fillQueued = fill.alreadyQueued;
                }
                const started =
                  queued.enqueued > 0 ||
                  queued.alreadyQueued > 0 ||
                  fillEnqueued > 0 ||
                  fillQueued > 0;
                if (queued.enqueued > 0 || fillEnqueued > 0) scheduleWhatsappDrainSoon({ accountId });
                customerSequence = {
                  started,
                  reason: !started
                    ? "no-sequence"
                    : lateRaced
                      ? "global-send-raced"
                      : queued.enqueued > 0 || fillEnqueued > 0
                        ? handoff.reason
                        : "already-queued",
                  cancelled_global: handoff.cancelled + lateCancelled,
                };
              } else {
                customerSequence = {
                  started: false,
                  reason: handoff.reason,
                  cancelled_global: handoff.cancelled,
                };
              }
              // Best-effort audit: attach the handoff outcome to this
              // assignment's own event row (meta JSONB).
              try {
                let metaUpdate = supabaseAdmin()
                  .from("lead_assignment_events")
                  .update({ meta: { customer_sequence: customerSequence } })
                  .eq("account_id", accountId)
                  .eq("flow_run_id", runId)
                  .eq("kind", "manual")
                  .eq("assigned_user_id", result.current)
                  .eq("created_by", userId);
                metaUpdate =
                  result.previous == null
                    ? metaUpdate.is("previous_user_id", null)
                    : metaUpdate.eq("previous_user_id", result.previous);
                await metaUpdate;
              } catch {
                // Audit-only; the assignment above already succeeded.
              }
            }
          } else if (result.current && result.current !== ASSIGNED_TO_UNASSIGNED) {
            // Reassignment: notify-only by construction — no handoff,
            // no cancellation, no customer templates.
            customerSequence = { started: false, reason: "reassignment", cancelled_global: 0 };
          }
        } catch {
          // Best-effort only; the assignment above already succeeded.
        }
      }
      // ADDITIVE prompt Meta Sheets sync — the service already queued
      // the row update (best-effort, Meta-only); schedule the bounded
      // post-response drain. Tracked `after()`, never detached; the
      // cron remains the fallback. Never fails the assignment.
      scheduleSheetsDrainSoon({ accountId });
      return NextResponse.json({ assignment: result, customer_sequence: customerSequence });
    } catch (err) {
      const raw =
        err instanceof Error
          ? (err as unknown as { status?: unknown }).status
          : undefined;
      const status = typeof raw === "number" && raw !== 500 ? raw : 400;
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid assignment." },
        { status },
      );
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
