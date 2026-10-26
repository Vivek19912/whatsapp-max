'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  Table2,
  Trash2,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
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
import { Switch } from '@/components/ui/switch';
import { formatColumnLabel } from '@/lib/flows/column-label';
import { isAssigneeField } from '@/lib/flows/workspace-assignee';
import { META_SOURCE_COLUMN_KEY } from '@/lib/meta-lead-ads/virtual-flow';
import { resolveMetaHeaderDisplayLabel } from '@/lib/meta-lead-ads/header-labels';
import {
  dedupeEquivalentColumns,
  dedupeSheetsColumns,
  defaultSheetsColumns,
  withoutShadowedDynamicColumns,
} from '@/lib/meta-lead-sheets/columns';
import {
  resolveSpreadsheetOpenUrl,
  validateWorksheetTabName,
} from '@/lib/meta-lead-sheets/sheets-client';

interface SheetsColumn {
  key: string;
  label: string;
}

interface ImportJob {
  id: string;
  status: string;
  mode: string;
  range_from: string | null;
  range_to: string | null;
  total: number;
  processed: number;
  sent: number;
  failed: number;
  retrying: number;
  pending: number;
  inserted: number;
  updated: number;
  skipped: number;
  truncated: boolean;
  done: boolean;
  finished_at: string | null;
  last_error: string | null;
}

interface TableSheetsStatus {
  configured: boolean;
  connected: boolean;
  needsReauth: boolean;
  email: string | null;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  spreadsheetTitle: string | null;
  sheetTab: string | null;
  autoSync: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  pending: number;
  failed: number;
  /** Failures scheduled for automatic retry (quota/transient backoff). */
  retrying?: number;
  columns: SheetsColumn[] | null;
  remapPending: boolean;
  cleanupPreview: { managedRows: number };
}

interface TableConfigPayload {
  flow: { id: string; name: string | null };
  form: {
    id: string;
    form_id: string;
    form_name: string | null;
    enabled: boolean;
    question_count: number;
    questions: Array<{ key: string; label: string }>;
  };
  connection: {
    connected: boolean;
    email: string | null;
    needsReauth: boolean;
  };
  configured: boolean;
  standard: SheetsColumn[];
  dynamic: SheetsColumn[];
  selectedColumns: SheetsColumn[] | null;
  /** True when the table has an explicitly saved column selection. */
  hasCustomColumns: boolean;
  status: TableSheetsStatus;
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

interface WorkspaceTableColumn {
  key: string;
  label: string;
  system: boolean;
}

interface WorkspaceCustomField {
  id: string;
  name: string;
}

/**
 * Build Sheets-available columns from the existing Workspace table
 * data source (columns + custom fields + header-label overrides).
 * Uses the exact human-readable labels displayed in Workspace
 * (formatColumnLabel + stored custom header names), preserving
 * Workspace capitalization, spacing, and display order.
 * Identity is stable Sheets keys (`submitted_at`, `name`, `phone`,
 * `source`, `answer:<key>`, `assignee`, `lead_type`, `stage`);
 * labels are display-only, so renaming never affects mapping.
 * Meta Lead ID stays pinned separately (stable lead-ID matching).
 */
function buildWorkspaceAvailableColumns(args: {
  columns: WorkspaceTableColumn[];
  customFields: WorkspaceCustomField[];
  headerLabels: Record<string, string>;
}): SheetsColumn[] {
  const { columns, customFields, headerLabels } = args;
  const out: SheetsColumn[] = [];
  const seen = new Set<string>();
  const push = (key: string, label: string) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ key, label });
  };
  const workspaceLabelFor = (col: WorkspaceTableColumn): string =>
    resolveMetaHeaderDisplayLabel({
      flowKind: 'meta_lead_ads',
      column: col,
      labels: headerLabels,
      formatOriginal: formatColumnLabel,
    });
  for (const col of columns) {
    // Workspace system helpers never sync to Sheets.
    if (col.system && (col.key === 'latest_recording' || col.key === 'status')) {
      continue;
    }
    if (col.system && col.key === 'submission_time') {
      push('submitted_at', workspaceLabelFor(col));
      continue;
    }
    if (col.system && col.key === 'name') {
      push('name', workspaceLabelFor(col));
      continue;
    }
    if (col.system && col.key === 'phone') {
      push('phone', workspaceLabelFor(col));
      continue;
    }
    if (!col.system && col.key === META_SOURCE_COLUMN_KEY) {
      push('source', workspaceLabelFor(col));
      continue;
    }
    if (!col.system) {
      push(`answer:${col.key}`, workspaceLabelFor(col));
      continue;
    }
  }
  // Business columns in Workspace display order: Assigned To first,
  // then Lead Type / Stage, matching the Workspace table's business
  // grouping. Labels use the exact Workspace display text.
  const byName = (n: string) =>
    customFields.find((f) => f.name.trim().toLowerCase() === n);
  const assignee = customFields.find((f) => isAssigneeField(f));
  if (assignee) push('assignee', formatColumnLabel(assignee.name));
  const leadType = byName('lead type');
  if (leadType) push('lead_type', formatColumnLabel(leadType.name));
  const stage = byName('stage');
  if (stage) push('stage', formatColumnLabel(stage.name));
  // Email as a first-class standard field when the Workspace table
  // carries it as a dynamic question: offer the `email` key with the
  // same Workspace display label so existing configs keep working
  // while new selections match what users see. This alias only
  // affects the available list, never values.
  const emailDynamic = out.find((c) => c.key.toLowerCase() === 'answer:email');
  if (emailDynamic && !seen.has('email')) {
    out.push({ key: 'email', label: emailDynamic.label });
  }
  // Drop dynamic twins shadowed by an offered standard counterpart
  // (`Full name` when `Name` is offered, `Phone number` when `Phone`
  // is offered): the standard entry syncs the same underlying
  // Workspace data, so offering both would only produce duplicate
  // headers with identical values. Twins without a counterpart stay.
  return withoutShadowedDynamicColumns(out, out);
}

