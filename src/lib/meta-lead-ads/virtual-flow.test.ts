import { describe, expect, it } from "vitest";

import {
  META_SOURCE_COLUMN_KEY,
  buildVirtualFlowNodes,
  parseFormQuestions,
  questionVarKeys,
  virtualFlowName,
} from "./virtual-flow";

describe("parseFormQuestions", () => {
  it("keeps well-formed entries and ignores the rest", () => {
    expect(
      parseFormQuestions([
        { key: "full_name", label: "Full Name", type: "TEXT" },
        "nope",
        null,
        { key: 5, label: "ok" },
      ]),
    ).toEqual([
      { key: "full_name", label: "Full Name", type: "TEXT" },
      { key: undefined, label: "ok", type: undefined },
    ]);
  });

  it("returns [] for non-arrays", () => {
    expect(parseFormQuestions(null)).toEqual([]);
    expect(parseFormQuestions({})).toEqual([]);
  });
});

describe("buildVirtualFlowNodes", () => {
  it("leads with a Source column then one node per question, chained", () => {
    const { nodes, entryNodeKey, questionKeys } = buildVirtualFlowNodes([
      { key: "Full Name", label: "Full Name" },
      { key: "Phone", label: "Phone Number" },
    ]);

    expect(entryNodeKey).toBe("meta_source_node");
    expect(nodes).toHaveLength(3);
    expect(nodes[0].config.var_key).toBe(META_SOURCE_COLUMN_KEY);
    expect(nodes[0].config.sheet_column_name).toBe("Source");
    expect(questionKeys).toEqual(["full_name", "phone"]);
    expect(nodes[1].config.sheet_column_name).toBe("Full Name");

    // Each node points at the next; the last terminates the chain.
    expect(nodes[0].config.next_node_key).toBe(nodes[1].node_key);
    expect(nodes[1].config.next_node_key).toBe(nodes[2].node_key);
    expect(nodes[2].config.next_node_key).toBeUndefined();
  });

  it("de-duplicates sanitized keys deterministically", () => {
    const { nodes } = buildVirtualFlowNodes([
      { key: "Phone" },
      { key: "phone" },
      { key: "PHONE" },
    ]);
    const keys = nodes.slice(1).map((n) => n.config.var_key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe("phone");
  });

  it("falls back to the raw key when no label is present", () => {
    const { nodes } = buildVirtualFlowNodes([{ key: "order_id" }]);
    expect(nodes[1].config.sheet_column_name).toBe("order_id");
    expect(nodes[1].config.var_key).toBe("order_id");
  });

  it("still emits the Source node for an empty question set", () => {
    const { nodes, questionKeys } = buildVirtualFlowNodes([]);
    expect(nodes).toHaveLength(1);
    expect(questionKeys).toEqual([]);
  });
});

describe("questionVarKeys", () => {
  it("matches the var_keys the virtual flow materializes", () => {
    const questions = [
      { key: "Full name", label: "Full name" },
      { key: "Phone", label: "Phone number" },
      { key: "phone" },
      {},
    ];
    const { questionKeys } = buildVirtualFlowNodes(questions);
    // Same deterministic derivation, so display lookups resolve to
    // the exact stored answer keys — re-running never re-keys data.
    expect(questionVarKeys(questions)).toEqual(questionKeys);
    expect(new Set(questionKeys).size).toBe(questionKeys.length);
  });
});

describe("virtualFlowName", () => {
  it("prefixes the form name and falls back to the id", () => {
    expect(virtualFlowName("Summer Promo", "123")).toBe("Meta Lead Ads · Summer Promo");
    expect(virtualFlowName("", "123")).toBe("Meta Lead Ads · 123");
    expect(virtualFlowName(null, "123")).toBe("Meta Lead Ads · 123");
  });
});
