"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import {
  confirmSignedOut,
  verifySessionActive,
} from "@/lib/auth/session-recovery";
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  isAccountRole,
  type AccountRole,
} from "@/lib/auth/roles";

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  /**
   * Opted-in beta feature keys for this account. No current feature
   * reads this — Flows was the last user and went to soft-GA in PR
   * #134 — but the column survives for future beta gates.
   */
  beta_features: string[];
  account_id: string | null;
  account_role: AccountRole | null;
}

interface AccountSummary {
  id: string;
  name: string;
  /** Default deal currency (ISO-4217). NOT NULL DEFAULT 'INR' in the
   *  DB (migration 021 as updated by 092); narrowed to DEFAULT_CURRENCY when absent. */
  default_currency: string;
  /** Travel CRM URL for the sidebar cross-app card (migration 076).
   *  Null (or empty) hides the card. Narrowed to null for older
   *  schemas where the column doesn't exist yet. */
  travel_crm_url: string | null;
}

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  /**
   * Session-level loading. Flips to false as soon as we know whether
   * a user is signed in, *without* waiting for the profile row. Use
   * this for chrome (sidebar / header) that can render with just the
   * user object.
   */
  loading: boolean;
  /**
   * Profile-row loading. Stays true until `fetchProfile` settles
   * (success, missing row, or error). Code that branches on
   * `profile.beta_features` MUST gate on this — otherwise it sees the
   * `{ loading: false, profile: null }` window during initial load
   * and may take the "not opted in" branch incorrectly.
   */
  profileLoading: boolean;
  signOut: () => Promise<void>;
  /**
   * Whether the session is confirmed dead. The dashboard shell
   * redirects to /login ONLY on "signed-out" — a null user with
   * "unknown" (transient blip under verification) renders blank
   * and waits for the next auth event instead of bouncing.
   */
  sessionStatus: "active" | "signed-out" | "unknown";
  /** Re-fetch the current user's profile row — call after a save from
   *  the settings form so header/sidebar reflect the change without a
   *  full page reload. */
  refreshProfile: () => Promise<void>;

  // ----------------------------------------------------------
  // Account-scoped context (added by the account-sharing series)
  //
  // All of these are nullable until `profileLoading` is false.
  // After the profile resolves they're guaranteed to be set,
  // because migration 017 made `account_id` / `account_role`
  // NOT NULL on `profiles`.
  // ----------------------------------------------------------

  /** Account id the current user belongs to. Null while loading. */
  accountId: string | null;
  /** Role within that account. Null while loading. */
  accountRole: AccountRole | null;
  /** Lightweight account meta — id + name + default_currency +
   *  travel_crm_url. Null while loading. */
  account: AccountSummary | null;
  /** Account default deal currency. Falls back to DEFAULT_CURRENCY
   *  while loading or when no account is resolved, so callers can use
   *  it unconditionally. */
  defaultCurrency: string;
  /** True if `accountRole === 'owner'`. */
  isOwner: boolean;
  /** True if `accountRole === 'admin'` (does NOT include owner — use canManageMembers for "admin or above"). */
  isAdmin: boolean;
  /** True if `accountRole === 'agent'`. */
  isAgent: boolean;
  /** True if `accountRole === 'viewer'`. */
  isViewer: boolean;
  /** True if the caller can manage members (admin+). */
  canManageMembers: boolean;
  /** True if the caller can edit account-wide settings (admin+). */
  canEditSettings: boolean;
  /** True if the caller can send messages and edit operational data (agent+). */
  canSendMessages: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * AuthProvider — wrap this around the dashboard layout.
 * Makes ONE getSession() call for the whole tree instead of one per
 * component, avoiding internal lock contention in the Supabase client.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // Session liveness as last determined: 'active' while a user is
  // known, 'signed-out' only after a verification proves death,
  // 'unknown' while a null session is still being confirmed.
  const [sessionStatus, setSessionStatus] = useState<
    "active" | "signed-out" | "unknown"
  >("unknown");
  // Tracked separately from `loading`. The session settles fast (one
  // local cookie read); the profile fetch crosses the network and
  // settles later. Callers that gate on `profile.*` need to know which
  // window they're in — see the type doc above.
  const [profileLoading, setProfileLoading] = useState(true);

  // Tracks the user ID we've successfully initiated/completed fetching
  // a profile for. This prevents redundant re-fetches and toggling
  // profileLoading back to true on window focus events/token refresh.
  const lastFetchedUserIdRef = useRef<string | null>(null);

  // True once an explicit signOut() is in flight. A null-session event
  // landing in that window must not trigger recovery — wiping already
  // won. (Reload on navigation discards the ref; a failed signOut
  // resets it so later events still verify.)
  const signingOutRef = useRef(false);
  // Serializes recovery verifications: one bounded check at a time,
  // so a burst of null-session events can't stack concurrent getUser
  // calls and hammer Supabase during an outage.
  const recoveringRef = useRef(false);
  // True once init has settled (successfully or after verification).
  // Lets the safety timer below stand down instead of double-settling.
  const settledRef = useRef(false);

  // Shared across init, auth-state-change listener, and the exposed
  // refreshProfile() callback. Reads the current session's user id and
  // pulls the matching profile row along with its account summary.
  const fetchProfile = useCallback(async (userId: string) => {
    const supabase = createClient();
    setProfileLoading(true);
    lastFetchedUserIdRef.current = userId;
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select(
          "id, full_name, email, avatar_url, role, beta_features, account_id, account_role",
        )
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        console.error("[AuthProvider] fetchProfile error:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        lastFetchedUserIdRef.current = null;
        return;
      }

      if (data) {
        // Load the account with a plain lookup by id instead of an
        // embedded FK join. The embed (`account:accounts!inner(...)`)
        // forces PostgREST to resolve the profiles.account_id →
        // accounts.id relationship from its schema cache; a stale cache
        // (common right after a migration adds the FK) makes it fail
        // hard with PGRST200 and blanks the whole profile — the user
        // then loses account context everywhere (issue #294). A point
        // lookup by id needs no relationship inference, so the profile
        // (with account_id / account_role) still resolves even if the
        // account name lookup itself can't.
        let accountRow: AccountSummary | null = null;
        if (data.account_id) {
          const { data: account, error: accountErr } = await supabase
            .from("accounts")
            // default_currency added in migration 021, travel_crm_url
            // in 076; both narrowed below for older schemas where
            // they read null.
            .select("id, name, default_currency, travel_crm_url")
            .eq("id", data.account_id)
            .maybeSingle();
          if (accountErr) {
            console.error("[AuthProvider] fetchAccount error:", {
              message: accountErr.message,
              details: accountErr.details,
              hint: accountErr.hint,
              code: accountErr.code,
            });
          } else if (account) {
            accountRow = {
              id: account.id,
              name: account.name,
              default_currency: account.default_currency ?? DEFAULT_CURRENCY,
              travel_crm_url: account.travel_crm_url ?? null,
            };
          }
        }

        // Narrow the DB enum into our AccountRole union. The DB
        // constraint should make this unconditional, but a future
        // migration that broadens the enum without updating TS would
        // otherwise crash here — fall back to null and let UI gates
        // treat the caller as least-privileged.
        const accountRole = isAccountRole(data.account_role)
          ? data.account_role
          : null;

        setProfile({
          id: data.id,
          full_name: data.full_name,
          email: data.email,
          avatar_url: data.avatar_url,
          role: data.role,
          // `beta_features` is `NOT NULL DEFAULT ARRAY[]` in the DB, but
          // narrow defensively in case the column hasn't been migrated yet
          // (older deployments running 011 lazily) — `null` reads as no
          // opt-ins, which is the safe default for any future beta gate.
          beta_features: data.beta_features ?? [],
          account_id: data.account_id ?? null,
          account_role: accountRole,
        });
        setAccount(accountRow);
      } else {
        lastFetchedUserIdRef.current = null;
      }
    } catch (err) {
      console.error("[AuthProvider] fetchProfile threw:", err);
      lastFetchedUserIdRef.current = null;
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;

    const safetyTimer = setTimeout(async () => {
      // getSession() hasn't settled after 3s (lock contention or
      // worse). The old code wiped auth state here unconditionally —
      // a false logout on every slow read. Verify server-side first:
      // only abandon the session when the server confirms it.
      if (!mounted || settledRef.current) return;
      console.warn("[auth] AUTH_INIT_TIMEOUT verifying session before giving up");
      const verification = await verifySessionActive(supabase, {
        getUserTimeoutMs: 4000,
      });
      if (!mounted || settledRef.current) return;
      if (verification.status === "active") {
        setUser(verification.user);
        setSessionStatus("active");
        if (verification.user.id !== lastFetchedUserIdRef.current) {
          fetchProfile(verification.user.id);
        }
      } else if (verification.status === "dead") {
        setUser(null);
        setProfile(null);
        setAccount(null);
        setProfileLoading(false);
        setSessionStatus("signed-out");
      }
      // "unknown" (infrastructure failure) deliberately keeps state:
      // a blip must not log the user out. The next auth event
      // re-evaluates, and data fetches surface their own errors.
      setLoading(false);
    }, 3000);

    const init = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (error) console.error("[AuthProvider] getSession error:", error.message);

        if (!mounted) return;
        const currentUser = session?.user ?? null;

        if (currentUser) {
          setUser(currentUser);
          setSessionStatus("active");
          // Don't block session loading on profile fetch — chrome
          // (header, sidebar) can render from the user object alone,
          // profile enriches async. Callers that need to branch on
          // profile data gate on `profileLoading` instead.
          fetchProfile(currentUser.id);
        } else {
          // Null at boot can be a torn cookie read mid-rotation, not
          // a logout — confirm before declaring the session dead so
          // a reload landing mid-rotation doesn't bounce to /login.
          const verification = await verifySessionActive(supabase, {
            getUserTimeoutMs: 4000,
          });
          if (!mounted) return;
          if (verification.status === "active") {
            setUser(verification.user);
            setSessionStatus("active");
            if (verification.user.id !== lastFetchedUserIdRef.current) {
              fetchProfile(verification.user.id);
            }
          } else {
            // No user → no profile to load. Flip profileLoading off so
            // pages that gate on it don't wait forever on the logged-out
            // path (the route guard or redirect should fire instead).
            setProfileLoading(false);
            if (verification.status === "dead") {
              setSessionStatus("signed-out");
            }
            // "unknown": status stays "unknown" — the shell holds
            // (blank, no redirect) until the next auth event or the
            // delayed re-verify below re-evaluates.
          }
        }
      } catch (err) {
        console.error("[AuthProvider] init threw:", err);
      } finally {
        settledRef.current = true;
        if (mounted) setLoading(false);
        clearTimeout(safetyTimer);
      }
    };

    init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!mounted) return;

      // The auth client emits SIGNED_OUT for explicit sign-outs AND
      // when a failed background refresh removes the local session —
      // e.g. this tab lost a refresh-token rotation race while a
      // sibling tab holds fresh tokens. Wiping blindly turns that
      // transient race into a logout, so confirm first (unless our
      // own explicit signOut() is in flight — wiping already won
      // there and navigation follows).
      if (event === "SIGNED_OUT") {
        if (signingOutRef.current) {
          lastFetchedUserIdRef.current = null;
          setUser(null);
          setProfile(null);
          setAccount(null);
          setProfileLoading(false);
          setSessionStatus("signed-out");
          setLoading(false);
          return;
        }
        console.warn("[auth] AUTH_SIGNED_OUT_VERIFYING before state change");
        const dead = await confirmSignedOut(supabase, {
          getUserTimeoutMs: 4000,
        });
        if (!mounted || signingOutRef.current) return;
        if (!dead) {
          console.warn("[auth] AUTH_SIGNED_OUT_RECOVERED keeping current page");
          // Storage already converged (sibling tab's rotation landed
          // or the broadcast carried a session) — re-adopt it.
          const {
            data: { session: current },
          } = await supabase.auth.getSession();
          if (!mounted) return;
          if (current?.user) {
            setUser(current.user);
            setSessionStatus("active");
            if (current.user.id !== lastFetchedUserIdRef.current) {
              fetchProfile(current.user.id);
            }
          }
          setLoading(false);
          return;
        }
        console.warn("[auth] AUTH_CONFIRMED_SIGNED_OUT redirecting to login");
        lastFetchedUserIdRef.current = null;
        setUser(null);
        setProfile(null);
        setAccount(null);
        setProfileLoading(false);
        setSessionStatus("signed-out");
        setLoading(false);
        return;
      }

      const currentUser = session?.user ?? null;
      if (currentUser) {
        setUser(currentUser);
        setSessionStatus("active");
        if (currentUser.id !== lastFetchedUserIdRef.current) {
          fetchProfile(currentUser.id);
        }
        setLoading(false);
        return;
      }

      // Null session on any other event (INITIAL_SESSION before
      // hydration, torn cookie read mid-rotation, cross-tab pickup):
      // transient until proven otherwise. Verify with one bounded
      // check instead of wiping — except while an explicit signOut()
      // is in flight, where wiping already won.
      if (signingOutRef.current || recoveringRef.current) return;
      recoveringRef.current = true;
      try {
        const verification = await verifySessionActive(supabase, {
          getUserTimeoutMs: 4000,
        });
        if (!mounted || signingOutRef.current) return;
        if (verification.status === "active") {
          console.warn("[auth] AUTH_SESSION_RECOVERED keeping current page");
          setUser(verification.user);
          setSessionStatus("active");
          if (verification.user.id !== lastFetchedUserIdRef.current) {
            fetchProfile(verification.user.id);
          }
        } else if (verification.status === "dead") {
          console.warn("[auth] AUTH_CONFIRMED_SIGNED_OUT redirecting to login");
          lastFetchedUserIdRef.current = null;
          setUser(null);
          setProfile(null);
          setAccount(null);
          setProfileLoading(false);
          setSessionStatus("signed-out");
        }
        // "unknown" (timeout/network/5xx/rotation-race): keep existing
        // state and stay "unknown". A blip must not log the user out;
        // the next auth event (or the delayed re-verify below)
        // re-evaluates, and data fetches surface their own errors
        // meanwhile.
      } finally {
        recoveringRef.current = false;
        if (mounted) setLoading(false);
      }
    });

    return () => {
      mounted = false;
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  }, [fetchProfile]);

  // One delayed re-verify while a null session stays unconfirmed.
  // Covers reloads landing mid-rotation (no further auth events may
  // arrive to re-evaluate). Single shot per unknown episode — no
  // polling loop that could hammer Supabase during an outage.
  const reverifyArmedRef = useRef(false);
  useEffect(() => {
    if (loading || user || sessionStatus !== "unknown" || reverifyArmedRef.current) {
      if (sessionStatus !== "unknown") reverifyArmedRef.current = false;
      return;
    }
    reverifyArmedRef.current = true;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const supabase = createClient();
      const verification = await verifySessionActive(supabase, {
        getUserTimeoutMs: 4000,
      });
      if (cancelled || signingOutRef.current) return;
      if (verification.status === "active") {
        setUser(verification.user);
        setSessionStatus("active");
        if (verification.user.id !== lastFetchedUserIdRef.current) {
          fetchProfile(verification.user.id);
        }
      } else if (verification.status === "dead") {
        setUser(null);
        setProfile(null);
        setAccount(null);
        setProfileLoading(false);
        setSessionStatus("signed-out");
      }
      // Still unknown: stop retrying. Later auth events (visibility
      // return, sibling-tab broadcast, rotation) re-evaluate.
    }, 6000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loading, user, sessionStatus, fetchProfile]);

  const signOut = useCallback(async () => {
    // Mark the explicit sign-out FIRST: a null-session event landing
    // in this window must not trigger recovery (which could restore
    // state mid-logout). Reset only if signOut itself throws — the
    // success path reloads to /login and discards all refs.
    // The SIGNED_OUT event this fires takes the wipe-immediately
    // branch above (signingOutRef is set), so intentional logout is
    // never delayed by verification.
    signingOutRef.current = true;
    try {
    // Unsubscribe Web Push before signing out so the server stops
    // sending push notifications to this device for this user.
    // Best-effort with hard timeouts: `navigator.serviceWorker.ready`
    // NEVER settles when no service worker is active (registration
    // deferred to window load, failed/unsupported registration, etc),
    // and a pending promise is not caught by try/catch — awaiting it
    // here used to stall signOut() forever before supabase.auth.signOut()
    // (no /auth/v1/logout, no redirect, no error). `getRegistration()`
    // resolves immediately (undefined when none), and every step below
    // races against a timeout so push cleanup can never block logout.
    if ("serviceWorker" in navigator && "PushManager" in window) {
      try {
        const withTimeout = <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
          Promise.race([
            promise.then(
              (value) => value,
              () => fallback,
            ),
            new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
          ]);
        const reg = await withTimeout(
          navigator.serviceWorker.getRegistration(),
          1500,
          undefined,
        );
        const sub = await withTimeout(
          reg?.pushManager.getSubscription() ?? Promise.resolve(null),
          1500,
          null,
        );
        if (sub) {
          const endpoint = sub.endpoint;
          await withTimeout(sub.unsubscribe().catch(() => false), 1500, false);
          await withTimeout(
            fetch("/api/push/unsubscribe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ endpoint }),
            }).catch(() => undefined),
            2000,
            undefined,
          );
        }
      } catch {
        // Best-effort — don't block signout on push cleanup failure.
      }
    }

    const supabase = createClient();
    // Remove all active realtime channels before signing out
    supabase.removeAllChannels();
    await supabase.auth.signOut({ scope: "local" });
    setUser(null);
    setProfile(null);
    setAccount(null);
    window.location.href = "/login";
    } catch (err) {
      signingOutRef.current = false;
      throw err;
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!user?.id) return;
    await fetchProfile(user.id);
  }, [user?.id, fetchProfile]);

  // Derive the role booleans once per profile change rather than on
  // every consumer render. Cheap regardless, but the memo also gives
  // each derived value a stable identity for React.memo / useEffect
  // dependencies downstream.
  const derived = useMemo(() => {
    const role = profile?.account_role ?? null;
    return {
      accountRole: role,
      accountId: profile?.account_id ?? null,
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
    };
  }, [profile?.account_role, profile?.account_id]);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        sessionStatus,
        signOut,
        refreshProfile,
        account,
        defaultCurrency: account?.default_currency ?? DEFAULT_CURRENCY,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * useAuth — read the shared auth state from context.
 * Must be used inside an <AuthProvider>.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider (shouldn't
    // happen in normal flow, but don't crash the page). Account state
    // collapses to least-privileged null — every `canX` boolean is
    // false so UI gates fail closed.
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      sessionStatus: "unknown" as const,
      signOut: async () => {
        window.location.href = "/login";
      },
      refreshProfile: async () => {},
      account: null,
      defaultCurrency: DEFAULT_CURRENCY,
      accountId: null,
      accountRole: null,
      isOwner: false,
      isAdmin: false,
      isAgent: false,
      isViewer: false,
      canManageMembers: false,
      canEditSettings: false,
      canSendMessages: false,
    };
  }
  return ctx;
}
