import type { SupabaseClient } from "@supabase/supabase-js";

import { getTravelCrmConfig } from "./config";
import { fetchTravelCrmLookups } from "./client";
import { resolveAccountOwnerEmail } from "./account-owner";

// ============================================================
// CRM User Mapping — WACRM user → Travel CRM salesperson (by ID).
//
// Identity is by INTERNAL IDs on both sides, never email or name:
//   WACRM side  profiles.user_id (auth.users id) within the account.
//   CRM side    Travel CRM users.id UUID from the linked account's
//               assignable-users feed.
// Emails and display names may differ or collide across the two
// systems; only IDs are stable. All resolution is server-side so a
// non-admin caller can never inject another user's mapping into a
// lead-creation request.
// ============================================================

export interface CrmSalesperson {
  id: string;
  fullName: string;
  username: string | null;
  email: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Tolerant parser for the `assignableUsers` array inside a Travel CRM
 * lookups payload. Skips malformed entries instead of failing — the
 * caller decides what an empty list means (degraded UI / failed
 * validation), never a crash.
 */
export function extractCrmSalespeople(
  lookups: Record<string, unknown> | null | undefined,
): CrmSalesperson[] {
  if (!lookups) return [];
  const raw = lookups.assignableUsers;
  if (!Array.isArray(raw)) return [];
  const out: CrmSalesperson[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item) out.push({ id: item, fullName: item, username: null, email: null });
      continue;
    }
    if (!isRecord(item)) continue;
    // Native lookups shape ({id, fullName, username, email}) and the
    // generic option shape ({value, label}) are both accepted.
    const id =
      typeof item.id === "string" && item.id
        ? item.id
        : typeof item.value === "string" && item.value
          ? item.value
          : null;
    if (!id) continue;
    const fullName =
      typeof item.fullName === "string" && item.fullName
        ? item.fullName
        : typeof item.label === "string" && item.label
          ? item.label
          : id;
    out.push({
      id,
      fullName,
      username: typeof item.username === "string" ? item.username : null,
      email: typeof item.email === "string" ? item.email : null,
    });
  }
  return out;
}

/**
 * Resolve the mapped Travel CRM salesperson id for a WACRM user.
 *
 * Server-side only: the caller passes the AUTHENTICATED user id from
 * the session (requireRole), never request input. Returns null on a
 * missing mapping or any database error — callers treat null as
 * "unmapped" and fall back to the workspace owner. Never throws, so
 * lead creation is never blocked by a mapping lookup failure.
 */
