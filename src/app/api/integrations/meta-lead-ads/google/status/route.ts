// GET /api/integrations/meta-lead-ads/google/status
//
// Lightweight probe for the Settings → Meta connection card: is the
// server configured, is a Google account connected (email only), and
// does it need reconnecting. Tokens are NEVER returned. Table-level
// sync status lives on the per-table config endpoint in Workspace.
// Meta-only — does not read `google_connections` (Flow Tables).

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { metaSheetsOAuthConfigured } from '@/lib/meta-lead-sheets/oauth';
import { isReconnectErrorText } from '@/lib/meta-lead-sheets/sheets-client';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data } = await ctx.supabase
      .from('meta_lead_sheets_connections')
      .select('google_email, last_error')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    const conn = data as {
      google_email: string | null;
      last_error: string | null;
    } | null;
    // needsReauth derives from persisted auth-flavored error text
    // only (revoked/expired credentials). Quota, sharing,
    // validation, or missing-tab errors must never flip the
    // reconnect badge — and a stale reconnect note must clear on
    // reconnection (see the OAuth callback).
    return NextResponse.json({
      configured: metaSheetsOAuthConfigured(),
      connected: !!conn,
      needsReauth: isReconnectErrorText(conn?.last_error),
      email: conn?.google_email ?? null,
      lastError: conn?.last_error ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
