// Meta CRM lead-quality — mapping + payload contracts.
//
// Pins: exact five-event mapping (case-insensitive), legacy/unmapped
// values never map, all five states explicitly selectable, payload uses
// system_generated + user_data.lead_id + stable event_id, invalid
// inputs throw without touching the network.

import { describe, expect, it, vi } from "vitest";

import {
  CRM_EVENT_NAMES,
  LEAD_QUALITY_OPTIONS,
  LEAD_QUALITY_TOOLTIP,
  buildCrmEventPayload,
  buildCrmEventsUrl,
  buildCrmRequestBody,
  isSafeJsonInteger,
  leadQualityToEvent,
  parseCrmRequestBody,
  sendCrmEvent,
  serializeCrmRequestBody,
  validateMetaLeadId,
} from "./lead-quality";
import { MetaCrmError } from "./datasets";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("leadQualityToEvent", () => {
  it("maps the five CRM display values to events", () => {
    expect(leadQualityToEvent("Lead")).toBe("Lead");
    expect(leadQualityToEvent("Interested Lead")).toBe("InterestedLead");
    expect(leadQualityToEvent("Qualified Lead")).toBe("QualifiedLead");
    expect(leadQualityToEvent("Booking Confirmed")).toBe("BookingConfirmed");
    expect(leadQualityToEvent("Disqualified Lead")).toBe("DisqualifiedLead");
  });

  it("matches case-insensitively with whitespace tolerance", () => {
    expect(leadQualityToEvent("  qualified lead ")).toBe("QualifiedLead");
    expect(leadQualityToEvent("BOOKING CONFIRMED")).toBe("BookingConfirmed");
  });

  it("never maps legacy, empty, or unknown values", () => {
    for (const bad of ["Hot", "Warm", "Cold", "Fake", "Contacted", "", "  ", null, undefined, 42]) {
      expect(leadQualityToEvent(bad as string | null)).toBeNull();
    }
  });

  it("keeps exactly five event names and five selectable options (Lead included)", () => {
    expect([...CRM_EVENT_NAMES]).toEqual([
      "Lead",
      "InterestedLead",
      "QualifiedLead",
      "BookingConfirmed",
      "DisqualifiedLead",
    ]);
    expect([...LEAD_QUALITY_OPTIONS]).toEqual([
      "Lead",
      "Interested Lead",
      "Qualified Lead",
      "Booking Confirmed",
      "Disqualified Lead",
    ]);
    // Every send is manual, so the initial state is explicitly
    // selectable — saving it can never duplicate an auto-event.
    expect(LEAD_QUALITY_OPTIONS).toContain("Lead");
    expect(LEAD_QUALITY_TOOLTIP.length).toBeGreaterThan(20);
  });
});

