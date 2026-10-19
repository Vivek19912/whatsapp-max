-- ============================================================
-- 122_meta_capi_app_secret.sql — optional per-account CAPI App Secret.
--
-- `appsecret_proof` must be HMAC-SHA256(access_token, <the App Secret of
-- the Meta app that issued that token>). A customer's System User token
-- can belong to their own Meta app, not the shared platform app, so the
-- platform META_LEAD_ADS_APP_SECRET is NOT necessarily the matching
-- secret — using it produced:
--
--   Invalid appsecret_proof provided in the API argument
--
-- We now store the customer's own App Secret (AES-256-GCM encrypted by
-- the app, same helper as access_token) when they provide it. When it is
-- absent the app omits appsecret_proof entirely (it is an optional Graph
-- argument) rather than sending one computed with the wrong secret.
--
-- Additive + idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE public.meta_capi_config
  ADD COLUMN IF NOT EXISTS app_secret TEXT;

COMMENT ON COLUMN public.meta_capi_config.app_secret IS
  'AES-256-GCM encrypted App Secret of the Meta app that issued access_token. Optional; used only to compute appsecret_proof. Never exposed to the browser.';
