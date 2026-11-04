// Client contracts for Team Member Lead Performance: payload
// normalization, sentinel handling, and the exact query mapping.
// Server-side counting/dedup logic is pinned by the migration
// contract test; these cover everything the browser decides.
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  loadTeamPerformance,
  normalizeLeadRows,
} from "./team-performance-client";

describe("normalizeLeadRows", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    ts: "2026-11-04T10:00:00.000Z",
    lead_id: "l1",
    form_name: "Fair",
    assignee_id: "u1",
    assignee_name: "Asha",
    stage: "Qualified",
    type: "Hot",
    contact_name: "Ravi",
    contact_phone: "+911234567890",
    ...over,
  });

  it("maps RPC snake_case rows onto the client shape", () => {
    const out = normalizeLeadRows([row()]);
    expect(out).toEqual([{
      date: "2026-11-04T10:00:00.000Z",
      leadName: "Ravi",
      leadPhone: "+911234567890",
      formName: "Fair",
      assigneeName: "Asha",
      type: "Hot",
      stage: "Qualified",
    }]);
  });

  it("keeps missing values nullable instead of inventing labels", () => {
    const out = normalizeLeadRows([row({
      stage: null, type: null, contact_name: null, contact_phone: null, assignee_name: null,
    })]);
    expect(out[0]).toMatchObject({
      stage: null, type: null, leadName: null, leadPhone: null, assigneeName: null,
    });
  });

  it("drops malformed rows and non-arrays", () => {
    expect(normalizeLeadRows(null)).toEqual([]);
    expect(normalizeLeadRows([{ ts: "bad" }])).toEqual([]);
    expect(normalizeLeadRows([null, 42])).toEqual([]);
  });
});

describe("loadTeamPerformance query mapping", () => {
  const seen: string[] = [];

  beforeEach(() => {
    seen.length = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return {
        ok: true,
        json: async () => ({
          members: [], unassigned: { total: 0, stages: [], types: [] },
          summary: { total: 0, assigned: 0, unassigned: 0 },
          forms: [], leads: { total: 0, rows: [] },
        }),
      } as Response;
    });
  });

  it("sends filters and pagination without any account id", async () => {
    await loadTeamPerformance({
      formId: "form-1",
      from: "2026-11-01",
      to: "2026-11-04",
      tz: "Asia/Kolkata",
      member: "u1",
      stage: "Qualified",
      type: "__none__",
      search: "ravi",
      page: 2,
      pageSize: 25,
    });
    const url = seen[0] ?? "";
    expect(url).toContain("/api/meta-lead-ads/team-performance?");
    for (const part of [
      "formId=form-1", "from=2026-11-01", "to=2026-11-04",
      "tz=Asia%2FKolkata", "member=u1", "stage=Qualified",
      "type=__none__", "search=ravi", "page=2", "pageSize=25",
    ]) {
      expect(url).toContain(part);
    }
    expect(url).not.toContain("account");
  });

  it("omits empty filters (aggregates-only call sends no member/stage/type/search)", async () => {
    await loadTeamPerformance({ tz: "UTC" });
    const url = seen[0] ?? "";
    expect(url).not.toContain("member=");
    expect(url).not.toContain("stage=");
    expect(url).not.toContain("type=");
    expect(url).not.toContain("search=");
    expect(url).toContain("page=1");
  });

  it("throws on HTTP errors without fabricating data", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500 } as Response));
    await expect(loadTeamPerformance({ tz: "UTC" })).rejects.toThrow("500");
  });
});
