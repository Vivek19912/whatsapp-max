'use client';

import { useRef, useState } from 'react';
import { Phone } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  isDialablePhoneNumber,
  normalizeDialNumber,
  toTelUri,
} from '@/lib/dial/validation';

interface DialActionProps {
  /** Raw phone value from the current table row (row.phone). */
  phone: string | null;
  /** True only on Meta Lead Ads tables; Flow Tables never render this. */
  isMetaTable: boolean;
  runId?: string | null;
  contactId?: string | null;
  flowId?: string | null;
  compact?: boolean;
}

/**
 * Workspace Dial action cell (Meta Lead Ads tables only).
 *
 * - Same-device: a `tel:` anchor opens the native dialer with the
 *   number prefilled (user places the call; never auto-placed).
 * - Desktop → phone: POSTs an authenticated dial request; the
 *   authorized CallVault device shows a notification and opens the
 *   native dialer via ACTION_DIAL after an explicit tap.
 * - Duplicate clicks are ignored while a request is in flight.
 * - Lead phone / sheet data is never mutated.
 */
export function DialAction({
  phone,
  isMetaTable,
  runId,
  contactId,
  flowId,
}: DialActionProps) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sent' | 'error'>('idle');
  const inFlight = useRef(false);

  if (!isMetaTable) return null;

  const dialable = isDialablePhoneNumber(phone);
  const telUri = toTelUri(phone);
  const normalized = dialable ? normalizeDialNumber(phone) : '';

  async function handleRemoteDial() {
    if (!dialable || inFlight.current || pending) return;
    inFlight.current = true;
    setPending(true);
    setStatus('idle');
    try {
      const idempotencyKey =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const res = await fetch('/api/dial-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_number: normalized,
          contact_id: contactId ?? undefined,
          flow_id: flowId ?? undefined,
          run_id: runId ?? undefined,
          idempotency_key: idempotencyKey,
        }),
      });
      if (!res.ok) {
        setStatus('error');
        return;
      }
      setStatus('sent');
    } catch {
      setStatus('error');
    } finally {
      setPending(false);
      inFlight.current = false;
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

  return (
    <span className="inline-flex items-center gap-1.5">
      {/* Same-device: opens the native dialer prefilled. */}
      <a
        href={telUri}
        onClick={(e) => e.stopPropagation()}
        title={`Dial ${normalized} on this device`}
        aria-label={`Dial ${normalized} on this device`}
        className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-xs font-medium hover:bg-accent"
      >
        <Phone className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Dial</span>
      </a>
      <button
        type="button"
        disabled={pending}
        onClick={(e) => {
          e.stopPropagation();
          void handleRemoteDial();
        }}
        title={
          status === 'sent'
            ? 'Dial request sent to your phone'
            : 'Send dial request to CallVault device'
        }
        aria-label={
          status === 'sent'
            ? 'Dial request sent'
            : `Send dial request for ${normalized} to phone`
        }
        className={cn(
          'inline-flex items-center rounded-md px-1.5 py-1 text-[11px] font-medium',
          status === 'sent'
            ? 'bg-emerald-500/10 text-emerald-600'
            : status === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          pending && 'pointer-events-none opacity-60'
        )}
      >
        {pending ? 'Sending…' : status === 'sent' ? 'Sent ✓' : status === 'error' ? 'Retry' : 'To phone'}
      </button>
    </span>
  );
}
