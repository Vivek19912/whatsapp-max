import { describe, expect, it } from "vitest";

import {
  cleanHiddenTableIds,
  resolveWorkspaceTableAfterVisibility,
  visibleWorkspaceTables,
} from "./workspace-hidden-tables";

const TABLES = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("visibleWorkspaceTables", () => {
  it("returns every table when nothing is hidden", () => {
    expect(visibleWorkspaceTables(TABLES, new Set())).toEqual(TABLES);
    // A copy, never the same reference.
    expect(visibleWorkspaceTables(TABLES, new Set())).not.toBe(TABLES);
  });

  it("removes hidden tables by stable id only", () => {
    expect(visibleWorkspaceTables(TABLES, new Set(["b"])).map((t) => t.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("ignores unknown hidden ids", () => {
    expect(
      visibleWorkspaceTables(TABLES, new Set(["zzz"])).map((t) => t.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("keeps table order and never mutates the input", () => {
    const input = [...TABLES];
    visibleWorkspaceTables(input, new Set(["a", "c"]));
    expect(input.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});

describe("resolveWorkspaceTableAfterVisibility", () => {
  it("keeps the selection when it is still visible", () => {
    expect(resolveWorkspaceTableAfterVisibility(["a", "b"], "b")).toBe("b");
  });

  it("falls back to the first visible table when selected is hidden", () => {
    expect(resolveWorkspaceTableAfterVisibility(["a", "c"], "b")).toBe("a");
  });

  it("returns null when no visible table remains", () => {
    expect(resolveWorkspaceTableAfterVisibility([], "b")).toBeNull();
    expect(resolveWorkspaceTableAfterVisibility([], null)).toBeNull();
  });
});

describe("cleanHiddenTableIds", () => {
  it("keeps non-empty strings and drops everything else", () => {
    expect(cleanHiddenTableIds(["a", "  ", "", 42, null, "b", "a"])).toEqual(
      new Set(["a", "b"]),
    );
  });

  it("returns an empty set for non-arrays", () => {
    expect(cleanHiddenTableIds(null)).toEqual(new Set());
    expect(cleanHiddenTableIds("a")).toEqual(new Set());
  });
});
