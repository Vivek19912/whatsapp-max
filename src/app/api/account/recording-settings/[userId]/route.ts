// ============================================================
// /api/account/recording-settings/[userId]
//
//   GET — read one member's recording policy (phone + WhatsApp).
//   PUT — set one member's recording policy (any of the three).
//
// Two independent policies per user:
//   phone:    owner-configured normalized number
//             (`phone_recording_number`, digits, NULL = none).
//             CallVault maps the number to the device's CURRENT
//             active subscription at call time. The legacy logical
//             slot column (`phone_recording_source`, 'none' |
//             'sim1' | 'sim2') is still accepted/stored for older
//             CallVault clients but is no longer authoritative.
//   whatsapp: exactly one of 'none' | 'whatsapp' | 'whatsapp_business'
// Absence of a row means none/none (safe defaults — recording a
// SIM or app nobody chose is opt-in, never inherited).
//
// Authorization (server-derived, never client input):
//   - GET: the user themselves, or the account owner.
//   - PUT: the user themselves, or the account owner.
//     Agents/viewers cannot configure another member.
// Target must belong to the caller's account, else 404 (no
// cross-tenant oracle). Writes go through the RLS-scoped
// caller client, whose owner-only WITH CHECK policy backstops
// the requireRole/hasMinRole checks here.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { hasMinRole } from "@/lib/auth/roles";
import { isValidE164, normalizePhone } from "@/lib/whatsapp/phone-utils";

export const VALID_WHATSAPP_SOURCES = ["none", "whatsapp", "whatsapp_business"] as const;
export type RecordingSource = (typeof VALID_WHATSAPP_SOURCES)[number];

export function isRecordingSource(value: unknown): value is RecordingSource {
  return (
    typeof value === "string" &&
    (VALID_WHATSAPP_SOURCES as readonly string[]).includes(value)
  );
}

export const VALID_PHONE_SOURCES = ["none", "sim1", "sim2"] as const;
export type PhoneRecordingSource = (typeof VALID_PHONE_SOURCES)[number];

export function isPhoneRecordingSource(value: unknown): value is PhoneRecordingSource {
  return (
    typeof value === "string" &&
    (VALID_PHONE_SOURCES as readonly string[]).includes(value)
  );
}

// Owner-configured phone number for call recording. Stored as
// normalized digits (no '+', no spaces — e.g. '918953065369').
// null/empty means "None" (no phone recording allowed). Rejects
// anything that is not a plausible E.164 number.
export function normalizeRecordingPhoneNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  // Strip formatting first ("+91 89530 65369" → "918953065369"),
  // then require a plausible E.164 digit string.
  const digits = normalizePhone(value.trim());
  if (!digits) return null;
  if (!isValidE164(digits)) return null;
  return digits;
}

export function isRecordingPhoneNumber(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  if (value.trim() === "") return true;
  return normalizeRecordingPhoneNumber(value) !== null;
}

interface SettingRow {
  user_id: string;
  whatsapp_recording_source: string;
  phone_recording_source: string;
  phone_recording_number: string | null;
  phone_recording_enabled: boolean | null;
  updated_at: string;
}

function toSetting(userId: string, row: SettingRow | null) {
  return {
    user_id: userId,
    whatsapp_recording_source: row?.whatsapp_recording_source ?? "none",
    phone_recording_source: row?.phone_recording_source ?? "none",
    phone_recording_number: row?.phone_recording_number ?? null,
    // Explicit owner opt-in for phone call recording. Absent rows and
    // legacy rows predate the flag: both read as disabled (fail closed).
    phone_recording_enabled: row?.phone_recording_enabled === true,
    updated_at: row?.updated_at ?? null,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    const { userId } = await params;

    const isSelf = userId === ctx.userId;
    if (!isSelf && !hasMinRole(ctx.role, "owner")) {
      return NextResponse.json(
        { error: "Only the account owner can view another member's recording settings" },
        { status: 403 },
      );
    }

    // Target must be in the caller's account — same 404 as a
    // missing contact, never a cross-account signal.
    const { data: member, error: memberError } = await ctx.supabase
      .from("profiles")
      .select("user_id")
      .eq("user_id", userId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!member) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    const { data: row, error } = await ctx.supabase
      .from("user_recording_settings")
      .select(
        "user_id, whatsapp_recording_source, phone_recording_source, phone_recording_number, phone_recording_enabled, updated_at",
      )
      .eq("account_id", ctx.accountId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;

    return NextResponse.json({
      setting: toSetting(userId, row as SettingRow | null),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    const { userId } = await params;

    const isSelf = userId === ctx.userId;
    if (!isSelf && !hasMinRole(ctx.role, "owner")) {
      return NextResponse.json(
        { error: "Only the account owner can configure another member's recording settings" },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => null)) as {
      whatsapp_recording_source?: unknown;
      phone_recording_source?: unknown;
      phone_recording_number?: unknown;
    } | null;
    const hasWhatsapp = body !== null && "whatsapp_recording_source" in body;
    const hasPhone = body !== null && "phone_recording_source" in body;
    const hasPhoneNumber = body !== null && "phone_recording_number" in body;
    if (!hasWhatsapp && !hasPhone && !hasPhoneNumber) {
      return NextResponse.json(
        {
          error:
            "Provide 'whatsapp_recording_source', 'phone_recording_source' and/or 'phone_recording_number'.",
        },
        { status: 400 },
      );
    }
    if (hasWhatsapp && !isRecordingSource(body?.whatsapp_recording_source)) {
      return NextResponse.json(
        { error: "'whatsapp_recording_source' must be one of none, whatsapp, whatsapp_business" },
        { status: 400 },
      );
    }
    if (hasPhone && !isPhoneRecordingSource(body?.phone_recording_source)) {
      return NextResponse.json(
        { error: "'phone_recording_source' must be one of none, sim1, sim2" },
        { status: 400 },
      );
    }
    if (hasPhoneNumber && !isRecordingPhoneNumber(body?.phone_recording_number)) {
      return NextResponse.json(
        {
          error:
            "'phone_recording_number' must be a valid phone number (e.g. +91 8953065369) or null for none",
        },
        { status: 400 },
      );
    }

    const { data: member, error: memberError } = await ctx.supabase
      .from("profiles")
      .select("user_id")
      .eq("user_id", userId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!member) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    // Partial update: only the provided policies are written, so
    // setting one never resets the other.
    const patch: Record<string, unknown> = {
      account_id: ctx.accountId,
      user_id: userId,
      updated_by: ctx.userId,
      updated_at: new Date().toISOString(),
    };
    if (hasWhatsapp) patch.whatsapp_recording_source = body?.whatsapp_recording_source;
    if (hasPhone) patch.phone_recording_source = body?.phone_recording_source;
    if (hasPhoneNumber) {
      const normalized = normalizeRecordingPhoneNumber(
        body?.phone_recording_number,
      );
      patch.phone_recording_number = normalized;
      // The Owner's explicit phone-recording choice, derived from the number
      // they saved: a number means recording is enabled for that SIM, while
      // null (Disabled in the UI) means it is not. Stored explicitly so the
      // app never has to infer intent from a missing value.
      patch.phone_recording_enabled = normalized !== null;
    }

    const { data: row, error } = await ctx.supabase
      .from("user_recording_settings")
      .upsert(patch, { onConflict: "account_id,user_id" })
      .select(
        "user_id, whatsapp_recording_source, phone_recording_source, phone_recording_number, phone_recording_enabled, updated_at",
      )
      .single();
    if (error) throw error;

    return NextResponse.json({
      setting: toSetting(userId, row as SettingRow),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
