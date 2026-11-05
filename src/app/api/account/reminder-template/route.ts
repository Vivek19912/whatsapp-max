import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { hasMinRole } from "@/lib/auth/roles";

/**
 * GET/PUT /api/account/reminder-template — fallback template for
 * WhatsApp reminders sent outside the 24-hour customer-service
 * window ({{1}} = reminder message).
 *
 *   GET — { template_name, template_language } (nulls when
 *     unconfigured). Any member. Agents resolve their PERSONAL
 *     setting first (`profiles.reminder_template_*` for the
 *     authenticated user) and fall back to the account default
 *     (`accounts.*`) when unset — back-compat with previously
 *     saved configuration. Owner/admin/viewer read the account
 *     default exactly as before.
 *   PUT — { template_name: string | null, template_language?: string }
 *     Agent+. Admins/owners write the account default (`accounts.*`,
 *     existing behavior); agents write ONLY their own personal
 *     setting (`profiles.*` scoped to the authenticated user id, so
 *     Agent A can never overwrite Agent B). Viewers stay read-only.
 *     A named template must exist in this account, be APPROVED, and
 *     carry exactly one {{1}} body variable — anything else 400s.
 */

const MAX_NAME_LEN = 120;

function countBodyVariables(bodyText: unknown): number | null {
  if (typeof bodyText !== "string") return null;
  const matches = bodyText.match(/\{\{(\d+)\}\}/g) ?? [];
  const indices = matches.map((m) => Number(m.slice(2, -2)));
  if (indices.length === 0) return 0;
  if (indices.some((n) => n !== 1)) return -1;
  return indices.length;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    // Agents: personal setting first, account default as fallback.
    // A missing profiles column (pre-migration schema) degrades to
    // the account default instead of breaking the read.
    if (ctx.role === "agent") {
      try {
        const { data: personal } = await ctx.supabase
          .from("profiles")
          .select("reminder_template_name, reminder_template_language")
          .eq("user_id", ctx.userId)
          .maybeSingle();
        const p = (personal ?? {}) as {
          reminder_template_name?: string | null;
          reminder_template_language?: string | null;
        };
        if (
          personal &&
          Object.prototype.hasOwnProperty.call(personal, "reminder_template_name") &&
          p.reminder_template_name
        ) {
          return NextResponse.json({
            template_name: p.reminder_template_name,
            template_language: p.reminder_template_language ?? "en_US",
          });
        }
      } catch {
        // Fall through to the account default below.
      }
    }
    const { data, error } = await ctx.supabase
      .from("accounts")
      .select("reminder_template_name, reminder_template_language")
      .eq("id", ctx.accountId)
      .maybeSingle();
    if (error) throw error;
    const row = (data ?? {}) as {
      reminder_template_name?: string | null;
      reminder_template_language?: string | null;
    };
    const name = row.reminder_template_name ?? null;
    return NextResponse.json({
      template_name: name,
      template_language: name ? (row.reminder_template_language ?? "en_US") : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole("agent");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const { template_name: rawName, template_language: rawLanguage } = body;

    // Explicit null (or empty string) clears the setting; a missing
    // template_name is a malformed request. Admins/owners clear the
    // account default; agents clear ONLY their personal setting.
    if (rawName === null || rawName === "") {
      if (hasMinRole(ctx.role, "admin")) {
        const { error } = await ctx.supabase
          .from("accounts")
          .update({ reminder_template_name: null, reminder_template_language: null })
          .eq("id", ctx.accountId);
        if (error) throw error;
      } else {
        const { error } = await ctx.supabase
          .from("profiles")
          .update({ reminder_template_name: null, reminder_template_language: null })
          .eq("user_id", ctx.userId);
        if (error) throw error;
      }
      return NextResponse.json({ template_name: null, template_language: null });
    }

    if (rawName === undefined) {
      return NextResponse.json(
        { error: "template_name is required." },
        { status: 400 },
      );
    }

    if (typeof rawName !== "string" || !rawName.trim()) {
      return NextResponse.json(
        { error: "template_name is required." },
        { status: 400 },
      );
    }
    const templateName = rawName.trim();
    if (templateName.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: "template_name is too long." },
        { status: 400 },
      );
    }
    const language =
      typeof rawLanguage === "string" && rawLanguage.trim()
        ? rawLanguage.trim()
        : "en_US";

    const { data: template, error: templateErr } = await ctx.supabase
      .from("message_templates")
      .select("name, language, status, body_text")
      .eq("account_id", ctx.accountId)
      .eq("name", templateName)
      .eq("language", language)
      .maybeSingle();
    if (templateErr) throw templateErr;
    const row = template as {
      status?: string;
      body_text?: unknown;
    } | null;
    if (!row) {
      return NextResponse.json(
        { error: "Template not found in this account." },
        { status: 400 },
      );
    }
    if (row.status !== "APPROVED") {
      return NextResponse.json(
        { error: "Template must be APPROVED by Meta." },
        { status: 400 },
      );
    }
    if (countBodyVariables(row.body_text) !== 1) {
      return NextResponse.json(
        { error: "Template body must contain exactly one {{1}} variable for the reminder text." },
        { status: 400 },
      );
    }

    // Admins/owners write the account default (existing behavior);
    // agents write ONLY their own personal setting, scoped to the
    // authenticated user id — one agent can never overwrite another's.
    if (hasMinRole(ctx.role, "admin")) {
      const { error } = await ctx.supabase
        .from("accounts")
        .update({
          reminder_template_name: templateName,
          reminder_template_language: language,
        })
        .eq("id", ctx.accountId);
      if (error) throw error;
    } else {
      const { error } = await ctx.supabase
        .from("profiles")
        .update({
          reminder_template_name: templateName,
          reminder_template_language: language,
        })
        .eq("user_id", ctx.userId);
      if (error) throw error;
    }
    return NextResponse.json({
      template_name: templateName,
      template_language: language,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
