// POST /api/integrations/meta-capi/test-event
//
// Sends ONE event flagged with the account's Test Event Code so it
// shows up under Events Manager → Test Events. This is explicitly
// tagged `is_test` in the ledger and reported to the UI as a TEST, so
// it is never confused with a real production conversion.
//
// The payload deliberately mirrors the production CRM lifecycle shape
// (system_generated + crm markers, no messaging_channel): a CRM test is
// NOT a messaging conversion, and Meta rejects business_messaging
// without a messaging_channel which a CRM test can never provide.

import crypto from "node:crypto";
import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { isValidEventName } from "@/lib/meta-capi/catalog";
import { sendEvents } from "@/lib/meta-capi/client";
import { buildUserData } from "@/lib/meta-capi/hash";
import {
  CRM_EVENT_SOURCE,
  CRM_LEAD_EVENT_SOURCE,
  buildCapiEvent,
  buildRequestPayload,
} from "@/lib/meta-capi/payload";
import {
  buildFailureResponse,
  toStoredResponse,
} from "@/lib/meta-capi/response";
import {
  getConfig,
  getDecryptedAppSecret,
  getDecryptedToken,
  insertDelivery,
  markDeliveryFailed,
  markDeliverySent,
} from "@/lib/meta-capi/store";
import { metaCapiPlatform } from "@/lib/meta-capi/triggers";
import { MetaLeadAdsError } from "@/lib/meta-lead-ads/errors";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import { supabaseAdmin } from "@/lib/flows/admin-client";

/**
 * Synthetic identifier for CRM test events. RFC 2606 reserves
 * example.com for exactly this: a never-real address, hashed by the
 * tested buildUserData util into Meta's required SHA-256 `em` format.
 */
const TEST_EVENT_EMAIL = "test@example.com";

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const platform = metaCapiPlatform();
    if (!platform) {
      return NextResponse.json(
        { error: "Meta is not configured on this server.", code: "not_configured" },
        { status: 501 },
      );
    }

    const config = await getConfig(ctx.supabase, ctx.accountId);
    if (!config?.dataset_id || !config?.access_token) {
      return NextResponse.json(
        { error: "Connect your dataset and access token first." },
        { status: 400 },
      );
    }
    if (!config.test_event_code) {
      return NextResponse.json(
        {
          error:
            "Add a Test Event Code (Events Manager → Test Events) before sending a test.",
        },
        { status: 400 },
      );
    }
    const token = await getDecryptedToken(ctx.supabase, ctx.accountId);
    if (!token) {
      return NextResponse.json(
        { error: "No access token is stored." },
        { status: 400 },
      );
    }
    // Optional: only the customer's own app secret is ever used here.
    const appSecret = await getDecryptedAppSecret(ctx.supabase, ctx.accountId).catch(
      () => null,
    );

    const body = (await request.json().catch(() => null)) as
      | { event_name?: string }
      | null;
    const eventName =
      body?.event_name && isValidEventName(body.event_name)
        ? body.event_name.trim()
        : "Lead";

    const eventId = `test:${crypto.randomUUID()}`;
    // CRM lifecycle shape: system_generated + crm markers, no
    // messaging_channel. The account's configured action_source is
    // deliberately NOT used here — it describes messaging conversions,
    // not CRM lifecycle tests. user_data carries exactly one hashed
    // synthetic identifier (RFC-reserved example.com, never a real
    // customer) in Meta's required SHA-256 format; no original Meta
    // lead id is ever invented for a test event.
    const event = buildCapiEvent({
      eventName,
      eventId,
      actionSource: "system_generated",
      eventTime: new Date(),
      userData: buildUserData({ email: TEST_EVENT_EMAIL }),
      customData: {
        event_source: CRM_EVENT_SOURCE,
        lead_event_source: CRM_LEAD_EVENT_SOURCE,
      },
    });
    const payload = buildRequestPayload(event, config.test_event_code);

    const admin = supabaseAdmin();
    const delivery = await insertDelivery(admin, {
      account_id: ctx.accountId,
      mapping_id: null,
      flow_run_id: null,
      contact_id: null,
      source_action: "test",
      source_value: null,
      event_name: eventName,
      event_id: eventId,
      action_source: "system_generated",
      is_test: true,
      status: "pending",
      request_payload: payload,
    });

    try {
      const res = await sendEvents(platform, config.dataset_id, token, payload, {
        appSecret,
      });
      // An event counts as accepted only when Meta confirms receipt.
      if ((res.events_received ?? 0) < 1) {
        const message =
          "Meta accepted the request but reported 0 events received.";
        // Meta DID answer (the parsed body is right here), so persist
        // it verbatim — the Recent Deliveries viewer renders exactly
        // what is stored, and a null body would show "not available".
        const stored = toStoredResponse(null, res);
        if (delivery)
          await markDeliveryFailed(admin, delivery.id, 1, message, null, stored);
        return NextResponse.json(
          { error: message, code: "test_failed", response: stored },
          { status: 502 },
        );
      }
      if (delivery) {
        await markDeliverySent(admin, delivery.id, res as Record<string, unknown>, 1);
      }
      return NextResponse.json({
        ok: true,
        eventsReceived: res.events_received ?? 0,
        fbtraceId: res.fbtrace_id ?? null,
        note:
          "This was a TEST event (Test Event Code used). It is not a production conversion.",
      });
    } catch (err) {
      const message =
        err instanceof MetaLeadAdsError
          ? err.message
          : "Meta rejected the test event.";
      // Persist the COMPLETE Graph answer (HTTP status, code/subcode,
      // type, nested error data, fbtrace_id) via the shared helper, so
      // Recent Deliveries shows the exact Meta verdict. Network and
      // non-Graph failures yield { httpStatus: null, body: { message } }
      // — no Meta fields are ever invented, and credential-looking keys
      // are redacted at capture time.
      const stored = buildFailureResponse(err);
      if (delivery)
        await markDeliveryFailed(admin, delivery.id, 1, message, null, stored);
      return NextResponse.json(
        { error: message, code: "test_failed", response: stored },
        { status: 502 },
      );
    }
  } catch (err) {
    return metaErrorResponse(err);
  }
}
