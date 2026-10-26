'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Columns3,
  Eye,
  Loader2,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { FlowTableColumn } from '@/lib/flows/flow-tables';
import type { WorkspaceField } from '@/lib/flows/workspace-fields';
import {
  defaultHeaderColor,
  resolveHeaderColor,
} from '@/lib/flows/header-colors';
import { HeaderColorSwatches } from './header-color-picker';
import {
  describeVisibilityMenu,
  filterVisibilityMenu,
  flattenVisibilityMenu,
  customFieldVisId,
  type VisibilityMenuItem,
} from '@/lib/flows/workspace-visibility';
import { formatColumnLabel } from '@/lib/flows/column-label';

/**
 * Columns management panel.
 *
 * Two independent concerns share this menu but never the same
 * control:
 *   VISIBILITY (new) — checkboxes hide/show table columns.
 *   Hiding is presentation-only: definitions, values, and order
 *   are untouched, and a hidden column returns to its original
 *   position when re-enabled.
 *   MANAGEMENT (existing) — the pencil/trash actions edit or
 *   delete custom Workspace columns. Deleting requires
 *   confirmation and removes only Workspace data — flow fields
 *   can never appear here as deletable, and hiding can never
 *   delete.
 */
export function ColumnsMenu({
  flowId,
  flowColumns,
  customFields,
  hiddenIds,
  onToggleVisibility,
  onShowAll,
  onReset,
  onEditField,
  onChanged,
  headerColors,
  onSaveHeaderColor,
  canCustomizeColors,
  headerColorMap,
}: {
  flowId: string | null;
  flowColumns: FlowTableColumn[];
  customFields: WorkspaceField[];
  /** Currently hidden visibility ids (see workspace-visibility). */
  hiddenIds: readonly string[];
  onToggleVisibility: (id: string) => void;
  onShowAll: () => void;
  onReset: () => void;
  onEditField: (field: WorkspaceField) => void;
  onChanged: () => void;
  /**
   * Stored header-color overrides by stable visibility id. Omitted
   * (with onSaveHeaderColor) hides the color affordance — the menu
   * then behaves exactly as before.
   */
  headerColors?: Record<string, string>;
  /** Persist one column's header tint; null resets to the default. */
  onSaveHeaderColor?: (columnKey: string, color: string | null) => void;
  /** Agent+ writers see the color dots; viewers never do. */
  canCustomizeColors?: boolean;
  /**
   * Effective header colors for the visible set (unique map from
   * buildHeaderColorMap). Dots preview the exact painted color;
   * falls back to per-column resolution when omitted.
   */
  headerColorMap?: Record<string, string>;
}) {
  const [deleting, setDeleting] = useState<WorkspaceField | null>(null);
  const [coloring, setColoring] = useState<VisibilityMenuItem | null>(null);
  const [busy, setBusy] = useState(false);
  // Effective colors of every OTHER visible column — picking one
  // of these in the dialog is blocked with an explicit message so
  // no two columns ever share a header color.
  const coloringTakenColors =
    coloring === null
      ? []
      : Object.entries(headerColorMap ?? {})
          .filter(([key]) => key !== coloring.id)
          .map(([, color]) => color);

  async function handleDelete() {
    if (!deleting || !flowId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/flows/${flowId}/workspace-fields/${deleting.id}`,
        { method: 'DELETE' }
      );
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok)
        throw new Error(json?.error ?? 'Could not delete the column.');
      toast.success(`Column "${deleting.name}" deleted.`);
      setDeleting(null);
      onChanged();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not delete the column.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            'border-border bg-card inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium shadow-xs',
            'text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
          )}
        >
          <Columns3 className="h-4 w-4" />
          Columns
          {customFields.length > 0 && (
            <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
              {customFields.length}
            </span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <VisibilityPanel
            flowColumns={flowColumns}
            customFields={customFields}
            hiddenIds={hiddenIds}
            onToggleVisibility={onToggleVisibility}
            onShowAll={onShowAll}
            onReset={onReset}
            onEditField={onEditField}
            onDeleteField={setDeleting}
            headerColors={headerColors}
            onColorColumn={setColoring}
            canCustomizeColors={canCustomizeColors}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={deleting !== null}
        onOpenChange={(v) => !v && setDeleting(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete “{deleting?.name}”?</DialogTitle>
            <DialogDescription>
              This will remove the Workspace column and all its custom values.
              Flow fields and history are not affected. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleting(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={handleDelete}
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Deleting…
                </>
              ) : (
                'Delete column'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={coloring !== null}
        onOpenChange={(v) => !v && setColoring(null)}
      >
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>Header color</DialogTitle>
            <DialogDescription>
              Tint the “{coloring?.label}” header. Saved per Workspace —
              hiding or resetting columns never changes it.
            </DialogDescription>
          </DialogHeader>
          {coloring && (
            <HeaderColorSwatches
              label={coloring.label}
              defaultHex={defaultHeaderColor(coloring.id, coloring.label)}
              custom={headerColors?.[coloring.id] ?? null}
              takenColors={coloringTakenColors}
              onPick={(color) => onSaveHeaderColor?.(coloring.id, color)}
            />
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setColoring(null)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Visibility manager: the menu content. Search state lives here so
 * it resets every time the menu closes (the dropdown content
 * unmounts on close). Search filters this list only — Workspace
 * rows are never affected.
 */
function VisibilityPanel({
  flowColumns,
  customFields,
  hiddenIds,
  onToggleVisibility,
  onShowAll,
  onReset,
  onEditField,
  onDeleteField,
  headerColors,
  onColorColumn,
  canCustomizeColors,
  headerColorMap,
}: {
  flowColumns: FlowTableColumn[];
  customFields: WorkspaceField[];
  hiddenIds: readonly string[];
  onToggleVisibility: (id: string) => void;
  onShowAll: () => void;
  onReset: () => void;
  onEditField: (field: WorkspaceField) => void;
  onDeleteField: (field: WorkspaceField) => void;
  headerColors?: Record<string, string>;
  onColorColumn?: (item: VisibilityMenuItem) => void;
  canCustomizeColors?: boolean;
  headerColorMap?: Record<string, string>;
}) {
  const [query, setQuery] = useState('');
  const model = useMemo(
    () =>
      filterVisibilityMenu(
        describeVisibilityMenu(flowColumns, customFields),
        query
      ),
    [flowColumns, customFields, query]
  );
  const hidden = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const fieldByVisId = useMemo(
    () => new Map(customFields.map((f) => [customFieldVisId(f.id), f])),
    [customFields]
  );
  const empty =
    model.core.length === 0 &&
    model.flow.length === 0 &&
    model.custom.length === 0;
  // ONE unified list — no section groupings. Row entry first,
  // then flow, then custom columns, each keeping its own row
  // behavior (hideable checkboxes, editable custom rows).
  const items = useMemo(() => flattenVisibilityMenu(model), [model]);

  return (
    <>
      <div className="px-2 pt-1.5">
        <p className="text-foreground px-1 text-sm font-semibold">Columns</p>
        <p className="text-muted-foreground px-1 text-sm">
          Manage visible columns
        </p>
      </div>
      {/* Stop menu typeahead/shortcuts while typing; Escape still closes. */}
      <div
        className="px-1 py-1.5"
        onKeyDown={(e) => {
          if (e.key !== 'Escape') e.stopPropagation();
        }}
      >
        <div className="relative">
          <Search
            className="text-muted-foreground absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search columns..."
            aria-label="Search columns"
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      {empty ? (
        <p className="text-muted-foreground px-3 py-4 text-sm">
          No columns match your search.
        </p>
      ) : (
        <div className="px-1 pb-1">
          {items.map((item) => {
            const field = fieldByVisId.get(item.id);
            if (field) {
              return (
                <CustomVisibilityRow
                  key={item.id}
                  item={item}
                  checked={!hidden.has(item.id)}
                  onToggle={() => onToggleVisibility(item.id)}
                  onEdit={() => onEditField(field)}
                  onDelete={() => onDeleteField(field)}
                  headerColors={headerColors}
                  onColorColumn={onColorColumn}
                  canCustomizeColors={canCustomizeColors}
                  headerColorMap={headerColorMap}
                />
  );
}

            return (
              <HideableRow
                key={item.id}
                item={item}
                checked={!hidden.has(item.id)}
                onToggle={() => onToggleVisibility(item.id)}
                headerColors={headerColors}
                onColorColumn={onColorColumn}
                canCustomizeColors={canCustomizeColors}
                headerColorMap={headerColorMap}
              />
            );
          })}
        </div>
      )}

      <div className="border-border bg-popover sticky bottom-0 border-t px-1 pt-1">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={onShowAll}
            className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            Show all columns
          </button>
          <button
            type="button"
            onClick={onReset}
            className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Reset columns
          </button>
        </div>
      </div>
    </>
  );
}

/** Compact header-tint dot. Writers (agent+) only; viewers never see it. */
function HeaderColorDot({ item,
  headerColors,
  onColorColumn,
  canCustomizeColors,
  headerColorMap,
}: {
  item: VisibilityMenuItem;
  headerColors?: Record<string, string>;
  onColorColumn?: (item: VisibilityMenuItem) => void;
  canCustomizeColors?: boolean;
  headerColorMap?: Record<string, string>;
}) {
  if (!canCustomizeColors || !onColorColumn) return null;
  // Exact painted color when the visible-set map is provided.
  const current =
    headerColorMap?.[item.id] ?? resolveHeaderColor(item.id, item.label, headerColors);
  return (
    <button
      type="button"
      onClick={(e) => {
        // The dot lives inside label rows — don't toggle visibility.
        e.preventDefault();
        e.stopPropagation();
        onColorColumn(item);
      }}
      aria-label={`Header color for ${item.label}`}
      title="Header color"
      className="focus-visible:ring-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:outline-none"
    >
      <span
        aria-hidden="true"
        className="border-border block h-3.5 w-3.5 rounded-full border"
        style={{ backgroundColor: current }}
      />
    </button>
  );
}

/**
 * Fixed-width, right-aligned color area. Every manager row ends
 * with this slot, so all color dots line up vertically no matter
 * how long the label is (labels truncate) or which row actions
 * precede it (custom edit/delete sit BEFORE the slot). Renders
 * the empty slot when coloring is unavailable, preserving
 * alignment in search results too. Positioning never depends
 * on label content.
 */
function ColorDotSlot({
  item,
  headerColors,
  onColorColumn,
  canCustomizeColors,
  headerColorMap,
}: {
  item: VisibilityMenuItem;
  headerColors?: Record<string, string>;
  onColorColumn?: (item: VisibilityMenuItem) => void;
  canCustomizeColors?: boolean;
  headerColorMap?: Record<string, string>;
}) {
  return (
    <span className="flex w-6 shrink-0 items-center justify-center">
      <HeaderColorDot
        item={item}
        headerColors={headerColors}
        onColorColumn={onColorColumn}
        canCustomizeColors={canCustomizeColors}
        headerColorMap={headerColorMap}
      />
    </span>
  );
}

/** Hideable column without management actions. The label toggles the
 * checkbox natively — one control, keyboard accessible. Every
 * column renders here, including Row, Submission Time, Name, and
 * Phone Number: nothing is locked. */
function HideableRow({
  item,
  checked,
  onToggle,
  headerColors,
  onColorColumn,
  canCustomizeColors,
  headerColorMap,
}: {
  item: VisibilityMenuItem;
  checked: boolean;
  onToggle: () => void;
  headerColors?: Record<string, string>;
  onColorColumn?: (item: VisibilityMenuItem) => void;
  canCustomizeColors?: boolean;
  headerColorMap?: Record<string, string>;
}) {
  return (
    <label className="text-foreground hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors">
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        aria-label={`${checked ? 'Hide' : 'Show'} ${item.label}`}
      />
      <span className="min-w-0 flex-1 truncate">{formatColumnLabel(item.label)}</span>
      <ColorDotSlot
        item={item}
        headerColors={headerColors}
        onColorColumn={onColorColumn}
        canCustomizeColors={canCustomizeColors}
        headerColorMap={headerColorMap}
      />
    </label>
  );
}

/**
 * Hideable custom column WITH its management actions. Visibility
 * (checkbox/name) and management (pencil/trash) are distinct
 * controls — toggling visibility can never edit or delete.
 */
function CustomVisibilityRow({
  item,
  checked,
  onToggle,
  onEdit,
  onDelete,
  headerColors,
  onColorColumn,
  canCustomizeColors,
  headerColorMap,
}: {
  item: VisibilityMenuItem;
  checked: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  headerColors?: Record<string, string>;
  onColorColumn?: (item: VisibilityMenuItem) => void;
  canCustomizeColors?: boolean;
  headerColorMap?: Record<string, string>;
}) {
  return (
    <div className="group hover:bg-muted flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors">
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        aria-label={`${checked ? 'Hide' : 'Show'} ${item.label}`}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-label={`${checked ? 'Hide' : 'Show'} ${item.label}`}
        className="text-foreground focus-visible:ring-ring min-w-0 flex-1 truncate rounded text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        {formatColumnLabel(item.label)}
      </button>
      <button
        type="button"
        aria-label={`Edit ${item.label}`}
        onClick={onEdit}
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={`Delete ${item.label}`}
        onClick={onDelete}
        className="text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:ring-ring flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <ColorDotSlot
        item={item}
        headerColors={headerColors}
        onColorColumn={onColorColumn}
        canCustomizeColors={canCustomizeColors}
        headerColorMap={headerColorMap}
      />
    </div>
  );
}
