// ============================================================
// POST /api/calls/unlinked/[recordingId]/link — manually link one
// unlinked recording to a contact (the "Find Lead" action).
//
// Body: { "contact_id": "<uuid>" }
//
// Security (all enforced, never trusted from the client):
// - recording must belong to the session account AND still be
//   unlinked — expressed as ONE conditional update, so two
//   sessions racing to link the same recording cannot both win.
// - agents may link only recordings they uploaded (resolved
//   from the session; anything else 404s).
// - contact must belong to the session account.
// - foreign recording/contact 404s exactly like a missing one
//   (no cross-tenant oracle).
// - already-linked (lost race) → 409 with a safe message.
// - conversation_id, audio, and storage are never touched.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { toCallRecording } from '@/lib/recordings/recordings';

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ recordingId: string }> }
) {
  try {
    const { recordingId } = await params;
    if (!recordingId) {
      return NextResponse.json({ error: 'Recording ID is required' }, { status: 400 });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const contactId = body && isUuid(body.contact_id) ? (body.contact_id as string) : null;
    if (!contactId) {
      return NextResponse.json(
        { error: "'contact_id' must be a valid UUID." },
        { status: 400 }
      );
    }

    const { supabase, accountId, userId, role } = await getCurrentAccount();

    // Contact must be ours — 404 otherwise (no oracle).
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (contactError) throw contactError;
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    // Agent data isolation: an agent may link only recordings they
    // uploaded. Anything else (including legacy unattributable
    // rows) 404s like a missing recording. Ownership is resolved
    // server-side from the session, never from the request.
    if (role === 'agent') {
      const { data: target, error: targetError } = await supabase
        .from('call_recordings')
        .select('id, uploaded_by, contact_id')
        .eq('id', recordingId)
        .eq('account_id', accountId)
        .maybeSingle();
      if (targetError) throw targetError;
      const owned =
        target &&
        (target as { uploaded_by: string | null }).uploaded_by === userId;
      if (!owned) {
        return NextResponse.json(
          { error: 'Recording not found' },
          { status: 404 }
        );
      }
      if ((target as { contact_id: string | null }).contact_id) {
        return NextResponse.json(
          { error: 'This call has already been linked to a lead.' },
          { status: 409 }
        );
      }
    }

    // Atomic claim: only an unlinked row of OUR account can move.
    // UPDATE call_recordings SET contact_id
    // WHERE id AND account_id AND contact_id IS NULL.
    const { data: claimed, error: claimError } = await supabase
      .from('call_recordings')
      .update({ contact_id: contactId })
      .eq('id', recordingId)
      .eq('account_id', accountId)
      .is('contact_id', null)
      .select('*');
    if (claimError) throw claimError;
    const row = (claimed ?? [])[0] as Record<string, unknown> | undefined;
    if (row) {
      return NextResponse.json({ data: toCallRecording(row) });
    }

    // Nothing moved: either foreign/missing, or already linked by
    // a racing session. Distinguish without leaking: re-read our
    // row — linked (by anyone) → 409; absent → 404.
    const { data: current, error: currentError } = await supabase
      .from('call_recordings')
      .select('id, contact_id')
      .eq('id', recordingId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (currentError) throw currentError;
    if (current && (current as { contact_id: string | null }).contact_id) {
      return NextResponse.json(
        { error: 'This call has already been linked to a lead.' },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
