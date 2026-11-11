import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  canActOnConversation,
  resolveViewerCaps,
} from "@/lib/inbox/assignment-access";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  countDistinctMetaTablesForContact,
  mirrorConversationAssignmentToWorkspace,
} from "@/lib/inbox/assignment-sync";

// ============================================================
// POST /api/inbox/conversations/[id]/assign — assign (or unassign)
// one Inbox conversation AND mirror it to the Workspace.
//
// Body: { user_id: string | null } — member user_id, or null to
// unassign. Validation mirrors the Workspace Assigned To rules:
// UUID member of this account, or null.
//
// Assignment authority: owners/admins, plus agents holding the
// Manage Assignments permission (resolved server-side). Agents
// without the grant — including View All-only agents and agents
// acting on their own threads — are rejected without an oracle
// (404), exactly like the thread-header dropdown (read-only for
// them) suggests. Hiding the UI is not the enforcement; this
// gate is.
//
// Writes BOTH stores so the two surfaces can never disagree:
//   1. conversations.assigned_agent_id (what the Inbox header and
//      list render; realtime postgres_changes notifies open tabs),
//   2. the contact's Assigned To workspace cell(s) (what the Workspace
//      table renders; the workspace realtime hook picks up the change).
// Multi-table safety: a contact linked to MORE THAN ONE distinct Meta
// Lead Ads table is rejected with 409 BEFORE any write, so one Inbox
// action can never bulk-overwrite independent Workspace leads. The
// user must reassign from the relevant Workspace table instead.
// Agent+ entry (viewers 403 via requireRole); the authority gate
// below admits only owners/admins and Manage Assignments holders.
// The conversation must belong to the caller's account or the
// request 404s without disclosing cross-tenant existence. Reassignments from the Workspace flow
// back through the same columns, so Inbox-initiated changes never
// fight Workspace-initiated ones — last writer wins per row.
// ============================================================

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(message = "Conversation not found.") {
  return NextResponse.json({ error: message }, { status: 404 });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx;
  try {
    // Agent+ entry (viewers 403); the authority gate below admits
    // only owners/admins and Manage Assignments holders.
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const { id } = await params;
  if (typeof id !== "string" || !UUID_RE.test(id)) return notFound();

  const body = await _request.json().catch(() => null);
  if (!body || typeof body !== "object" || !("user_id" in body)) {
    return NextResponse.json({ error: "user_id is required." }, { status: 400 });
  }
  const userId = (body as { user_id: unknown }).user_id;
  if (userId !== null && (typeof userId !== "string" || !UUID_RE.test(userId))) {
    return NextResponse.json(
      { error: "user_id must be a member id or null." },
      { status: 400 },
    );
  }

  // Tenant check + current value (404 covers missing AND foreign).
  // Uses the service-role client: agents with Manage Assignments must
  // be able to read threads they cannot yet see (RLS would hide them),
  // and the explicit checks below re-establish every boundary RLS
  // would otherwise enforce — account scoping on every statement,
  // assignee-gated writes, roster-validated targets.
  const admin = supabaseAdmin();
  const caps = await resolveViewerCaps(
    admin,
    ctx.accountId,
    ctx.userId,
    ctx.role
  );
  // Assignment authority gate FIRST: only owners/admins and agents
  // holding Manage Assignments may change assignments at all — no
  // own-thread exception (the header dropdown is read-only for
  // everyone else, and the API must not offer a wider path than
  // the UI). 404 (not 403) avoids confirming an invisible thread
  // exists, and reveals nothing about which grant is missing.
  if (
    ctx.role !== "owner" &&
    ctx.role !== "admin" &&
    !(ctx.role === "agent" && caps.canManageAssignments)
  ) {
    return notFound();
  }
  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select("id, account_id, assigned_agent_id, contact_id")
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (convErr || !conv) return notFound();

  // Multi-table ambiguity gate — BEFORE any ownership write, for
  // every role (owner/admin/Manage Assignments cannot bypass). Counts
  // DISTINCT Meta Lead Ads tables for this contact; duplicates in the
  // same table count as one, non-Meta tables are ignored.
  //   0 tables → existing non-Meta behavior (no Workspace mirror).
  //   1 table  → allow; mirror syncs that table's leads.
  //   >1 table → 409, no writes at all.
  // Lookup failures fail safely (503): never allow a blind write when
  // the ambiguity check itself could not be determined.
  {
    const contactId = (conv as { contact_id: string | null }).contact_id ?? null;
    if (contactId) {
      const tableCheck = await countDistinctMetaTablesForContact(
        admin as never,
        ctx.accountId,
        contactId,
      );
      if (tableCheck.error) {
        return NextResponse.json(
          {
            error: "Could not verify lead table ownership. Please try again.",
            code: "TABLE_CHECK_FAILED",
          },
          { status: 503 },
        );
      }
      if (tableCheck.count > 1) {
        return NextResponse.json(
          {
            error:
              "This contact exists in multiple Meta Lead Ads tables. Please reassign this lead from the relevant Workspace table.",
            code: "CONTACT_IN_MULTIPLE_META_LEAD_ADS_TABLES",
            distinctMetaTables: tableCheck.count,
          },
          { status: 409 },
        );
      }
    }
  }

  // Defense in depth: owners/admins may touch any thread; agents
  // here always hold Manage Assignments (see the gate above), which
  // grants any-thread assignment (still never full read access; see
  // the Inbox visibility rules). Viewers can never assign.
  const assigned =
    (conv as { assigned_agent_id: string | null }).assigned_agent_id ?? null;
  // canActOnConversation covers owner/admin + own threads; the caps
  // argument additionally admits agents holding Manage Assignments.
  if (
    !canActOnConversation(
      { role: ctx.role, userId: ctx.userId },
      assigned,
      caps
    )
  ) {
    return notFound();
  }

  // Members only — same roster rule as Workspace assignment.
  // Service-role read: the target row may belong to a thread the
  // caller cannot see (manage-assignments flow), but the account
  // scoping below keeps it strictly in-tenant.
  if (userId !== null) {
    const { data: member, error: memberErr } = await admin
      .from("profiles")
      .select("user_id")
      .eq("account_id", ctx.accountId)
      .eq("user_id", userId)
      .maybeSingle();
    if (memberErr) {
      return NextResponse.json(
        { error: "Could not verify team member." },
        { status: 500 },
      );
    }
    if (!member) {
      return NextResponse.json(
        { error: "Choose a team member from this account." },
        { status: 400 },
      );
    }
  }

  // Write via the service-role client: a manage-assignments agent
  // legitimately updates threads RLS hides from them, and every
  // boundary (tenant, gate, roster) was already enforced above.
  const { error: updateErr } = await admin
    .from("conversations")
    .update({ assigned_agent_id: userId })
    .eq("id", id)
    .eq("account_id", ctx.accountId);
  if (updateErr) {
    console.error("[inbox/assign] conversation update failed:", {
      message: updateErr.message,
      code: updateErr.code,
    });
    return NextResponse.json(
      { error: "Could not update assignment." },
      { status: 500 },
    );
  }

  // Mirror into the Workspace cell (best-effort: the Inbox write
  // above already succeeded and realtime already notified tabs).
  // Service-role client: the workspace_values RLS policies gate on
  // membership, and the route already proved (account, member);
  // the helper re-scopes every statement by account anyway.
  try {
    const mirrored = await mirrorConversationAssignmentToWorkspace(
      supabaseAdmin(),
      ctx.accountId,
      id,
      userId,
    );
    if (!mirrored) {
      console.error("[inbox/assign] workspace mirror skipped", {
        conversation: id.slice(0, 8),
      });
    }
  } catch (err) {
    console.error("[inbox/assign] workspace mirror failed:", err);
  }

  return NextResponse.json({ assigned_agent_id: userId });
}
