-- ============================================================
-- 164_template_media.sql
--
-- Adds the `template-media` Supabase Storage bucket used for WhatsApp
-- message-template document (PDF) header samples.
--
-- Why a separate bucket instead of reusing `chat-media`: template PDF
-- samples follow Meta's document cap (100 MB), while `chat-media` /
-- `flow-media` are capped at 16 MB (migration 023). A distinct bucket
-- lets the template limit diverge without touching inbox/flow sends.
--
-- Same conventions as 016 (`flow-media`) and 023 (`chat-media`):
--   template-media/account-<account_id>/<timestamp>-<basename>.pdf
-- Public reads (Meta fetches the sample URL during review); writes
-- scoped to account members via the path's first segment. PDF-only
-- allow-list — nothing else is ever stored here.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. template-media storage bucket
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'template-media',
  'template-media',
  TRUE,
  104857600, -- 100 MB (Meta's document header sample cap)
  ARRAY[
    'application/pdf'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================
-- 2. Storage RLS — account-scoped writes, public reads
--
-- Same predicate shape as 020/023: writes are allowed when the
-- path's first segment is `account-<account_id>` for an account the
-- caller belongs to. Reads are public (Meta fetches the sample link
-- during template review).
-- ============================================================
DROP POLICY IF EXISTS "Template media is publicly readable" ON storage.objects;
CREATE POLICY "Template media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'template-media');

DROP POLICY IF EXISTS "Members can upload template media" ON storage.objects;
CREATE POLICY "Members can upload template media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'template-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update template media" ON storage.objects;
CREATE POLICY "Members can update template media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'template-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete template media" ON storage.objects;
CREATE POLICY "Members can delete template media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'template-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
