'use client';

// ============================================================
// CallvaultDevicesDialog — owner-only per-agent CallVault
// device list with remote logout.
//
// The owner sees every registered device of the selected agent:
// name / model / presence / last seen / login date / session
// expiry / app version. Presence is Connected, Disconnected
// (with an alert banner: agent, device, last seen,
// disconnected-since, and a live-ticking offline duration),
// Remote Logout (owner-revoked — never shown as an ordinary
// disconnect), Session Expired (60d, history only), plus the
// legacy Active / Logout Pending / Logged Out logout states.
// "Log out" revokes one device session; "Log out all" revokes
// every session of the agent. Both ask for confirmation first
// and report success/failure via toasts.
//
// The list refetches every 15s while the dialog is open (one
// unified poller — the old 5s-while-pending poller was folded
// into it), quietly (no spinner, no error toasts; a failed
// poll retries on the next tick). The poller and the 1s
// banner-duration ticker both stop when the dialog closes or
// unmounts.
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
  /** Server-computed presence (see src/lib/callvault/presence.ts). */
  presence: string;
  /** Open disconnect episode start, if any. */
  disconnected_since: string | null;
  logout_ack_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  session_expires_at: string | null;
}

interface CallvaultDeviceHistoryEvent {
  id: string;
  device_id: string;
  disconnected_at: string;
  reconnected_at: string | null;
  reason: string;
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

/** Compact offline duration for the ticking banner ("3m 12s"). */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function presenceBadge(presence: string): { label: string; className: string } {
  switch (presence) {
    case 'disconnected':
      return {
        label: 'Disconnected',
        className:
          'bg-red-500/10 text-red-300 border-red-500/30 text-[10px] uppercase tracking-wide',
      };
    case 'remote_logout':
      return {
        label: 'Remote logout',
        className:
          'bg-muted text-muted-foreground border-border text-[10px] uppercase tracking-wide',
      };
    case 'session_expired':
      return {
        label: 'Session expired',
        className:
          'bg-amber-500/10 text-amber-300 border-amber-500/30 text-[10px] uppercase tracking-wide',
      };
    default:
      return {
        label: 'Connected',
        className:
          'bg-emerald-500/10 text-emerald-300 border-emerald-500/30 text-[10px] uppercase tracking-wide',
      };
  }
}

export function CallvaultDevicesDialog({
  member,
  onClose,
}: {
  member: CallvaultDeviceMember | null;
  onClose: () => void;
}) {
  const [devices, setDevices] = useState<CallvaultDevice[]>([]);
  const [history, setHistory] = useState<CallvaultDeviceHistoryEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmDevice, setConfirmDevice] = useState<CallvaultDevice | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  // Ticking clock for the live "offline for …" banner durations.
  const [nowMs, setNowMs] = useState(() => Date.now());

