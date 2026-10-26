import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  getTableConfig,
  resolveTableFlow,
  saveTableConfig,
  type AvailabilityView,
  type TableConfigDetail,
} from "@/lib/lead-assignment/table-config";
import { isPausedAt, resolveEligibleAssignees } from "@/lib/lead-assignment/table-assignment";
import { formatPausedUntil } from "@/lib/lead-assignment/table-validation";
import { eligibleMemberIds } from "@/lib/lead-assignment/members";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/flows/[id]/assignment — this table's assignment
 * settings with live per-assignee availability. Works for Meta
 * Lead Ads tables and Flow tables (both render in Workspace).
 *
 * Members+ may view. Contact details (email/phone) are only
 * returned to owner/admin roles — agents and viewers see names,
 * weights, and availability, never private contact channels.
 */
export async function GET(_request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const ctx = await getCurrentAccount();
    // Contact details are private to owner/admin: the flow gate
    // runs on the caller's RLS client (proves table access), then
    // the config loads through the service role with explicit
    // account+flow scoping and masks emails/phones for other
    // roles. No service-role result ever reaches the browser
    // unscoped.
    const gate = await resolveTableFlow(ctx.supabase, ctx.accountId, id);
    if (!gate) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }
    const detail = await getTableConfig(supabaseAdmin(), ctx.accountId, id);
    if (!detail) {
      // No settings saved yet (the table itself resolved above).
      return NextResponse.json({
        flow: { id: gate.flowId, kind: gate.kind, form_db_id: gate.formDbId },
        config: null,
      });
    }
    const privileged = ctx.role === "owner" || ctx.role === "admin";
    const now = Date.now();
    // Eligibility is computed server-side on the scoped admin
    // client (the flow gate above already proved table access);
    // contact masking below is what protects privacy per role.
    const admin = supabaseAdmin();
    const eligibleIds = new Set(
      (await resolveEligibleAssignees(admin, ctx.accountId, detail, now)).map(
        (a) => a.id,
      ),
    );
    // Live roster check for internal links (removed/demoted
    // members surface as ineligible without touching config).
    const { data: rosterRows } = await admin
      .from("profiles")
      .select("user_id, account_role")
      .eq("account_id", ctx.accountId);
    const rosterOk = new Set(
      eligibleMemberIds(
        ((rosterRows ?? []) as Array<{ user_id: unknown; account_role: unknown }>).map(
          (r) => ({ user_id: r.user_id, role: r.account_role }),
        ),
      ),
    );
    const availability: AvailabilityView[] = detail.assignees.map((a) => {
      const paused = isPausedAt(a, now);
      let unavailable_reason: AvailabilityView["unavailable_reason"] = null;
      if (!a.is_active) unavailable_reason = "active";
      else if (paused) unavailable_reason = "paused";
      else if (a.user_id && !rosterOk.has(a.user_id)) {
        unavailable_reason = "ineligible-member";
      } else if (!eligibleIds.has(a.id)) {
        unavailable_reason = "paused";
      }
      const status_label = !a.is_active
        ? "Inactive"
        : paused && a.paused_until
          ? formatPausedUntil(a.paused_until, detail.timezone)
          : "Available";
      const base = {
        ...a,
        email: privileged ? a.email : null,
        phone: privileged ? a.phone : null,
        available: unavailable_reason === null,
        unavailable_reason,
        status_label,
      };
      return base;
    });
    return NextResponse.json({
      flow: { id: detail.flow_id, kind: detail.kind, form_db_id: detail.form_db_id },
      config: {
        id: detail.id,
        enabled: detail.enabled,
        mode: detail.mode,
        timezone: detail.timezone,
        whatsapp_template_name: privileged ? detail.whatsapp_template_name : null,
        whatsapp_template_language: detail.whatsapp_template_language,
      },
      assignees: availability,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PUT /api/flows/[id]/assignment — create or replace this table's
 * assignment settings. Owner-only. One table's save never touches
 * another table's config, state, history, or leads.
 */
export async function PUT(request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const ctx = await requireRole("owner");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const detail = await saveTableConfig(ctx.supabase, {
      accountId: ctx.accountId,
      flowId: id,
      input: {
        enabled: body.enabled,
        mode: body.mode,
        timezone: body.timezone,
        whatsapp_template_name: body.whatsapp_template_name,
        whatsapp_template_language: body.whatsapp_template_language,
        assignees: body.assignees,
      },
    });
    return NextResponse.json({ ok: true, config: serializeDetail(detail) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function serializeDetail(detail: TableConfigDetail) {
  return {
    id: detail.id,
    flow_id: detail.flow_id,
    enabled: detail.enabled,
    mode: detail.mode,
    timezone: detail.timezone,
    whatsapp_template_name: detail.whatsapp_template_name,
    whatsapp_template_language: detail.whatsapp_template_language,
    assignees: detail.assignees,
  };
}
