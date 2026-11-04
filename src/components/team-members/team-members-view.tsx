'use client';

// ============================================================
// TeamMembersView — standalone /team-members page content.
//
// Member roster — every member of the account. Roles are
// display-only on this page (a static badge per row); roles are
// never changed here. Owner row was already non-editable
// (transfer is its own separate flow, deferred to a later PR).
// Owner direct creation lives in AddUserDialog ("+ Add user",
// owner-only).
//
// NOTE: the "Pending invitations" section was intentionally removed
// from this UI. The invitation backend (routes, RPCs, /join/[token])
// is untouched — existing invite links stay redeemable.
//
// Extracted verbatim from the former Settings tab — behavior
// unchanged, only the mount point moved to /team-members.
//
// Role-gating
//   The page itself is reachable by any member, but mutation buttons
//   are wrapped in `<RequireRole min="admin">` / `useCan` so an
//   agent or viewer sees the roster read-only. The server-side
//   RPCs (set_member_role, remove_account_member) double-check
//   the role anyway.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Loader2,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Trash2,
} from 'lucide-react';

import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { usePresence } from '@/hooks/use-presence';
import type { AccountRole } from '@/lib/auth/roles';
import {
  formatPhoneForDisplay,
  isIndianCountryCodeNumber,
} from '@/lib/whatsapp/phone-utils';
import { presenceLabel, summarize } from '@/lib/presence';
import {
  PRESENCE_DOT_CLASS,
  PresenceDot,
} from '@/components/presence/presence-dot';
import { AddUserDialog } from './add-user-dialog';
import {
  CallvaultDevicesDialog,
  type CallvaultDeviceMember,
} from './callvault-devices-dialog';
import {
  AgentPermissionsDialog,
  type AgentInboxPermissions,
} from './agent-permissions-dialog';
import {
  RecordingConfigDialog,
  type RecordingConfigPatch,
} from './recording-config-dialog';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import { ROLE_META } from '@/components/settings/role-meta';

interface Member {
  user_id: string;
  full_name: string;
  email: string | null;
  avatar_url: string | null;
  role: AccountRole;
  joined_at: string;
  whatsapp_recording_source: string;
  phone_recording_source: string;
  phone_recording_number: string | null;
  /** Inbox grants (owner view only; absent = no grants). */
  can_manage_assignments?: boolean;
  can_view_all?: boolean;
}

// Readable display for the stored normalized digits. Indian
// numbers render as "+91 89530 65369"-style via the shared
// display helper; anything else renders with a '+' prefix.
// Display only — storage/matching always use raw digits.

export function displayRecordingNumber(digits: string | null): string {
  if (!digits) return 'None';
  if (isIndianCountryCodeNumber(digits)) return `+91 ${formatPhoneForDisplay(digits)}`;
  return `+${digits}`;
}

// The single effective WhatsApp choice — mirrors the API vocabulary
// (user_recording_settings.whatsapp_recording_source). Used only for
// the read-only row summary; editing lives in RecordingConfigDialog.
const RECORDING_SOURCE_LABELS: Record<string, string> = {
  none: 'None',
  whatsapp: 'WhatsApp',
  whatsapp_business: 'WhatsApp Business',
};

// Per-role chip metadata (icon / label / colour) lives in the shared
// ROLE_META module so this roster and the Overview identity chip can't
// drift. The colour scale runs amber (owner — scarce, immutable) →
// primary (admin) → muted (agent / viewer). Roles render as static
// badges on this page; they are never edited here.

