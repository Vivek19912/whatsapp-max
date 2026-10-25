'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  MessageCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

interface TemplateSlot {
  key: string;
  component: 'body' | 'header' | 'button';
  position: number;
  buttonIndex?: number;
}

interface SequenceItem {
  template_name: string;
  template_language: string;
  position: number;
  variable_mappings: Record<string, string>;
}

interface ApprovedTemplate {
  template_name: string;
  template_language: string;
  preview: string | null;
  body_text: string;
  variables: TemplateSlot[];
}

interface FieldDef {
  key: string;
  label: string;
}

interface WhatsappTablePayload {
  flow: { id: string; name: string | null };
  form: {
    id: string;
    form_id: string;
    form_name: string | null;
    enabled: boolean;
  };
  configured: boolean;
  paused: boolean;
  delay_seconds: number;
  items: SequenceItem[];
  fields: FieldDef[];
  sample_values: Record<string, string> | null;
  approved_templates: ApprovedTemplate[];
  counts: { pending: number; sending: number; sent: number; failed: number };
}

function slotLabel(slot: TemplateSlot): string {
  if (slot.component === 'body') return `Body {{${slot.position}}}`;
  if (slot.component === 'header') return `Header {{${slot.position}}}`;
  return `Button ${slot.buttonIndex! + 1} {{${slot.position}}}`;
}

/** Display-only preview: sample values substituted, unmapped left as {{N}}. */
function previewBody(
  bodyText: string,
  slots: TemplateSlot[],
  mappings: Record<string, string>,
  sample: Record<string, string> | null
): string {
  return bodyText.replace(/\{\{(\d+)\}\}/g, (placeholder, raw: string) => {
    const slot = slots.find(
      (s) => s.component === 'body' && s.position === Number(raw)
    );
    if (!slot) return placeholder;
    const fieldKey = mappings[slot.key];
    if (!fieldKey || !sample) return placeholder;
    const value = (sample[fieldKey] ?? '').trim();
    return value === '' ? placeholder : value;
  });
}

/**
 * Per-table WhatsApp auto-send configuration (Meta Lead Ads tables
 * only — never rendered for Flow Tables).
 *
 * Lets the owner pick an ordered sequence of APPROVED templates,
 * map each template variable to a field of THIS table's
 * Workspace row, set the delay between consecutive sends, and
 * pause/resume the automation for THIS table only. Keyed by flow
 * so switching tables loads that table's own settings.
 */
