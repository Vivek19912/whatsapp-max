import { describe, expect, it, vi } from "vitest";

import {
  buildDeliveryErrorRows,
  persistDeliveryErrors,
} from "./delivery-errors";

describe("buildDeliveryErrorRows", () => {
  it("returns [] when there are no errors", () => {
    expect(
      buildDeliveryErrorRows({
        accountId: "a",
        messageIds: ["m1"],
        providerMessageId: "w1",
        errors: [],
        providerTimestampIso: null,
      }),
    ).toEqual([]);
    expect(
      buildDeliveryErrorRows({
        accountId: "a",
        messageIds: ["m1"],
        providerMessageId: "w1",
        errors: null,
        providerTimestampIso: null,
      }),
    ).toEqual([]);
  });

  it("builds one row per message per error entry", () => {
    const rows = buildDeliveryErrorRows({
      accountId: "acct",
      messageIds: ["m1", "m2"],
      providerMessageId: "wamid.1",
      errors: [
        { code: 131026, title: "Undeliverable", message: "nope" },
        { code: 132000 },
      ],
      providerTimestampIso: "2026-11-01T04:00:16.000Z",
    });
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      account_id: "acct",
      message_id: "m1",
      provider_message_id: "wamid.1",
      code: 131026,
      title: "Undeliverable",
      message: "nope",
      provider_timestamp: "2026-11-01T04:00:16.000Z",
    });
    expect(rows[1].details).toEqual({});
  });

  it("keeps href in details and nulls missing scalars", () => {
    const [row] = buildDeliveryErrorRows({
      accountId: "a",
      messageIds: [],
      providerMessageId: "w2",
      errors: [{ href: "https://example.com/x" }],
      providerTimestampIso: null,
    });
    expect(row.message_id).toBeNull();
    expect(row.code).toBeNull();
    expect(row.details).toEqual({ href: "https://example.com/x" });
  });

  it("persists nested error_data.details", () => {
    const [row] = buildDeliveryErrorRows({
      accountId: "a",
      messageIds: ["m"],
      providerMessageId: "w",
      errors: [
        {
          code: 131053,
          title: "Media upload error",
          error_data: { details: "Image fetch failed" },
        },
      ],
      providerTimestampIso: null,
    });
    expect(row.details).toEqual({ error_data_details: "Image fetch failed" });
  });

  it("never includes tokens or payloads", () => {
    const [row] = buildDeliveryErrorRows({
      accountId: "a",
      messageIds: ["m"],
      providerMessageId: "w",
      errors: [{ code: 1, title: "t", message: "m", href: "h" }],
      providerTimestampIso: null,
    });
    expect(Object.keys(row).sort()).toEqual(
      [
        "account_id",
        "code",
        "details",
        "message",
        "message_id",
        "provider_message_id",
        "provider_timestamp",
        "title",
      ].sort(),
    );
  });
});

describe("persistDeliveryErrors", () => {
  it("inserts rows and returns the count", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const client = { from: () => ({ insert }) };
    const n = await persistDeliveryErrors(client, [
      {
        account_id: "a",
        message_id: "m",
        provider_message_id: "w",
        code: 1,
        title: null,
        message: null,
        details: {},
        provider_timestamp: null,
      },
    ]);
    expect(n).toBe(1);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("returns 0 without inserting when empty or failed", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    expect(await persistDeliveryErrors({ from: () => ({ insert }) }, [])).toBe(
      0,
    );
    expect(insert).not.toHaveBeenCalled();
    const failing = {
      from: () => ({ insert: async () => ({ error: { message: "x" } }) }),
    };
    expect(
      await persistDeliveryErrors(failing, [
        {
          account_id: "a",
          message_id: null,
          provider_message_id: "w",
          code: null,
          title: null,
          message: null,
          details: {},
          provider_timestamp: null,
        },
      ]),
    ).toBe(0);
  });

  it("survives a throwing client without propagating", async () => {
    const throwing = {
      from: () => ({
        insert: async () => {
          throw new Error("boom");
        },
      }),
    };
    await expect(
      persistDeliveryErrors(throwing, [
        {
          account_id: "a",
          message_id: "m",
          provider_message_id: "w",
          code: 1,
          title: null,
          message: null,
          details: {},
          provider_timestamp: null,
        },
      ]),
    ).resolves.toBe(0);
  });
});
