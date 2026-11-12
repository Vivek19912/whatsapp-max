'use client';

// ============================================================
// RecordingConfigDialog — owner-only per-member recording
// configuration in a dedicated modal.
//
// Replaces the former inline row controls (phone input +
// Save/Cancel + WhatsApp dropdown directly in the roster),
// which were cramped and unfinished. The member row now shows
// only a compact summary + Configure button; all editing
// happens here.
//
// Sections:
//   PHONE CALL RECORDING — large number input (or Disabled).
//     The owner types the salesperson's actual SIM number; the
//     server normalizes/validates/stores digits, and CallVault
//     maps the number to the device's current subscription.
//     No slot/subscription IDs anywhere in this UI.
//   WHATSAPP CALL RECORDING — mutually exclusive segmented
//     control: None | WhatsApp | WhatsApp Business.
//
// Save issues ONE PUT with both fields to the existing
// recording-settings API; Cancel persists nothing. Backend
// authorization is unchanged (owner-only for others).
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Phone } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WhatsappIcon } from '@/components/icons/whatsapp-icon';
import { isValidE164, normalizePhone } from '@/lib/whatsapp/phone-utils';

export interface RecordingConfigMember {
  user_id: string;
  full_name: string;
  email: string | null;
  avatar_url: string | null;
  phone_recording_number: string | null;
  whatsapp_recording_source: string;
}

export interface RecordingConfigPatch {
  phone_recording_number: string | null;
  whatsapp_recording_source: string;
}

export const WHATSAPP_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'whatsapp_business', label: 'WhatsApp Business' },
] as const;

export function whatsappSourceLabel(value: string | null): string {
  const found = WHATSAPP_OPTIONS.find((o) => o.value === (value || 'none'));
  return found ? found.label : 'None';
}

/**
 * Client-side mirror of the server's recording-number validation
 * (`normalizeRecordingPhoneNumber` / `isRecordingPhoneNumber` in
 * the recording-settings route, same `normalizePhone` +
 * `isValidE164` rule). The server re-validates on save; this only
 * drives the inline error state.
 */
export function normalizeRecordingPhoneNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const digits = normalizePhone(value.trim());
  if (!digits) return null;
  if (!isValidE164(digits)) return null;
  return digits;
}

export function isRecordingPhoneNumber(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  if (value.trim() === '') return true;
  return normalizeRecordingPhoneNumber(value) !== null;
}

/** Readable display for stored normalized digits (same rule as the roster). */
export function displayRecordingNumber(digits: string | null): string {
  if (!digits) return 'None';
  // Indian numbers render spaced; anything else gets a '+' prefix.
  // Display only — storage/matching always use raw digits.
  if (/^91\d{10}$/.test(digits)) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return `+${digits}`;
}

/**
 * Editable 10-digit portion for the fixed-+91 phone input from a
 * stored normalized value. `91` + 10 digits (with or without
 * formatting) yields the 10 subscriber digits; a bare 10-digit
 * value is used as-is. Anything else yields '' so a legacy
 * non-conforming value is never mangled into the field — the
 * owner re-enters it and validation blocks saving until it is
 * exactly 10 digits.
 */
export function recordingMobileDigitsFromStored(value: string | null): string {
  if (!value) return '';
  const digits = normalizePhone(value);
  if (/^91\d{10}$/.test(digits)) return digits.slice(2);
  if (/^\d{10}$/.test(digits)) return digits;
  return '';
}

/**
 * Sanitize keystrokes/pastes for the fixed-+91 phone input. Digits
 * only, capped at 10. A pasted (or fully typed) 12-digit Indian
 * number (`91` + 10 digits, `+` already stripped) is reduced to
 * its 10 subscriber digits so the fixed prefix is never
 * duplicated. A genuine 10-digit entry is never stripped.
 */
export function sanitizeRecordingMobileInput(value: string): string {
  const digits = (value ?? '').replace(/\D/g, '');
  if (/^91\d{10}$/.test(digits)) return digits.slice(2);
  return digits.slice(0, 10);
}

/**
 * Resolve what the recording form saves for the phone field.
 * Disabled → null (no number). Enabled → exactly 10 digits,
 * stored as `91` + digits via the shared server-mirroring
 * normalizer (never a doubled prefix). Anything else is a
 * user-facing validation error; the caller keeps the dialog open.
 */
export function resolveRecordingSaveNumber(
  phoneEnabled: boolean,
  digits: string,
): { number: string | null } | { error: string } {
  if (!phoneEnabled) return { number: null };
  const clean = (digits ?? '').trim();
  if (!/^\d{10}$/.test(clean)) {
    return { error: 'Enter a valid 10-digit mobile number.' };
  }
  const normalized = normalizeRecordingPhoneNumber(`91${clean}`);
  if (!normalized) {
    return { error: 'Enter a valid 10-digit mobile number.' };
  }
  return { number: normalized };
}

