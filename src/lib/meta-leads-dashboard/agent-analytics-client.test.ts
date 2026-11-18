// Agent loader contract: hits the self-scoped endpoint (never the
// owner one), normalizes daily/monthly via the shared helpers, and
// passes through assignedTotal/stages verbatim.
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadMetaAgentAnalytics } from "./analytics-client";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
});

describe("loadMetaAgentAnalytics", () => {
  it("fetches /api/meta-lead-ads/agent-dashboard and normalizes the payload", async () => {
    let seenUrl = "";
    globalThis.fetch = vi.fn(async (url: unknown) => {
      seenUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          assignedTotal: 7,
          todayLeads: 2,
          yesterdayLeads: 1,
          last7Leads: 4,
          last30Leads: 6,
          daily: [{ date: "2026-10-01", total: 2, forms: [] }],
          monthly: [{ month: 10, total: 6, forms: [] }],
          year: 2026,
          stages: [
            { stage: "New", leads: 4 },
            { stage: null, leads: 3 },
          ],
        }),
      };
    }) as unknown as typeof fetch;

    const out = await loadMetaAgentAnalytics({
      startISO: "2026-10-01T00:00:00.000Z",
      endISO: "2026-10-02T00:00:00.000Z",
      prevStartISO: "2026-09-30T00:00:00.000Z",
      prevEndISO: "2026-10-01T00:00:00.000Z",
      year: 2026,
      tz: "UTC",
    });

    expect(seenUrl).toContain("/api/meta-lead-ads/agent-dashboard?");
    expect(seenUrl).not.toContain("/api/meta-lead-ads/dashboard?");
    expect(out.assignedTotal).toBe(7);
    expect(out.daily).toHaveLength(30);
    expect(out.monthly).toHaveLength(12);
    expect(out.stages).toEqual([
      { stage: "New", leads: 4 },
      { stage: null, leads: 3 },
    ]);
  });

  it("throws on non-OK responses", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    await expect(
      loadMetaAgentAnalytics({
        startISO: "2026-10-01T00:00:00.000Z",
        endISO: "2026-10-02T00:00:00.000Z",
        prevStartISO: "2026-09-30T00:00:00.000Z",
        prevEndISO: "2026-10-01T00:00:00.000Z",
        year: 2026,
        tz: "UTC",
      }),
    ).rejects.toThrow("403");
  });
});
