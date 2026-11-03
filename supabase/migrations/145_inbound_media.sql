-- ============================================================
-- 145_inbound_media.sql
--
-- Private `inbound-media` Storage bucket for inbound WhatsApp media
-- archival (issue: historical PDFs unopenable after Meta's 7-day
-- webhook media window).
--
-- Meta deletes webhook media IDs 7 days after delivery, and the inbox
-- used to store only `/api/whatsapp/media/{media_id}` with no bytes
-- anywhere. Every attachment older than a week therefore 404'd at Meta
-- and returned a generic 500.
--
-- From this migration forward the webhook archives inbound bytes at
-- receipt time (see `src/lib/whatsapp/inbound-media.ts`):
--
--   bucket: inbound-media   (PRIVATE — never in `chat-media`)
--   path:   {account_id}/{media_id}   (raw UUID, deterministic)
--
-- The path is deterministic so the media route can serve archived
-- bytes without any `messages` schema change, and account isolation
-- is part of the key. Reads go through the service-role client in
-- `GET /api/whatsapp/media/[mediaId]` (storage-first, Meta fallback),
-- which bypasses RLS; the policies below gate dashboard-side clients.
--
-- Size limit 50 MB — the live provider cap on this deployment refused
-- 100 MB at bucket-update time. Meta documents can be up to 100 MB;
-- files above the limit are skipped with a logged `too_large` error
-- (see INBOUND_MEDIA_MAX_BYTES) and remain Meta-served until expiry.
--
-- Idempotent — safe to re-run.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'inbound-media',
  'inbound-media',
  FALSE,
  52428800, -- 50 MB (provider cap; mirrors INBOUND_MEDIA_MAX_BYTES)
  ARRAY[
    -- Images (incl. stickers, which arrive as image/webp)
    'image/png', 'image/jpeg', 'image/webp',
    -- Videos
    'video/mp4', 'video/3gpp',
    -- Documents
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    -- Audio (voice notes)
    'audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Reads: account members only, via the path's first segment, which is
-- the RAW account UUID (no `account-` prefix, unlike 020/023/105).
-- Deliberately NO public SELECT — customer documents must never be
-- reachable by URL. Playback goes through the media route, which
-- re-checks the caller's account before streaming.
DROP POLICY IF EXISTS "Members can read inbound media" ON storage.objects;
CREATE POLICY "Members can read inbound media"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'inbound-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id::text = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can upload inbound media" ON storage.objects;
CREATE POLICY "Members can upload inbound media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'inbound-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id::text = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update inbound media" ON storage.objects;
CREATE POLICY "Members can update inbound media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'inbound-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id::text = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete inbound media" ON storage.objects;
CREATE POLICY "Members can delete inbound media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'inbound-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id::text = (storage.foldername(name))[1]
    )
  );
