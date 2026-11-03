// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers, isAccountRole, type AccountRole } from "@/lib/auth/roles";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import type { AccountMember } from "@/types";

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  account_role: string;
  created_at: string;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // RLS on profiles allows reading any row whose account matches
    // the caller's, so this query is naturally account-scoped.
    const { data, error } = await ctx.supabase
      .from("profiles")
      .select("user_id, full_name, email, avatar_url, account_role, created_at")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[GET /api/account/members] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    const canSeeEmails = canManageMembers(ctx.role);

    // Inbox permission flags for the Team Members Access UI. Owner-only:
    // agents must not learn who else holds grants. Single batched
    // lookup, merged below; absent row = no grants.
    let grantsByUser = new Map<string, { can_manage_assignments: boolean; can_view_all: boolean }>();
    if (ctx.role === "owner") {
      const { data: grants, error: grantsError } = await ctx.supabase
        .from("agent_inbox_permissions")
        .select("user_id, can_manage_assignments, can_view_all")
        .eq("account_id", ctx.accountId);
      if (grantsError) {
        console.error("[GET /api/account/members] grants fetch error:", grantsError);
        return NextResponse.json(
          { error: "Failed to load members" },
          { status: 500 },
        );
      }
      grantsByUser = new Map(
        ((grants ?? []) as Array<{
          user_id: string;
          can_manage_assignments: boolean;
          can_view_all: boolean;
        }>).map((g) => [
          g.user_id,
          {
            can_manage_assignments: g.can_manage_assignments === true,
            can_view_all: g.can_view_all === true,
          },
        ]),
      );
    }

    // Effective recording sources in one batched lookup (absent
    // row = 'none'). Same request, never N+1.
    const { data: settings, error: settingsError } = await ctx.supabase
      .from("user_recording_settings")
      .select("user_id, whatsapp_recording_source, phone_recording_source, phone_recording_number")
      .eq("account_id", ctx.accountId);
    if (settingsError) {
      console.error("[GET /api/account/members] settings fetch error:", settingsError);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }
    const sourceByUser = new Map(
      ((settings ?? []) as Array<{
        user_id: string;
        whatsapp_recording_source: string;
        phone_recording_source: string;
        phone_recording_number: string | null;
      }>).map((s) => [s.user_id, s] as const),
    );

    const members: AccountMember[] = (data as ProfileRow[]).flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.account_role)) return [];
      const setting = sourceByUser.get(row.user_id);
      const whatsapp = setting?.whatsapp_recording_source;
      const phone = setting?.phone_recording_source;
      const phoneNumber =
        typeof setting?.phone_recording_number === "string" &&
        setting.phone_recording_number.length > 0
          ? setting.phone_recording_number
          : null;
      return [
        {
          user_id: row.user_id,
          full_name: row.full_name ?? "",
          email: canSeeEmails ? row.email : null,
          avatar_url: row.avatar_url,
          role: row.account_role,
          joined_at: row.created_at,
          whatsapp_recording_source:
            whatsapp === "whatsapp" || whatsapp === "whatsapp_business" ? whatsapp : "none",
          phone_recording_source:
            phone === "sim1" || phone === "sim2" ? phone : "none",
          phone_recording_number: phoneNumber,
          // Inbox grants ride along for owners only (see fetch above);
          // agents/viewers never receive other members' flags.
          ...(ctx.role === "owner"
            ? {
                can_manage_assignments:
                  grantsByUser.get(row.user_id)?.can_manage_assignments ?? false,
                can_view_all: grantsByUser.get(row.user_id)?.can_view_all ?? false,
              }
            : {}),
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// ============================================================
// POST /api/account/members — owner creates a user directly.
//
// Replaces invitation links for new users: the OWNER supplies
// name + email + password, and the user exists (confirmed,
// member of this account, profile full_name set, role agent)
// when the call returns.
//
// Server-side, all derived from the session — never trusted
// from the browser:
//   1. requireRole("owner") — only the account owner.
//   2. account = caller's account (ctx.accountId).
//   3. email trimmed + lowercased; format-checked.
//   4. password ≥ 6 chars (matches the signup-page policy).
//   5. role is always agent — an explicit non-agent role value
//      is rejected, so crafted requests cannot escalate.
//   6. admin.createUser({ email_confirm: true }) — no verification
//      mail, immediate login. Duplicate email → 409, existing
//      user untouched.
//   7. The signup trigger auto-creates a personal account +
//      owner-profile for the new id; we MOVE that profile row
//      into this account with the requested role and delete the
//      orphan personal account (same shape as invite redemption).
//      If the trigger row is missing, we insert the profile
//      directly instead.
//   8. If anything after Auth creation fails, ONLY the just-
//      created Auth user is deleted (rollback). Never broad.
// ============================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 6;
// Display-name ceiling — matches the existing name conventions
// (account/API-key/invite-label names all cap at 80). Rejected,
// never truncated: silently shortening someone's name would store
// a value they didn't enter.
const MAX_NAME_LEN = 80;
// Add User always creates Agents — there is no role picker in the
// UI, and any client-supplied role is rejected below so a crafted
// request cannot escalate to admin/viewer/owner.

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("owner");

    const limit = checkRateLimit(
      `owner:createUser:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      email?: unknown;
      password?: unknown;
      role?: unknown;
      name?: unknown;
    } | null;

    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json(
        { error: "A name is required." },
        { status: 400 }
      );
    }
    if (name.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: `Name must be ${MAX_NAME_LEN} characters or fewer.` },
        { status: 400 }
      );
    }
    const email =
      typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json(
        { error: "A valid email address is required." },
        { status: 400 }
      );
    }
    if (typeof body?.password !== "string" || body.password.length < MIN_PASSWORD_LEN) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` },
        { status: 400 }
      );
    }
    // Add User always creates Agents. An explicit "agent" (what the
    // UI sends) or an absent role is accepted; anything else —
    // admin, viewer, owner, or garbage — is rejected so a crafted
    // request can never mint a privileged or unknown role.
    if (body?.role !== undefined && body.role !== "agent") {
      return NextResponse.json(
        { error: "New users are always created as agents." },
        { status: 400 }
      );
    }
    const role: AccountRole = "agent";

    const admin = supabaseAdmin();

    // Supabase Auth is the uniqueness authority: a duplicate email
    // fails here with the existing user completely untouched (no
    // password/role/account changes, no new profile — we return
    // before touching anything else).
    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email,
        password: body.password as string,
        email_confirm: true,
        // The signup trigger reads raw_user_meta_data->>'full_name'
        // into profiles.full_name — the name lands on the profile
        // row through the existing trigger path, not a side write.
        user_metadata: { full_name: name },
      });
    if (createError || !created?.user) {
      const message = `${createError?.message ?? ""} ${createError?.code ?? ""}`;
      if (/already (registered|exists)|duplicate|taken/i.test(message)) {
        return NextResponse.json(
          { error: "A user with this email already exists." },
          { status: 409 }
        );
      }
      console.error("[POST /api/account/members] auth create error:", createError?.message);
      return NextResponse.json(
        { error: "Failed to create user." },
        { status: 500 }
      );
    }
    const newUserId = created.user.id as string;

    // Move the trigger-created profile (personal owner account)
    // into this account with the requested role. Fall back to a
    // direct insert if the trigger row is somehow missing.
    try {
      const { data: freshProfile, error: profileError } = await admin
        .from("profiles")
        .select("account_id")
        .eq("user_id", newUserId)
        .maybeSingle();
      if (profileError) throw profileError;
      const orphanAccountId = (freshProfile as { account_id?: string } | null)?.account_id ?? null;

      if (orphanAccountId) {
        // full_name is set explicitly (not just trusted from the
        // trigger) so the submitted name wins even if trigger
        // metadata handling ever changes.
        const { error: moveError } = await admin
          .from("profiles")
          .update({ account_id: ctx.accountId, account_role: role, full_name: name })
          .eq("user_id", newUserId);
        if (moveError) throw moveError;
        // Delete the orphan personal account only when nothing
        // else points at it (defensive — it should be empty now).
        const { data: remaining, error: remainingError } = await admin
          .from("profiles")
          .select("user_id")
          .eq("account_id", orphanAccountId)
          .limit(1);
        if (remainingError) throw remainingError;
        if ((remaining ?? []).length === 0) {
          const { error: deleteError } = await admin
            .from("accounts")
            .delete()
            .eq("id", orphanAccountId);
          if (deleteError) throw deleteError;
        }
      } else {
        const { error: insertError } = await admin.from("profiles").insert({
          user_id: newUserId,
          full_name: name,
          email,
          account_id: ctx.accountId,
          account_role: role,
        });
        if (insertError) throw insertError;
      }
    } catch (dbError) {
      // Roll back ONLY the Auth user this call just created —
      // never any pre-existing user.
      await admin.auth.admin.deleteUser(newUserId).catch(() => undefined);
      console.error("[POST /api/account/members] membership setup failed, rolled back:", dbError);
      return NextResponse.json(
        { error: "Failed to create user." },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        member: {
          user_id: newUserId,
          full_name: name,
          email,
          avatar_url: null,
          role,
          joined_at: new Date().toISOString(),
        },
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
