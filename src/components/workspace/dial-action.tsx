'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Phone } from 'lucide-react';

import {
  isDialablePhoneNumber,
  normalizeDialNumber,
  toTelUri,
} from '@/lib/dial/validation';
import { subscribeDialStatus } from '@/lib/dial/dial-status-socket';

interface DialActionProps {
  /** Raw phone value from the current table row (row.phone). */
  phone: string | null;
  /** Owning contact for server-side authorization (optional). */
  contactId?: string | null;
  /** Owning flow/table for server-side authorization (optional). */
  flowId?: string | null;
  /** Row identity, used for duplicate-click protection only. */
  runId?: string | null;
}

type DialState =
  | { kind: 'idle' }
  | { kind: 'queueing' }
  // Queued: the server accepted the request. A live WebSocket status
  // subscription (see subscribeDialStatus) flips the cell when the
  // server confirms a persisted transition — never optimistically.
  | { kind: 'queued'; requestId: string; expiresAt?: string | null }
  // Delivered: the phone acknowledged receipt (server-persisted).
  | { kind: 'delivered'; requestId: string; expiresAt?: string | null }
  // Expired: TTL passed without consumption — re-dial to start over.
  | { kind: 'expired'; requestId: string }
  | { kind: 'failed'; reason: string };

/**
 * Duplicate-click protection without server state: the same row +
 * normalized number maps to the same key inside a 30s window, so a
 * double-click (or retry storms) collapses into the existing row
 * via the UNIQUE(account_id, idempotency_key) constraint instead
 * of buzzing the phone twice. A genuinely new dial minutes later
 * gets a fresh key.
 */
export function dialIdempotencyKey(
  runId: string | null | undefined,
  normalizedPhone: string,
  nowMs = Date.now(),
  cycle = 0
): string {
  const bucket = Math.floor(nowMs / 30000);
  return `${runId ?? 'row'}:${normalizedPhone}:${bucket}:${cycle}`.slice(0, 128);
}

/**
 * Terminal server states mapped onto the cell's user-facing status.
 * Reserved for WebSocket status events (`delivered`/`opened`/
 * `failed` pushed by the sidecar after the database confirms the
 * transition). These states only ever arrive from the server — the
 * cell never invents them.
 */
export function interpretDialStatus(status: string | null | undefined): 'delivered' | 'failed' | null {
  if (status === 'delivered' || status === 'opened' || status === 'completed') {
    return 'delivered';
  }
  if (
    status === 'expired' ||
    status === 'cancelled' ||
    status === 'failed'
  ) {
    return 'failed';
  }
  return null; // still pending — no status event yet.
}

/**
 * Display state for a persisted server status plus the request's
 * expiry. Opened is shown as its own state (the dialer launched);
 * it is explicitly not proof that a call was placed. A pending or
 * delivered row past its server-issued TTL reads as expired —
 * no polling, just the timestamps the server already sent.
 */
export function dialDisplayState(
  status: string | null | undefined,
  expiresAt: string | null | undefined,
  nowMs: number = Date.now()
): 'delivered' | 'opened' | 'expired' | 'failed' | null {
  if (status === 'opened' || status === 'completed') return 'opened';
  if (status === 'cancelled' || status === 'failed') return 'failed';
  if (status === 'expired') return 'expired';
  // Pending or delivered past the server-issued TTL reads as expired
  // (mirrors the GET lazy-expiry rule); no polling involved.
  if (status === 'pending' || status === 'delivered' || status == null) {
    if (typeof expiresAt === 'string' && expiresAt) {
      const ms = Date.parse(expiresAt);
      if (Number.isFinite(ms) && ms <= nowMs) return 'expired';
    }
    return status === 'delivered' ? 'delivered' : null;
  }
  return null;
}

