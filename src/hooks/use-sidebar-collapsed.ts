import { useCallback, useReducer } from "react";
import { useSyncExternalStore } from "react";

// ============================================================
// Sidebar collapse preference — persisted UI state.
//
// Expanded (default) = full sidebar with labels; collapsed = a
// narrow desktop icon rail. Stored in localStorage per account
// (same scoping pattern as workspace column visibility), so the
// choice survives navigation (shell state) and refresh (storage).
// Collapsing only ever affects lg+ presentation classes — the
// mobile drawer always renders full-width regardless.
//
// SSR-safe: initial state is always expanded; the stored value
// syncs in an effect, so server and first-client HTML agree.
// Exception: an explicit deep-link request (`?sidebar=collapsed`,
// e.g. from a Recordings lead link) reads collapsed on the very
// first client snapshot — before first paint — so the new tab opens
// on the icon rail with no expanded flash or width animation. The
// flag is one-time and tab-scoped: it lives only in that tab's URL,
// is never written to the stored preference, and expanding the rail
// forgets it (see toggle). Ordinary navigation carries no flag and
// behaves exactly as before.
// ============================================================

export const SIDEBAR_COLLAPSED_PARAM = "sidebar";
export const SIDEBAR_COLLAPSED_VALUE = "collapsed";

/**
 * Whether the current navigation explicitly requests the collapsed
 * rail (`?sidebar=collapsed`). Pure function of an optional query
 * string (defaults to the live URL); SSR-safe — no window access on
 * the server, where it always answers false.
 */
export function hasCollapsedSidebarParam(search?: string): boolean {
  try {
    const query =
      search ?? (typeof window === "undefined" ? "" : window.location.search);
    return (
      new URLSearchParams(query).get(SIDEBAR_COLLAPSED_PARAM) ===
      SIDEBAR_COLLAPSED_VALUE
    );
  } catch {
    return false;
  }
}

/**
 * Forget a one-time collapsed-rail deep link (`?sidebar=collapsed`)
 * without a Next.js navigation — a plain history entry swap, so no
 * re-render, refetch, or remount can disturb an in-flight flow
 * (notably the contact deep-link locate → select → highlight
 * sequence that runs on the same mount). Used when expanding from
 * a state that exists only because of the link: persisting an
 * expansion there would be wrong (nothing is stored yet), and
 * leaving the flag would make the rail snap back to collapsed.
 * No-op server-side, when the flag is absent, or on failure.
 */
export function stripCollapsedSidebarParam(): void {
  try {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get(SIDEBAR_COLLAPSED_PARAM) !== SIDEBAR_COLLAPSED_VALUE) return;
    url.searchParams.delete(SIDEBAR_COLLAPSED_PARAM);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Best effort: worst case the flag lingers in the URL until the
    // next navigation, which the snapshot reader tolerates.
  }
}

const STORAGE_PREFIX = "wacrm:sidebar-collapsed:v1";

export function sidebarCollapsedStorageKey(accountId: string): string {
  return `${STORAGE_PREFIX}:${accountId}`;
}

/** Stored preference for this scope. Missing/corrupt → expanded. */
export function loadSidebarCollapsed(accountId: string | null): boolean {
  try {
    if (accountId === null || typeof localStorage === "undefined") return false;
    return localStorage.getItem(sidebarCollapsedStorageKey(accountId)) === "1";
  } catch {
    return false;
  }
}

/** Persist (collapsed) or clear (expanded = default state) the preference. */
export function saveSidebarCollapsed(accountId: string, collapsed: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    const key = sidebarCollapsedStorageKey(accountId);
    if (collapsed) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Session-only fallback: state still lives in React.
  }
}

export interface SidebarCollapsed {
  collapsed: boolean;
  toggle: () => void;
}

function subscribeToCollapse(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

/**
 * Shell-owned collapse state. Scope derives from the account every
 * render; switching accounts simply reads the other scope.
 * useSyncExternalStore (server snapshot: expanded) keeps server
 * and first-client HTML agreeing, syncs other tabs for free, and
 * satisfies the set-state-in-effect rule the naive effect version
 * trips. The local bump re-renders this tab after its own writes
 * (same-tab storage writes fire no event).
 */
export function useSidebarCollapsed(accountId: string | null): SidebarCollapsed {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const getSnapshot = useCallback(
    // A deep-linked collapse request wins over the stored default so
    // the new tab paints the rail immediately. Tab-scoped only: the
    // flag is never persisted, and the toggle below forgets it on
    // expand — so later visits and other tabs are untouched.
    () => loadSidebarCollapsed(accountId) || hasCollapsedSidebarParam(),
    [accountId],
  );
  const collapsed = useSyncExternalStore(
    subscribeToCollapse,
    getSnapshot,
    () => false,
  );
  const toggle = useCallback(() => {
    if (accountId === null) return;
    const stored = loadSidebarCollapsed(accountId);
    const hadParam = hasCollapsedSidebarParam();
    // A present flag is always one-time: forget it first, with a
    // plain history swap (no Next.js navigation, so an in-flight
    // deep-link locate → select → highlight is never disturbed).
    if (hadParam) stripCollapsedSidebarParam();
    if (!hadParam || stored) {
      // Ordinary toggle. A link-only collapse (nothing stored, flag
      // just forgotten above) already expanded — storing anything
      // here would wrongly persist a preference the user never set.
      saveSidebarCollapsed(accountId, !stored);
    }
    bump();
  }, [accountId]);
  return { collapsed, toggle };
}
