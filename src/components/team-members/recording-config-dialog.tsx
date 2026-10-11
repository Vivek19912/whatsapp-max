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
  const [phoneDraft, setPhoneDraft] = useState(() =>
    member.phone_recording_number
      ? displayRecordingNumber(member.phone_recording_number)
      : '',
  );
  const [whatsapp, setWhatsapp] = useState(
    () => member.whatsapp_recording_source || 'none',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setError(null);
    let number: string | null = null;
    if (phoneEnabled) {
      if (!isRecordingPhoneNumber(phoneDraft) || !phoneDraft.trim()) {
        setError('Enter a valid phone number.');
        return;
      }
      number = normalizeRecordingPhoneNumber(phoneDraft);
      if (!number) {
        setError('Enter a valid phone number.');
        return;
      }
    }
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
            <Input
              id={`rec-phone-input-${member.user_id}`}
              value={phoneDraft}
              disabled={!phoneEnabled || saving}
              onChange={(e) => {
                setPhoneDraft(e.target.value);
                setError(null);
              }}
              placeholder="+91 __________"
              inputMode="tel"
              autoComplete="tel"
              aria-invalid={error ? true : undefined}
              aria-describedby={`rec-phone-hint-${member.user_id}`}
              className="mt-1.5 bg-muted border-border text-foreground"
            />
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
