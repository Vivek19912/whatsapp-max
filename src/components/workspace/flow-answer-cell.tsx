"use client";

import { useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TextCellPopover, isRestorableChange } from "./text-cell-popover";
import { AttachmentCellLink } from "./attachment-cell-link";

/**
 * Editable flow-derived Workspace cell (one question column).
 *
 * Display rule: `override ?? original` — the Workspace value wins
 * when an agent override exists (even an explicit empty one);
 * otherwise the original flow answer shows. Originals are never
 * mutated here; edits go to PUT flow-overrides and Restore goes
 * to DELETE, with the parent refreshing afterwards.
 *
 * Editors by column kind (same primitives as business cells):
 * buttons/list questions (column.options) reuse the select +
 * Clear pattern; every other flow question reuses the long-text
 * popover (exact-text editing preserves numbers/dates
 * byte-for-byte — flow answers carry no static type metadata).
 * System columns never render through this component.
 */

export interface FlowAnswerCellProps {
  flowId: string;
  runId: string;
  columnKey: string;
  /** Display label (header text). */
  label: string;
  /** Fixed choices for buttons/list questions; absent otherwise. */
  options?: string[] | null;
  /** Original flow answer (null when unanswered). Never mutated. */
  original: string | null;
  /**
   * Raw ingested answer for Meta Lead Ads tables (the stored value
   * before any display mapping). When provided, restore compares
   * and displays against it instead of `original`, so the exact
   * Meta-supplied text is what gets restored. Absent on every
   * other table → legacy behavior, untouched.
   */
  rawOriginal?: string | null;
  /**
   * Agent override (undefined = none → show original; null =
   * explicitly cleared → show blank + edited).
   */
  override: string | null | undefined;
  /**
   * Clickable file URL for attachment values, resolved by the parent
   * (`resolveAttachmentUrl`). Null/absent = ordinary text cell —
   * rendered exactly as before. When set AND the displayed value is
   * non-empty, the cell renders the filename as a link that opens the
   * actual existing WACRM media URL in a new tab, replacing the
   * popover trigger (an attachment filename is not an editable text).
   */
  fileUrl?: string | null;
  canEdit: boolean;
  /** Parent refresh after a successful save/restore. */
  onChanged: () => void;
}

export function FlowAnswerCell({
  flowId,
  runId,
  columnKey,
  label,
  options,
  original,
  rawOriginal,
  override,
  fileUrl,
  canEdit,
  onChanged,
}: FlowAnswerCellProps) {
  const [saving, setSaving] = useState(false);
  const display = override !== undefined ? override : original;
  const edited = override !== undefined;
  // Meta Lead Ads tables compare (and restore) against the raw
  // ingested answer rather than the display-mapped original, so a
  // mapped label can never mask a changed override. `undefined`
  // everywhere else → legacy behavior, untouched.
  const showRestore =
    rawOriginal === undefined ? undefined : isRestorableChange(override, rawOriginal);
  const originalForRestore = rawOriginal !== undefined ? rawOriginal : original;

  // Attachment value (resolved file URL + non-empty display): the
  // filename renders as a clickable link that opens the actual file in
  // a new tab. Only these cells change — every other cell keeps its
  // existing popover/select surface untouched.
  if (fileUrl && display !== null && display !== undefined && display !== "") {
    return (
      <AttachmentCellLink
        url={fileUrl}
        fileName={display}
        label={label}
        edited={edited}
        originalValue={original}
      />
    );
  }

  async function request(
    method: "PUT" | "DELETE",
    value?: string | null,
  ): Promise<boolean> {
    setSaving(true);
    try {
      const res = await fetch(`/api/flows/${flowId}/flow-overrides`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          method === "PUT"
            ? { flow_run_id: runId, field_key: columnKey, value }
            : { flow_run_id: runId, field_key: columnKey },
        ),
      });
      if (!res.ok) return false;
      onChanged();
      return true;
    } catch {
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Read-only (or empty): today's plain/reader surface. Flow
  // answers have no write path here.
  if (!canEdit) {
    if ((display ?? "") === "") return <span></span>;
    return (
      <TextCellPopover
        fieldLabel={label}
        value={display ?? ""}
        editable={false}
        originalValue={original}
      />
    );
  }

  // Buttons/list questions: the existing dropdown pattern (Clear +
  // the question's own options). Chevron-less cell trigger, like
  // business selects, so rows stay visually quiet.
  if (options && options.length > 0) {
    return (
      <span onClick={(e) => e.stopPropagation()}>
        <Select
          value={display ?? ""}
          disabled={saving}
          onValueChange={(v) => {
            void request("PUT", v === "__clear__" ? null : v);
          }}
        >
          <SelectTrigger
            className="h-8 w-full min-w-28 border-transparent bg-transparent px-1 text-[13px] hover:border-border data-[state=open]:border-border [&_svg]:hidden"
            aria-label={`${label} value`}
          >
            <SelectValue placeholder="">
              {display == null || display === "" ? undefined : (
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="truncate">{display}</span>
                  {edited && (
                    <span
                      aria-label="Edited"
                      title={
                        original
                          ? `Edited — original: ${original}`
                          : "Edited"
                      }
                      className="inline-block size-1.5 shrink-0 rounded-full bg-blue-500"
                    />
                  )}
                </span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__clear__">
              <span className="text-muted-foreground">Clear</span>
            </SelectItem>
            {options.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
    );
  }

  // Text answers (incl. numbers/dates, which flow answers store as
  // exact text): the shared long-text popover with restore. Empty
  // originals open the same empty editor for entry.
  return (
    <TextCellPopover
      fieldLabel={label}
      value={display ?? ""}
      editable
      onSave={(v) => request("PUT", v)}
      originalValue={originalForRestore}
      showRestore={showRestore}
      onRestore={() => request("DELETE")}
    />
  );
}
