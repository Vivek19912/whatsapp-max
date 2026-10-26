// GET /api/integrations/meta-lead-ads/cron
//
// Sweeps failed Meta lead retrievals whose bounded-backoff window has
// elapsed, continues any interrupted historical import, and polls
// enabled forms for new leads (the webhook fallback). Auth re-uses
// AUTOMATION_CRON_SECRET / CRON_SECRET, matching the other cron
// endpoints (see scripts/setup-automation-cron.sh).

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { metaLeadAdsConfig } from '@/lib/meta-lead-ads/config';
import { drainMetaLeadNotifications } from '@/lib/meta-lead-ads/notify';
import { runDueRetries } from '@/lib/meta-lead-ads/process-lead';
import { POLL_DEFAULT_LIMIT, runLeadPolls } from '@/lib/meta-lead-ads/sync';
import { pumpActiveImportJobs } from '@/lib/meta-lead-sheets/import-jobs';
import { drainSheetsQueue } from '@/lib/meta-lead-sheets/queue';
import { drainWhatsappQueue } from '@/lib/meta-lead-whatsapp/queue';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const expectedSecrets = [
    process.env.CRON_SECRET,
    process.env.AUTOMATION_CRON_SECRET,
  ].filter((secret): secret is string => Boolean(secret));
  if (expectedSecrets.length === 0) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }

  const authorization = request.headers.get('authorization');
  const supplied =
    request.headers.get('x-cron-secret') ??
    (authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
  const suppliedBuf = Buffer.from(supplied);
  const authorized = expectedSecrets.some((expected) => {
    const expectedBuf = Buffer.from(expected);
    return (
      suppliedBuf.length === expectedBuf.length &&
      timingSafeEqual(suppliedBuf, expectedBuf)
    );
  });
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const config = metaLeadAdsConfig();
  if (!config) {
    return NextResponse.json(
      { error: 'Meta Lead Ads is not configured on this server.' },
      { status: 503 }
    );
  }

  try {
    const db = supabaseAdmin();

    // A failure sweeping old failed submissions must not stop new-lead
    // polling: the two paths are independent, and one broken retry
    // row/tenant must never stall every form. Polling itself isolates
    // per-form failures inside runLeadPolls.
    let retries = { attempted: 0, processed: 0, failed: 0, skipped: 0 };
    let retryError: string | null = null;
    try {
      retries = await runDueRetries(db, config, 50);
    } catch (error) {
      retryError = error instanceof Error ? error.message : String(error);
      console.error('[meta-lead-ads-cron] retry sweep failed:', retryError);
    }

    const sync = await runLeadPolls(db, config, POLL_DEFAULT_LIMIT);

    // New-lead email outbox drain. Fully isolated like the retry
    // sweep: notification failures never affect polling, and the
    // cadence is unchanged (same 5-minute sweep, no new scheduler).
    let notifications = {
      sent: 0,
      failed: 0,
      skippedDisabled: 0,
      finalFailures: 0,
    };
    try {
      notifications = await drainMetaLeadNotifications(db);
    } catch (error) {
      console.error(
        '[meta-lead-ads-cron] notification drain failed:',
        error instanceof Error ? error.message : error
      );
    }

    // ADDITIVE Meta Sheets live-sync drain. Same 5-minute sweep, no
    // new scheduler; per-row failures never affect polling or
    // notifications, and Sheets failures never roll back leads.
    // Meta-only: drains only meta_lead_sheets_queue rows.
    let sheets = {
      attempted: 0,
      sent: 0,
      failed: 0,
      skippedDisabled: 0,
      skippedNoConfig: 0,
      needsReauth: 0,
    };
    try {
      sheets = await drainSheetsQueue(db, { limit: 20 });
    } catch (error) {
      console.error(
        '[meta-lead-ads-cron] sheets drain failed:',
        error instanceof Error ? error.message : error
      );
    }

    // ADDITIVE WhatsApp auto-send drain. Same 5-minute sweep, no
    // new scheduler; per-row failures never affect polling,
    // notifications, or Sheets, and WhatsApp failures never roll
    // back leads. Meta-only: drains only meta_lead_whatsapp_queue
    // rows.
    let whatsapp = {
      attempted: 0,
      sent: 0,
      failed: 0,
      skippedPaused: 0,
      skippedNoConfig: 0,
      skippedNoPhone: 0,
      skippedOutOfOrder: 0,
    };
    try {
      whatsapp = await drainWhatsappQueue(db, { limit: 20 });
    } catch (error) {
      console.error(
        '[meta-lead-ads-cron] whatsapp drain failed:',
        error instanceof Error ? error.message : error
      );
    }

    // ADDITIVE manual-import job pump. Same 5-minute sweep, no
    // new scheduler: each active job gets one bounded worker pass
    // so imports complete in the background after POST returns.
    // Per-job failures are isolated and never affect polling,
    // notifications, or the live-sync drain.
    let imports = { jobs: 0, pumped: 0 };
    try {
      imports = await pumpActiveImportJobs(db);
    } catch (error) {
      console.error(
        '[meta-lead-ads-cron] import-job pump failed:',
        error instanceof Error ? error.message : error
      );
    }

    return NextResponse.json({
      ...retries,
      sync,
      notifications,
      sheets,
      whatsapp,
      imports,
      ...(retryError ? { retryError } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[meta-lead-ads-cron] sync sweep failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
