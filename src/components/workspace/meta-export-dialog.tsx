'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

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
import type { AssigneeMember } from '@/lib/flows/workspace-assignee';
import { assigneeDisplayName } from '@/lib/flows/workspace-assignee';
import {
  EXPORT_DATE_PRESETS,
  EXPORT_DATE_PRESET_LABELS,
  isExportDatePreset,
  resolveExportDateRange,
  type ExportDatePreset,
} from '@/lib/meta-leads-export/date-presets';
import { ALL_META_LEADS_ID } from '@/lib/workspace/all-meta-leads';

interface MetaExportForm {
  flowId: string;
  tableName: string;
}

interface MetaExportDialogProps {
  tableId: string | null;
  tableName: string;
  isAllView: boolean;
  forms: MetaExportForm[];
  teamMembers: AssigneeMember[];
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function MetaExportButton(props: MetaExportDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9 gap-1.5"
        onClick={() => setOpen(true)}
        aria-label="Export Excel"
        title="Export Excel"
      >
        <Download className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">Export Excel</span>
      </Button>
      {open ? (
        <MetaExportDialog {...props} open={open} onOpenChange={setOpen} />
      ) : null}
    </>
  );
}

function MetaExportDialog(
  props: MetaExportDialogProps & {
    open: boolean;
    onOpenChange: (v: boolean) => void;
  }
) {
  const {
    tableId,
    tableName,
    isAllView,
    forms,
    teamMembers,
    open,
    onOpenChange,
  } = props;
  const [preset, setPreset] = useState<ExportDatePreset>('last30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [formFilter, setFormFilter] = useState<string>('__all');
  const [assignee, setAssignee] = useState<string>('all');
  const [source, setSource] = useState<string>('all');
  const [campaign, setCampaign] = useState<string>('__all');
  const [ad, setAd] = useState<string>('__all');
  const [search, setSearch] = useState('');
  const [campaigns, setCampaigns] = useState<string[]>([]);
  const [ads, setAds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFormFilter('__all');
    setAssignee('all');
    setSource('all');
    setCampaign('__all');
    setAd('__all');
    setSearch('');
    setPreset('last30');
    setCustomFrom('');
    setCustomTo('');
  }, [open, tableId]);

  useEffect(() => {
    if (!open || !tableId) return;
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams({ tableId, options: '1' });
        const res = await fetch(`/api/workspace/meta-export?${qs.toString()}`);
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (!data || cancelled) return;
        if (Array.isArray(data.campaigns))
          setCampaigns(data.campaigns.slice(0, 200));
        if (Array.isArray(data.ads)) setAds(data.ads.slice(0, 200));
      } catch {
        // Best-effort: dropdowns fall back to All-only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tableId]);

  const canExport = useMemo(() => {
    if (!tableId) return false;
    if (preset === 'custom' && (!customFrom || !customTo)) return false;
    return !busy;
  }, [tableId, preset, customFrom, customTo, busy]);

  const clearAll = useCallback(() => {
    setPreset('last30');
    setCustomFrom('');
    setCustomTo('');
    setFormFilter('__all');
    setAssignee('all');
    setSource('all');
    setCampaign('__all');
    setAd('__all');
    setSearch('');
  }, []);

  const handleExport = useCallback(async () => {
    if (!tableId) return;
    if (!isExportDatePreset(preset)) {
      toast.error('Choose a valid date range.');
      return;
    }
    let dateFrom: string | null = null;
    let dateTo: string | null = null;
    try {
      const range = resolveExportDateRange(preset, {
        from: customFrom || null,
        to: customTo || null,
      });
      dateFrom = range?.from ?? null;
      dateTo = range?.to ?? null;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invalid date range.');
      return;
    }
    setBusy(true);
    try {
      const qs = new URLSearchParams({ tableId });
      if (isAllView && formFilter !== '__all') qs.set('formId', formFilter);
      if (dateFrom && dateTo) {
        qs.set('dateFrom', dateFrom);
        qs.set('dateTo', dateTo);
      }
      if (assignee && assignee !== 'all') qs.set('assignee', assignee);
      if (source && source !== 'all') qs.set('source', source);
      if (campaign && campaign !== '__all') qs.set('campaign', campaign);
      if (ad && ad !== '__all') qs.set('ad', ad);
      if (search.trim()) qs.set('search', search.trim().slice(0, 120));
      const res = await fetch(`/api/workspace/meta-export?${qs.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(
          (data as { error?: string } | null)?.error ??
            `Export failed (${res.status}).`
        );
      }
      const blob = await res.blob();
      const dispo = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(dispo);
      const filename = match?.[1] ?? 'Meta_Leads.xlsx';
      downloadBlob(blob, filename);
      toast.success(`Excel downloaded — ${filename}`);
      const unresolved = res.headers.get('X-Export-Unresolved-Assignees');
      if (unresolved) {
        toast.warning(
          `${unresolved} assigned lead(s) reference team members no longer on the roster — shown as Unknown.`
        );
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }, [
    tableId,
    isAllView,
    formFilter,
    assignee,
    source,
    campaign,
    ad,
    search,
    preset,
    customFrom,
    customTo,
    onOpenChange,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        aria-label="Export Excel"
      >
        <DialogHeader>
          <DialogTitle>Export Excel</DialogTitle>
          <DialogDescription>
            {isAllView || tableId === ALL_META_LEADS_ID
              ? `All Meta Leads — one worksheet combining every form. Filters narrow Submission Time and lead attributes.`
              : `${tableName} — exports only this table's leads into one worksheet.`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="meta-export-date">Submission Time</Label>
            <Select
              value={preset}
              onValueChange={(v: string | null) => {
                if (isExportDatePreset(v)) setPreset(v);
              }}
            >
              <SelectTrigger id="meta-export-date" className="h-9">
                <SelectValue placeholder="Date range" />
              </SelectTrigger>
              <SelectContent>
                {EXPORT_DATE_PRESETS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {EXPORT_DATE_PRESET_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {preset === 'custom' ? (
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <Label htmlFor="meta-export-from">From</Label>
                  <Input
                    id="meta-export-from"
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="meta-export-to">To</Label>
                  <Input
                    id="meta-export-to"
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                  />
                </div>
              </div>
            ) : null}
          </div>

          {isAllView ? (
            <div className="grid gap-2">
              <Label htmlFor="meta-export-form">Form</Label>
              <Select
                value={formFilter}
                onValueChange={(v: string | null) => {
                  if (typeof v === 'string') setFormFilter(v);
                }}
              >
                <SelectTrigger id="meta-export-form" className="h-9">
                  <SelectValue placeholder="All forms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">
                    All Forms{forms.length > 0 ? ` (${forms.length})` : ''}
                  </SelectItem>
                  {forms.map((f) => (
                    <SelectItem key={f.flowId} value={f.flowId}>
                      {f.tableName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="meta-export-assignee">Assignment</Label>
              <Select
                value={assignee}
                onValueChange={(v: string | null) => {
                  if (typeof v === 'string') setAssignee(v);
                }}
              >
                <SelectTrigger id="meta-export-assignee" className="h-9">
                  <SelectValue placeholder="All agents" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Agents</SelectItem>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {teamMembers.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {assigneeDisplayName(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="meta-export-source">Lead Source</Label>
              <Select
                value={source}
                onValueChange={(v: string | null) => {
                  if (typeof v === 'string') setSource(v);
                }}
              >
                <SelectTrigger id="meta-export-source" className="h-9">
                  <SelectValue placeholder="All sources" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All (Organic + Paid)</SelectItem>
                  <SelectItem value="organic">Organic</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="meta-export-campaign">Campaign</Label>
              <Select
                value={campaign}
                onValueChange={(v: string | null) => {
                  if (typeof v === 'string') setCampaign(v);
                }}
              >
                <SelectTrigger id="meta-export-campaign" className="h-9">
                  <SelectValue placeholder="All campaigns" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">All Campaigns</SelectItem>
                  {campaigns.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="meta-export-ad">Ad</Label>
              <Select
                value={ad}
                onValueChange={(v: string | null) => {
                  if (typeof v === 'string') setAd(v);
                }}
              >
                <SelectTrigger id="meta-export-ad" className="h-9">
                  <SelectValue placeholder="All ads" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">All Ads</SelectItem>
                  {ads.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="meta-export-search">Search</Label>
            <Input
              id="meta-export-search"
              placeholder="Name, phone, answer…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={120}
            />
          </div>
        </div>

        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearAll}
            disabled={busy}
          >
            Clear All
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleExport}
              disabled={!canExport}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Download className="h-4 w-4" aria-hidden />
              )}
              {busy ? 'Exporting…' : 'Download .xlsx'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