describe("buildCrmEventPayload", () => {
  it("builds a CRM payload with system_generated + lead_id + event_id + required custom_data", () => {
    const payload = buildCrmEventPayload({
      eventName: "QualifiedLead",
      eventTimeIso: "2026-11-22T10:00:00.000Z",
      metaLeadId: "123456789012345",
      eventUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    expect(payload).toEqual({
      event_name: "QualifiedLead",
      event_time: Math.floor(Date.parse("2026-11-22T10:00:00.000Z") / 1000),
      action_source: "system_generated",
      user_data: { lead_id: "123456789012345" },
      custom_data: { lead_event_source: "WhatsApp Max", event_source: "crm" },
      event_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
  });

  it("refuses fabricated times and missing lead ids", () => {
    expect(() =>
      buildCrmEventPayload({
        eventName: "Lead",
        eventTimeIso: "not-a-date",
        metaLeadId: "123",
        eventUuid: "u",
      }),
    ).toThrow(MetaCrmError);
    expect(() =>
      buildCrmEventPayload({
        eventName: "Lead",
        eventTimeIso: "2026-11-22T10:00:00.000Z",
        metaLeadId: "   ",
        eventUuid: "u",
      }),
    ).toThrow(MetaCrmError);
  });

  it("rejects non-numeric, substituted, or over-long lead ids (never coerced)", () => {
    for (const bad of ["LEAD1", "FORM-99", "12ab34", "", "1".repeat(21)]) {
      expect(() => validateMetaLeadId(bad)).toThrow(MetaCrmError);
      expect(() =>
        buildCrmEventPayload({
          eventName: "Lead",
          eventTimeIso: "2026-11-22T10:00:00.000Z",
          metaLeadId: bad,
          eventUuid: "u",
        }),
      ).toThrow(MetaCrmError);
    }
    expect(validateMetaLeadId("  1176464514919762  ")).toBe("1176464514919762");
  });

  it("rejects future event times (occurrence only, never the future)", () => {
    expect(() =>
      buildCrmEventPayload({
        eventName: "QualifiedLead",
        eventTimeIso: new Date(Date.now() + 60 * 60_000).toISOString(),
        metaLeadId: "1176464514919762",
        eventUuid: "u",
      }),
    ).toThrow(MetaCrmError);
  });

  it("includes pre-hashed match data when provided, omits it otherwise", () => {
    const withMatch = buildCrmEventPayload({
      eventName: "QualifiedLead",
      eventTimeIso: "2026-11-22T10:00:00.000Z",
      metaLeadId: "1176464514919762",
      eventUuid: "u",
      match: { em: ["aaa"], ph: ["bbb"] },
    });
    expect(withMatch.user_data).toEqual({
      lead_id: "1176464514919762",
      em: ["aaa"],
      ph: ["bbb"],
    });
    const without = buildCrmEventPayload({
      eventName: "Lead",
      eventTimeIso: "2026-11-22T10:00:00.000Z",
      metaLeadId: "1176464514919762",
      eventUuid: "u",
    });
    expect(without.user_data).toEqual({ lead_id: "1176464514919762" });
  });

  it("pins the v27.0 events endpoint with the dataset id as text", () => {
    expect(buildCrmEventsUrl("1830596054845292")).toBe(
      "https://graph.facebook.com/v27.0/1830596054845292/events",
    );
  });
});

describe("CRM request body (documented `data` wrapper)", () => {
  it("wraps the event in a top-level data array with all CRM parameters", () => {
    const payload = buildCrmEventPayload({
      eventName: "InterestedLead",
      eventTimeIso: "2026-11-22T10:00:00.000Z",
      metaLeadId: "1176464514919762",
      eventUuid: "fc4bb2a7482cc029",
    });
    const body = buildCrmRequestBody(payload);
    expect(body).toEqual({
      data: [
        {
          event_name: "InterestedLead",
          event_time: Math.floor(Date.parse("2026-11-22T10:00:00.000Z") / 1000),
          action_source: "system_generated",
          user_data: { lead_id: "1176464514919762" },
          custom_data: { lead_event_source: "WhatsApp Max", event_source: "crm" },
          event_id: "fc4bb2a7482cc029",
        },
      ],
    });
    // The serializer emits exactly-representable ids as JSON numbers
    // (Meta's documented integer type); parsing them back yields the
    // numeric form of the same event.
    const reparsed = parseCrmRequestBody(serializeCrmRequestBody(body));
    expect(reparsed.data[0]).toEqual({
      ...body.data[0],
      user_data: { lead_id: 1176464514919762 },
    });
  });

  it("serializes safe ids as JSON numbers (documented integer type)", () => {
    const payload = buildCrmEventPayload({
      eventName: "Lead",
      eventTimeIso: "2026-11-22T10:00:00.000Z",
      metaLeadId: "1176464514919762",
      eventUuid: "u",
    });
    expect(isSafeJsonInteger("1176464514919762")).toBe(true);
    const parsed = JSON.parse(serializeCrmRequestBody(buildCrmRequestBody(payload)));
    expect(parsed.data[0].user_data.lead_id).toBe(1176464514919762);
  });

  it("preserves over-range ids as exact strings (never imprecise numbers)", () => {
    const huge = "99999999999999999999";
    expect(isSafeJsonInteger(huge)).toBe(false);
    const parsed = JSON.parse(
      serializeCrmRequestBody(
        buildCrmRequestBody(
          buildCrmEventPayload({
            eventName: "Lead",
            eventTimeIso: "2026-11-22T10:00:00.000Z",
            metaLeadId: huge.slice(0, 20),
            eventUuid: "u",
          }),
        ),
      ),
    );
    // Exact digits survive; a float conversion would corrupt them.
    expect(parsed.data[0].user_data.lead_id).toBe(huge.slice(0, 20));
    expect(typeof parsed.data[0].user_data.lead_id).toBe("string");
  });
});

describe("sendCrmEvent", () => {
  it("POSTs one event array with Bearer auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ events_received: 1 });
    }) as unknown as typeof fetch;

    const { response } = await sendCrmEvent({
      datasetId: "1830596054845292",
      accessToken: "USER_TOKEN",
      payload: buildCrmEventPayload({
        eventName: "Lead",
        eventTimeIso: "2026-11-22T10:00:00.000Z",
        metaLeadId: "123",
        eventUuid: "uuid-1",
      }),
      fetchImpl,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://graph.facebook.com/v27.0/1830596054845292/events");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer USER_TOKEN");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event_id).toBe("uuid-1");
    // Documented integer form on the wire for exactly-representable ids.
    expect(body.data[0].user_data.lead_id).toBe(123);
    expect(response).toEqual({ events_received: 1 });
  });

  it("maps Meta #200 to forbidden with codes and never leaks the token", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: { message: "No permission.", code: 200, error_subcode: 7 } }, 400)) as unknown as typeof fetch;
    const err = await sendCrmEvent({
      datasetId: "12345",
      accessToken: "SECRET_TOKEN_XYZ",
      payload: buildCrmEventPayload({
        eventName: "Lead",
        eventTimeIso: "2026-11-22T10:00:00.000Z",
        metaLeadId: "123",
        eventUuid: "uuid-1",
      }),
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect((err as MetaCrmError).status).toBe(403);
    expect((err as MetaCrmError).metaCode).toBe(200);
    expect(String((err as Error).message)).not.toContain("SECRET_TOKEN_XYZ");
  });

  it("single POST with no retry on network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const err = await sendCrmEvent({
      datasetId: "12345",
      accessToken: "TOK",
      payload: buildCrmEventPayload({
        eventName: "Lead",
        eventTimeIso: "2026-11-22T10:00:00.000Z",
        metaLeadId: "123",
        eventUuid: "uuid-1",
      }),
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
