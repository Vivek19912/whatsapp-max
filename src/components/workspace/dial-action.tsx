'use client';

import { useState, useSyncExternalStore } from 'react';
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
  // `queued` is terminal in the browser: there is deliberately no
  // status polling (no repeated status reads). The
  // request is delivered over the authenticated WebSocket and the
  // phone opens the native dialer itself; the browser leaves the
  // cell at Queued until a WebSocket status event arrives (not yet
  // implemented) rather than re-asking the server. Delivered is never
  // shown unless a device acknowledgement is observed.
  | { kind: 'queued'; requestId: string }
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
  nowMs = Date.now()
): string {
  const bucket = Math.floor(nowMs / 30000);
  return `${runId ?? 'row'}:${normalizedPhone}:${bucket}`.slice(0, 128);
}

/**
 * Terminal server states mapped onto the cell's user-facing status.
 * Reserved for future WebSocket status events (`delivered`/`opened`/
 * `failed` pushed to the browser). Nothing calls this yet: the cell
 * stays at Queued rather than polling the server for status.
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
      // Terminal UI state: no polling follows. The phone receives
      // the request over its WebSocket and opens the dialer; the
      // cell stays Queued.
      setState({ kind: 'queued', requestId });
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
        : state.kind === 'failed'
          ? 'Retry'
          : 'Dial';
  const title =
    state.kind === 'queued'
      ? 'Dial request queued — your phone opens the dialer automatically'
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
          // Idle or failed only — never while queueing or queued.
          // A queued cell stays queued (no status polling) until a
          // WebSocket status event arrives.
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
