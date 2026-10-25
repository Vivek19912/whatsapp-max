'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Phone } from 'lucide-react';

import {
  isDialablePhoneNumber,
  normalizeDialNumber,
  toTelUri,
} from '@/lib/dial/validation';

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
  | { kind: 'queued'; requestId: string }
  | { kind: 'delivered' }
  | { kind: 'failed'; reason: string };

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_ATTEMPTS = 24; // ~60s: longer than any foreground-sync round trip.

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
  nowMs = Date.now()
): string {
  const bucket = Math.floor(nowMs / 30000);
  return `${runId ?? 'row'}:${normalizedPhone}:${bucket}`.slice(0, 128);
}

/** Terminal server states mapped onto the cell's user-facing status. */
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
  return null; // still pending — keep polling.
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
 *   Assigned To). Status reads Queued → Delivered / Failed by
 *   polling the request — Delivered is shown ONLY after the
 *   server reports the device received it; no premature
 *   confirmation is ever displayed.
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
  const stateRef = useRef(state);
  stateRef.current = state;
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };

  useEffect(() => stopPolling, []);

  const dialable = isDialablePhoneNumber(phone);
  const telUri = toTelUri(phone);
  const normalized = dialable ? normalizeDialNumber(phone) : '';

  async function pollStatus(requestId: string) {
    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      try {
        const res = await fetch(
          `/api/dial-requests?id=${encodeURIComponent(requestId)}`
        );
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as {
          dial_request?: { status?: string };
        };
        const mapped = interpretDialStatus(json.dial_request?.status);
        if (mapped === 'delivered') {
          stopPolling();
          setState({ kind: 'delivered' });
          return;
        }
        if (mapped === 'failed') {
          stopPolling();
          setState({
            kind: 'failed',
            reason: 'The request expired before your phone picked it up.',
          });
          return;
        }
      } catch {
        // Transient poll failure — keep waiting until the budget
        // runs out rather than flashing an error.
      }
      if (attempts >= POLL_MAX_ATTEMPTS) {
        stopPolling();
        if (stateRef.current.kind === 'queued') {
          setState({
            kind: 'failed',
            reason: 'Timed out waiting for your phone. Open CallVault on it and retry.',
          });
        }
      }
    };
    stopPolling();
    pollTimer.current = setInterval(() => void tick(), POLL_INTERVAL_MS);
    void tick();
  }

  async function handleDesktopDial() {
    if (!dialable || state.kind === 'queueing' || state.kind === 'queued') return;
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
          idempotency_key: dialIdempotencyKey(runId, normalized),
        }),
      });
      if (!res.ok) throw new Error(`create ${res.status}`);
      const json = (await res.json()) as {
        dial_request?: { id?: string };
      };
      const requestId = json.dial_request?.id;
      if (!requestId) throw new Error('no id');
      setState({ kind: 'queued', requestId });
      void pollStatus(requestId);
    } catch {
      setState({
        kind: 'failed',
        reason: 'Could not queue the dial request. Retry from this phone instead.',
      });
    }
  }

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

  const busy = state.kind === 'queueing' || state.kind === 'queued';
  const label =
    state.kind === 'queueing'
      ? 'Queueing…'
      : state.kind === 'queued'
        ? 'Queued'
        : state.kind === 'delivered'
          ? 'Delivered ✓'
          : state.kind === 'failed'
            ? 'Retry'
            : 'Dial';
  const title =
    state.kind === 'queued'
      ? 'Dial request queued — waiting for your phone to pick it up'
      : state.kind === 'delivered'
        ? 'Your phone received the dial request'
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
          // Idle, failed, or finished (Delivered starts a fresh
          // request) — never while queueing or awaiting delivery.
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