  const loadDevices = useCallback(async (userId: string, opts?: { quiet?: boolean }) => {
    const quiet = opts?.quiet === true;
    if (!quiet) setLoading(true);
    try {
      const res = await fetch(
        `/api/callvault/devices?user_id=${encodeURIComponent(userId)}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        if (!quiet) {
          const payload = await res.json().catch(() => ({}));
          toast.error(payload.error || 'Failed to load devices');
        }
        return;
      }
      const data = (await res.json()) as {
        devices: CallvaultDevice[];
        history?: CallvaultDeviceHistoryEvent[];
      };
      setDevices(data.devices ?? []);
      setHistory(data.history ?? []);
    } catch (err) {
      if (!quiet) {
        console.error('[CallvaultDevices] load error:', err);
        toast.error('Could not reach the server');
      }
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (member) {
      setDevices([]);
      setHistory([]);
      setConfirmDevice(null);
      setConfirmAll(false);
      void loadDevices(member.user_id);
    }
  }, [member, loadDevices]);

  // Unified poller: refetch every 15s while the dialog is open so
  // disconnect banners, ack flips (Pending → Logged Out), and
  // history stay fresh without reopening. This replaces the old
  // 5s-while-pending poller — one cadence for every state, quiet
  // (no spinner, no error toasts; failures retry next tick).
  // Stops when the dialog closes or unmounts (cleanup below).
  useEffect(() => {
    if (!member) return;
    const userId = member.user_id;
    const timer = setInterval(() => {
      void loadDevices(userId, { quiet: true });
    }, 15000);
    return () => clearInterval(timer);
  }, [member, loadDevices]);

  const disconnected = devices.filter((d) => d.presence === 'disconnected');

  // 1s ticker drives the live "offline for …" durations. Runs
  // only while a disconnected device is shown; stops with the
  // dialog (cleanup) like the poller above.
  useEffect(() => {
    if (!member || disconnected.length === 0) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [member, disconnected.length]);

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
              {disconnected.length > 0 && (
                <p className="text-xs font-medium text-red-300">
                  {disconnected.length} of {devices.length} device
                  {devices.length === 1 ? '' : 's'} disconnected
                </p>
              )}
              {disconnected.map((d) => {
                const sinceMs = d.disconnected_since
                  ? Date.parse(d.disconnected_since)
                  : NaN;
                return (
                  <div
                    key={`offline-${d.device_id}`}
                    role="alert"
                    className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2.5"
                  >
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-300" />
                    <div className="min-w-0 text-xs">
                      <p className="font-semibold uppercase tracking-wide text-red-200">
                        Disconnected — {member?.full_name || 'Agent'} ·{' '}
                        {d.device_name || d.device_id}
                      </p>
                      <p className="mt-0.5 text-red-200/80">
                        Last seen {fmtDateTime(d.last_seen_at)} · Disconnected
                        since {fmtDateTime(d.disconnected_since)}
                        {Number.isFinite(sinceMs) &&
                          ` · Offline for ${fmtDuration(nowMs - sinceMs)}`}
                      </p>
                      <p className="mt-0.5 text-red-200/80">
                        App may be offline, stopped, or uninstalled.
                      </p>
                    </div>
                  </div>
                );
              })}
              <ul className="divide-y divide-border rounded-md border border-border">
                {devices.map((d) => {
                  const loggedOut = d.status === 'logged_out';
                  const pendingLogout = d.status === 'pending';
                  const settled = loggedOut || pendingLogout;
                  const busy = pending === d.device_id;
                  const badge = presenceBadge(d.presence);
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
                          <Badge className={badge.className}>{badge.label}</Badge>
                          {settled && (
                            <Badge className="bg-muted text-muted-foreground border-border text-[10px] uppercase tracking-wide">
                              {loggedOut ? 'Logged out' : 'Logout pending'}
                            </Badge>
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {[d.device_model, d.app_version].filter(Boolean).join(' · ') ||
                            d.device_id}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Last seen {fmtDateTime(d.last_seen_at)} · Login{' '}
                          {fmtDate(d.created_at)} · Session expires{' '}
                          {fmtDate(d.session_expires_at)}
                          {d.presence === 'disconnected' &&
                            ` · Disconnected since ${fmtDateTime(d.disconnected_since)}`}
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
              {history.length > 0 && (
                <div className="rounded-md border border-border px-3 py-2.5">
                  <p className="text-xs font-medium text-muted-foreground">
                    Recent disconnects
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {history.map((e) => {
                      const start = Date.parse(e.disconnected_at);
                      const end = e.reconnected_at
                        ? Date.parse(e.reconnected_at)
                        : nowMs;
                      return (
                        <li
                          key={e.id}
                          className="text-xs text-muted-foreground"
                        >
                          {e.device_id} · {fmtDateTime(e.disconnected_at)} →{' '}
                          {e.reconnected_at
                            ? fmtDateTime(e.reconnected_at)
                            : 'still offline'}{' '}
                          ({fmtDuration(end - start)}
                          {e.reason === 'session_expired'
                            ? ', session expired'
                            : ''}
                          )
                        </li>
                      );
                    })}
                  </ul>
                </div>
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
