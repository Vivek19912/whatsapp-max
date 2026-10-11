import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  toErrorResponse,
} from '@/lib/auth/account';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { resolveUploaderName, toCallRecording } from '@/lib/recordings/recordings';
import { uploaderNamesByUserId } from '@/lib/recordings/uploaders';

/** Default page size — matches the contacts list convention. */
const DEFAULT_LIMIT = 25;
/** Hard ceiling so one request can't dump the whole catalog. */
const MAX_LIMIT = 100;
/** Cap for the contact-id prefetch behind text search. */
const SEARCH_CONTACT_LIMIT = 100;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALL_TYPES = ['phone', 'whatsapp', 'whatsapp_business'] as const;

function parseBound(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * GET /api/recordings — account-scoped recording list for the
 * Recordings page. Any member may read (mirrors the
 * `call_recordings_select` RLS policy). Newest call first.
 *
 * Filters (all optional, all server-side, all ANDed):
 *   limit, offset — pagination (existing).
 *   contact_id — one lead's recordings (lead view); verified
 *     against the caller's account, 404 otherwise.
 *   q — text search over linked lead name and phone digits
 *     (contacts.name ILIKE, contacts.phone match, or the
 *     recording's own phone_number). Never the filename.
 *   from, to — ISO bounds over EFFECTIVE time
 *     (recorded_at ?? created_at).
 *   call_type — phone | whatsapp (both match whatsapp +
 *     whatsapp_business: one reporting category) |
 *     whatsapp_business (legacy alias, same merged set).
 *   direction — in | out | unknown (unknown = IS NULL, never
 *     folded into in/out).
 *   uploaded_by — auth user UUID.
 *   status — linked | unlinked (contact_id nullity).
 *   summary=1 — instead of rows, aggregate the filtered set:
 *     { total, totalDurationSecs, phone, whatsapp (merged),
 *       unlinked }. The stored whatsapp/whatsapp_business split
 *     is folded server-side; there is no separate business KPI.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();

    const params = new URL(request.url).searchParams;
    const limit = Math.min(
      Math.max(Number(params.get('limit')) || DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );
    const offset = Math.max(Number(params.get('offset')) || 0, 0);
    const contactId = params.get('contact_id')?.trim() || null;
    const q = params.get('q')?.trim() || null;
    const from = parseBound(params.get('from'));
    const to = parseBound(params.get('to'));
    const callType = params.get('call_type')?.trim() || null;
    const direction = params.get('direction')?.trim() || null;
    const uploadedBy = params.get('uploaded_by')?.trim() || null;
    const status = params.get('status')?.trim() || null;
    const wantSummary = params.get('summary') === '1';

    if ((params.get('from') || params.get('to')) && (from === null || to === null || !(from < to))) {
      return NextResponse.json(
        { error: "'from' and 'to' must be valid ISO timestamps with 'from' before 'to'." },
        { status: 400 }
      );
    }
    if (callType && !(CALL_TYPES as readonly string[]).includes(callType)) {
      return NextResponse.json(
        { error: "'call_type' must be phone, whatsapp, or whatsapp_business." },
        { status: 400 }
      );
    }
    if (direction && direction !== 'in' && direction !== 'out' && direction !== 'unknown') {
      return NextResponse.json(
        { error: "'direction' must be in, out, or unknown." },
        { status: 400 }
      );
    }
    if (uploadedBy && !UUID_RE.test(uploadedBy)) {
      return NextResponse.json(
        { error: "'uploaded_by' must be a valid user id." },
        { status: 400 }
      );
    }
    if (status && status !== 'linked' && status !== 'unlinked') {
      return NextResponse.json(
        { error: "'status' must be linked or unlinked." },
        { status: 400 }
      );
    }

    // A contact from another workspace must 404 exactly like a
    // nonexistent one (no cross-tenant oracle) — and a missing
    // contact must not silently list the whole account. The header
    // (name/phone) is returned for the lead page so it needs no
    // second request; it comes from this same verified row.
    let contactHeader: { id: string; name: string | null; phone: string | null } | null = null;
    if (contactId) {
      const { data: contact, error: contactError } = await supabase
        .from('contacts')
        .select('id, name, phone')
        .eq('id', contactId)
        .eq('account_id', accountId)
        .maybeSingle();
      if (contactError) throw contactError;
      if (!contact) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        );
      }
      const c = contact as { id: string; name: string | null; phone: string | null };
      contactHeader = { id: c.id, name: c.name, phone: c.phone };
    }

    // Text search prefetch: linked-lead ids whose name matches, plus
    // the raw digits for phone matching. Empty candidates (with no
    // digits to fall back on) short-circuit to an empty result —
    // never the unfiltered list.
    let searchContactIds: string[] | null = null;
    let searchDigits: string | null = null;
    if (q) {
      const digits = normalizePhone(q);
      searchDigits = digits.length >= 3 ? digits : null;
      const orParts = [`name.ilike.%${q}%`];
      if (searchDigits) {
        orParts.push(`phone_normalized.eq.${searchDigits}`);
      }
      const { data: hits, error: hitsError } = await supabase
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        .or(orParts.join(','))
        .limit(SEARCH_CONTACT_LIMIT);
      if (hitsError) throw hitsError;
      searchContactIds = ((hits ?? []) as Array<{ id: string }>).map((h) => h.id);
      if (searchContactIds.length === 0 && !searchDigits) {
        return NextResponse.json(
          wantSummary
            ? { summary: emptySummary() }
            : { recordings: [], total: 0, limit, offset, contact: contactHeader }
        );
      }
    }

    const buildQuery = (select: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query: any = supabase
        .from('call_recordings')
        .select(select, { count: 'exact' })
        .eq('account_id', accountId);
      if (contactId) query = query.eq('contact_id', contactId);
      if (callType === 'phone') query = query.eq('call_type', 'phone');
      // Merged reporting category: either whatsapp* value matches
      // both stored types, exactly like the summary RPC. Phone stays
      // exact and excludes both.
      if (callType === 'whatsapp' || callType === 'whatsapp_business') {
        query = query.in('call_type', ['whatsapp', 'whatsapp_business']);
      }
      if (direction === 'in' || direction === 'out') query = query.eq('direction', direction);
      if (direction === 'unknown') query = query.is('direction', null);
      if (uploadedBy) query = query.eq('uploaded_by', uploadedBy);
      if (status === 'linked') query = query.not('contact_id', 'is', null);
      if (status === 'unlinked') query = query.is('contact_id', null);
      if (from !== null && to !== null) {
        const fromISO = new Date(from).toISOString();
        const toISO = new Date(to).toISOString();
        query = query.or(
          `and(recorded_at.gte.${fromISO},recorded_at.lt.${toISO}),` +
            `and(recorded_at.is.null,created_at.gte.${fromISO},created_at.lt.${toISO})`
        );
      }
      if (q) {
        const parts: string[] = [];
        if (searchContactIds && searchContactIds.length > 0) {
          parts.push(`contact_id.in.(${searchContactIds.join(',')})`);
        }
        if (searchDigits) {
          parts.push(`phone_number.ilike.%${searchDigits}%`);
        }
        if (parts.length > 0) query = query.or(parts.join(','));
      }
      return query;
    };

    if (wantSummary) {
      // Exact database-side aggregation (migration 108): one indexed
      // scan, no row cap — mathematically exact for any number of
      // matches. Same predicates as the list query below, so the
      // cards always describe the filtered set; pagination never
      // applies to the summary.
      const rpcArgs: Record<string, unknown> = {
        p_account_id: accountId,
        p_contact_id: contactId,
        p_contact_ids: q ? (searchContactIds ?? []) : null,
        p_digits: q ? searchDigits : null,
        p_from: from !== null ? new Date(from).toISOString() : null,
        p_to: to !== null ? new Date(to).toISOString() : null,
        p_call_type: callType,
        p_direction: direction,
        p_uploaded_by: uploadedBy,
        p_status: status,
      };
      const { data, error } = await supabase.rpc('call_recordings_summary', rpcArgs);
      if (error) throw error;
      return NextResponse.json({ summary: toSummary(data) });
    }

    const { data, error, count } = await buildQuery('*')
      .order('recorded_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    const rows = (data ?? []) as Record<string, unknown>[];
    const names = await uploaderNamesByUserId(
      supabase,
      rows.map((r) => r.uploaded_by as string | null).filter(Boolean) as string[]
    );
    // Lead display for the table: one batched account-scoped lookup,
    // never N+1. Deleted contacts (SET NULL keeps the recording, or a
    // contact removed after linking) resolve to null → "Unlinked".
    const contactIds = [...new Set(
      rows.map((r) => r.contact_id as string | null).filter(Boolean)
    )] as string[];
    const contactInfo = new Map<string, { name: string | null; phone: string | null }>();
    if (contactIds.length > 0) {
      const { data: contacts, error: contactsError } = await supabase
        .from('contacts')
        .select('id, name, phone')
        .eq('account_id', accountId)
        .in('id', contactIds);
      if (contactsError) throw contactsError;
      for (const c of (contacts ?? []) as Array<Record<string, unknown>>) {
        contactInfo.set(c.id as string, {
          name: (c.name as string | null) ?? null,
          phone: (c.phone as string | null) ?? null,
        });
      }
    }

    return NextResponse.json({
      recordings: rows.map((r) => {
        const info = r.contact_id
          ? (contactInfo.get(r.contact_id as string) ?? null)
          : null;
        return toCallRecording(
          r,
          r.uploaded_by
            ? (names[r.uploaded_by as string] ?? resolveUploaderName(null))
            : null,
          info?.name ?? null,
          info?.phone ?? null
        );
      }),
      total: count ?? 0,
      limit,
      offset,
      // Present only for ?contact_id= — the lead page header.
      // Null/absent otherwise; never a cross-account row (verified
      // above against the caller's account).
      contact: contactHeader,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function emptySummary() {
  return {
    total: 0,
    totalDurationSecs: 0,
    phone: 0,
    whatsapp: 0,
    unlinked: 0,
  };
}

/**
 * Coerce the RPC's JSONB aggregate to the summary shape. Non-finite
 * or missing members fall back to zero — the function always
 * returns all keys, so this only guards transport skew. The stored
 * whatsapp/whatsapp_business split is folded here into the single
 * user-facing WhatsApp count.
 */
function toSummary(data: unknown): {
  total: number;
  totalDurationSecs: number;
  phone: number;
  whatsapp: number;
  unlinked: number;
} {
  const base = emptySummary();
  if (!data || typeof data !== 'object') return base;
  const row = data as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return {
    total: num(row.total),
    totalDurationSecs: num(row.totalDurationSecs),
    phone: num(row.phone),
    whatsapp: num(row.whatsapp) + num(row.whatsappBusiness),
    unlinked: num(row.unlinked),
  };
}
