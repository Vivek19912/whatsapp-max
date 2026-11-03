import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceRealtimeSubscription,
  WORKSPACE_REALTIME_DEBOUNCE_MS,
} from "./use-workspace-realtime";

// ---------------------------------------------------------------------------
// The subscription core (`createWorkspaceRealtimeSubscription`) is a pure
// controller — no React, no real Supabase — so it's unit-tested directly
// with a fake client surface and fake timers. The thin hook wrapper is
// asserted via its source (React effects don't run under renderToStaticMarkup,
// matching this repo's existing test style).
// ---------------------------------------------------------------------------

interface FakeChannel {
  name: string;
  handlers: Array<(payload: unknown) => void>;
  configs: Array<Record<string, unknown>>;
  subscribeCb: ((status: string) => void) | null;
  on: (
    event: string,
    cfg: Record<string, unknown>,
    cb: (p: unknown) => void,
  ) => FakeChannel;
  subscribe: (cb: (status: string) => void) => FakeChannel;
}

function fakeClient() {
  const channels: FakeChannel[] = [];
  const removed: FakeChannel[] = [];
  const client = {
    channel(name: string) {
      const ch: FakeChannel = {
        name,
        handlers: [],
        configs: [],
        subscribeCb: null,
        on: (_event: string, cfg: Record<string, unknown>, cb: (p: unknown) => void) => {
          ch.configs.push(cfg);
          ch.handlers.push(cb);
          return ch;
        },
        subscribe: (cb: (status: string) => void) => {
          ch.subscribeCb = cb;
          return ch;
        },
      };
      channels.push(ch);
      return ch;
    },
    removeChannel(ch: FakeChannel) {
      removed.push(ch);
    },
  };
  return { client, channels, removed };
}

function emit(ch: FakeChannel, eventType: string) {
  ch.handlers[0]?.({ eventType });
}

function connect(ch: FakeChannel, times = 1) {
  for (let i = 0; i < times; i++) ch.subscribeCb?.("SUBSCRIBED");
}

const ACCOUNT = "acct-1";
const FLOW = "flow-1";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createWorkspaceRealtimeSubscription", () => {
  it("subscribes to flow_runs postgres_changes scoped to the selected flow", () => {
    const { client, channels } = fakeClient();
    const onChange = vi.fn();
    createWorkspaceRealtimeSubscription({
      supabase: client,
      accountId: ACCOUNT,
      flowId: FLOW,
      onDataChanged: onChange,
    });
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe(`workspace-${ACCOUNT}-${FLOW}`);
    expect(channels[0].configs).toEqual([
      {
        event: "*",
        schema: "public",
        table: "flow_runs",
        filter: `flow_id=eq.${FLOW}`,
      },
      {
        event: "*",
        schema: "public",
        table: "workspace_values",
      },
    ]);
  });

  it("workspace_values changes schedule the same debounced reload", () => {
    const { client, channels } = fakeClient();
    const onChange = vi.fn();
    createWorkspaceRealtimeSubscription({
      supabase: client,
      accountId: ACCOUNT,
      flowId: FLOW,
      onDataChanged: onChange,
    });
    const ch = channels[0];
    // Second handler = workspace_values (Assigned To edits from Inbox).
    ch.handlers[1]?.({ eventType: "UPDATE" });
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WORKSPACE_REALTIME_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("INSERT/UPDATE/DELETE each schedule one debounced reload", () => {
    const { client, channels } = fakeClient();
    const onChange = vi.fn();
    createWorkspaceRealtimeSubscription({
      supabase: client,
      accountId: ACCOUNT,
      flowId: FLOW,
      onDataChanged: onChange,
    });
    const ch = channels[0];

    for (const ev of ["INSERT", "UPDATE", "DELETE"]) emit(ch, ev);
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(WORKSPACE_REALTIME_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of rapid events into exactly one reload", () => {
    const { client, channels } = fakeClient();
    const onChange = vi.fn();
    createWorkspaceRealtimeSubscription({
      supabase: client,
      accountId: ACCOUNT,
      flowId: FLOW,
      onDataChanged: onChange,
    });
    const ch = channels[0];

    for (let i = 0; i < 8; i++) {
      emit(ch, "UPDATE");
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(WORKSPACE_REALTIME_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("fires reload on the debounce boundary, not before it", () => {
    const { client, channels } = fakeClient();
    const onChange = vi.fn();
    createWorkspaceRealtimeSubscription({
      supabase: client,
      accountId: ACCOUNT,
      flowId: FLOW,
      onDataChanged: onChange,
    });
    emit(channels[0], "INSERT");
    vi.advanceTimersByTime(WORKSPACE_REALTIME_DEBOUNCE_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("cleanup removes the channel and cancels a pending debounce", () => {
    const { client, channels, removed } = fakeClient();
    const onChange = vi.fn();
    const teardown = createWorkspaceRealtimeSubscription({
      supabase: client,
      accountId: ACCOUNT,
      flowId: FLOW,
      onDataChanged: onChange,
    });
    emit(channels[0], "UPDATE");
    vi.advanceTimersByTime(500);

    teardown();

    expect(removed).toHaveLength(1);
    expect(removed[0]).toBe(channels[0]);
    // Pending debounce was cancelled — no reload after cleanup.
    vi.advanceTimersByTime(WORKSPACE_REALTIME_DEBOUNCE_MS * 2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("the initial SUBSCRIBED does not reload; a reconnect SUBSCRIBED does", () => {
    const { client, channels } = fakeClient();
    const onChange = vi.fn();
    createWorkspaceRealtimeSubscription({
      supabase: client,
      accountId: ACCOUNT,
      flowId: FLOW,
      onDataChanged: onChange,
    });
    const ch = channels[0];

    // Initial connect — no recovery reload.
    connect(ch);
    vi.advanceTimersByTime(WORKSPACE_REALTIME_DEBOUNCE_MS);
    expect(onChange).not.toHaveBeenCalled();

    // Channel dropped and re-subscribed → one recovery reload.
    connect(ch);
    vi.advanceTimersByTime(WORKSPACE_REALTIME_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("useWorkspaceRealtime hook wiring", () => {
  const root = process.cwd();
  const src = readFileSync(
    `${root}/src/hooks/use-workspace-realtime.ts`,
    "utf8",
  );

  it("never subscribes when no flow is selected (or account unresolved)", () => {
    expect(src).toContain("if (!flowId || !accountId) return;");
  });

  it("reuses the existing browser Supabase client, never a second one", () => {
    expect(src).toContain('import { createClient } from "@/lib/supabase/client";');
    expect(src).not.toContain("createBrowserClient(");
  });

  it("guards the first SUBSCRIBED so reconnects are the only recovery reloads", () => {
    expect(src).toContain("seenSubscribed");
  });
});