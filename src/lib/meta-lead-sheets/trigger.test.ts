// Meta Sheets prompt drain trigger — scheduling, scoping, and
// failure isolation. Google API + DB work happens inside the
// tracked `after()` callback (post-response); scheduling itself
// never throws and never touches Flow Tables.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cbs: [] as Array<() => void>,
  afterThrows: false,
  drains: [] as Array<{ db: unknown; opts: Record<string, unknown> }>,
  drainError: null as Error | null,
  admin: { __adminClient: true },
}));

vi.mock("next/server", () => ({
  after: (cb: () => void) => {
    if (h.afterThrows) throw new Error("after() called outside request scope");
    h.cbs.push(cb);
  },
  NextResponse: class {},
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => h.admin,
}));

vi.mock("./queue", () => ({
  drainSheetsQueue: async (db: unknown, opts: Record<string, unknown>) => {
    h.drains.push({ db, opts });
    if (h.drainError) throw h.drainError;
    return { attempted: 1, sent: 1, failed: 0, skippedDisabled: 0, needsReauth: 0 };
  },
}));

import { PROMPT_DRAIN_LIMIT, scheduleSheetsDrainSoon } from "./trigger";

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  h.cbs = [];
  h.afterThrows = false;
  h.drains = [];
  h.drainError = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("scheduleSheetsDrainSoon", () => {
  it("schedules a bounded, account-scoped drain after the response", async () => {
    scheduleSheetsDrainSoon({ accountId: "acct-1" });
    expect(h.cbs).toHaveLength(1);
    // Nothing runs synchronously — the request path stays unblocked.
    expect(h.drains).toHaveLength(0);
    h.cbs[0]();
    await flush();
    expect(h.drains).toHaveLength(1);
    expect(h.drains[0].db).toBe(h.admin);
    expect(h.drains[0].opts).toMatchObject({
      limit: PROMPT_DRAIN_LIMIT,
      onlyAccountId: "acct-1",
    });
  });

  it("drains without an account scope when none is known", async () => {
    scheduleSheetsDrainSoon();
    h.cbs[0]();
    await flush();
    expect(h.drains).toHaveLength(1);
    expect(h.drains[0].opts).not.toHaveProperty("onlyAccountId");
  });

  it("swallows Google API failures and timeouts (cron fallback covers)", async () => {
    h.drainError = new Error("Google Sheets quota exceeded (429)");
    scheduleSheetsDrainSoon({ accountId: "acct-1" });
    h.cbs[0]();
    await flush();
    expect(h.drains).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });

  it("is a safe no-op outside request scope", () => {
    h.afterThrows = true;
    expect(() => scheduleSheetsDrainSoon({ accountId: "acct-1" })).not.toThrow();
    expect(h.cbs).toHaveLength(0);
    expect(h.drains).toHaveLength(0);
  });

  it("coalesces overlapping triggers via the queue's claim guard", async () => {
    // Three rapid triggers (new lead + assign + cell edit) schedule
    // three bounded drains; each is an independent tracked callback
    // and the shared claim-CAS dedupes the actual row work.
    scheduleSheetsDrainSoon({ accountId: "acct-1" });
    scheduleSheetsDrainSoon({ accountId: "acct-1" });
    scheduleSheetsDrainSoon({ accountId: "acct-1" });
    expect(h.cbs).toHaveLength(3);
    for (const cb of h.cbs) cb();
    await flush();
    expect(h.drains).toHaveLength(3);
    for (const d of h.drains) {
      expect(d.opts).toMatchObject({ limit: PROMPT_DRAIN_LIMIT, onlyAccountId: "acct-1" });
    }
  });
});
