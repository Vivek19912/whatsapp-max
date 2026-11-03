'use client';

// ============================================================
// AddUserDialog — owner creates a user directly.
//
// Single-step modal: Name + Email + Password →
// POST /api/account/members. Every user created here is an
// Agent (no role picker — the server enforces this too, so a
// crafted request cannot escalate). The user exists
// (confirmed, member of this account) when the call returns —
// no invitation link, no email verification step.
//
// Only rendered for owners (the server re-verifies anyway).
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface AddUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create so the parent re-fetches the roster. */
  onCreated: () => void;
}

// Mirrors the signup-page policy (min 6 chars) and the server's
// name ceiling (80). The server re-validates — these only
// short-circuit the round-trip.
const MIN_PASSWORD_LEN = 6;
const MAX_NAME_LEN = 80;

export function AddUserDialog({
  open,
  onOpenChange,
  onCreated,
}: AddUserDialogProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName('');
    setEmail('');
    setPassword('');
    setShowPassword(false);
    setSubmitting(false);
  }

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Name is required.');
      return;
    }
    if (trimmedName.length > MAX_NAME_LEN) {
      toast.error(`Name must be ${MAX_NAME_LEN} characters or fewer.`);
      return;
    }
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      toast.error('Email is required.');
      return;
    }
    if (password.length < MIN_PASSWORD_LEN) {
      toast.error(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No role is sent: the server pins every new user to the
        // agent role and rejects any other role value outright.
        body: JSON.stringify({
          name: trimmedName,
          email: trimmedEmail,
          password,
        }),
      });
      const payload = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        toast.error(payload?.error || 'Failed to create user.');
        return;
      }
      toast.success('User created successfully.');
      reset();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      console.error('[AddUserDialog] create error:', err);
      toast.error('Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">Add user</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Create a login for a teammate. They can sign in immediately —
            no invitation link, no email verification.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="add-user-name" className="text-muted-foreground">
              Name
            </Label>
            <Input
              id="add-user-name"
              type="text"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Vikas Sahni"
              maxLength={MAX_NAME_LEN + 10}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-user-email" className="text-muted-foreground">
              Email
            </Label>
            <Input
              id="add-user-email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-user-password" className="text-muted-foreground">
              Password
            </Label>
            <div className="relative">
              <Input
                id="add-user-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`At least ${MIN_PASSWORD_LEN} characters`}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? (
                  <Eye className="h-5 w-5" />
                ) : (
                  <EyeOff className="h-5 w-5" />
                )}
              </button>
            </div>
            <p className="text-muted-foreground text-xs">
              New users are created as Agents.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={submitting} onClick={() => void handleCreate()}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Creating…
              </>
            ) : (
              'Create user'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
