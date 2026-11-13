// ============================================================
// GET /api/calls/unlinked — actionable queue of unlinked call
// recordings (contact_id IS NULL) for the current account.
//
// Powers /calls/unlinked ("Find Lead" queue). Same conventions
// as GET /api/recordings: cookie session, account from session,
// newest-first page, uploader join, metadata only (playback stays
// on /api/recordings/[id]/audio — never here).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { recordingSortTime, resolveUploaderName } from '@/lib/recordings/recordings';
import { uploaderNamesByUserId } from '@/lib/recordings/uploaders';

/** Default page size — matches the recordings list convention. */
const DEFAULT_LIMIT = 25;
/** Hard ceiling so one request can't dump the queue. */
const MAX_LIMIT = 100;

export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await getCurrentAccount();

    const params = new URL(request.url).searchParams;
    const limit = Math.min(
      Math.max(Number(params.get('limit')) || DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );
    const offset = Math.max(Number(params.get('offset')) || 0, 0);

    // Agents see only the unlinked queue they uploaded (owner or
    // session uploader for key uploads). Server-side from the
    // session — agents cannot widen this to the whole account.
    let listQuery = supabase
      .from('call_recordings')
      .select(
        'id, file_name, phone_number, direction, duration_seconds, recorded_at, created_at, uploaded_by',
        { count: 'exact' }
      )
      .eq('account_id', accountId)
      .is('contact_id', null);
    if (role === 'agent') listQuery = listQuery.eq('uploaded_by', userId);
    const { data, error, count } = await listQuery
      .order('recorded_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    const rows = ((data ?? []) as Record<string, unknown>[])
      // Display order within the page follows the effective-time
      // rule exactly (recorded_at ?? created_at, ties by
      // created_at then id), mirroring latestByContact.
      .sort((a, b) => {
        const aCreated = a.created_at as string;
        const bCreated = b.created_at as string;
        const dt = recordingSortTime({
          recorded_at: a.recorded_at as string | null,
          created_at: aCreated,
        }) - recordingSortTime({
          recorded_at: b.recorded_at as string | null,
          created_at: bCreated,
        });
        if (dt !== 0) return -dt;
        if (aCreated !== bCreated) return aCreated < bCreated ? 1 : -1;
        return (a.id as string) < (b.id as string) ? 1 : -1;
      });
    const names = await uploaderNamesByUserId(
      supabase,
      rows.map((r) => r.uploaded_by as string | null).filter(Boolean) as string[]
    );

    return NextResponse.json({
      // Queue projection: only what the table needs. Storage
      // bucket/path are deliberately excluded — playback goes
      // through /api/recordings/[id]/audio, never a raw URL.
      recordings: rows.map((r) => ({
        id: r.id as string,
        file_name: (r.file_name as string | null) ?? null,
        phone_number: (r.phone_number as string | null) ?? null,
        direction: (r.direction as string | null) ?? null,
        duration_seconds:
          typeof r.duration_seconds === 'number' ? (r.duration_seconds as number) : null,
        recorded_at: (r.recorded_at as string | null) ?? null,
        created_at: r.created_at as string,
        uploader_name: r.uploaded_by
          ? (names[r.uploaded_by as string] ?? resolveUploaderName(null))
          : null,
      })),
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
