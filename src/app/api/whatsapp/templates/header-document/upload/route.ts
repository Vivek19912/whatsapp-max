import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { requireAuthenticatedUser, toErrorResponse } from '@/lib/auth/account';
import {
  TEMPLATE_DOCUMENT_BUCKET,
  TEMPLATE_DOCUMENT_MAX_BYTES,
  TEMPLATE_DOCUMENT_MIME,
  validateTemplateDocumentBytes,
  validateTemplateDocumentFile,
} from '@/lib/whatsapp/template-document';
import { buildMediaPath } from '@/lib/storage/upload-media';

/**
 * Template document (PDF) header samples.
 *
 * POST — stage a PDF for the New Message Template dialog. Authenticated
 * multipart form with a `file` field (PDF only, ≤100 MB). The file is
 * validated by extension, MIME, size, AND actual content (`%PDF-`
 * magic) before it is stored in the account-scoped `template-media`
 * bucket (migration 164). Returns the public URL — the dialog sends
 * that URL as `header_media_url`, and the submit route turns it into
 * Meta's `example.header_handle` via the resumable-upload flow.
 *
 * DELETE — remove a previously staged PDF (`{ path }`). The path must
 * live under the caller's own `account-<account_id>/` folder, so one
 * account can never delete another's file. Best-effort cleanup for
 * replace/remove in the dialog — failures are surfaced but never
 * block the user's other form inputs.
 *
 * The browser never sees the service-role key or Meta tokens: storage
 * writes go through the caller's RLS-scoped client, and Meta upload
 * happens later in the submit route.
 */

async function resolveAccountId(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle();
  return (profile?.account_id as string | undefined) ?? null;
}

export async function POST(request: Request) {
  try {
    const guard = await requireAuthenticatedUser();
    if (!guard.ok) {
      return NextResponse.json(guard.body, { status: guard.status });
    }
    const { supabase, userId } = guard;

    const accountId = await resolveAccountId(supabase, userId);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      );
    }

    let file: File | null = null;
    try {
      const form = await request.formData();
      const entry = form.get('file');
      if (entry instanceof File) file = entry;
    } catch {
      file = null;
    }
    if (!file) {
      return NextResponse.json(
        { error: 'Attach a PDF file.' },
        { status: 400 },
      );
    }

    // Extension + MIME + size (browser values are untrusted — the
    // content check below is authoritative).
    const fileProblem = validateTemplateDocumentFile({
      name: file.name,
      size: file.size,
      type: file.type,
    });
    if (fileProblem) {
      return NextResponse.json({ error: fileProblem }, { status: 400 });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentProblem = validateTemplateDocumentBytes(bytes);
    if (contentProblem) {
      return NextResponse.json({ error: contentProblem }, { status: 400 });
    }

    const safeName = file.name.trim().toLowerCase().endsWith('.pdf')
      ? file.name
      : `${file.name}.pdf`;
    const path = buildMediaPath(accountId, safeName);
    const { error: upErr } = await supabase.storage
      .from(TEMPLATE_DOCUMENT_BUCKET)
      .upload(path, bytes, {
        cacheControl: '3600',
        upsert: false,
        contentType: TEMPLATE_DOCUMENT_MIME,
      });
    if (upErr) {
      const tooBig =
        /too large|exceeded|file_size_limit|maximum/i.test(upErr.message) ||
        bytes.byteLength > TEMPLATE_DOCUMENT_MAX_BYTES;
      return NextResponse.json(
        {
          error: tooBig
            ? `PDF is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — Meta's document limit is 100 MB.`
            : `Upload failed: ${upErr.message}`,
        },
        { status: tooBig ? 400 : 502 },
      );
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from(TEMPLATE_DOCUMENT_BUCKET).getPublicUrl(path);

    return NextResponse.json({ publicUrl, path });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const guard = await requireAuthenticatedUser();
    if (!guard.ok) {
      return NextResponse.json(guard.body, { status: guard.status });
    }
    const { supabase, userId } = guard;

    const accountId = await resolveAccountId(supabase, userId);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      );
    }

    let path: unknown;
    try {
      path = (await request.json())?.path;
    } catch {
      path = null;
    }
    if (typeof path !== 'string' || path.trim() === '') {
      return NextResponse.json({ error: 'path is required.' }, { status: 400 });
    }
    const prefix = `account-${accountId}/`;
    if (!path.startsWith(prefix)) {
      return NextResponse.json(
        { error: 'You can only remove files from your own account.' },
        { status: 403 },
      );
    }

    const { error: delErr } = await supabase.storage
      .from(TEMPLATE_DOCUMENT_BUCKET)
      .remove([path]);
    if (delErr) {
      return NextResponse.json(
        { error: `Remove failed: ${delErr.message}` },
        { status: 502 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
