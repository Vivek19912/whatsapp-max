import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Contract: the search route forwards the validated Lead Source value
// to the RPC as p_source. The RPC itself is covered structurally in
// search-history.test.ts; this pins the route half of the handoff.
const routeSrc = readFileSync(
  join(process.cwd(), "src", "app", "api", "inbox", "search", "route.ts"),
  "utf8"
);

describe("inbox search route Lead Source handoff", () => {
  it("passes p_source from validated params to the RPC", () => {
    expect(routeSrc).toContain("p_source: params.source");
  });

  it("keeps every existing RPC argument (no dropped facet)", () => {
    for (const arg of [
      "p_search: params.q",
      "p_status: params.status",
      "p_tag_ids: params.tagIds",
      "p_company: params.company",
      "p_flow_id: params.flowId",
      "p_member_ids: params.memberIds",
      "p_from: params.from",
      "p_to: params.to",
      "p_cur_ts:",
      "p_cur_id:",
      "p_limit: params.limit",
    ]) {
      expect(routeSrc).toContain(arg);
    }
  });
});
