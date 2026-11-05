'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface ApprovedTemplateOption {
  name: string;
  language: string;
}

const NONE_VALUE = "__none__";

/**
 * Fallback template picker for reminders sent outside the 24-hour
 * customer-service window (`{{1}}` = reminder message). Admins and
 * owners save the account default (`accounts.*`); agents save their
 * OWN personal setting (scoped server-side to the authenticated
 * user, so teammates can never overwrite each other). The
 * scheduler validates APPROVED status again at send time, and
 * resolves personal-first with the account default as fallback.
 * Agent+ UI — the API enforces agent+ writes regardless, and
 * viewers stay read-only.
 */
export function ReminderTemplatePanel() {
  const { accountId, canManageMembers, canSendMessages } = useAuth();
  const supabase = createClient();

  const [options, setOptions] = useState<ApprovedTemplateOption[]>([]);
  const [saved, setSaved] = useState<{ name: string | null; language: string }>({
    name: null,
    language: 'en_US',
  });
  const [draft, setDraft] = useState<string>(NONE_VALUE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const [tmplRes, settingRes] = await Promise.all([
          supabase
            .from('message_templates')
            .select('name, language')
            .eq('account_id', accountId)
            .eq('status', 'APPROVED')
            .order('name'),
          fetch('/api/account/reminder-template', { cache: 'no-store' }),
        ]);
        if (cancelled) return;
        if (!tmplRes.error) {
          setOptions(
            ((tmplRes.data ?? []) as ApprovedTemplateOption[]).filter(
              (t) => t.name,
            ),
          );
        }
        if (settingRes.ok) {
          const json = (await settingRes.json().catch(() => null)) as {
            template_name?: string | null;
            template_language?: string | null;
          } | null;
          const current = {
            name: json?.template_name ?? null,
            language: json?.template_language ?? 'en_US',
          };
          setSaved(current);
          setDraft(
            current.name ? `${current.name}|||${current.language}` : NONE_VALUE,
          );
        }
      } catch {
        // Best-effort lists; save surfaces real errors.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  if (!canManageMembers && !canSendMessages) return null;

  const dirty =
    (draft === NONE_VALUE ? null : draft) !==
    (saved.name ? `${saved.name}|||${saved.language}` : null);

  async function handleSave() {
    const cleared = draft === NONE_VALUE;
    setSaving(true);
    try {
      const res = await fetch('/api/account/reminder-template', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          cleared
            ? { template_name: null }
            : (() => {
                const [name, language] = draft.split('|||');
                return { template_name: name, template_language: language || 'en_US' };
              })(),
        ),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        template_name?: string | null;
        template_language?: string | null;
      };
      if (!res.ok) throw new Error(payload.error || 'Could not save the template.');
      setSaved({
        name: payload.template_name ?? null,
        language: payload.template_language ?? 'en_US',
      });
      toast.success(
        payload.template_name
          ? 'Reminder fallback template saved'
          : 'Reminder fallback template cleared',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the template.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle className="text-foreground">Fallback template</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-muted-foreground">
            Approved template for closed-window sends
          </Label>
          <Select value={draft} onValueChange={(v) => v && setDraft(v)}>
            <SelectTrigger
              className="border-border bg-card w-full max-w-sm"
              aria-label="Reminder fallback template"
            >
              <SelectValue placeholder="No fallback (fail closed)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>No fallback (fail closed)</SelectItem>
              {options.map((t) => (
                <SelectItem key={`${t.name}|||${t.language}`} value={`${t.name}|||${t.language}`}>
                  {t.name} ({t.language})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Used only when the 24-hour window is closed. The reminder text
            is sent as variable {`{{1}}`} — the template must be APPROVED
            with exactly one body variable.
          </p>
        </div>
        <div>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving…
              </>
            ) : (
              'Save template'
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