export function RecordingConfigDialog({
  member,
  onClose,
  onSaved,
}: {
  member: RecordingConfigMember | null;
  onClose: () => void;
  onSaved: (userId: string, patch: RecordingConfigPatch) => void;
}) {
  return (
    <Dialog
      open={member !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="bg-popover border-border w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Recording Configuration</DialogTitle>
          <DialogDescription>
            Control which calls this team member&apos;s CallVault device is allowed to record.
          </DialogDescription>
        </DialogHeader>
        {member ? (
          <RecordingConfigForm
            key={member.user_id}
            member={member}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The dialog body, exported for SSR tests (Base UI portals don't SSR). */
export function RecordingConfigForm({
  member,
  onClose,
  onSaved,
}: {
  member: RecordingConfigMember;
  onClose: () => void;
  onSaved: (userId: string, patch: RecordingConfigPatch) => void;
}) {
  const [phoneEnabled, setPhoneEnabled] = useState(
    () => member.phone_recording_number != null,
  );
  // Editable subscriber digits only — the +91 prefix is a fixed,
  // non-editable adornment rendered beside the input, never part
  // of this value, so it can never be deleted or duplicated.
  const [phoneDigits, setPhoneDigits] = useState(() =>
    recordingMobileDigitsFromStored(member.phone_recording_number),
  );
  const [whatsapp, setWhatsapp] = useState(
    () => member.whatsapp_recording_source || 'none',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setError(null);
    const resolved = resolveRecordingSaveNumber(phoneEnabled, phoneDigits);
    if ('error' in resolved) {
      setError(resolved.error);
      return;
    }
    const number = resolved.number;
    setSaving(true);
    try {
      const res = await fetch(`/api/account/recording-settings/${member.user_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_recording_number: number,
          whatsapp_recording_source: whatsapp,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          (payload as { error?: string }).error || 'Failed to save recording configuration',
        );
        return;
      }
      const setting = (payload as { setting?: Partial<RecordingConfigPatch> }).setting ?? {};
      onSaved(member.user_id, {
        phone_recording_number:
          typeof setting.phone_recording_number === 'string'
            ? setting.phone_recording_number
            : number,
        whatsapp_recording_source: setting.whatsapp_recording_source ?? whatsapp,
      });
      toast.success(`Recording configuration saved for ${member.full_name || 'member'}`);
      onClose();
    } catch {
      setError('Could not reach the server');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-0 pt-1 pb-4">
        <span
          aria-hidden
          className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-medium"
        >
          {(member.full_name || member.email || 'U').charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {member.full_name || 'Unnamed'}
          </p>
          {member.email ? (
            <p className="truncate text-xs text-muted-foreground">{member.email}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-5 py-1">
        <section aria-labelledby="rec-phone-heading">
          <h3
            id="rec-phone-heading"
            className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
          >
            <Phone className="size-3.5" /> Phone call recording
          </h3>
          <div className="mt-2 flex gap-4" role="radiogroup" aria-label="Phone recording">
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
              <input
                type="radio"
                name={`phone-enabled-${member.user_id}`}
                checked={phoneEnabled}
                onChange={() => {
                  setPhoneEnabled(true);
                  setError(null);
                }}
                className="accent-primary"
              />
              Enabled
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
              <input
                type="radio"
                name={`phone-enabled-${member.user_id}`}
                checked={!phoneEnabled}
                onChange={() => {
                  setPhoneEnabled(false);
                  setError(null);
                }}
                className="accent-primary"
              />
              Disabled
            </label>
          </div>
          <div className="mt-2">
            <Label htmlFor={`rec-phone-input-${member.user_id}`} className="text-sm text-foreground">
              Phone number
            </Label>
            <div className="relative mt-1.5">
              <span
                aria-hidden="true"
                className={`text-muted-foreground pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm select-none ${!phoneEnabled || saving ? 'opacity-50' : ''}`}
              >
                +91
              </span>
              <span
                aria-hidden="true"
                className={`bg-border pointer-events-none absolute top-2 bottom-2 left-11 w-px ${!phoneEnabled || saving ? 'opacity-50' : ''}`}
              />
              <Input
                id={`rec-phone-input-${member.user_id}`}
                value={phoneDigits}
                disabled={!phoneEnabled || saving}
                onChange={(e) => {
                  setPhoneDigits(sanitizeRecordingMobileInput(e.target.value));
                  setError(null);
                }}
                placeholder="8604012345"
                inputMode="numeric"
                autoComplete="tel"
                aria-invalid={error ? true : undefined}
                aria-describedby={`rec-phone-hint-${member.user_id}`}
                className="bg-muted border-border pl-16 text-foreground"
              />
            </div>
            <p id={`rec-phone-hint-${member.user_id}`} className="mt-1.5 text-xs text-muted-foreground">
              Enter the SIM&apos;s phone number assigned to this salesperson. CallVault
              automatically detects which active SIM currently has this number.
            </p>
            {!phoneEnabled ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                No phone calls will be recorded.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="mt-1.5 text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </section>

        <section aria-labelledby="rec-wa-heading">
          <h3
            id="rec-wa-heading"
            className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
          >
            <WhatsappIcon className="size-3.5" /> WhatsApp call recording
          </h3>
          <p className="mt-2 text-sm text-foreground">Which app should be recorded?</p>
          <div
            className="mt-2 grid grid-cols-3 gap-2"
            role="radiogroup"
            aria-label="WhatsApp app to record"
          >
            {WHATSAPP_OPTIONS.map((o) => {
              const selectedOption = whatsapp === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={selectedOption}
                  onClick={() => setWhatsapp(o.value)}
                  className={
                    selectedOption
                      ? 'border-primary bg-primary/10 text-foreground rounded-lg border px-2 py-2.5 text-sm font-medium'
                      : 'border-border text-muted-foreground hover:text-foreground rounded-lg border px-2 py-2.5 text-sm'
                  }
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Only one WhatsApp app can be recorded at a time.
          </p>
        </section>
      </div>

      <div className="flex gap-2 sm:justify-between">
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Saving...
            </>
          ) : (
            'Save Changes'
          )}
        </Button>
      </div>
    </>
  );
}
