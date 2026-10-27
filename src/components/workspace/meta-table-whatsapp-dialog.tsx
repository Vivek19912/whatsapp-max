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

import { Button } from '@/components/ui/button';
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
import {
  ConfigDialog,
  ConfigFooterActions,
  ConfigSection,
  ConfigStatusBadge,
} from './config-dialog';

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
 *
 * The "Applies to" scope switches between the table-wide
 * sequence ("All new leads") and one salesperson's personal
 * sequence. A salesperson's sequence fires only on that
 * salesperson's genuine initial assignments and never on
 * reassignments. When both exist, newly assigned leads receive
 * the table sequence on arrival plus the salesperson's sequence
 * on initial assignment.
 */
export function MetaTableWhatsappDialog({
  flowId,
  open,
  onOpenChange,
  viewMode = false,
}: {
  flowId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Read-only inspection: every control is disabled, every
   * mutating button is hidden, the footer offers Close only, and
   * the save/retry submitters refuse to run. Saved configuration
   * still renders exactly as stored.
   */
  viewMode?: boolean;
}) {
  const [payload, setPayload] = useState<WhatsappTablePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [items, setItems] = useState<SequenceItem[]>([]);
  const [delay, setDelay] = useState('0');
  const [paused, setPaused] = useState(false);
  const [pick, setPick] = useState('');
  // View mode renders the same saved state with every mutation
  // path closed: disabled inputs, hidden action buttons, a
  // Close-only footer, and guarded submitters (so no keyboard
  // path can persist anything either).
  const readOnly = viewMode === true;
  // Per-salesperson scope: null = the table-wide sequence;
  // otherwise a salesperson key from the picker's `salespeople`
  // list. Switching scopes reloads that scope's saved sequence
  // (unsaved edits are discarded), and saving writes only the
  // visible scope. The scope picker stays interactive in view
  // mode — it only navigates between saved sequences.
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const [salespeople, setSalespeople] = useState<
    Array<{ key: string; label: string; kind: string }>
  >([]);
  const [configuredKeys, setConfiguredKeys] = useState<string[]>([]);

  const load = useCallback(
    async (scope: string | null) => {
      setLoading(true);
      try {
        const url =
          `/api/integrations/meta-lead-ads/whatsapp/tables/${encodeURIComponent(flowId)}/config` +
          (scope ? `?assignee_key=${encodeURIComponent(scope)}` : '');
        const res = await fetch(url, { cache: 'no-store' });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          throw new Error(
            typeof json.error === 'string' ? json.error : `Request failed (${res.status})`
          );
        }
        const next = json as unknown as WhatsappTablePayload & {
          salespeople?: Array<{ key: string; label: string; kind: string }>;
          configured_keys?: unknown;
          assignee?: {
            key: string;
            delay_seconds: number;
            items: SequenceItem[];
          } | null;
        };
        setPayload(next);
        setSalespeople(Array.isArray(next.salespeople) ? next.salespeople : []);
        setConfiguredKeys(
          Array.isArray(next.configured_keys)
            ? (next.configured_keys as unknown[]).filter(
                (k): k is string => typeof k === 'string'
              )
            : []
        );
        // A salesperson scope edits that salesperson's own
        // sequence; the table-wide scope edits the table sequence.
        // Absent salesperson data means no saved sequence yet.
        const scoped =
          scope && next.assignee && next.assignee.key === scope ? next.assignee : null;
        const sourceItems = scope ? (scoped?.items ?? []) : (next.items ?? []);
        setItems(
          [...sourceItems]
            .sort((a, b) => a.position - b.position)
            .map((t) => ({ ...t, variable_mappings: { ...(t.variable_mappings ?? {}) } }))
        );
        setDelay(String((scope ? scoped?.delay_seconds : next.delay_seconds) ?? 0));
        setPaused(next.paused);
        setPick('');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to load auto-send settings.');
      } finally {
        setLoading(false);
      }
    },
    [flowId]
  );

  useEffect(() => {
    if (open) {
      setScopeKey(null);
      void load(null);
    }
  }, [open, load]);

  const chosen = new Set(items.map((i) => `${i.template_name}\u0000${i.template_language}`));
  const available = (payload?.approved_templates ?? []).filter(
    (t) => !chosen.has(`${t.template_name}\u0000${t.template_language}`)
  );
  const scopeLabel =
    scopeKey === null
      ? 'All new leads'
      : (salespeople.find((s) => s.key === scopeKey)?.label ?? scopeKey);

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
    if (readOnly) return;
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
    if (readOnly) return;
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
    if (readOnly) return;
    setItems((cur) => cur.filter((_, i) => i !== index).map((t, position) => ({ ...t, position })));
  }

  function setMapping(index: number, slotKey: string, fieldKey: string) {
    if (readOnly) return;
    setItems((cur) =>
      cur.map((t, i) =>
        i === index
          ? { ...t, variable_mappings: { ...t.variable_mappings, [slotKey]: fieldKey } }
          : t
      )
    );
  }

  function save() {
    if (readOnly) return;
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
    const body: Record<string, unknown> = {
      delay_seconds: delayNum,
      templates: items.map((t) => ({
        template_name: t.template_name,
        template_language: t.template_language,
        variable_mappings: t.variable_mappings,
      })),
    };
    if (scopeKey) {
      body.assignee_key = scopeKey;
    } else {
      body.paused = paused;
    }
    fetch(
      `/api/integrations/meta-lead-ads/whatsapp/tables/${encodeURIComponent(flowId)}/config`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    )
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          throw new Error(
            typeof json.error === 'string' ? json.error : `Request failed (${res.status})`
          );
        }
        return json as unknown as WhatsappTablePayload & {
          assignee?: {
            key: string;
            delay_seconds: number;
            items: SequenceItem[];
          } | null;
        };
      })
      .then((next) => {
        if (scopeKey) {
          // Per-salesperson scope: apply the saved sequence locally
          // and refresh the configured-salespeople hint. The
          // table-wide payload (template catalog, counts) stays as
          // loaded.
          const savedItems = [...(next.assignee?.items ?? [])]
            .sort((a, b) => a.position - b.position)
            .map((t) => ({ ...t, variable_mappings: { ...(t.variable_mappings ?? {}) } }));
          setItems(savedItems);
          setDelay(String(next.assignee?.delay_seconds ?? 0));
          setConfiguredKeys((prev) =>
            savedItems.length > 0
              ? Array.from(new Set([...prev, scopeKey]))
              : prev.filter((k) => k !== scopeKey)
          );
          toast.success(
            savedItems.length === 0
              ? `Salesperson sequence cleared${scopeLabel && scopeLabel !== 'All new leads' ? ` for ${scopeLabel}` : ''}.`
              : `Salesperson sequence saved${scopeLabel && scopeLabel !== 'All new leads' ? ` for ${scopeLabel}` : ''}.`
          );
          return;
        }
        setPayload(next as unknown as WhatsappTablePayload);
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
    if (readOnly) return;
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

  const statusTone = !payload?.configured
    ? 'outline'
    : payload.paused
      ? 'secondary'
      : 'default';

  return (
    <ConfigDialog
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      icon={<MessageCircle aria-hidden />}
      title="Auto-send WhatsApp"
      tableLine={payload?.form.form_name ?? 'This table'}
      description={
        readOnly
          ? 'New leads automatically receive these templates in order. Viewing — switch to Edit to make changes.'
          : 'New leads automatically receive these templates in order. Other tables are unaffected.'
      }
      status={
        <ConfigStatusBadge tone={statusTone as 'default' | 'secondary' | 'outline'}>
          {!payload || !payload.configured ? 'Not configured' : payload.paused ? 'Paused' : 'Active'}
        </ConfigStatusBadge>
      }
      loading={loading || !payload}
      footer={
        readOnly ? (
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        ) : (
          <ConfigFooterActions
            onClose={() => onOpenChange(false)}
            closeLabel="Close"
            onSave={save}
            saveLabel="Save Changes"
            saving={saving}
            saveDisabled={loading || !payload}
          />
        )
      }
    >
      {payload ? (
        <div className="flex flex-col gap-5">
          <ConfigSection
            title="Applies to"
            hint="The table-wide sequence sends to every new lead. A salesperson's sequence sends only on their genuine initial assignments — never on reassignment. Switching scopes reloads that sequence; unsaved edits are discarded."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wa-scope">Sequence scope</Label>
              <Select
                value={scopeKey ?? 'all'}
                onValueChange={(v: string | null) => {
                  const next = v && v !== 'all' ? v : null;
                  setScopeKey(next);
                  void load(next);
                }}
              >
                <SelectTrigger id="wa-scope" className="w-full sm:max-w-sm">
                  <SelectValue placeholder="Select who receives this sequence…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All new leads (table sequence)</SelectItem>
                  {salespeople.map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {s.label}
                      {configuredKeys.includes(s.key) ? ' · sequence set' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {configuredKeys.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Salesperson sequences configured for:{' '}
                  {configuredKeys
                    .map((k) => salespeople.find((s) => s.key === k)?.label ?? k)
                    .join(', ')}
                  . Other assignees get no customer templates (assignment
                  notifications still work).
                </p>
              ) : null}
              {payload.items.length > 0 && configuredKeys.length > 0 ? (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                  Both a table sequence and salesperson sequences exist. New
                  leads receive the table sequence on arrival; initially
                  assigned leads additionally receive their salesperson&apos;s
                  sequence.
                </p>
              ) : null}
              {scopeKey ? (
                <p className="text-xs text-muted-foreground">
                  Editing {scopeLabel}&apos;s sequence. It follows the
                  table&apos;s pause setting.
                </p>
              ) : null}
            </div>
          </ConfigSection>

          {scopeKey ? null : (
          <ConfigSection
            title="Status"
            hint="Pause stops new sends. History, order, and counts are kept."
            action={
              counts ? (
                <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {counts.sent} sent · {counts.pending + counts.sending} pending ·{' '}
                  {counts.failed} failed
                </p>
              ) : null
            }
          >
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {paused ? 'Automation paused' : 'Automation running'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {paused
                    ? 'No new sends start while paused. History and order are kept.'
                    : 'New leads receive the sequence below.'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {paused ? (
                  <Pause className="size-4 text-muted-foreground" aria-hidden />
                ) : (
                  <Play className="size-4 text-muted-foreground" aria-hidden />
                )}
                <Switch
                  checked={!paused}
                  onCheckedChange={(v) => setPaused(!v)}
                  aria-label={paused ? 'Resume automation' : 'Pause automation'}
                  disabled={readOnly}
                />
              </div>
            </div>
          </ConfigSection>
          )}

          <ConfigSection
            title="Timing"
            hint="Delay applied between consecutive messages. 0 sends all templates immediately, still in order."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wa-delay">Delay between messages (seconds)</Label>
              <Input
                id="wa-delay"
                inputMode="numeric"
                value={delay}
                onChange={(e) => setDelay(e.target.value)}
                disabled={readOnly}
                className="max-w-[160px]"
              />
            </div>
          </ConfigSection>

          <ConfigSection
            title={`Send sequence${items.length > 0 ? ` · ${items.length} step${items.length === 1 ? '' : 's'}` : ''}`}
            hint="Templates send top to bottom. Reorder, remap fields, or remove steps at any time."
          >
            {items.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center">
                <p className="text-sm font-medium text-foreground">No templates yet</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                  Pick an approved template below to add the first message of
                  the sequence.
                </p>
              </div>
            ) : (
              <ol className="flex flex-col gap-2">
                {items.map((item, index) => {
                  const slots = slotsFor(item);
                  const rendered = previewBody(
                    bodyFor(item),
                    slots,
                    item.variable_mappings,
                    sample
                  );
                  return (
                    <li
                      key={`${item.template_name}::${item.template_language}`}
                      className="rounded-lg border border-border bg-card px-3 py-2.5"
                    >
                      <div className="flex items-center gap-2.5">
                        <span
                          aria-hidden
                          className="bg-primary text-primary-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums"
                        >
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-foreground">
                            {item.template_name}
                          </p>
                          <p className="text-xs text-muted-foreground">{item.template_language}</p>
                        </div>
                        {readOnly ? null : (
                        <div className="flex shrink-0 items-center gap-0.5">
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
                        )}
                      </div>
                      {slots.length > 0 ? (
                        <div className="space-y-1.5 border-t border-border pt-2">
                      {slots.map((slot) => {
                        const mappedKey = item.variable_mappings[slot.key] ?? '';
                        const mappedLabel =
                          fields.find((f) => f.key === mappedKey)?.label ?? mappedKey;
                        return (
                        <div key={slot.key} className="flex items-center gap-2">
                        <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
                          {slotLabel(slot)}
                        </span>
                        {readOnly ? (
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                            {mappedLabel === '' ? 'Not mapped' : mappedLabel}
                          </span>
                        ) : (
                        <Select
                          value={mappedKey}
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
                        )}
                        </div>
                        );
                      })}
                          <p className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                            Preview: {rendered}
                            {sample ? null : ' (no lead yet — live values fill in per lead)'}
                          </p>
                        </div>
                    ) : (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          Static template — sends as approved, no mapping needed.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
              )}
              {readOnly ? null : (
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
                <Button variant="outline" size="sm" onClick={addPicked} disabled={!pick} className="shrink-0">
                  <Plus className="size-4" aria-hidden /> Add
                </Button>
              </div>
              )}
            </ConfigSection>

            {(counts?.failed ?? 0) > 0 ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
                <span className="min-w-0 text-muted-foreground">
                  {counts?.failed} failed send{(counts?.failed ?? 0) === 1 ? '' : 's'} — fix the
                  cause (template approval, WhatsApp setup, missing values), then retry.
                </span>
                {readOnly ? null : (
                <Button variant="outline" size="sm" onClick={retryFailed} disabled={retrying} className="shrink-0">
                  {retrying ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <RotateCcw className="size-4" aria-hidden />
                  )}
                  Retry
                </Button>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </ConfigDialog>
    );
  }