export async function resolveMappedCrmUserId(
  db: SupabaseClient,
  accountId: string,
  wacrmUserId: string,
): Promise<string | null> {
  try {
    const { data, error } = await db
      .from("crm_user_mappings")
      .select("crm_user_id")
      .eq("account_id", accountId)
      .eq("wacrm_user_id", wacrmUserId)
      .maybeSingle();
    if (error) return null;
    const id = (data as { crm_user_id?: unknown } | null)?.crm_user_id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

// ============================================================
// Display labels for mapping dropdowns and tables.
//
// Base UI's `Select.Value` resolves an item's label only from
// *mounted* popup items — once the popup closes (or when the roster
// hasn't loaded yet), an unmatched value falls back to the raw
// string, which is how raw UUIDs ended up on screen. These helpers
// resolve labels from plain data instead, so the UI passes an
// explicit name to `Select.Value` and never depends on item
// registration timing. They never return an id.
// ============================================================

export interface CrmDisplayRosterEntry {
  id: string;
  fullName: string;
  email?: string | null;
}

export interface WacrmDisplayRosterEntry {
  id: string;
  name: string;
  email?: string | null;
  role?: string | null;
}

/**
 * Name to show for a CRM salesperson id: live roster first, then the
 * name saved on the mapping row (covers removed salespeople whose id
 * is no longer in the roster), then a neutral fallback. Never the id.
 */
export function resolveCrmDisplayName(
  crmUserId: string,
  roster: CrmDisplayRosterEntry[],
  savedName?: string | null,
): string {
  const match = roster.find((u) => u.id === crmUserId);
  if (match) {
    return match.email && match.email !== match.fullName
      ? `${match.fullName} (${match.email})`
      : match.fullName;
  }
  const saved = (savedName ?? "").trim();
  if (saved) return saved;
  return "Unknown salesperson";
}

/**
 * Name to show for a WACRM member id: live roster first, then the
 * name saved on the mapping row, then a neutral fallback. Never the id.
 */
export function resolveWacrmDisplayName(
  wacrmUserId: string,
  roster: WacrmDisplayRosterEntry[],
  savedName?: string | null,
): string {
  const match = roster.find((u) => u.id === wacrmUserId);
  if (match) {
    const email = (match.email ?? "").trim();
    const role = (match.role ?? "").trim();
    const suffix = [email && email !== match.name ? `(${email})` : "", role ? `· ${role}` : ""]
      .filter(Boolean)
      .join(" ");
    return suffix ? `${match.name} ${suffix}` : match.name;
  }
  const saved = (savedName ?? "").trim();
  if (saved) return saved;
  return "Unknown user";
}

// ============================================================
// Mapping store — account-scoped reads shared by the dashboard
// Settings API (RLS client) and the public v1 API (service client
// fixed to the API key's account). Both callers pass an already
// authorized client; every query filters by account_id.
// ============================================================

export type MappingStatus =
  | "active"
  | "crm-user-removed"
  | "wacrm-user-removed"
  | "unknown";

export interface MappingRow {
  id: string;
  wacrm_user_id: string;
  wacrm_name: string | null;
  wacrm_email: string | null;
  crm_user_id: string;
  crm_name: string | null;
  crm_email: string | null;
  status: MappingStatus;
  created_at: string;
  updated_at: string;
}

export interface StoredMappingRow {
  id: string;
  wacrm_user_id: string;
  crm_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface MappingProfileLite {
  user_id: string;
  full_name: string | null;
  email: string | null;
}

export interface WacrmMemberOption {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
}

/** Live CRM roster, best-effort. Null when Travel CRM is unreachable. */
export async function loadCrmRoster(
  baseUrl: string,
  secret: string,
  ownerEmail: string | null,
): Promise<CrmSalesperson[] | null> {
  try {
    const lookups = await fetchTravelCrmLookups(baseUrl, secret, fetch, {
      ownerEmail,
    });
    return extractCrmSalespeople(lookups);
  } catch (err) {
    console.error(
      "[crm-user-mappings] CRM roster fetch failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export function buildMappingRows(
  stored: StoredMappingRow[],
  profiles: Map<string, MappingProfileLite>,
  roster: CrmSalesperson[] | null,
): MappingRow[] {
  const byId = new Map((roster ?? []).map((u) => [u.id, u]));
  return stored.map((m) => {
    const profile = profiles.get(m.wacrm_user_id);
    const crm = byId.get(m.crm_user_id);
    let status: MappingStatus = "unknown";
    if (roster !== null) {
      if (!profile) status = "wacrm-user-removed";
      else if (!crm) status = "crm-user-removed";
      else status = "active";
    }
    return {
      id: m.id,
      wacrm_user_id: m.wacrm_user_id,
      wacrm_name: profile?.full_name ?? null,
      wacrm_email: profile?.email ?? null,
      crm_user_id: m.crm_user_id,
      crm_name: crm?.fullName ?? null,
      crm_email: crm?.email ?? null,
      status,
      created_at: m.created_at,
      updated_at: m.updated_at,
    };
  });
}

export interface AccountMappings {
  rows: MappingRow[];
  members: WacrmMemberOption[];
  crmReachable: boolean;
}

/**
 * Load everything a mapping manager needs for one account: stored
 * rows joined to live member names, the CRM roster for salesperson
 * names + status, and the member list for the "new mapping" picker.
 * Never throws for CRM outages (rows degrade to `unknown` status);
 * throws only on database failures, which callers map to 500s.
 */
export async function listAccountMappings(
  db: SupabaseClient,
  accountId: string,
): Promise<AccountMappings> {
  const [{ data: stored, error: storedError }, { data: members, error: membersError }] =
    await Promise.all([
      db
        .from("crm_user_mappings")
        .select("id, wacrm_user_id, crm_user_id, created_at, updated_at")
        .eq("account_id", accountId)
        .order("created_at", { ascending: true }),
      db
        .from("profiles")
        .select("user_id, full_name, email, account_role")
        .eq("account_id", accountId),
    ]);
  if (storedError) throw new Error(`mappings fetch failed: ${storedError.message}`);
  if (membersError) throw new Error(`members fetch failed: ${membersError.message}`);

  const memberRows = ((members ?? []) as Array<MappingProfileLite & { account_role?: unknown }>);
  const profiles = new Map(memberRows.map((p) => [p.user_id, p]));

  const { secret, baseUrl } = getTravelCrmConfig();
  let roster: CrmSalesperson[] | null = null;
  if (secret) {
    const ownerEmail = await resolveAccountOwnerEmail(db, accountId);
    roster = await loadCrmRoster(baseUrl, secret, ownerEmail);
  }

  return {
    rows: buildMappingRows((stored ?? []) as StoredMappingRow[], profiles, roster),
    members: memberRows.map((p) => ({
      id: p.user_id,
      name: p.full_name ?? p.email ?? p.user_id,
      email: p.email,
      role: typeof p.account_role === "string" ? p.account_role : null,
    })),
    crmReachable: roster !== null,
  };
}
