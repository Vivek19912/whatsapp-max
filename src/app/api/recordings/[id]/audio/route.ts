import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  toErrorResponse,
} from '@/lib/auth/account';

/**
 * GET /api/recordings/[id]/audio — stream one recording's audio.
 *
 * Verifies (cookie session) that the recording belongs to the
 * caller's account, then mints a 60-second signed Storage URL and
 * redirects to it. The browser streams bytes DIRECTLY from
 * Supabase — with Range/seek support and without the audio ever
 * passing through (or being buffered by) Node.
 *
 * Why a redirect and not a byte proxy: supabase-js `download()`
 * has no Range support, so proxying would mean loading the whole
 * file into memory and breaking seeking. The WhatsApp media
 * route (`/api/whatsapp/media/[mediaId]`) can stream because
 * Meta honors Range; here the signed URL gives us the same
 * property. The raw Storage URL never reaches the client and the
 * signature dies in 60s, so a shared link can't leak another
 * workspace's audio.
 *
 * `?download=1` forces a download with the original filename
 * instead of inline playback.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: 'Recording ID is required' },
        { status: 400 }
      );
    }

    const { supabase, accountId, userId, role } = await getCurrentAccount();

    // Account-scoped lookup — a recording from another workspace
    // 404s exactly like a nonexistent one (no cross-tenant oracle).
    // uploaded_by is fetched for the agent ownership check below
    // but never leaves this route.
    const { data: recording, error } = await supabase
      .from('call_recordings')
      .select('storage_bucket, storage_path, file_name, uploaded_by')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw error;
    if (!recording) {
      return NextResponse.json(
        { error: 'Recording not found' },
        { status: 404 }
      );
    }
    // Agent data isolation: an agent may stream only recordings
    // they uploaded. Anything else (including legacy rows with no
    // attributable uploader) 404s like a missing recording — no
    // oracle, no signed URL, no storage path leak.
    if (
      role === 'agent' &&
      (recording as { uploaded_by: string | null }).uploaded_by !== userId
    ) {
      return NextResponse.json(
        { error: 'Recording not found' },
        { status: 404 }
      );
    }

    const asDownload =
      new URL(request.url).searchParams.get('download') === '1';
    const { data: signed, error: signError } = await supabase.storage
      .from(recording.storage_bucket as string)
      .createSignedUrl(recording.storage_path as string, 60, {
        download: asDownload
          ? ((recording.file_name as string | null) || 'recording')
          : undefined,
      });
    if (signError || !signed?.signedUrl) {
      console.error('[api/recordings/audio] sign failed:', signError?.message);
      return NextResponse.json(
        { error: 'Failed to load recording audio' },
        { status: 500 }
      );
    }

    return NextResponse.redirect(signed.signedUrl, 307);
  } catch (err) {
    return toErrorResponse(err);
  }
}