/**
 * Workspace Dial action cell — available in EVERY Workspace table
 * (Meta Lead Ads tables, Flow Tables, and any other table with a
 * Phone Number column).
 *
 * - On an Android phone: a `tel:` anchor opens the native dialer
 *   with the row's number prefilled. The user places the call
 *   manually; nothing is ever auto-placed and no request is sent.
 * - On desktop: clicking sends ONE authenticated dial request for
 *   the clicking user's own authorized device
 *   (server routes by the session's `requested_by`, never by
 *   Assigned To). The cell reads Queued once the server accepts the
 *   request. There is no status polling: delivery happens over the
 *   authenticated phone WebSocket and the phone opens the dialer
 *   itself. Delivered is shown ONLY after a device acknowledgement
 *   is observed over a WebSocket status event; until such events
 *   exist the cell stays at Queued — no premature confirmation is
 *   ever displayed and the server is never re-asked.
 */
export function isAndroidDialSupported(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return /Android/i.test(userAgent);
}

function subscribeAndroid() {
  return () => {};
}

function getAndroidSnapshot(): boolean {
  return isAndroidDialSupported(navigator.userAgent);
}

function getAndroidServerSnapshot(): boolean {
  return false;
}

export function DialAction({ phone, contactId, flowId, runId }: DialActionProps) {
  // Client-only UA check (no hydration mismatch: the server and the
  // first client paint both render the desktop path).
  const isAndroid = useSyncExternalStore(
    subscribeAndroid,
    getAndroidSnapshot,
    getAndroidServerSnapshot
  );

  const [state, setState] = useState<DialState>({ kind: 'idle' });

  const dialable = isDialablePhoneNumber(phone);
  const telUri = toTelUri(phone);
  const normalized = dialable ? normalizeDialNumber(phone) : '';

  async function handleDesktopDial() {
    if (!dialable || state.kind === 'queueing' || state.kind === 'queued' || state.kind === 'delivered') return;
    setState({ kind: 'queueing' });
    try {
      const res = await fetch('/api/dial-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_number: normalized,
          contact_id: contactId ?? undefined,
          flow_id: flowId ?? undefined,
          run_id: runId ?? undefined,
          // Fresh salt per dial cycle: a deliberate re-dial after a
          // completed/expired/failed request always creates a NEW
          // server row (never replays the old one), while rapid
          // double-clicks within one cycle still collapse into the
          // same row via the UNIQUE constraint.
          idempotency_key: dialIdempotencyKey(runId, normalized, Date.now(), cycleRef.current),
        }),
      });
      if (!res.ok) throw new Error(`create ${res.status}`);
      const json = (await res.json()) as {
        dial_request?: { id?: string; expires_at?: string };
      };
      const requestId = json.dial_request?.id;
      if (!requestId) throw new Error('no id');
      // Live updates follow over the browser WebSocket (no polling):
      // the sidecar pushes the persisted status for this request id
      // and the cell flips Queued → Delivered → Opened. Displayed
      // states below come only from those server events.
      setState({
        kind: 'queued',
        requestId,
        expiresAt: json.dial_request?.expires_at ?? null,
      });
    } catch {
      setState({
        kind: 'failed',
        reason: 'Could not queue the dial request. Retry from this phone instead.',
      });
    }
  }

  // Dial-cycle salt for the idempotency key. Bumped every time a
  // tracked request reaches a terminal state (opened / expired /
  // failed), so the next deliberate click always creates a FRESH
  // server row with a fresh id — never reusing or replaying the
  // previous request. Within one cycle the key is stable, so
  // double-clicks (and two tabs clicking at once) still collapse
  // into the same row via UNIQUE(account_id, idempotency_key).
  // Bumping inside the setState updater is intentionally idempotent:
  // a double-invoked updater only skips a salt value, which has no
  // observable effect beyond keeping keys unique.
  const cycleRef = useRef(0);

  // Live status subscription: active only while this cell tracks a
  // request. Server events are idempotent per (request id, status),
  // so reconnect snapshots and duplicate frames converge safely and
  // multiple tabs never double-act (display only, no side effects).
  const trackedId =
    state.kind === 'queued' || state.kind === 'delivered'
      ? state.requestId
      : null;
  useEffect(() => {
    if (!trackedId) return;
    return subscribeDialStatus(trackedId, (update) => {
      setState((prev) => {
        if (prev.kind !== 'queued' && prev.kind !== 'delivered') return prev;
        if ((prev as { requestId?: string }).requestId !== update.requestId) return prev;
        const next = dialDisplayState(update.status, update.expiresAt);
        if (next === 'delivered') return { kind: 'delivered', requestId: update.requestId };
        if (next === 'opened') {
          // Dialer opened on the phone: reset to a clickable Dial so
          // the next click starts a completely new request.
          cycleRef.current += 1;
          return { kind: 'idle' };
        }
        if (next === 'expired') {
          cycleRef.current += 1;
          return { kind: 'expired', requestId: update.requestId };
        }
        if (next === 'failed') {
          cycleRef.current += 1;
          return {
            kind: 'failed',
            reason: 'Delivery failed. Dial again to retry.',
          };
        }
        return prev;
      });
    });
  }, [trackedId]);

  // Local expiry flip: no polling, just the server-issued TTL the
  // cell already holds. The server is the source of truth on
  // reconnect (snapshot), this only keeps the label honest while
  // the TTL passes with no further events. Bumping the cycle keeps
  // the retry key fresh, same as a server-sent expiry.
  useEffect(() => {
    if (state.kind !== 'queued' && state.kind !== 'delivered') return;
    const expiresAt = (state as { expiresAt?: string | null }).expiresAt;
    if (!expiresAt) return;
    const ms = Date.parse(expiresAt);
    if (!Number.isFinite(ms)) return;
    const delay = ms - Date.now();
    if (delay <= 0) {
      cycleRef.current += 1;
      setState({ kind: 'expired', requestId: (state as { requestId: string }).requestId });
      return;
    }
    const timer = setTimeout(() => {
      cycleRef.current += 1;
      setState((prev) =>
        prev.kind === 'queued' || prev.kind === 'delivered'
          ? { kind: 'expired', requestId: (prev as { requestId: string }).requestId }
          : prev
      );
    }, delay);
    return () => clearTimeout(timer);
  }, [state]);

  if (!dialable || !telUri) {
    return (
      <span
        title="Number unavailable"
        aria-label="Dial unavailable"
        aria-disabled="true"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50"
      >
        <Phone className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Dial</span>
      </span>
    );
  }

  if (isAndroid) {
    return (
      <a
        href={telUri}
        onClick={(e) => e.stopPropagation()}
        title={`Dial ${normalized} on this phone`}
        aria-label={`Dial ${normalized} on this phone`}
        className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-xs font-medium hover:bg-accent"
      >
        <Phone className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Dial</span>
      </a>
    );
  }

  const busy =
    state.kind === 'queueing' ||
    state.kind === 'queued' ||
    state.kind === 'delivered';
  const label =
    state.kind === 'queueing'
      ? 'Queueing…'
      : state.kind === 'queued'
        ? 'Queued'
        : state.kind === 'delivered'
          ? 'Delivered'
          : state.kind === 'expired'
            ? 'Expired'
            : state.kind === 'failed'
              ? 'Retry'
              : 'Dial';
  const title =
    state.kind === 'queued'
      ? 'Dial request queued — your phone opens the dialer automatically'
      : state.kind === 'delivered'
        ? 'Phone received the dial request'
        : state.kind === 'expired'
          ? 'Dial request expired — dial again to retry'
          : state.kind === 'failed'
            ? state.reason
            : `Send dial request for ${normalized} to your phone`;

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          // Idle, failed, or expired only — never while a request is
          // in flight. Live WebSocket status events (not polling)
          // move the cell between queued, delivered and opened.
          if (!busy) void handleDesktopDial();
        }}
        title={title}
        aria-label={title}
        className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-xs font-medium hover:bg-accent disabled:pointer-events-none disabled:opacity-60"
      >
        <Phone className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">{label}</span>
      </button>
    </span>
  );
}