export function MetaTableWhatsappDialog({
  flowId,
  open,
  onOpenChange,
}: {
  flowId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [payload, setPayload] = useState<WhatsappTablePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [items, setItems] = useState<SequenceItem[]>([]);
  const [delay, setDelay] = useState('0');
  const [paused, setPaused] = useState(false);
  const [pick, setPick] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/integrations/meta-lead-ads/whatsapp/tables/${encodeURIComponent(flowId)}/config`,
        { cache: 'no-store' }
      );
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(
          typeof json.error === 'string' ? json.error : `Request failed (${res.status})`
        );
      }
      const next = json as unknown as WhatsappTablePayload;
      setPayload(next);
      setItems(
        [...(next.items ?? [])]
          .sort((a, b) => a.position - b.position)
          .map((t) => ({ ...t, variable_mappings: { ...(t.variable_mappings ?? {}) } }))
      );
      setDelay(String(next.delay_seconds ?? 0));
      setPaused(next.paused);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load auto-send settings.');
    } finally {
      setLoading(false);
    }
  }, [flowId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const chosen = new Set(items.map((i) => `${i.template_name}\u0000${i.template_language}`));
  const available = (payload?.approved_templates ?? []).filter(
    (t) => !chosen.has(`${t.template_name}\u0000${t.template_language}`)
  );

  function slotsFor(item: SequenceItem): TemplateSlot[] {
    return (
      payload?.approved_templates.find(
        (t) =>
          t.template_name === item.template_name &&
          t.template_language === item.template_language
      )?.variables ?? []
    );
  }

  function bodyFor(item: SequenceItem): string {
    return (
      payload?.approved_templates.find(
        (t) =>
          t.template_name === item.template_name &&
          t.template_language === item.template_language
      )?.body_text ?? ''
    );
  }

  function addPicked() {
    if (!pick) return;
    const found = (payload?.approved_templates ?? []).find(
      (t) => `${t.template_name}\u0000${t.template_language}` === pick
    );
    if (!found) return;
    setItems((cur) => [
      ...cur,
      {
        template_name: found.template_name,
        template_language: found.template_language,
        position: cur.length,
        variable_mappings: {},
      },
    ]);
    setPick('');
  }

  function move(index: number, dir: -1 | 1) {
    setItems((cur) => {
      const next = [...cur];
      const j = index + dir;
      if (j < 0 || j >= next.length) return cur;
      const tmp = next[index];
      next[index] = next[j];
      next[j] = tmp;
      return next.map((t, position) => ({ ...t, position }));
    });
  }

  function remove(index: number) {
    setItems((cur) => cur.filter((_, i) => i !== index).map((t, position) => ({ ...t, position })));
  }

  function setMapping(index: number, slotKey: string, fieldKey: string) {
    setItems((cur) =>
      cur.map((t, i) =>
        i === index
          ? { ...t, variable_mappings: { ...t.variable_mappings, [slotKey]: fieldKey } }
          : t
      )
    );
  }

  function save() {
    const delayNum = Number(delay);
    if (!Number.isInteger(delayNum) || delayNum < 0 || delayNum > 86400) {
      toast.error('Delay must be a whole number of seconds between 0 and 86400.');
      return;
    }
    // Client-side guard (the server re-validates): every required
    // variable must have a mapped field before saving.
    for (const item of items) {
      for (const slot of slotsFor(item)) {
        if (!item.variable_mappings[slot.key]) {
          toast.error(
            `Template "${item.template_name}" needs a Workspace field for ${slotLabel(slot)}.`
          );
          return;
        }
      }
    }
    setSaving(true);
    fetch(
      `/api/integrations/meta-lead-ads/whatsapp/tables/${encodeURIComponent(flowId)}/config`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          delay_seconds: delayNum,
          paused,
          templates: items.map((t) => ({
            template_name: t.template_name,
            template_language: t.template_language,
            variable_mappings: t.variable_mappings,
          })),
        }),
      }
    )
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          throw new Error(
            typeof json.error === 'string' ? json.error : `Request failed (${res.status})`
          );
        }
        return json as unknown as WhatsappTablePayload;
      })
      .then((next) => {
        setPayload(next);
        setItems(
          [...(next.items ?? [])]
            .sort((a, b) => a.position - b.position)
            .map((t) => ({ ...t, variable_mappings: { ...(t.variable_mappings ?? {}) } }))
        );
        setDelay(String(next.delay_seconds ?? 0));
        setPaused(next.paused);
        toast.success(
          next.items.length === 0
            ? 'Auto-send cleared for this table.'
            : next.paused
              ? 'Auto-send saved (paused). No new sends until resumed.'
              : 'Auto-send saved for this table.'
        );
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : 'Failed to save auto-send settings.');
      })
      .finally(() => setSaving(false));
  }

  function retryFailed() {
    setRetrying(true);
    fetch(
      `/api/integrations/meta-lead-ads/whatsapp/tables/${encodeURIComponent(flowId)}/retry`,
      { method: 'POST' }
    )
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          throw new Error(
            typeof json.error === 'string' ? json.error : `Request failed (${res.status})`
          );
        }
        return json as { revived?: number; counts?: WhatsappTablePayload['counts'] };
      })
      .then((json) => {
        toast.success(
          (json.revived ?? 0) > 0
            ? `${json.revived} failed send${json.revived === 1 ? '' : 's'} queued for retry.`
            : 'No failed sends to retry.'
        );
        if (json.counts && payload) setPayload({ ...payload, counts: json.counts });
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : 'Retry failed.');
      })
      .finally(() => setRetrying(false));
  }

  const counts = payload?.counts;
  const fields = payload?.fields ?? [];
  const sample = payload?.sample_values ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="size-4" />
            WhatsApp Auto-send Templates
          </DialogTitle>
          <DialogDescription>
            {payload?.form.form_name ?? 'This table'} — new leads automatically receive
            these templates in order. Other tables are unaffected.
          </DialogDescription>
        </DialogHeader>

        {loading || !payload ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant={payload.configured && !payload.paused ? 'secondary' : 'outline'}>
                {payload.configured
                  ? payload.paused
                    ? 'Paused'
                    : 'Active'
                  : 'Not configured'}
              </Badge>
              {counts ? (
                <span className="text-muted-foreground">
                  {counts.sent} sent · {counts.pending + counts.sending} pending ·{' '}
                  {counts.failed} failed
                </span>
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {paused ? 'Automation paused' : 'Automation running'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {paused
                    ? 'No new sends start while paused. History and order are kept.'
                    : 'New leads receive the sequence below.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {paused ? <Pause className="size-4" /> : <Play className="size-4" />}
                <Switch
                  checked={!paused}
                  onCheckedChange={(v) => setPaused(!v)}
                  aria-label={paused ? 'Resume automation' : 'Pause automation'}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="wa-delay">Delay between messages (seconds)</Label>
              <Input
                id="wa-delay"
                inputMode="numeric"
                value={delay}
                onChange={(e) => setDelay(e.target.value)}
                className="mt-1 max-w-[160px]"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                0 sends all templates immediately, still in order.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Send sequence (in order)</Label>
              {items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No templates yet — pick an approved template below to add the
                  first message.
                </p>
              ) : (
                items.map((item, index) => {
                  const slots = slotsFor(item);
                  const rendered = previewBody(
                    bodyFor(item),
                    slots,
                    item.variable_mappings,
                    sample
                  );
                  return (
                    <div
                      key={`${item.template_name}::${item.template_language}`}
                      className="space-y-2 rounded-md border border-border px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">
                            <span className="mr-2 tabular-nums text-muted-foreground">
                              {index + 1}.
                            </span>
                            {item.template_name}
                          </p>
                          <p className="text-xs text-muted-foreground">{item.template_language}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => move(index, -1)}
                            disabled={index === 0}
                            aria-label={`Move ${item.template_name} up`}
                          >
                            <ArrowUp className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => move(index, 1)}
                            disabled={index === items.length - 1}
                            aria-label={`Move ${item.template_name} down`}
                          >
                            <ArrowDown className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => remove(index)}
                            aria-label={`Remove ${item.template_name}`}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </div>
                      {slots.length > 0 ? (
                        <div className="space-y-1.5 border-t border-border pt-2">
                          {slots.map((slot) => (
                            <div key={slot.key} className="flex items-center gap-2">
                              <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
                                {slotLabel(slot)}
                              </span>
                              <Select
                                value={item.variable_mappings[slot.key] ?? ''}
                                onValueChange={(v: string | null) =>
                                  setMapping(index, slot.key, v ?? '')
                                }
                              >
                                <SelectTrigger className="flex-1">
                                  <SelectValue placeholder="Select a field…" />
                                </SelectTrigger>
                                <SelectContent>
                                  {fields.map((f) => (
                                    <SelectItem key={f.key} value={f.key}>
                                      {f.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          ))}
                          <p className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                            Preview: {rendered}
                            {sample ? null : ' (no lead yet — live values fill in per lead)'}
                          </p>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          Static template — sends as approved, no mapping needed.
                        </p>
                      )}
                    </div>
                  );
                })
              )}
              <div className="flex items-center gap-2">
                <Select value={pick} onValueChange={(v: string | null) => setPick(v ?? '')}>
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Add an approved template…" />
                  </SelectTrigger>
                  <SelectContent>
                    {available.length === 0 ? (
                      <SelectItem value="__none" disabled>
                        {payload.approved_templates.length === 0
                          ? 'No APPROVED templates — sync templates from Meta first.'
                          : 'All approved templates are already in the sequence.'}
                      </SelectItem>
                    ) : (
                      available.map((t) => (
                        <SelectItem
                          key={`${t.template_name}\u0000${t.template_language}`}
                          value={`${t.template_name}\u0000${t.template_language}`}
                        >
                          {t.template_name} ({t.template_language})
                          {t.variables.length > 0
                            ? ` · ${t.variables.length} variable${t.variables.length === 1 ? '' : 's'}`
                            : ''}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" onClick={addPicked} disabled={!pick}>
                  <Plus className="size-4" /> Add
                </Button>
              </div>
            </div>

            {(counts?.failed ?? 0) > 0 ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <span className="text-muted-foreground">
                  {counts?.failed} failed send{(counts?.failed ?? 0) === 1 ? '' : 's'} — fix the
                  cause (template approval, WhatsApp setup, missing values), then retry.
                </span>
                <Button variant="outline" size="sm" onClick={retryFailed} disabled={retrying}>
                  {retrying ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RotateCcw className="size-4" />
                  )}
                  Retry
                </Button>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={save} disabled={loading || saving || !payload}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
