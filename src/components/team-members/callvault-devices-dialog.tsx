'use client';

// ============================================================
// CallvaultDevicesDialog — owner-only per-agent CallVault
// device list with remote logout.
//
// The owner sees every registered device of the selected agent:
// name / model / status / last seen / login date / session
// expiry / app version. Status is Active, Logout Pending (revoked,
// phone hasn't confirmed yet), or Logged Out (phone acked). "Log
// out" revokes one device session; "Log out all" revokes every
// session of the agent. Both ask for confirmation first and report
// success/failure via toasts.
//
// Revocation is session-scoped (the row's current session is
// banned; other sessions keep working) and never touches GoTrue
// — no signOut of any scope. Hidden entirely for non-owners
// (the caller in team-members-view.tsx only mounts this for
// owners).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, LogOut, Smartphone } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface CallvaultDeviceMember {
  user_id: string;
  full_name: string;
}

interface CallvaultDevice {
  device_id: string;
  device_name: string | null;
  device_model: string | null;
  app_version: string | null;
  status: string;
  logout_ack_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  session_expires_at: string | null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function CallvaultDevicesDialog({
  member,
  onClose,
}: {
  member: CallvaultDeviceMember | null;
  onClose: () => void;
}) {
  const [devices, setDevices] = useState<CallvaultDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmDevice, setConfirmDevice] = useState<CallvaultDevice | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const loadDevices = useCallback(async (userId: string) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/callvault/devices?user_id=${encodeURIComponent(userId)}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to load devices');
        return;
      }
      const data = (await res.json()) as { devices: CallvaultDevice[] };
      setDevices(data.devices ?? []);
    } catch (err) {
      console.error('[CallvaultDevices] load error:', err);
      toast.error('Could not reach the server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (member) {
      setDevices([]);
      setConfirmDevice(null);
      setConfirmAll(false);
      void loadDevices(member.user_id);
    }
  }, [member, loadDevices]);

  async function handleRevokeOne() {
    if (!member || !confirmDevice) return;
    setPending(confirmDevice.device_id);
    try {
      const res = await fetch('/api/callvault/devices/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: member.user_id,
          device_id: confirmDevice.device_id,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to log out device');
        return;
      }
      toast.success('Device logged out');
      // Optimistic pending: the revocation is persisted, the phone
      // confirms asynchronously (push → ack, or status poll → HTTP
      // ack). The list re-reads the true state on reopen.
      setDevices((prev) =>
        prev.map((d) =>
          d.device_id === confirmDevice.device_id
            ? { ...d, status: 'pending' }
            : d,
        ),
      );
      setConfirmDevice(null);
    } catch (err) {
      console.error('[CallvaultDevices] revoke error:', err);
      toast.error('Could not reach the server');
    } finally {
      setPending(null);
    }
  }

  async function handleRevokeAll() {
    if (!member) return;
    setPending('__all__');
    try {
      const res = await fetch('/api/callvault/devices/revoke-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: member.user_id }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to log out devices');
        return;
      }
      toast.success('All CallVault devices logged out');
      setDevices((prev) => prev.map((d) => ({ ...d, status: 'pending' })));
      setConfirmAll(false);
    } catch (err) {
      console.error('[CallvaultDevices] revoke-all error:', err);
      toast.error('Could not reach the server');
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <Dialog
        open={member !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent className="bg-popover border-border w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <Smartphone className="size-4" />
              CallVault Devices
              {member?.full_name ? ` — ${member.full_name}` : ''}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Devices this agent is logged into. Logging out ends that
              device&apos;s session only — other devices keep working.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-6 animate-spin text-primary" />
            </div>
          ) : devices.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No CallVault devices registered for this agent.
            </p>
          ) : (
            <div className="space-y-3">
              <ul className="divide-y divide-border rounded-md border border-border">
                {devices.map((d) => {
                  const loggedOut = d.status === 'logged_out';
                  const pendingLogout = d.status === 'pending';
                  const settled = loggedOut || pendingLogout;
                  const busy = pending === d.device_id;
                  return (
                    <li
                      key={d.device_id}
                      className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {d.device_name || d.device_id}
                          </span>
                          <Badge
                            className={
                              loggedOut
                                ? 'bg-muted text-muted-foreground border-border text-[10px] uppercase tracking-wide'
                                : pendingLogout
                                  ? 'bg-amber-500/10 text-amber-300 border-amber-500/30 text-[10px] uppercase tracking-wide'
                                  : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30 text-[10px] uppercase tracking-wide'
                            }
                          >
                            {loggedOut
                              ? 'Logged out'
                              : pendingLogout
                                ? 'Logout pending'
                                : 'Active'}
                          </Badge>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {[d.device_model, d.app_version].filter(Boolean).join(' · ') ||
                            d.device_id}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Last seen {fmtDateTime(d.last_seen_at)} · Login{' '}
                          {fmtDate(d.created_at)} · Session expires{' '}
                          {fmtDate(d.session_expires_at)}
                        </p>
                      </div>
                      {!settled && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || pending !== null}
                          onClick={() => setConfirmDevice(d)}
                          aria-label={`Log out device ${d.device_name || d.device_id}`}
                        >
                          {busy ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <LogOut className="size-4" />
                          )}
                          Log out
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {devices.some((d) => d.status === 'active') && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => setConfirmAll(true)}
                  className="border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:border-red-500/60 hover:text-red-200"
                >
                  {pending === '__all__' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <LogOut className="size-4" />
                  )}
                  Log out all CallVault devices
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmDevice !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDevice(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-amber-400" />
              Log out device
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Log out{' '}
              <span className="font-medium text-muted-foreground">
                {confirmDevice?.device_name || confirmDevice?.device_id}
              </span>
              ? The agent will need to log in again on that device. Other
              devices are unaffected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setConfirmDevice(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              onClick={handleRevokeOne}
              disabled={pending !== null}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Logging out...
                </>
              ) : (
                'Log out device'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmAll}
        onOpenChange={(open) => {
          if (!open) setConfirmAll(false);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-amber-400" />
              Log out all devices
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Log out every CallVault device for{' '}
              <span className="font-medium text-muted-foreground">
                {member?.full_name || 'this agent'}
              </span>
              ? They will need to log in again on each device.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setConfirmAll(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              onClick={handleRevokeAll}
              disabled={pending !== null}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {pending === '__all__' ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Logging out...
                </>
              ) : (
                'Log out all'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
