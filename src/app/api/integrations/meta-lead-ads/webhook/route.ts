// /api/integrations/meta-lead-ads/webhook
//
// Meta's Page webhook for the `leadgen` field.
//
//   GET  — answers Meta's verification challenge with the configured
//          verify token.
//   POST — validates X-Hub-Signature-256 against the App Secret over
//          the RAW body, then records each leadgen change idempotently
//          (account resolved server-side from the Page) and defers the
//          Graph retrieval to `after()` so we ack promptly.
//
// Invalid signatures are rejected; unknown Page ids and non-enabled
// forms are ignored. Account ids are NEVER taken from the payload.

import { after, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { metaLeadAdsConfig } from "@/lib/meta-lead-ads/config";
import {
  processSubmissionById,
  recordLeadgenNotification,
} from "@/lib/meta-lead-ads/process-lead";
import { verifyMetaWebhookSignature } from "@/lib/whatsapp/webhook-signature";

export const maxDuration = 60;

interface LeadgenChange {
  field?: string;
  value?: {
    leadgen_id?: string | number;
    page_id?: string | number;
    form_id?: string | number;
  };
}
interface WebhookEntry {
  id?: string;
  changes?: LeadgenChange[];
}
interface WebhookBody {
  object?: string;
  entry?: WebhookEntry[];
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  const config = metaLeadAdsConfig();
  if (!config) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  if (mode === "subscribe" && token === config.webhookVerifyToken && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function POST(request: Request) {
  const config = metaLeadAdsConfig();
  if (!config) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyMetaWebhookSignature(rawBody, signature, config.appSecret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(rawBody) as WebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Only Page leadgen events belong to this endpoint.
  if (body.object !== "page") {
    return new NextResponse("EVENT_RECEIVED", { status: 200 });
  }

  const admin = supabaseAdmin();
  const toProcess: string[] = [];

  for (const entry of body.entry ?? []) {
    const entryPageId = entry.id != null ? String(entry.id) : "";
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen") continue;
      const value = change.value ?? {};
      const leadgenId = value.leadgen_id != null ? String(value.leadgen_id) : "";
      const pageId = value.page_id != null ? String(value.page_id) : entryPageId;
      const formId = value.form_id != null ? String(value.form_id) : null;
      if (!leadgenId || !pageId) continue;

      try {
        const rec = await recordLeadgenNotification(admin, {
          pageId,
          formId,
          leadgenId,
        });
        if (rec.outcome === "received" && rec.submissionId) {
          toProcess.push(rec.submissionId);
        }
      } catch (err) {
        // Never fail the ack on a single bad entry — Meta retries the
        // whole batch on non-2xx, which would duplicate work.
        console.error(
          "[meta-lead-ads] record failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  if (toProcess.length > 0) {
    after(async () => {
      for (const id of toProcess) {
        try {
          await processSubmissionById(admin, config, id);
        } catch (err) {
          console.error(
            "[meta-lead-ads] processing failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
    });
  }

  return new NextResponse("EVENT_RECEIVED", { status: 200 });
}
