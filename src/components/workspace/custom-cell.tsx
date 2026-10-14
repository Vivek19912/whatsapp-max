"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatWorkspaceCurrency } from "@/lib/currency";
import {
  displayWorkspaceValue,
  parseMultiSelectValue,
  resolveWorkspaceCurrency,
  type WorkspaceField,
} from "@/lib/flows/workspace-fields";
import {
  ASSIGNED_TO_CLEAR_SENTINEL,
  ASSIGNED_TO_UNASSIGNED,
  buildAssigneeOptions,
  isAssigneeField,
  resolveAssigneeDisplay,
  type AssigneeMember,
} from "@/lib/flows/workspace-assignee";
import {
  assigneeChipFor,
  getSelectChip,
  UNASSIGNED_CHIP,
  type SelectChip,
} from "@/lib/flows/workspace-select-chips";
import { defaultBusinessValue } from "@/lib/flows/workspace-defaults";
import { TextCellPopover } from "./text-cell-popover";

/**
 * Sheets-style value chip: compact rounded pill, colored
 * background + readable text, sized to its content. No borders,
 * shadows, gradients, or icons — color is decorative only, the
 * text label carries the meaning (and stays in the a11y tree).
 *
 * Exported for reuse: the Travel CRM dialog renders its
 * Received/Type/Stage dropdowns with this exact chip so the two
 * surfaces can never disagree on colors.
 */
export function SelectChipView({ chip, children }: { chip: SelectChip; children: string }) {
  return (
    <span
      className="inline-flex max-w-full items-center justify-center rounded-full px-2 py-0.5 align-middle text-[12px] leading-4 font-medium whitespace-nowrap"
      style={{ backgroundColor: chip.background, color: chip.color }}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * Shared trigger styling for every Workspace select cell (Assigned
 * To, Type, Stage, Received, …). The trigger spans the whole cell
 * so clicking the chip OR empty space opens the existing dropdown;
 * hover border + focus ring (already on the trigger) signal
 * interactivity. The chevron svg rendered by the shared
 * SelectTrigger is hidden HERE ONLY — `[&_svg]:hidden` keeps the
 * icon in the a11y/DOM tree but removes the always-visible arrow
 * from every row so dense tables stay quiet. Chips, values,
 * options, keyboard handling, and persistence are untouched.
 *
 * Exported for reuse: the Travel CRM dialog's Received/Type/Stage
 * dropdowns share this exact trigger styling.
 */
export const SELECT_CELL_TRIGGER_CLASS =
  "h-8 w-full min-w-28 border-transparent bg-transparent px-1 text-[13px] hover:border-border data-[state=open]:border-border [&_svg]:hidden";

/**
 * Minimum filterable-option count before a search box appears at
 * the top of a select dropdown. Small lists (Type, Call Status…)
 * stay a plain menu; long ones (Stage, Received, big rosters) get
 * a filter. Clear is always pinned above the filter and never
 * filtered out.
 */
export const OPTION_SEARCH_THRESHOLD = 8;

export interface FilterableCellOption {
  value: string;
  label: string;
}

/**
 * Pure substring filter for dropdown options (case-insensitive,
 * matches label or value). Display-only: stored values are never
 * touched — a query that matches nothing simply shows no options.
 */
export function filterCellOptions<T extends FilterableCellOption>(
  options: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  return options.filter(
    (o) =>
      o.label.toLowerCase().includes(q) ||
      o.value.toLowerCase().includes(q),
  );
}

/**
 * Keys the search box lets through to the enclosing Select
 * dropdown: Escape dismisses the menu, Tab moves focus out.
 * Every other key (characters, space, backspace, arrows, Enter,
 * shortcuts) is consumed by the text field — the Select popup's
 * own typeahead/keyboard navigation must never see it.
 */
export function searchBoxKeyShouldPropagate(key: string): boolean {
  return key === "Escape" || key === "Tab";
}

/**
 * Keydown guard for the dropdown search box (shared by Workspace
 * cell selects and the Travel CRM Departure Country/City
 * selects): stops propagation so the Select popup's typeahead
 * and list navigation — which `preventDefault()` printable keys
 * without checking whether the target is an editable input —
 * can never swallow keystrokes. Stopping propagation never
 * blocks the input itself (default behavior still edits text),
 * so typing, filtering, backspace, select-all, and caret keys
 * all work while Escape/Tab keep their dropdown behavior.
 */
export function onSearchBoxKeyDown(
  e: Pick<KeyboardEvent, "key" | "stopPropagation">,
): void {
  if (!searchBoxKeyShouldPropagate(e.key)) e.stopPropagation();
}

/**
 * Search box pinned to the top of long select dropdowns. Filters
 * the displayed options only (the query resets on close);
 * Escape dismisses and Tab moves focus out, while every other
 * key edits the query text (see onSearchBoxKeyDown).
 *
 * Exported for reuse: the Travel CRM dialog's long funnel
 * dropdowns (Received, Stage) share this exact search behavior.
 */
export function OptionSearchBox({
  query,
  onQuery,
  fieldName,
}: {
  query: string;
  onQuery: (query: string) => void;
  fieldName: string;
}) {
  return (
    <div className="p-1" onKeyDown={onSearchBoxKeyDown}>
      <Input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search options…"
        aria-label={`Search ${fieldName} options`}
        className="h-7 text-[13px]"
      />
    </div>
  );
}

function formatDisplay(field: WorkspaceField, stored: string | null): string {
  // Type/Stage business defaults (Fresh / New Lead) resolve here,
  // after the stored value and the field's own default_value, so
  // empty cells display/select the default while saved picks
  // always win — and nothing is ever written back.
  const shown =
    displayWorkspaceValue(field, stored) ?? defaultBusinessValue(field);
  // Empty cells render BLANK (never a dash placeholder) —
  // display-only; the stored value is untouched.
  if (shown === null || shown === "") return "";
  switch (field.field_type) {
    case "currency": {
      const n = Number(shown);
      if (!Number.isFinite(n)) return shown;
      try {
        return formatWorkspaceCurrency(n, resolveWorkspaceCurrency(field));
      } catch {
        return shown;
      }
    }
    case "date": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(shown);
      if (!m) return shown;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isNaN(d.getTime())
        ? shown
        : d.toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
          });
    }
    case "datetime": {
      const t = Date.parse(shown);
      if (Number.isNaN(t)) return shown;
      return new Date(t).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    case "multi_select":
      return parseMultiSelectValue(shown).join(", ");
    case "checkbox":
      return shown === "true" ? "Yes" : "No";
    default:
      return shown;
  }
}

