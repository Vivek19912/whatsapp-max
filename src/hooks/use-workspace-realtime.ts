"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Live Workspace updates via Supabase Realtime on `flow_runs` and
 * `workspace_values`.
 *
 * The core logic lives in the pure `createWorkspaceRealtimeSubscription`
 * so it can be unit-tested without React rendering or a real Supabase
 * connection; `useWorkspaceRealtime` is a thin hook wrapper over it that
 * reuses the application's existing browser client (`createClient` from
 * `@/lib/supabase/client` — never a second client).
 *
 * Behavior contract (see the task spec):
 * - One channel per account+flow: `workspace-${accountId}-${flowId}`.
 * - Subscribes to `postgres_changes` on `flow_runs`, event `*`,
 *   filter `flow_id=eq.<flowId>`.
 * - ALSO subscribes to `postgres_changes` on `workspace_values`,
 *   event `*`, with NO table filter (that table carries no flow_id;
 *   scoping rides on RLS `workspace_values_select`). This refreshes
 *   the Assigned To column when an Inbox reassign writes the same
 *   cell from the other surface. Debounced like everything else, so
 *   unrelated cell edits coalesce instead of refetching per edit.
 * - Any INSERT/UPDATE/DELETE schedules the existing table reload,
 *   debounced (~1.2s) so a flow advancing through nodes produces ONE
 *   refetch, not many.
 * - The reload goes through the existing `reloadTable()` /
 *   `setRefreshSeq` path — the server RPC stays the single source of
 *   truth. No client-side row insertion, no payload filtering here.
 * - A reconnect back to `SUBSCRIBED` schedules one recovery reload so
 *   events missed while the socket was down are picked up.
 * - Cleanup removes the channel and cancels any pending debounce.
 *
 * Account isolation is guaranteed by the existing `flow_runs` RLS
 * (`flow_runs_select ... USING (is_account_member(account_id))`) — the
 * Realtime subscription can never receive another account's rows, and
 * the `/api/flows/[id]/table` refetch re-applies authorization and all
 * filters.
 */

/** Debounce window for coalescing bursts of flow_runs events. */
export const WORKSPACE_REALTIME_DEBOUNCE_MS = 1200;

/**
 * Minimal structural surface of the Realtime channel the controller
 * needs — kept deliberately narrow (not the full RealtimeChannel type)
 * so the real Supabase client and unit-test doubles both satisfy it.
 */
interface RealtimeChannelLike {
  on(
    event: string,
    filter: Record<string, unknown>,
    callback: (payload: unknown) => void,
  ): RealtimeChannelLike;
  subscribe(callback?: (status: string) => void): RealtimeChannelLike;
}

/** Minimal structural surface of the client the controller needs. */
export interface RealtimeClientLike {
  channel(name: string): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): void;
}

export interface WorkspaceRealtimeSubscriptionOptions {
  /** Existing browser Supabase client (or a test double with the same surface). */
  supabase: RealtimeClientLike;
  accountId: string;
  flowId: string;
  /** Called (debounced) after any flow_runs INSERT/UPDATE/DELETE. */
  onDataChanged: () => void;
  /** Debounce window — burst events coalesce into one call. Default 1200ms. */
  debounceMs?: number;
}

export function createWorkspaceRealtimeSubscription({
  supabase,
  accountId,
  flowId,
  onDataChanged,
  debounceMs = WORKSPACE_REALTIME_DEBOUNCE_MS,
}: WorkspaceRealtimeSubscriptionOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The first SUBSCRIBED is the initial connect, not a reconnect. Only
  // a later SUBSCRIBED (channel dropped and recovered) schedules a
  // recovery reload so events missed while disconnected are caught.
  let seenSubscribed = false;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onDataChanged();
    }, debounceMs);
  };

  const channel = supabase
    .channel(`workspace-${accountId}-${flowId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "flow_runs",
        filter: `flow_id=eq.${flowId}`,
      },
      schedule,
    )
    // Assigned To cells live in workspace_values (no flow_id column
    // to filter on — RLS scopes by account). Same debounce, so an
    // Inbox-side reassign refreshes the column it mirrors.
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "workspace_values",
      },
      schedule,
    )
    .subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      if (!seenSubscribed) {
        seenSubscribed = true;
        return;
      }
      schedule();
    });

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    supabase.removeChannel(channel);
  };
}

export interface UseWorkspaceRealtimeArgs {
  accountId: string | null;
  flowId: string | null;
  onChange: () => void;
  debounceMs?: number;
}

export function useWorkspaceRealtime({
  accountId,
  flowId,
  onChange,
  debounceMs,
}: UseWorkspaceRealtimeArgs): void {
  // Keep the latest callback in a ref so re-renders with fresh closures
  // don't tear down and rebuild the channel.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    // Subscribe only when a flow is actually selected (and the account
    // context has resolved). Changing flowId re-runs this effect, which
    // tears down the previous channel before subscribing to the new one.
    if (!flowId || !accountId) return;
    const supabase = createClient();
    return createWorkspaceRealtimeSubscription({
      supabase,
      accountId,
      flowId,
      onDataChanged: () => onChangeRef.current(),
      debounceMs,
    });
  }, [accountId, flowId, debounceMs]);
}