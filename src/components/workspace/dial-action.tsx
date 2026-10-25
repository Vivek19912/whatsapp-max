'use client';

import { useSyncExternalStore } from 'react';
import { Phone } from 'lucide-react';

import {
  isDialablePhoneNumber,
  normalizeDialNumber,
  toTelUri,
} from '@/lib/dial/validation';

interface DialActionProps {
  /** Raw phone value from the current table row (row.phone). */
  phone: string | null;
}

/**
 * Workspace Dial action cell — available in EVERY Workspace table
 * (Meta Lead Ads tables, Flow Tables, and any other table with a
 * Phone Number column).
 *
 * Phone-only click-to-dial: on an Android phone, a `tel:` anchor
 * opens the native dialer with the row's number prefilled — the
 * user places the call manually, never automatically. No request
 * is sent anywhere; CallVault is not involved in opening the
 * dialer and keeps its existing carrier-call recording workflow
 * for whatever call the user then places.
 *
 * On desktop (or any non-Android browser) the cell renders a
 * clearly-labelled hint instead: dialing is supported from the
 * Android phone. Tapping it never creates a remote dial request.
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

export function DialAction({ phone }: DialActionProps) {
  // Client-only UA check (no hydration mismatch: the server and the
  // first client paint both render the non-Android hint).
  const isAndroid = useSyncExternalStore(
    subscribeAndroid,
    getAndroidSnapshot,
    getAndroidServerSnapshot
  );

  const dialable = isDialablePhoneNumber(phone);
  const telUri = toTelUri(phone);
  const normalized = dialable ? normalizeDialNumber(phone) : '';

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

  if (!isAndroid) {
    return (
      <span
        title="Dialing is supported from WhatsApp Max on your Android phone"
        aria-label="Dial available on Android phone"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      >
        <Phone className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Android only</span>
      </span>
    );
  }

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