/**
 * Native editor input type for one workspace field type. Text-like
 * fields edit as text, dates use the native date affordance —
 * never a generic select chevron.
 */
export function editorInputType(
  field_type: WorkspaceField["field_type"],
): "date" | "datetime-local" | "number" | "text" {
  if (field_type === "date") return "date";
  if (field_type === "datetime") return "datetime-local";
  if (field_type === "number" || field_type === "currency") return "number";
  return "text";
}

/**
 * One editable custom cell. Click to edit inline with a type-aware
 * editor; saves server-side on commit (blur/Enter/select). Flow
 * answers are never touched — only workspace_values rows.
 */
export function CustomCell({
  flowId,
  runId,
  field,
  stored,
  canEdit,
  onSaved,
  twoLineClamp = false,
  members,
}: {
  flowId: string;
  runId: string;
  field: WorkspaceField;
  stored: string | null | undefined;
  canEdit: boolean;
  onSaved: (fieldId: string, runId: string, value: string | null) => void;
  /**
   * Two-line visual clamp for the text trigger (Customer
   * Response / Next Action cells): up to 2 wrapped lines with
   * an ellipsis instead of single-line truncation. Visual only
   * — stored values, saves, and the editing popover are
   * untouched. Defaults to false; ignored for non-text types.
   */
  twoLineClamp?: boolean;
  /**
   * Live account roster for the "Assigned To" column (same data as
   * Settings → Team Members via GET /api/account/members).
   * Ignored for every other column. Empty/omitted renders the
   * stored value as-is (preserved) with Clear + Unassigned still
   * available.
   */
  members?: readonly AssigneeMember[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [optionQuery, setOptionQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  async function save(raw: unknown): Promise<boolean> {
    setSaving(true);
    try {
      const res = await fetch(`/api/flows/${flowId}/workspace-values`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          field_id: field.id,
          flow_run_id: runId,
          value: raw,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
        value?: string | null;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not save the value.");
      onSaved(field.id, runId, json?.value ?? null);
      setEditing(false);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the value.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  const shown =
    displayWorkspaceValue(field, stored ?? null) ?? defaultBusinessValue(field);

  // "Assigned To" is dynamic: Clear + Unassigned + the live account
  // roster (Settings → Team Members via /api/account/members).
  // Stored value is the stable member user_id; the name resolves at
  // render so renames propagate and new teammates appear with no
  // code change. Unknown stored values (legacy display strings or
  // removed members) render as-is and are never rewritten here.
  if (isAssigneeField(field)) {
    const roster = members ?? [];
    const rosterIds = roster.map((m) => m.user_id);
    const base = shown;
    const display = resolveAssigneeDisplay(base, roster);
    // Member chips: deterministic per member within the live
    // roster (never hardcoded); Unassigned takes the ONLY gray
    // chip; Clear stays plain; legacy/removed values stay plain.
    const assigneeChip =
      base === ASSIGNED_TO_UNASSIGNED
        ? UNASSIGNED_CHIP
        : base
          ? assigneeChipFor(base.trim(), rosterIds)
          : null;
    if (!canEdit) {
      if (display == null || display === "") return <span></span>;
      return assigneeChip ? (
        <SelectChipView chip={assigneeChip}>{display}</SelectChipView>
      ) : (
        <span>{display}</span>
      );
    }
    const options = buildAssigneeOptions(roster, base);
    const searchableAssignee = options.filter((o) => o.kind !== "clear");
    const showAssigneeSearch =
      searchableAssignee.length > OPTION_SEARCH_THRESHOLD;
    const visibleAssignee = showAssigneeSearch
      ? filterCellOptions(searchableAssignee, optionQuery)
      : searchableAssignee;
    return (
      <span onClick={(e) => e.stopPropagation()}>
        <Select
          value={base ?? ""}
          disabled={saving}
          onValueChange={(v) =>
            save(v === ASSIGNED_TO_CLEAR_SENTINEL ? null : v)
          }
          onOpenChange={(o) => {
            if (!o) setOptionQuery("");
          }}
        >
          <SelectTrigger
            className={SELECT_CELL_TRIGGER_CLASS}
            aria-label={`${field.name} value`}
          >
            <SelectValue placeholder="">
              {display == null ? undefined : assigneeChip ? (
                <SelectChipView chip={assigneeChip}>{display}</SelectChipView>
              ) : (
                display
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options
              .filter((o) => o.kind === "clear")
              .map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <span className="text-muted-foreground">Clear</span>
                </SelectItem>
              ))}
            {showAssigneeSearch && (
              <OptionSearchBox
                query={optionQuery}
                onQuery={setOptionQuery}
                fieldName={field.name}
              />
            )}
            {visibleAssignee.map((o) => {
              const optionChip =
                o.kind === "unassigned"
                  ? UNASSIGNED_CHIP
                  : o.kind === "member"
                    ? assigneeChipFor(o.value, rosterIds)
                    : null;
              return (
                <SelectItem key={`${o.kind}:${o.value}`} value={o.value}>
                  {optionChip ? (
                    <SelectChipView chip={optionChip}>{o.label}</SelectChipView>
                  ) : (
                    o.label
                  )}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </span>
    );
  }

  if (!canEdit) {
    if (field.field_type === "url" && shown) {
      return (
        <a
          href={shown}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {formatDisplay(field, stored ?? null)}
        </a>
      );
    }
    if (field.field_type === "single_select" && !isAssigneeField(field)) {
      const text = formatDisplay(field, stored ?? null);
      const chip = shown ? getSelectChip(field.name, shown) : null;
      if (text !== "" && chip) {
        return <SelectChipView chip={chip}>{text}</SelectChipView>;
      }
      return <span>{text}</span>;
    }
    // Plain text cells (no edit rights): same read surface as the
    // editable popover so long values stay comfortably readable.
    if (field.field_type === "text") {
      return (
        <TextCellPopover
          fieldLabel={field.name}
          value={shown ?? ""}
          editable={false}
          twoLineClamp={twoLineClamp}
        />
      );
    }
    return <span>{formatDisplay(field, stored ?? null)}</span>;
  }

  // Checkbox + single-select commit immediately, no edit mode.
  if (field.field_type === "checkbox") {
    return (
      <span className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={shown === "true"}
          disabled={saving}
          onCheckedChange={(v) => save(v === true)}
          aria-label={`${field.name} value`}
        />
        {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </span>
    );
  }

  if (field.field_type === "single_select") {
    // Business dropdowns paint Sheets-style chips in both the
    // selected value and every option (same pure mapping, so the
    // two can never disagree). Unknown/legacy values render as
    // plain text; empty cells render blank.
    const selectedChip = shown ? getSelectChip(field.name, shown) : null;
    const fieldOptions = field.options ?? [];
    const showOptionSearch = fieldOptions.length > OPTION_SEARCH_THRESHOLD;
    const visibleOptions = showOptionSearch
      ? filterCellOptions(
          fieldOptions.map((o) => ({ value: o, label: o })),
          optionQuery,
        )
      : fieldOptions.map((o) => ({ value: o, label: o }));
    return (
      <span onClick={(e) => e.stopPropagation()}>
        <Select
          value={shown ?? ""}
          disabled={saving}
          onValueChange={(v) => save(v === "__clear__" ? null : v)}
          onOpenChange={(o) => {
            if (!o) setOptionQuery("");
          }}
        >
          <SelectTrigger className={SELECT_CELL_TRIGGER_CLASS}>
            <SelectValue placeholder="">
              {shown == null || shown === "" ? undefined : selectedChip ? (
                <SelectChipView chip={selectedChip}>{shown}</SelectChipView>
              ) : (
                shown
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__clear__">
              <span className="text-muted-foreground">Clear</span>
            </SelectItem>
            {showOptionSearch && (
              <OptionSearchBox
                query={optionQuery}
                onQuery={setOptionQuery}
                fieldName={field.name}
              />
            )}
            {visibleOptions.map((o) => {
              const chip = getSelectChip(field.name, o.value);
              return (
                <SelectItem key={o.value} value={o.value}>
                  {chip ? <SelectChipView chip={chip}>{o.label}</SelectChipView> : o.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </span>
    );
  }

  if (field.field_type === "multi_select") {
    const picked = parseMultiSelectValue(shown);
    return (
      <span onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "flex h-8 w-full items-center gap-1 rounded-md px-1 text-[13px] transition-colors",
              "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            )}
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {picked.length > 0 ? picked.join(", ") : ""}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {(field.options ?? []).map((o) => (
              <DropdownMenuCheckboxItem
                key={o}
                checked={picked.includes(o)}
                onCheckedChange={() => {
                  const next = picked.includes(o)
                    ? picked.filter((p) => p !== o)
                    : [...picked, o];
                  save(next);
                }}
                onSelect={(e) => e.preventDefault()}
              >
                {o}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    );
  }

  if (!editing) {
    // Long-text popover editor for plain text fields (Customer
    // Response, Final Remark, notes…): compact truncated trigger →
    // anchored popover with the full multiline value for reading
    // and writing in one surface. Dates, numbers, and URLs keep
    // their existing inline editors below.
    if (field.field_type === "text") {
      return (
        <TextCellPopover
          fieldLabel={field.name}
          value={shown ?? ""}
          editable={canEdit}
          twoLineClamp={twoLineClamp}
          onSave={save}
        />
      );
    }
    const text = formatDisplay(field, stored ?? null);
    if (field.field_type === "url" && shown) {
      return (
        <span className="inline-flex items-center gap-1">
          <a
            href={shown}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {text}
          </a>
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setDraft(shown ?? "");
          setEditing(true);
        }}
        // Full-cell click target: the button spans the cell width
        // with a minimum select-like height, so clicking ANYWHERE
        // in the cell (value or blank area) enters edit mode —
        // clicks never fall through to the row below. Plain text,
        // no chevron, no pill: only true selects render chevrons
        // (via the shared SelectTrigger).
        className="flex min-h-8 w-full items-center rounded px-1 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        title="Click to edit"
        aria-label={`${field.name} value`}
      >
        <span className={cn("min-w-0 flex-1 truncate", text === "" && "text-muted-foreground")}>{text}</span>
      </button>
    );
  }

  const inputType = editorInputType(field.field_type);

  return (
    <span
      className="inline-flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
    >
      <Input
        ref={inputRef}
        type={inputType}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!saving) save(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-8 w-36"
        aria-label={`${field.name} value`}
      />
      {saving ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Check className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      )}
      {field.field_type === "url" && shown && (
        <a
          href={shown}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open link"
          className="text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </span>
  );
}