/**
 * Per-table Google Sheets configuration (Meta Lead Ads tables only).
 * Opened from the Workspace table selector via "Configure Sheet".
 * The flowId key identifies the table; its form, spreadsheet, tab,
 * and columns are all scoped to that table server-side.
 */
export function MetaTableSheetsDialog({
  flowId,
  open,
  onOpenChange,
}: {
  flowId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [payload, setPayload] = useState<TableConfigPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [spreadsheet, setSpreadsheet] = useState('');
  const [tabs, setTabs] = useState<string[] | null>(null);
  const [tab, setTab] = useState('');
  const [tabTouched, setTabTouched] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  // Null until the configuration load decides: a saved selection
  // is applied verbatim (customizations preserved), otherwise every
  // available Workspace header is selected by default, exactly once.
  const [columns, setColumns] = useState<SheetsColumn[] | null>(null);
  const [newTabName, setNewTabName] = useState('');
  // Manual historical import panel state (separate from automatic
  // sync): collapsed by default, reset every time the dialog opens.
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<'all' | 'range'>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [importJob, setImportJob] = useState<ImportJob | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importPolling, setImportPolling] = useState(false);
  // Workspace-derived available headers: exact human-readable labels
  // displayed in the currently selected Workspace table, in Workspace
  // display order. Built from the existing Workspace table data source
  // (`/api/flows/[id]/table` + header-labels), never from raw form
  // questions or normalized keys. Null until loaded; falls back to
  // the table-config payload lists.
  const [workspaceAvailable, setWorkspaceAvailable] = useState<
    SheetsColumn[] | null
  >(null);
  const prefilled = useRef(false);
  const autoTabsDone = useRef(false);

  const readJson = async (res: Response) => {
    const json = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!res.ok) {
      throw new Error(
        typeof json.error === 'string'
          ? json.error
          : `Request failed (${res.status})`
      );
    }
    return json;
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const json = (await readJson(
        await fetch(
          `/api/integrations/meta-lead-ads/sheets/tables/${encodeURIComponent(flowId)}/config`,
          { cache: 'no-store' }
        )
      )) as unknown as TableConfigPayload;
      setPayload(json);
      // Best-effort Workspace headers: exact display labels + order
      // from the currently selected table. Never blocks the config.
      // Captured locally so the first-time default below can use
      // the Workspace order even before state settles.
      let workspaceHeaders: SheetsColumn[] | null = null;
      try {
        const [tableRes, labelsRes] = await Promise.all([
          fetch(`/api/flows/${encodeURIComponent(flowId)}/table?view=all&page=0&pageSize=1`, {
            cache: 'no-store',
          }),
          fetch(
            `/api/integrations/meta-lead-ads/flows/${encodeURIComponent(flowId)}/header-labels`,
            { cache: 'no-store' }
          ),
        ]);
        if (tableRes.ok) {
          const tableJson = (await tableRes.json().catch(() => null)) as {
            columns?: WorkspaceTableColumn[];
            customFields?: WorkspaceCustomField[];
            meta?: { kind?: string | null };
          } | null;
          let headerLabels: Record<string, string> = {};
          if (labelsRes.ok) {
            const lj = (await labelsRes.json().catch(() => null)) as {
              labels?: Record<string, string>;
            } | null;
            if (lj && typeof lj.labels === 'object' && lj.labels) {
              headerLabels = lj.labels as Record<string, string>;
            }
          }
          if (
            tableJson &&
            tableJson.meta?.kind === 'meta_lead_ads' &&
            Array.isArray(tableJson.columns)
          ) {
            const scopedCustom = (tableJson.customFields ?? []).filter((f) => {
              const n = (f.name ?? '').trim().toLowerCase();
              // Mirror the Workspace table: drop the derived
              // "Lead Received" duplicate for Meta tables.
              return n !== 'lead received';
            });
            const built = buildWorkspaceAvailableColumns({
              columns: tableJson.columns,
              customFields: scopedCustom,
              headerLabels,
            });
            if (built.length > 0) {
              setWorkspaceAvailable(built);
              workspaceHeaders = built;
            }
          }
        }
      } catch {
        // Non-fatal: fall back to the config payload lists below.
      }
      if (!prefilled.current) {
        prefilled.current = true;
        const status = json.status;
        const url = (status.spreadsheetUrl ?? status.spreadsheetId ?? '') as string;
        if (url) {
          setSpreadsheet(url);
        }
        if (status.sheetTab) {
          setTab(status.sheetTab);
          setTabTouched(true);
        }
        setAutoSync(status.autoSync);
        // An explicitly saved selection is applied verbatim —
        // existing user customizations are never silently replaced
        // (even an ID-first order the user chose stays until they
        // reorder it). Anything else — new configurations and
        // legacy rows that predate column selection — defaults to
        // every available Workspace header, in table order, with
        // the Meta Lead ID last, exactly once.
        const saved =
          json.hasCustomColumns ? (json.selectedColumns ?? null) : null;
        if (saved && saved.length > 0) {
          setColumns(dedupeSheetsColumns(saved));
        } else {
          setColumns(
            defaultSheetsColumns({
              workspace: workspaceHeaders ?? [],
              standard: json.standard,
              dynamic: json.dynamic,
            })
          );
        }
        // Fresh table with a spreadsheet but no saved tab yet: list
        // tabs once so the first existing (leftmost) tab becomes the
        // default without an extra click.
        if (url && !status.sheetTab && !autoTabsDone.current) {
          autoTabsDone.current = true;
          try {
            const tabsJson = (await readJson(
              await fetch(
                `/api/integrations/meta-lead-ads/sheets/tabs?spreadsheet_id=${encodeURIComponent(url.trim())}`,
                { cache: 'no-store' }
              )
            )) as unknown as { tabs: string[]; title: string };
            setTabs(tabsJson.tabs);
            if (tabsJson.tabs.length > 0) {
              setTab(tabsJson.tabs[0] as string);
            } else {
              toast.error('This spreadsheet has no usable worksheet tab.');
            }
          } catch (err) {
            // Non-fatal: the user can still load tabs manually.
            toast.error(
              err instanceof Error ? err.message : 'Could not list worksheet tabs.'
            );
          }
        }
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : 'Failed to load sheet configuration.'
      );
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId]);

  useEffect(() => {
    if (open) {
      prefilled.current = false;
      autoTabsDone.current = false;
      setTabs(null);
      setTabTouched(false);
      setWorkspaceAvailable(null);
      setColumns(null);
      setNewTabName('');
      setImportOpen(false);
      setImportMode('all');
      setDateFrom('');
      setDateTo('');
      setImportJob(null);
      setImportError(null);
      setImportPolling(false);
      void load();
    }
  }, [open, load]);

  async function loadTabs(spreadsheetInput: string) {
    if (!spreadsheetInput.trim()) {
      toast.error('Paste a spreadsheet URL or ID first.');
      return;
    }
    await act('tabs', async () => {
      const json = (await readJson(
        await fetch(
          `/api/integrations/meta-lead-ads/sheets/tabs?spreadsheet_id=${encodeURIComponent(spreadsheetInput.trim())}`,
          { cache: 'no-store' }
        )
      )) as unknown as { tabs: string[]; title: string };
      setTabs(json.tabs);
      // Default to the first existing (leftmost) tab when the user
      // has not picked one yet.
      if (!tabTouched && !tab) {
        if (json.tabs.length > 0) setTab(json.tabs[0] as string);
        else toast.error('This spreadsheet has no usable worksheet tab.');
      }
      if (json.tabs.length === 0) {
        toast.error('This spreadsheet has no usable worksheet tab.');
      }
    });
  }

  /**
   * Create one Google Spreadsheet in the connected account for this
   * table, then populate the URL field and select its first tab.
   * Configuration, columns, and sync controls are untouched, and no
   * sync starts — the user still saves explicitly afterwards.
   */
  function createSpreadsheet() {
    void act('createsheet', async () => {
      const json = (await readJson(
        await fetch('/api/integrations/meta-lead-ads/sheets/spreadsheets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ flow_id: flowId }),
        })
      )) as unknown as {
        spreadsheet_id: string;
        url: string;
        title: string;
        tabs: string[];
      };
      // Populate the URL field from the response (fall back to the
      // bare id when Google omits the URL). Coerce defensively: a
      // malformed success payload must never blank the field into
      // an uncontrolled input or crash the tab selector below.
      const createdUrl =
        typeof json.url === 'string' && json.url.trim() !== ''
          ? json.url
          : typeof json.spreadsheet_id === 'string'
            ? json.spreadsheet_id
            : '';
      const createdTabs = Array.isArray(json.tabs)
        ? (json.tabs as unknown[]).filter(
            (t): t is string => typeof t === 'string' && t !== ''
          )
        : [];
      const createdTitle =
        typeof json.title === 'string' && json.title.trim() !== ''
          ? json.title
          : 'Spreadsheet';
      setSpreadsheet(createdUrl);
      setTabs(createdTabs);
      if (createdTabs.length > 0) {
        setTab(createdTabs[0] as string);
        setTabTouched(true);
      } else {
        setTab('');
        setTabTouched(false);
      }
      toast.success(`Spreadsheet "${createdTitle}" created — review and save.`);
    });
  }

  /** Create one worksheet tab now, refresh tabs, select it. */
  function createNewTab() {
    if (!spreadsheet.trim()) {
      toast.error('Paste a spreadsheet URL or ID first.');
      return;
    }
    const name = validateWorksheetTabName(newTabName);
    if ('error' in name) {
      toast.error(name.error);
      return;
    }
    // Google treats tab titles case-insensitively — reject a
    // duplicate without a round trip when the live list shows it.
    if ((tabs ?? []).some((t) => t.toLowerCase() === name.tab.toLowerCase())) {
      toast.error(`A worksheet tab named "${name.tab}" already exists.`);
      return;
    }
    void act('createtab', async () => {
      const json = (await readJson(
        await fetch('/api/integrations/meta-lead-ads/sheets/tabs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            flow_id: flowId,
            spreadsheet_url: spreadsheet.trim(),
            tab: name.tab,
          }),
        })
      )) as unknown as { tab: string; tabs: string[] };
      setTabs(json.tabs);
      setTab(json.tab);
      setTabTouched(true);
      setNewTabName('');
      toast.success(`Worksheet tab "${json.tab}" created and selected.`);
    });
  }

  /**
   * Delete exactly the selected worksheet tab after an explicit
   * confirmation. Only that tab is removed — the spreadsheet,
   * every other tab, and all table configurations are untouched.
   * Never called automatically by configuration or sync.
   */
  function deleteSelectedTab() {
    const name = tab.trim();
    if (!spreadsheet.trim()) {
      toast.error('Paste a spreadsheet URL or ID first.');
      return;
    }
    if (!name) {
      toast.error('Select a worksheet tab to delete.');
      return;
    }
    if (
      !window.confirm(
        `Delete worksheet tab "${name}"? Only this tab and its contents are removed — the spreadsheet and every other tab stay untouched. This cannot be undone.`
      )
    ) {
      return;
    }
    void act('deletetab', async () => {
      const json = (await readJson(
        await fetch(
          `/api/integrations/meta-lead-ads/sheets/tabs?spreadsheet_id=${encodeURIComponent(spreadsheet.trim())}&tab=${encodeURIComponent(name)}&flow_id=${encodeURIComponent(flowId)}`,
          { method: 'DELETE', cache: 'no-store' }
        )
      )) as unknown as { deleted: string; tabs: string[] };
      setTabs(json.tabs);
      // Clear the selection only when the deleted tab was selected.
      if (tab.trim() === json.deleted) {
        setTab('');
        setTabTouched(false);
      }
      toast.success(`Worksheet tab "${json.deleted}" deleted.`);
    });
  }

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  const columnKeys = new Set((columns ?? []).map((c) => c.key));

  function addColumn(col: SheetsColumn) {
    setColumns((current) => {
      const next = [...(current ?? [])];
      if (next.some((c) => c.key === col.key)) return next;
      next.push({ ...col });
      return next;
    });
  }

  function removeColumn(key: string) {
    setColumns((current) => (current ?? []).filter((c) => c.key !== key));
  }

  function moveColumn(key: string, direction: -1 | 1) {
    setColumns((current) => {
      const next = [...(current ?? [])];
      const idx = next.findIndex((c) => c.key === key);
      const swap = idx + direction;
      if (idx < 0 || swap < 0 || swap >= next.length) return next;
      [next[idx], next[swap]] = [next[swap]!, next[idx]!];
      return next;
    });
  }

  function renameColumn(key: string, label: string) {
    setColumns((current) =>
      (current ?? []).map((c) => (c.key === key ? { ...c, label } : c))
    );
  }

  function save() {
    if (!spreadsheet.trim()) {
      toast.error('Paste a Google Sheets URL or spreadsheet ID.');
      return;
    }
    if (!columns || columns.length === 0) {
      toast.error('Select at least one spreadsheet column.');
      return;
    }
    if (!tab.trim()) {
      toast.error('Select a worksheet tab (load the tabs first).');
      return;
    }
    void act('save', async () => {
      // Normalize to unique underlying fields in order: one
      // Workspace header can never be saved (or synced) twice, and
      // a dynamic twin (`Full name`) collapses into its standard
      // counterpart (`Name`) which syncs the same values. The
      // server re-validates and rejects duplicates with a clear
      // error as a backstop.
      const uniqueColumns = dedupeEquivalentColumns(
        dedupeSheetsColumns(columns)
      );
      const json = (await readJson(
        await fetch(
          `/api/integrations/meta-lead-ads/sheets/tables/${encodeURIComponent(flowId)}/config`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              spreadsheet_url: spreadsheet.trim(),
              sheet_tab: tab.trim(),
              // Tabs are never created implicitly: the tab must
              // already exist or be created via Create tab above.
              create_tab: false,
              auto_sync: autoSync,
              columns: uniqueColumns,
            }),
          }
        )
      )) as {
        ok: boolean;
        status: TableSheetsStatus;
        backfill?: { enqueued: number } | null;
        drain?: { sent: number; failed: number } | null;
        reseeded?: number | null;
        remap?: { done: boolean; remapped: number; skipped: number } | null;
      };
      prefilled.current = true;
      const parts: string[] = [];
      if (json.backfill && json.backfill.enqueued > 0) {
        parts.push(`queued ${json.backfill.enqueued} existing leads`);
      }
      if (typeof json.reseeded === 'number' && json.reseeded > 0) {
        parts.push(`reseeded ${json.reseeded} leads into the spreadsheet`);
      }
      if (json.remap && !json.remap.done) {
        parts.push('column rollout continues automatically');
      } else if (json.remap && json.remap.remapped > 0) {
        parts.push(
          `rewrote ${json.remap.remapped} existing rows to the new columns`
        );
      }
      toast.success(
        parts.length > 0
          ? `Configuration saved (${parts.join('; ')}).`
          : 'Configuration saved. New and updated leads will sync automatically.'
      );
      // Success closes the dialog (fresh config + status load on
      // next open). Failures and validation errors return before
      // this point, so the dialog stays open with the error shown.
      onOpenChange(false);
    });
  }

  /**
   * Manual historical import for this table only (separate from
   * automatic sync, which only handles new + updated leads). The
   * server starts a durable import job and runs a single bounded
   * worker pass, then returns immediately with the job — long
   * imports complete in the background (prompt drain + cron) while
   * the dialog polls job status. Matching downstream is by stable
   * Meta Lead ID, so existing rows update instead of duplicating
   * and resuming never re-appends synced rows.
   */
  function startImport() {
    if (importMode === 'range' && (!dateFrom || !dateTo)) {
      toast.error('Select a start and end date to import.');
      return;
    }
    if (importMode === 'range' && dateFrom > dateTo) {
      toast.error('The start date must be on or before the end date.');
      return;
    }
    void act('import', async () => {
      try {
        setImportJob(null);
        setImportError(null);
        const res = await fetch(
          `/api/integrations/meta-lead-ads/sheets/tables/${encodeURIComponent(flowId)}/import`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
              importMode === 'range'
                ? { mode: 'range', from: dateFrom, to: dateTo }
                : { mode: 'all' }
            ),
          }
        );
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          job?: ImportJob;
          jobId?: string;
          error?: string;
        };
        if (!res.ok) {
          // An already-running import is adopted, not an error: pick
          // up its live progress instead of starting a duplicate.
          if (res.status === 409 && typeof json.jobId === 'string' && json.jobId !== '') {
            toast('An import is already running for this table — showing its progress.');
            await refreshImportJob(json.jobId);
            return;
          }
          throw new Error(
            typeof json.error === 'string' ? json.error : `Request failed (${res.status})`
          );
        }
        if (!json.job) throw new Error('Import did not return a job.');
        setImportJob(json.job);
        toast.success(
          json.job.total > 0
            ? `Import started: ${json.job.total} lead${json.job.total === 1 ? '' : 's'} queued.`
            : 'Import started: nothing new to import.'
        );
        await load();
      } catch (err) {
        // A failed start shows here (not the generic toast path
        // alone) so the user can fix the cause and retry.
        setImportError(err instanceof Error ? err.message : 'Import failed.');
        throw err;
      }
    });
  }

  /** Fetch one job's status (pure read — never restarts work). */
  async function refreshImportJob(jobId: string): Promise<boolean> {
    try {
      const res = await fetch(
        `/api/integrations/meta-lead-ads/sheets/tables/${encodeURIComponent(flowId)}/import/jobs/${encodeURIComponent(jobId)}`,
        { cache: 'no-store' }
      );
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        job?: ImportJob;
        error?: string;
      };
      if (!res.ok) {
        setImportError(
          typeof json.error === 'string' ? json.error : `Request failed (${res.status})`
        );
        return true;
      }
      if (!json.job) return true;
      setImportJob(json.job);
      if (json.job.last_error) setImportError(json.job.last_error);
      return json.job.done;
    } catch {
      // Polling blips (offline, restart) must never kill the job
      // view: the next tick retries.
      return false;
    }
  }

  // Poll an active job's progress until it completes. The GET is a
  // pure read — polls can never duplicate work or restart the job.
  const activeImportJobId = importJob && !importJob.done ? importJob.id : null;
  useEffect(() => {
    if (!open || !activeImportJobId) {
      setImportPolling(false);
      return;
    }
    let cancelled = false;
    setImportPolling(true);
    const tick = async () => {
      const done = await refreshImportJob(activeImportJobId);
      if (!cancelled && done) setImportPolling(false);
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // refreshImportJob is stable (no state captured except setters).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeImportJobId, flowId]);

  /** Resume a stalled job with one bounded worker pass (no duplicates). */
  function resumeImport(reviveFailures: boolean) {
    if (!importJob) return;
    const jobId = importJob.id;
    void act('import-resume', async () => {
      try {
        const res = await fetch(
          `/api/integrations/meta-lead-ads/sheets/tables/${encodeURIComponent(flowId)}/import/jobs/${encodeURIComponent(jobId)}/resume`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ revive_failures: reviveFailures }),
          }
        );
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          claimed?: boolean;
          revived?: number;
          job?: ImportJob;
          error?: string;
        };
        if (!res.ok || !json.job) {
          throw new Error(
            typeof json.error === 'string' ? json.error : `Request failed (${res.status})`
          );
        }
        setImportError(null);
        setImportJob(json.job);
        toast.success(
          (json.revived ?? 0) > 0
            ? `Retrying ${json.revived} failed lead${json.revived === 1 ? '' : 's'}.`
            : 'Import resumed.'
        );
        await load();
      } catch (err) {
        setImportError(err instanceof Error ? err.message : 'Resume failed.');
        throw err;
      }
    });
  }

  function cancelImport() {
    if (!importJob) return;
    const jobId = importJob.id;
    void act('import-cancel', async () => {
      try {
        const res = await fetch(
          `/api/integrations/meta-lead-ads/sheets/tables/${encodeURIComponent(flowId)}/import/jobs/${encodeURIComponent(jobId)}/cancel`,
          { method: 'POST' }
        );
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          job?: ImportJob;
          error?: string;
        };
        if (!res.ok || !json.job) {
          throw new Error(
            typeof json.error === 'string' ? json.error : `Request failed (${res.status})`
          );
        }
        setImportJob(json.job);
        toast('Import cancelled.');
        await load();
      } catch (err) {
        setImportError(err instanceof Error ? err.message : 'Cancel failed.');
        throw err;
      }
    });
  }

  /**
   * Safe retry for this table's failed syncs: revives every failed
   * queue row (fresh attempt budget, due immediately) and drains.
   * Already-synced rows are never touched server-side, so this
   * cannot duplicate spreadsheet rows.
   */
  function retryFailed() {
    void act('retry-failed', async () => {
      try {
        const json = (await readJson(
          await fetch(
            `/api/integrations/meta-lead-ads/sheets/tables/${encodeURIComponent(flowId)}/retry`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ revive_failed: true }),
            }
          )
        )) as {
          ok: boolean;
          revived?: number;
          sent?: number;
          failed?: number;
          retrying?: number;
        };
        const parts: string[] = [];
        if ((json.revived ?? 0) > 0) parts.push(`requeued ${json.revived}`);
        parts.push(
          `${json.sent ?? 0} synced${(json.retrying ?? 0) > 0 ? `, ${json.retrying} still retrying` : ''}${(json.failed ?? 0) > 0 ? `, ${json.failed} failed` : ''}`
        );
        toast.success(`Retry queued (${parts.join('; ')}).`);
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Retry failed.');
        throw err;
      }
    });
  }

  function cleanupTable() {
    const n = payload?.status.cleanupPreview.managedRows ?? 0;
    if (n === 0) {
      toast('No managed rows from this table remain in the sheet.');
      return;
    }
    if (
      !window.confirm(
        `Delete ${n} spreadsheet row${n === 1 ? '' : 's'} synced from “${payload?.form.form_name ?? 'this table'}”? ` +
          'Only rows WhatsApp Max previously wrote (verified by stable lead ID) are removed. ' +
          'Your own content is never touched.'
      )
    ) {
      return;
    }
    void act('cleanup', async () => {
      const json = (await readJson(
        await fetch(
          `/api/integrations/meta-lead-ads/sheets/tables/${encodeURIComponent(flowId)}/cleanup`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirmed: true }),
          }
        )
      )) as { ok: boolean; removed: number; skippedUnmapped: number };
      toast.success(
        `Removed ${json.removed} row${json.removed === 1 ? '' : 's'} for this table.` +
          (json.skippedUnmapped > 0
            ? ` ${json.skippedUnmapped} row(s) without a verified mapping were left alone.`
            : '')
      );
      await load();
    });
  }

  const status = payload?.status ?? null;
  const managedRows = status?.cleanupPreview.managedRows ?? 0;
  // The SAVED spreadsheet URL for the open-spreadsheet action —
  // never the editable text field above (unsaved input must not
  // leak into another tab). Null until a spreadsheet is saved.
  const savedSpreadsheetUrl = resolveSpreadsheetOpenUrl({
    spreadsheetUrl: status?.spreadsheetUrl ?? null,
    spreadsheetId: status?.spreadsheetId ?? null,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Table2 className="size-4" /> Configure Google Sheet
          </DialogTitle>
          <DialogDescription>
            {payload ? (
              <>
                Table “
                {payload.form.form_name ??
                  payload.flow.name ??
                  payload.form.form_id}
                ”
                {payload.form.enabled
                  ? ''
                  : ' (form disabled — historical leads still sync)'}
                . Syncs only this table&apos;s leads into its own spreadsheet,
                tab, and columns.
              </>
            ) : (
              "Sync this table's leads into its own spreadsheet, tab, and columns."
            )}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : !payload ? (
          <p className="text-destructive text-sm" role="alert">
            Could not load this table&apos;s sheet configuration.
          </p>
        ) : !payload.connection.connected ? (
          <p className="text-muted-foreground text-sm">
            Connect a Google account first in Settings → Google Sheets — Meta
            Lead Ads, then configure this table here.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="secondary">
                <CheckCircle2 className="mr-1 size-3" />{' '}
                {payload.connection.email ?? 'Connected'}
              </Badge>
              {payload.connection.needsReauth ? (
                <Badge variant="destructive">Needs reconnect</Badge>
              ) : null}
              {status?.remapPending ? (
                <Badge variant="outline">Column rollout in progress</Badge>
              ) : null}
              <span className="text-muted-foreground">
                Last success: {fmt(status?.lastSuccessAt ?? null)} · Pending:{' '}
                {status?.pending ?? 0}
                {(status?.retrying ?? 0) > 0 ? (
                  <> · Retrying: {status?.retrying ?? 0}</>
                ) : null}{' '}
                · Failed: {status?.failed ?? 0}
              </span>
              {(status?.failed ?? 0) > 0 || (status?.retrying ?? 0) > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={retryFailed}
                  disabled={busy === 'retry-failed'}
                  title="Requeue failed syncs for this table (already-synced rows are never duplicated)"
                >
                  {busy === 'retry-failed' ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="size-3.5" />
                  )}
                  Retry failed
                </Button>
              ) : null}
            </div>
            {status?.lastError ? (
              <p className="text-destructive flex items-start gap-2 text-xs">
                <XCircle className="mt-0.5 size-3.5 shrink-0" />{' '}
                {status.lastError}
              </p>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="meta-table-sheets-url">
                  Spreadsheet URL or ID
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="meta-table-sheets-url"
                    placeholder="https://docs.google.com/spreadsheets/d/…"
                    value={spreadsheet}
                    onChange={(e) => setSpreadsheet(e.target.value)}
                    className="min-w-0 flex-1"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label="Open Spreadsheet"
                    title={
                      savedSpreadsheetUrl
                        ? 'Open the saved spreadsheet in a new tab'
                        : 'Save a spreadsheet URL first'
                    }
                    disabled={!savedSpreadsheetUrl}
                    onClick={() => {
                      if (savedSpreadsheetUrl) {
                        window.open(
                          savedSpreadsheetUrl,
                          '_blank',
                          'noopener,noreferrer'
                        );
                      }
                    }}
                  >
                    <ExternalLink className="size-4" />
                  </Button>
                </div>
                <p className="text-muted-foreground mt-1 text-xs">
                  Your Google account needs Editor access. The sheet stays
                  private.
                </p>
                <div className="mt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={createSpreadsheet}
                    disabled={busy === 'createsheet'}
                  >
                    {busy === 'createsheet' ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Plus className="size-3.5" />
                    )}
                    Create Spreadsheet
                  </Button>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Creates “Meta Leads - [this table]” in your connected
                    Google account and fills the field above. Nothing
                    syncs until you save.
                  </p>
                </div>
              </div>
              <div>
                <Label htmlFor="meta-table-sheets-tab">Worksheet tab</Label>
                <div className="flex items-center gap-2">
                  {tabs === null ? (
                    <Input
                      id="meta-table-sheets-tab"
                      placeholder="Load tabs first…"
                      value={tab}
                      onChange={(e) => {
                        setTab(e.target.value);
                        setTabTouched(true);
                      }}
                      className="min-w-0 flex-1"
                    />
                  ) : tabs.length === 0 ? (
                    <Input
                      id="meta-table-sheets-tab"
                      placeholder="New tab name…"
                      value={tab}
                      onChange={(e) => {
                        setTab(e.target.value);
                        setTabTouched(true);
                      }}
                      className="min-w-0 flex-1"
                    />
                  ) : (
                    <select
                      id="meta-table-sheets-tab"
                      className="border-input bg-card h-9 min-w-0 flex-1 rounded-md border px-3 text-sm"
                      value={tabTouched || tab ? tab : (tabs[0] as string)}
                      onChange={(e) => {
                        setTab(e.target.value);
                        setTabTouched(true);
                      }}
                    >
                      {tabs.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button
                    variant="outline"
                    className="shrink-0"
                    aria-label="Load worksheet tabs"
                    onClick={() => loadTabs(spreadsheet)}
                    disabled={busy === 'tabs'}
                  >
                    {busy === 'tabs' ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      'Load tabs'
                    )}
                  </Button>
                </div>
                <p className="text-muted-foreground mt-1 text-xs">
                  Defaults to the first existing tab. Missing tabs are never
                  created or substituted silently — pick an existing tab.
                </p>
                {tab &&
                tabs !== null &&
                tabs.length > 0 &&
                !tabs.includes(tab) ? (
                  <p className="text-destructive mt-1 text-xs" role="alert">
                    The saved tab “{tab}” was renamed or deleted. Select a
                    replacement — saving writes only to the tab you pick.
                  </p>
                ) : null}
                {tabs !== null && tabs.length > 0 && tab.trim() ? (
                  <div className="mt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={deleteSelectedTab}
                      disabled={busy === 'deletetab'}
                      aria-label={`Delete worksheet tab ${tab.trim()}`}
                    >
                      {busy === 'deletetab' ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                      Delete tab
                    </Button>
                    <p className="text-muted-foreground mt-1 text-xs">
                      Deletes only this tab after confirmation — the
                      spreadsheet and other tabs are never touched.
                    </p>
                  </div>
                ) : null}
                <div className="mt-2">
                  <Label htmlFor="meta-table-sheets-new-tab">
                    Create a new worksheet tab
                  </Label>
                  <div className="mt-1 flex gap-2">
                    <Input
                      id="meta-table-sheets-new-tab"
                      placeholder="New tab name…"
                      value={newTabName}
                      onChange={(e) => setNewTabName(e.target.value)}
                      className="min-w-0 flex-1"
                    />
                    <Button
                      variant="outline"
                      onClick={createNewTab}
                      disabled={busy === 'createtab' || !newTabName.trim()}
                    >
                      {busy === 'createtab' ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Plus className="size-4" />
                      )}
                      Create tab
                    </Button>
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Created inside the spreadsheet above, then selected
                    automatically. Existing tabs are never modified.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <Label className="mb-2 block text-sm font-medium">
                Columns for this table
              </Label>
              <div className="grid gap-3 lg:grid-cols-2">
                <div>
                  <p className="text-muted-foreground mb-1 text-xs font-medium">
                    Selected columns (in sheet order)
                  </p>
                  {(columns ?? []).length === 0 ? (
                    <p className="border-border text-muted-foreground rounded-md border border-dashed p-3 text-xs">
                      No columns selected — add columns from the available list.
                    </p>
                  ) : (
                    <div className="border-border max-h-64 space-y-1.5 overflow-y-auto rounded-md border p-2">
                      {(columns ?? []).map((col, idx) => (
                        <div
                          key={col.key}
                          className="bg-muted/50 flex items-center gap-1.5 rounded px-2 py-1.5"
                        >
                          <span className="text-muted-foreground w-6 shrink-0 text-center text-xs">
                            {idx + 1}
                          </span>
                          <Input
                            value={col.label}
                            onChange={(e) =>
                              renameColumn(col.key, e.target.value)
                            }
                            className="h-7 text-xs"
                            aria-label={`Label for ${col.key}`}
                          />
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={idx === 0}
                            onClick={() => moveColumn(col.key, -1)}
                            aria-label="Move up"
                          >
                            <ArrowUp className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={idx === (columns?.length ?? 0) - 1}
                            onClick={() => moveColumn(col.key, 1)}
                            aria-label="Move down"
                          >
                            <ArrowDown className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => removeColumn(col.key)}
                            aria-label="Remove column"
                          >
                            <Minus className="size-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <p className="text-muted-foreground mb-1 text-xs font-medium">
                    Available columns
                  </p>
                  <div className="border-border max-h-64 space-y-3 overflow-y-auto rounded-md border p-2">
                    {workspaceAvailable && workspaceAvailable.length > 0 ? (
                      <div>
                        <p className="text-muted-foreground mb-1 text-[11px] tracking-wide uppercase">
                          This table&apos;s Workspace columns (in table order)
                        </p>
                        {workspaceAvailable
                          .filter((c) => !columnKeys.has(c.key))
                          .map((c) => (
                            <button
                              key={c.key}
                              type="button"
                              onClick={() =>
                                addColumn({ key: c.key, label: c.label })
                              }
                              className="hover:bg-muted border-border mr-1.5 mb-1.5 inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs"
                            >
                              <Plus className="size-3" /> {c.label}
                            </button>
                          ))}
                        {workspaceAvailable.filter(
                          (c) => !columnKeys.has(c.key)
                        ).length === 0 ? (
                          <p className="text-muted-foreground text-xs">
                            All Workspace columns are selected.
                          </p>
                        ) : null}
                        <p className="text-muted-foreground mt-1 text-[11px]">
                          Labels match the Workspace table exactly. Extra
                          table-config fields (Form Name, Campaign, Ad) remain
                          available below.
                        </p>
                      </div>
                    ) : null}
                    <div>
                      <p className="text-muted-foreground mb-1 text-[11px] tracking-wide uppercase">
                        Standard lead fields
                      </p>
                      {payload.standard
                        .filter((s) => !columnKeys.has(s.key))
                        .map((s) => {
                          const wsMatch = workspaceAvailable?.find(
                            (w) => w.key === s.key
                          );
                          const label = wsMatch ? wsMatch.label : s.label;
                          return (
                            <button
                              key={s.key}
                              type="button"
                              onClick={() =>
                                addColumn({ key: s.key, label })
                              }
                              className="hover:bg-muted border-border mr-1.5 mb-1.5 inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs"
                            >
                              <Plus className="size-3" /> {label}
                            </button>
                          );
                        })}
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-1 text-[11px] tracking-wide uppercase">
                        This form&apos;s answers
                      </p>
                      {withoutShadowedDynamicColumns(
                        payload.dynamic,
                        payload.standard
                      ).length === 0 && payload.dynamic.length > 0 ? (
                        <p className="text-muted-foreground text-xs">
                          Remaining answer fields duplicate the standard
                          fields above (same data, same values).
                        </p>
                      ) : null}
                      {payload.dynamic.length === 0 ? (
                        <p className="text-muted-foreground text-xs">
                          This form has no extra answer fields.
                        </p>
                      ) : (
                        withoutShadowedDynamicColumns(
                          payload.dynamic,
                          payload.standard
                        )
                          .filter((d) => !columnKeys.has(d.key))
                          .map((d) => {
                            const wsMatch = workspaceAvailable?.find(
                              (w) => w.key === d.key
                            );
                            const label = wsMatch ? wsMatch.label : d.label;
                            return (
                              <button
                                key={d.key}
                                type="button"
                                onClick={() =>
                                  addColumn({ key: d.key, label })
                                }
                                className="hover:bg-muted border-border mr-1.5 mb-1.5 inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs"
                              >
                                <Plus className="size-3" /> {label}
                              </button>
                            );
                          })
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <label className="flex w-fit items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={autoSync}
                onCheckedChange={setAutoSync}
                aria-label="Enable automatic sync"
              />
              Automatic sync for new + updated leads
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={save} disabled={busy === 'save'}>
                {busy === 'save' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                Save Configuration
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setImportJob(null);
                  setImportError(null);
                  setImportOpen((v) => !v);
                }}
              >
                <Download className="size-4" />
                Import Leads
              </Button>
            </div>

            {importOpen ? (
              <div
                className="rounded-md border border-border p-3"
                aria-label="Import leads options"
              >
                <p className="text-sm font-medium">
                  Import existing leads into this table&apos;s sheet
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  Existing rows match by Meta Lead ID and update in
                  place — nothing is duplicated, and Workspace leads
                  are never modified.
                </p>
                <div className="mt-2 grid gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="sheets-import-mode"
                      checked={importMode === 'all'}
                      onChange={() => setImportMode('all')}
                      disabled={busy === 'import'}
                    />
                    Import All Leads
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="sheets-import-mode"
                      checked={importMode === 'range'}
                      onChange={() => setImportMode('range')}
                      disabled={busy === 'import'}
                    />
                    Import Leads by Date Range
                  </label>
                  {importMode === 'range' ? (
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="grid gap-1">
                        <Label htmlFor="sheets-import-from">Start date</Label>
                        <Input
                          id="sheets-import-from"
                          type="date"
                          value={dateFrom}
                          max={dateTo || undefined}
                          onChange={(e) => setDateFrom(e.target.value)}
                          disabled={busy === 'import'}
                          className="w-40"
                        />
                      </div>
                      <div className="grid gap-1">
                        <Label htmlFor="sheets-import-to">End date</Label>
                        <Input
                          id="sheets-import-to"
                          type="date"
                          value={dateTo}
                          min={dateFrom || undefined}
                          onChange={(e) => setDateTo(e.target.value)}
                          disabled={busy === 'import'}
                          className="w-40"
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
                {busy === 'import' && !importJob ? (
                  <p
                    className="text-muted-foreground mt-2 flex items-center gap-2 text-sm"
                    role="status"
                  >
                    <Loader2 className="size-4 animate-spin" />
                    Importing leads…
                  </p>
                ) : null}
                {importJob && !importJob.done ? (
                  <div className="mt-2 space-y-1.5" role="status" aria-label="Import progress">
                    <p className="flex items-center gap-2 text-sm text-foreground">
                      <Loader2 className="size-4 animate-spin" />
                      Importing leads… {importJob.processed} of {importJob.total}
                    </p>
                    <div
                      className="bg-muted h-2 w-full overflow-hidden rounded-full"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={Math.max(importJob.total, 1)}
                      aria-valuenow={importJob.processed}
                    >
                      <div
                        className="bg-primary h-full transition-all"
                        style={{
                          width: `${importJob.total > 0 ? Math.round((importJob.processed / importJob.total) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {importJob.sent} synced
                      {importJob.retrying > 0 ? ` · ${importJob.retrying} retrying` : ''}
                      {importJob.pending > 0 ? ` · ${importJob.pending} pending` : ''}
                      {importPolling ? ' · updating…' : ''}
                    </p>
                  </div>
                ) : null}
                {importError && (!importJob || importJob.done) ? (
                  <p className="text-destructive mt-2 text-xs" role="alert">
                    {importError}
                  </p>
                ) : null}
                {importJob?.done ? (
                  <div className="mt-2 space-y-1.5" role="status">
                    <p className="text-xs text-green-600">
                      Import finished: {importJob.inserted} imported,{' '}
                      {importJob.updated} updated, {importJob.skipped}{' '}
                      skipped, {importJob.failed} failed
                      {importJob.truncated ? ' (list truncated — repeat for the rest)' : '.'}
                    </p>
                    {importJob.retrying > 0 ? (
                      <p className="text-muted-foreground text-xs">
                        {importJob.retrying} still retrying automatically.
                      </p>
                    ) : null}
                    {importJob.failed > 0 || importJob.last_error ? (
                      <p className="text-destructive text-xs">
                        {importJob.failed > 0
                          ? `${importJob.failed} lead${importJob.failed === 1 ? '' : 's'} could not be synced. `
                          : ''}
                        {importJob.last_error ?? ''}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {!importJob || importJob.done ? (
                    <Button
                      onClick={startImport}
                      disabled={busy === 'import'}
                      size="sm"
                    >
                      {busy === 'import' ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : null}
                      Start Import
                    </Button>
                  ) : (
                    <>
                      <Button
                        onClick={() => resumeImport(false)}
                        disabled={busy === 'import-resume'}
                        size="sm"
                      >
                        {busy === 'import-resume' ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : null}
                        Resume
                      </Button>
                      {(importJob.failed > 0 || importJob.retrying > 0) ? (
                        <Button
                          variant="outline"
                          onClick={() => resumeImport(true)}
                          disabled={busy === 'import-resume'}
                          size="sm"
                          title="Reset failed rows and retry them (synced rows are never duplicated)"
                        >
                          Retry failed
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={cancelImport}
                        disabled={busy === 'import-cancel'}
                      >
                        Cancel import
                      </Button>
                    </>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setImportOpen(false)}
                    disabled={busy === 'import'}
                  >
                    Close
                  </Button>
                </div>
              </div>
            ) : null}

            {managedRows > 0 ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <p className="text-xs font-medium text-destructive">
                  Danger zone
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Delete spreadsheet rows previously synced from this
                  table. Only rows WhatsApp Max wrote are removed —
                  your own content is never touched.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={cleanupTable}
                  disabled={busy === 'cleanup'}
                >
                  {busy === 'cleanup' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  Remove {managedRows} synced row{managedRows === 1 ? '' : 's'}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
