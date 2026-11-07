import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  toErrorResponse,
} from '@/lib/auth/account';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many recent submissions to scan for a live workspace run. */
const SUBMISSION_SCAN_LIMIT = 10;

/**
 * GET /api/inbox/workspace-lead?contact_id=<uuid> — resolve the
 * exact Workspace lead for an Inbox conversation's contact.
 *
 * Chain (all account-scoped, verified server-side):
 *   contacts.id → meta_lead_submissions (status = processed,
 *   newest first) → flow_run_id → flow_runs.id (same account AND
 *   same contact — a run pointing elsewhere is skipped, never
 *   trusted) → flows.name (same account).
 *
 * Shapes:
 *   { linked: false, meta: false } — no processed submission:
 *     not a Meta conversation, caller renders no section.
 *   { linked: false, meta: true } — submission(s) exist but none
 *     resolves to a live run: caller renders the "not linked"
 *     state, never a guessed link.
 *   { linked: true, … } — exact lead + table by stable ids.
 *
 * A foreign contact 404s exactly like a missing one (no
 * cross-tenant oracle). The returned contact_id is the stable
 * record id the existing `/workspace?contact=` deep link locates
 * (own pagination, scroll, temporary highlight) — no new
 * navigation mechanism, no ids beyond what RLS already
 * authorizes, no tokens or phone numbers in URLs.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();

    const contactId =
      new URL(request.url).searchParams.get('contact_id')?.trim() || null;
    if (!contactId || !UUID_RE.test(contactId)) {
      return NextResponse.json(
        { error: "'contact_id' must be a valid contact id." },
        { status: 400 }
      );
    }

    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id, name')
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
    const verified = contact as { id: string; name: string | null };

    const { data: submissions, error: submissionsError } = await supabase
      .from('meta_lead_submissions')
      .select('id, flow_run_id, meta_created_time, created_at')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('status', 'processed')
      .order('meta_created_time', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(SUBMISSION_SCAN_LIMIT);
    if (submissionsError) throw submissionsError;
    const subs = ((submissions ?? []) as Array<{
      id: string;
      flow_run_id: string | null;
      meta_created_time?: string | null;
      created_at?: string | null;
    }>).filter((s) => s.flow_run_id);
    if (subs.length === 0) {
      // Distinguish "Meta conversation, run unresolvable" from
      // "no Meta relationship at all" so the caller can render
      // the not-linked state vs nothing.
      const hadSubmission =
        ((submissions ?? []) as Array<unknown>).length > 0;
      return NextResponse.json({ linked: false, meta: hadSubmission });
    }

    const { data: runs, error: runsError } = await supabase
      .from('flow_runs')
      .select('id, flow_id, contact_id')
      .eq('account_id', accountId)
      .in(
        'id',
        [...new Set(subs.map((s) => s.flow_run_id as string))]
      );
    if (runsError) throw runsError;
    const runById = new Map(
      ((runs ?? []) as Array<{
        id: string;
        flow_id: string | null;
        contact_id: string | null;
      }>).map((r) => [r.id, r])
    );
    // Most recent submission first (query order): the first live
    // run belonging to THIS contact and account wins. Runs
    // pointing at another contact, another flow-less row, or a
    // deleted run are skipped — never trusted, never guessed.
    let hit: { id: string; flow_id: string } | null = null;
    for (const s of subs) {
      const run = runById.get(s.flow_run_id as string);
      if (
        run &&
        run.contact_id === contactId &&
        run.flow_id
      ) {
        hit = { id: run.id, flow_id: run.flow_id };
        break;
      }
    }
    if (!hit) {
      return NextResponse.json({ linked: false, meta: true });
    }

    const { data: flow, error: flowError } = await supabase
      .from('flows')
      .select('id, name')
      .eq('id', hit.flow_id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (flowError) throw flowError;
    if (!flow) {
      return NextResponse.json({ linked: false, meta: true });
    }
    const row = flow as { id: string; name: string | null };
    const flowName =
      typeof row.name === 'string' && row.name.trim()
        ? row.name.trim()
        : 'Untitled Flow';

    return NextResponse.json({
      linked: true,
      meta: true,
      contact_id: verified.id,
      contact_name: verified.name,
      flow_id: row.id,
      flow_name: flowName,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
