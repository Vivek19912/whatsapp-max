'use client';

import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Loader2,
  Search,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  EXPORT_COLUMN_GROUPS,
  filterColumnsByQuery,
  groupSelectionCount,
  groupSelectionState,
  type ExportColumnGroup,
  type SelectableExportColumn,
} from '@/lib/meta-leads-export/column-selection';

export interface MetaExportColumnsStepProps {
  /** All available columns in canonical workbook order. */
  columns: readonly SelectableExportColumn[];
  /** Selected column keys (stable ids, never display labels). */
  selected: ReadonlySet<string>;
  search: string;
  onSearchChange: (value: string) => void;
  expanded: Record<ExportColumnGroup, boolean>;
  onToggleExpanded: (group: ExportColumnGroup) => void;
  onToggleColumn: (key: string) => void;
  onToggleGroup: (group: ExportColumnGroup) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onBack: () => void;
  onCancel: () => void;
  onDownload: () => void;
  busy: boolean;
}

function GroupSection({
  group,
  columns,
  selected,
  search,
  expanded,
  onToggleExpanded,
  onToggleColumn,
  onToggleGroup,
}: {
  group: (typeof EXPORT_COLUMN_GROUPS)[number];
  columns: readonly SelectableExportColumn[];
  selected: ReadonlySet<string>;
  search: string;
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggleColumn: (key: string) => void;
  onToggleGroup: () => void;
}) {
  const groupColumns = columns.filter((c) => c.group === group.id);
  const visible = filterColumnsByQuery(groupColumns, search);
  const counts = groupSelectionCount(
    groupColumns.map((c) => c.key),
    selected
  );
  const master = groupSelectionState(
    groupColumns.map((c) => c.key),
    selected
  );
  const isManagement = group.id === 'management';

  return (
    <section
      aria-label={group.title}
      className="border-border overflow-hidden rounded-xl border"
    >
      <div className="bg-muted/60 flex items-start gap-3 px-4 py-3">
        {isManagement ? (
          <Checkbox
            checked={master === 'checked'}
            indeterminate={master === 'indeterminate'}
            onCheckedChange={onToggleGroup}
            aria-label={`Select all ${group.title} columns`}
            className="mt-1 shrink-0"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <h3 className="text-foreground text-[15px] font-semibold">
            {group.title}
          </h3>
          <p className="text-muted-foreground text-xs">{group.description}</p>
        </div>
        <span className="text-muted-foreground shrink-0 text-sm">
          {counts.selected} of {counts.total} selected
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.title}`}
        >
          {expanded ? (
            <ChevronUp className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronDown className="h-4 w-4" aria-hidden />
          )}
        </Button>
      </div>
      {expanded ? (
        <div className="bg-card px-4 py-3">
          {visible.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No columns match your search.
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((c) => (
                <li key={c.key}>
                  <label className="text-foreground flex cursor-pointer items-start gap-2 text-sm">
                    <Checkbox
                      checked={selected.has(c.key)}
                      onCheckedChange={() => onToggleColumn(c.key)}
                      aria-label={c.header}
                      className="mt-0.5 shrink-0"
                    />
                    <span className="leading-snug break-words">{c.header}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function StepIndicator({ step }: { step: 1 | 2 }) {
  return (
    <div className="flex items-center gap-3" aria-label="Export progress">
      <span
        aria-hidden
        className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full"
      >
        {step === 2 ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <span className="text-xs font-semibold">1</span>
        )}
      </span>
      <span
        className={
          step === 1
            ? 'text-foreground text-sm font-semibold'
            : 'text-muted-foreground text-sm'
        }
      >
        1. Filters
      </span>
      <span aria-hidden className="bg-primary/60 h-px min-w-8 flex-1" />
      <span
        aria-hidden
        className={
          step === 2
            ? 'bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold'
            : 'border-border text-muted-foreground flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold'
        }
      >
        2
      </span>
      <span
        className={
          step === 2
            ? 'text-foreground decoration-primary text-sm font-semibold underline decoration-2 underline-offset-4'
            : 'text-muted-foreground text-sm'
        }
        aria-current={step === 2 ? 'step' : undefined}
      >
        Select Columns
      </span>
    </div>
  );
}

export function MetaExportColumnsStep(props: MetaExportColumnsStepProps) {
  const {
    columns,
    selected,
    search,
    onSearchChange,
    expanded,
    onToggleExpanded,
    onToggleColumn,
    onToggleGroup,
    onSelectAll,
    onDeselectAll,
    onBack,
    onCancel,
    onDownload,
    busy,
  } = props;
  const noneSelected = selected.size === 0;

  return (
    <div className="flex flex-col gap-4">
      <StepIndicator step={2} />
      <p className="text-muted-foreground text-sm">
        Select the columns you want to include in the Excel file.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
          />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search columns..."
            aria-label="Search columns"
            className="pl-9"
          />
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onSelectAll}
          >
            Select All
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDeselectAll}
          >
            Deselect All
          </Button>
        </div>
      </div>

      <div className="max-h-[55vh] space-y-4 overflow-y-auto pr-1">
        {EXPORT_COLUMN_GROUPS.map((group) => (
          <GroupSection
            key={group.id}
            group={group}
            columns={columns}
            selected={selected}
            search={search}
            expanded={expanded[group.id]}
            onToggleExpanded={() => onToggleExpanded(group.id)}
            onToggleColumn={onToggleColumn}
            onToggleGroup={() => onToggleGroup(group.id)}
          />
        ))}
      </div>

      {noneSelected ? (
        <p role="alert" className="text-destructive text-sm">
          Select at least one column to include in the Excel file.
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onBack}
          disabled={busy}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back
        </Button>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onDownload}
            disabled={busy || noneSelected}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="h-4 w-4" aria-hidden />
            )}
            {busy ? 'Downloading…' : 'Download .xlsx'}
          </Button>
        </div>
      </div>
    </div>
  );
}