function fmtDate(iso: string): string {
  // Match the rest of the dashboard's locale-light formatting.
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function TeamMembersView() {
  const { user, canManageMembers, isOwner } = useAuth();
  const { getPresence, getRow, now } = usePresence();

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  const [addUserOpen, setAddUserOpen] = useState(false);
  const [removingMember, setRemovingMember] = useState<Member | null>(null);
  const [configMember, setConfigMember] = useState<Member | null>(null);
  const [permMember, setPermMember] = useState<Member | null>(null);
  const [devicesMember, setDevicesMember] = useState<CallvaultDeviceMember | null>(
    null,
  );
  const [pendingMemberAction, setPendingMemberAction] = useState<string | null>(
    null,
  );

  const loadEverything = useCallback(async () => {
    try {
      const mres = await fetch('/api/account/members', { cache: 'no-store' });

      if (!mres.ok) {
        const payload = await mres.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to load members');
        return;
      }
      const mdata = (await mres.json()) as { members: Member[] };
      setMembers(mdata.members);
    } catch (err) {
      console.error('[MembersTab] load error:', err);
      toast.error('Could not reach the server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadEverything();
  }, [loadEverything]);

  // Recording policy edits happen exclusively in RecordingConfigDialog
  // (owner-only). Its onSaved merges the server-confirmed patch into
  // the roster so the row summary updates without a full reload.
  function handleConfigSaved(
    userId: string,
    patch: RecordingConfigPatch,
  ) {
    setMembers((prev) =>
      prev.map((m) => (m.user_id === userId ? { ...m, ...patch } : m)),
    );
  }

  // Permission edits merge the same way so the row badges update
  // without a full reload.
  function handlePermSaved(userId: string, flags: AgentInboxPermissions) {
    setMembers((prev) =>
      prev.map((m) =>
        m.user_id === userId
          ? {
              ...m,
              can_manage_assignments: flags.can_manage_assignments,
              can_view_all: flags.can_view_all,
            }
          : m,
      ),
    );
  }

  async function handleRemove() {    if (!removingMember) return;
    setPendingMemberAction(removingMember.user_id);
    try {
      const res = await fetch(
        `/api/account/members/${removingMember.user_id}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to remove member');
        return;
      }
      toast.success(`Removed ${removingMember.full_name || 'member'}`);
      setMembers((prev) =>
        prev.filter((m) => m.user_id !== removingMember.user_id),
      );
      setRemovingMember(null);
    } catch (err) {
      console.error('[MembersTab] remove error:', err);
      toast.error('Could not reach the server');
    } finally {
      setPendingMemberAction(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="Team Members"
        description="People with access to this account. Roles control what each teammate can do."
        action={
          <RequireRole min="owner">
            <Button onClick={() => setAddUserOpen(true)}>
              <Plus className="size-4" />
              Add user
            </Button>
          </RequireRole>
        }
      />

      {/* Owner-managed recording policy. These dropdowns choose which
          calls each member's CallVault device is allowed to record —
          recording configuration is controlled by the WhatsApp Max
          owner, never by the member's own device. */}
      {isOwner ? (
        <p className="text-xs text-muted-foreground">
          Use Configure on a member to choose which calls their
          CallVault device is allowed to record.
        </p>
      ) : null}

      {/* Live presence summary across the roster. Updates without a
          full refresh as heartbeats and the local re-derive tick land. */}
      {members.length > 0 &&
        (() => {
          const counts = summarize(members.map((m) => getPresence(m.user_id)));
          return (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="online" />
                {counts.online} online
              </span>
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="away" />
                {counts.away} away
              </span>
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="offline" />
                {counts.offline} offline
              </span>
              <span className="text-muted-foreground/70">
                · {members.length} member{members.length === 1 ? '' : 's'}
              </span>
            </div>
          );
        })()}

      {/* Roster */}
      <Card>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {members.map((member) => {
              const roleMeta = ROLE_META[member.role];
              const RoleIcon = roleMeta.icon;
              const isSelf = member.user_id === user?.id;
              const isOwnerRow = member.role === 'owner';
              const isBusy = pendingMemberAction === member.user_id;
              const presence = getPresence(member.user_id);
              const presenceRow = getRow(member.user_id);
              const presenceText = presenceLabel(
                presence,
                presenceRow?.last_seen_at ?? null,
                now,
              );

              return (
                <li
                  key={member.user_id}
                  // Mobile: stack identity (avatar+name+email) above the
                  // role/actions so the row never forces the name into
                  // a narrow truncation. Desktop (sm+): everything
                  // inline as before.
                  className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-4">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Avatar className="size-9 shrink-0">
                            {member.avatar_url ? (
                              <AvatarImage
                                src={member.avatar_url}
                                alt={member.full_name || 'Member'}
                              />
                            ) : null}
                            <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                              {(member.full_name || member.email || 'U')
                                .charAt(0)
                                .toUpperCase()}
                            </AvatarFallback>
                            {/* role+label so screen readers announce
                                presence — the hover tooltip alone isn't
                                reachable by keyboard/AT on a non-focusable
                                avatar. */}
                            <AvatarBadge
                              role="img"
                              aria-label={presenceText}
                              className={PRESENCE_DOT_CLASS[presence]}
                            />
                          </Avatar>
                        }
                      />
                      <TooltipContent>{presenceText}</TooltipContent>
                    </Tooltip>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {member.full_name || 'Unnamed'}
                        </span>
                        {isSelf && (
                          <Badge className="bg-muted text-muted-foreground border-border text-[10px] uppercase tracking-wide">
                            You
                          </Badge>
                        )}
                        {/* Active Inbox grants (owner view only — the
                            flags only arrive on the owner response). */}
                        {member.role === 'agent' && member.can_manage_assignments ? (
                          <Badge className="bg-primary/10 text-primary border-primary/30 text-[10px] uppercase tracking-wide">
                            Can assign
                          </Badge>
                        ) : null}
                        {member.role === 'agent' && member.can_view_all ? (
                          <Badge className="bg-primary/10 text-primary border-primary/30 text-[10px] uppercase tracking-wide">
                            Views all
                          </Badge>
                        ) : null}
                      </div>
                      {member.email && (
                        <p className="truncate text-xs text-muted-foreground">
                          {member.email}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Joined date stays desktop-only. The mobile row's
                      vertical density makes the joined date noise. */}
                  <div className="hidden sm:block text-right text-xs text-muted-foreground">
                    Joined {fmtDate(member.joined_at)}
                  </div>

                  {/* Actions cluster. On mobile this is its own row
                      below the identity block; on desktop it sits
                      inline. Items align to the start on mobile so the
                      role badge lines up under the avatar. */}
                  <div className="flex items-center gap-2 sm:gap-3">
                    {/* Role badge (read-only). The actual role comes
                        from the member record; nothing on this page
                        can change it. */}
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${roleMeta.className}`}
                    >
                      <RoleIcon className="size-3.5" />
                      {roleMeta.label}
                    </span>

                    {/* Recording summary + Configure. The row itself
                        carries no editable controls: owners open the
                        RecordingConfigDialog, everyone else sees the
                        read-only summary (their own effective values
                        travel with their CallVault session). */}
                    <div className="flex flex-col gap-0.5 text-xs">
                      <span className="font-medium text-muted-foreground">
                        Recording
                      </span>
                      <span className="text-muted-foreground">
                        Phone:{' '}
                        <span className="text-foreground">
                          {displayRecordingNumber(member.phone_recording_number)}
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        WhatsApp:{' '}
                        <span className="text-foreground">
                          {RECORDING_SOURCE_LABELS[member.whatsapp_recording_source] ?? 'None'}
                        </span>
                      </span>
                    </div>
                    {isOwner ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => setConfigMember(member)}
                        aria-label={`Configure recording for ${member.full_name || 'member'}`}
                      >
                        <SlidersHorizontal className="size-4" />
                        Configure
                      </Button>
                    ) : null}
                    {/* Inbox access (owner-only, agents only — owners
                        and admins already have full access by role, and
                        viewers keep read-only. Opens the permissions
                        dialog; distinct from CallVault Configure above. */}
                    {isOwner && member.role === 'agent' && !isSelf ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => setPermMember(member)}
                        aria-label={`Inbox permissions for ${member.full_name || 'agent'}`}
                        title="Inbox permissions"
                      >
                        <ShieldCheck className="size-4" />
                        Access
                      </Button>
                    ) : null}

                    {/* CallVault devices (owner-only, agents only — the
                        dialog lists registered devices with per-device
                        and log-out-all remote logout; entirely hidden
                        for non-owners). */}
                    {isOwner && member.role === 'agent' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isBusy}
                        onClick={() =>
                          setDevicesMember({
                            user_id: member.user_id,
                            full_name: member.full_name,
                          })
                        }
                        aria-label={`CallVault devices for ${member.full_name || 'agent'}`}
                        title="CallVault devices"
                      >
                        <Smartphone className="size-4" />
                        Devices
                      </Button>
                    ) : null}

                    {/* Remove. Admin+ only; never on the owner row;
                        never on yourself. Pre-polish styling was
                        neutral-default + red-on-hover — the
                        destructive intent was invisible until the
                        user moused over. Now red is the default
                        state with a darker shade on hover so the
                        affordance reads at-a-glance. */}
                    {canManageMembers && !isOwnerRow && !isSelf && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRemovingMember(member)}
                        disabled={isBusy}
                        className="border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:border-red-500/60 hover:text-red-200"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <AddUserDialog
        open={addUserOpen}
        onOpenChange={setAddUserOpen}
        onCreated={loadEverything}
      />

      <AgentPermissionsDialog
        member={permMember}
        onClose={() => setPermMember(null)}
        onSaved={handlePermSaved}
      />

      <RecordingConfigDialog
        member={configMember}
        onClose={() => setConfigMember(null)}
        onSaved={handleConfigSaved}
      />

      <CallvaultDevicesDialog
        member={devicesMember}
        onClose={() => setDevicesMember(null)}
      />

      <Dialog
        open={removingMember !== null}
        onOpenChange={(open) => {
          if (!open) setRemovingMember(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-amber-400" />
              Remove member
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Remove{' '}
              <span className="font-medium text-muted-foreground">
                {removingMember?.full_name || 'this teammate'}
              </span>{' '}
              from the account? They&apos;ll be signed out of this account
              and given a fresh personal account on their next sign-in. Their
              login isn&apos;t deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setRemovingMember(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              onClick={handleRemove}
              disabled={!!pendingMemberAction}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {pendingMemberAction ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Removing...
                </>
              ) : (
                'Remove member'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
