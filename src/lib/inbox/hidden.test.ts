import { describe, expect, it } from "vitest";

import {
  filterHidden,
  filterHiddenIds,
  getHiddenConversationIds,
  isHidden,
  type HiddenQueryClient,
} from "./hidden";

function stubClient(
  rows: { conversation_id: string }[] | null,
  error: { message: string } | null = null,
): HiddenQueryClient {
  return {
    from() {
      return {
        select() {
          return Promise.resolve({ data: rows, error });
        },
      };
    },
  };
}

describe("isHidden", () => {
  it("matches only set members", () => {
    const hidden = new Set(["a", "b"]);
    expect(isHidden(hidden, "a")).toBe(true);
    expect(isHidden(hidden, "c")).toBe(false);
    expect(isHidden(new Set(), "a")).toBe(false);
  });
});

describe("filterHidden", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("removes hidden conversations and preserves order", () => {
    expect(filterHidden(list, new Set(["b"]))).toEqual([
      { id: "a" },
      { id: "c" },
    ]);
  });

  it("returns everything when nothing is hidden", () => {
    expect(filterHidden(list, new Set())).toEqual(list);
  });

  it("does not mutate the input", () => {
    filterHidden(list, new Set(["a"]));
    expect(list).toHaveLength(3);
  });
});

describe("filterHiddenIds", () => {
  it("drops hidden ids for search hydration", () => {
    expect(filterHiddenIds(["a", "b", "c"], new Set(["a", "c"]))).toEqual([
      "b",
    ]);
  });
});

describe("getHiddenConversationIds", () => {
  it("builds a set from rows", async () => {
    const ids = await getHiddenConversationIds(
      stubClient([{ conversation_id: "a" }, { conversation_id: "b" }]),
    );
    expect(ids).toEqual(new Set(["a", "b"]));
  });

  it("returns empty on error or null rows", async () => {
    expect(
      await getHiddenConversationIds(stubClient(null, { message: "x" })),
    ).toEqual(new Set());
    expect(await getHiddenConversationIds(stubClient(null))).toEqual(
      new Set(),
    );
  });
});
