"use client";

import { useRef, useState, type Ref } from "react";
import { Loader2, Maximize2, Minimize2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Long-text cell viewer/editor for the Workspace table.
 *
 * One surface for READ + WRITE: a compact truncated trigger opens
 * an anchored popover (portal — never clipped by the table's
 * overflow containers) with the full multiline value. Text fields
 * edit in place; flow answers and other read-only cells open the
 * same surface without save affordances.
 *
 * Persistence is NEVER owned here: editable cells save through the
 * caller's existing update path (`onSave`, e.g. CustomCell's PUT
 * workspace-values + optimistic onSaved). This component only
 * threads the exact draft string through.
 *
 * Optional restore support (flow-answer overrides): pass
 * `originalValue` (the authoritative original) plus `onRestore`
 * (deletes the override, resolves true on success). The trigger
 * then carries a subtle edited dot, and the panel shows the
 * original with a Restore action — only while the committed
 * value differs from the original.
 */

export interface TextCellKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** "248 characters" / "1 character" — live count below the editor. */
export function formatCharCount(count: number): string {
  return `${count} ${count === 1 ? "character" : "characters"}`;
}

/** True for Ctrl+Enter / Cmd+Enter (save). Plain Enter types a newline. */
export function isSaveShortcut(e: TextCellKeyEvent): boolean {
  return e.key === "Enter" && (e.ctrlKey === true || e.metaKey === true);
}

/** True for Escape (cancel). */
export function isCancelKey(e: TextCellKeyEvent): boolean {
  return e.key === "Escape";
}

/**
 * Whether a stored override differs from the authoritative original
 * answer, i.e. whether offering "Restore original" makes sense.
 * `undefined` override = no override written (nothing to restore);
 * `null` and `""` compare as the same empty value.
 */
export function isRestorableChange(
  override: string | null | undefined,
  original: string | null | undefined,
): boolean {
  if (override === undefined) return false;
  return (override ?? "") !== (original ?? "");
}

/** True when the draft differs from the opened value. */
export function isDirtyDraft(draft: string, value: string): boolean {
  return draft !== value;
}

/**
 * Size-related textarea classes by mode. Compact auto-grows with
 * content (field-sizing-content from the shared Textarea) up to a
 * max height, then scrolls internally — a huge value can never
 * push the page/table out of control. Expanded trades compactness
 * for a larger scrollable area with the same value.
 */
export function textEditorClassName(expanded: boolean): string {
  return expanded
    ? "max-h-[60vh] min-h-64 overflow-y-auto"
    : "max-h-56 min-h-28 overflow-y-auto";
}

export interface TextCellPopoverProps {
  /** Column/field display label (header + aria). */
  fieldLabel: string;
  /** Exact current text (already resolved shown value). Never trimmed. */
  value: string;
  /** False renders the same read surface without save affordances. */
  editable: boolean;
  /**
   * Existing persistence path. Receives the EXACT draft string;
   * resolves true only when persisted (false keeps the editor open).
   */
  onSave?: (value: string) => Promise<boolean>;
  /**
   * Authoritative original value for restore UI. When defined and
   * different from `value`, the trigger shows a subtle edited dot
   * and the panel offers the original plus a Restore action.
   * Absent/unchanged → no restore UI at all.
   */
  originalValue?: string | null;
  /**
   * Deletes the override (resolves true on success). The panel
   * resets to the original and closes; the caller refreshes.
   */
  onRestore?: () => Promise<boolean>;
  /**
   * Explicit restore-UI override. When undefined (default), the
   * panel derives visibility from `value` vs `originalValue`
   * exactly as before — existing callers are untouched. Meta Lead
   * Ads tables pass an explicit value computed against the raw
   * ingested answer (never the display-mapped one).
   */
  showRestore?: boolean;
  /** Test/SSR escape hatch: render initially open. */
  defaultOpen?: boolean;
  /** Test/SSR escape hatch: render initially expanded. */
  defaultExpanded?: boolean;
  /**
   * Two-line visual clamp for the trigger text (Customer
   * Response / Next Action cells): wraps naturally up to 2
   * lines with an ellipsis, instead of the single-line
   * `truncate`. Visual only — `value`, the editor, and the
   * saved text are never touched. Defaults to false so every
   * other column keeps its existing single-line trigger.
   */
  twoLineClamp?: boolean;
  placeholder?: string;
}

export interface TextEditorPanelProps {
  fieldLabel: string;
  draft: string;
  editable: boolean;
  saving: boolean;
  expanded: boolean;
  dirtyNotice: boolean;
  placeholder?: string;
  textareaRef?: Ref<HTMLTextAreaElement>;
  onDraftChange: (value: string) => void;
  onToggleExpand: () => void;
  /** X button (may guard on unsaved changes). */
  onCloseRequest: () => void;
  /** Cancel button / Escape (always discards). */
  onCancel: () => void;
  /** Save button / Ctrl+Enter (editable only). */
  onSave: () => void;
  /** Original value text for the restore block (undefined hides it). */
  originalValue?: string | null;
  /** Whether the restore block is visible (committed value differs). */
  showRestore?: boolean;
  /** Restore original button (resolved by the caller). */
  onRestore?: () => void;
}

/**
 * The popover's inner surface, dependency-free (no popover
 * primitives) so it renders anywhere — including SSR/tests — with
 * identical markup. The textarea is controlled; every keystroke
 * flows through onDraftChange verbatim (line breaks, emoji, and
 * spacing preserved — never trimmed or normalized here).
 */
export function TextEditorPanel({
  fieldLabel,
  draft,
  editable,
  saving,
  expanded,
  dirtyNotice,
  placeholder = "",
  textareaRef,
  onDraftChange,
  onToggleExpand,
  onCloseRequest,
  onCancel,
  onSave,
  originalValue,
  showRestore = false,
  onRestore,
}: TextEditorPanelProps) {
  return (
    <>
      <div className="flex items-center gap-1">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {fieldLabel}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onToggleExpand}
          aria-label={expanded ? "Collapse editor" : "Expand editor"}
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onCloseRequest}
          aria-label="Close"
          title="Close"
        >
          <X />
        </Button>
      </div>
      <Textarea
        ref={textareaRef}
        rows={expanded ? 12 : 5}
        value={draft}
        readOnly={!editable}
        placeholder={placeholder}
        aria-label={`${fieldLabel} text`}
        className={textEditorClassName(expanded)}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (isCancelKey(e)) {
            e.stopPropagation();
            onCancel();
            return;
          }
          if (editable && isSaveShortcut(e)) {
            e.preventDefault();
            onSave();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span aria-live="polite">{formatCharCount(draft.length)}</span>
        {editable && <span>Ctrl/Cmd + Enter to save</span>}
      </div>
      {dirtyNotice && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          You have unsaved changes — Save or Cancel to proceed.
        </p>
      )}
      {showRestore && (
        <div className="space-y-1.5 rounded-lg border border-dashed border-border p-2">
          <p className="text-xs text-muted-foreground">Original flow value:</p>
          {originalValue ? (
            <p className="text-sm break-words whitespace-pre-wrap text-foreground">
              {originalValue}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">(empty)</p>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={onRestore}
          >
            Restore original
          </Button>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        {editable ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={saving}
              onClick={onSave}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </>
        ) : (
          <span className="flex w-full justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancel}
            >
              Close
            </Button>
          </span>
        )}
      </div>
    </>
  );
}

export function TextCellPopover({
  fieldLabel,
  value,
  editable,
  onSave,
  originalValue,
  onRestore,
  showRestore: showRestoreOverride,
  defaultOpen = false,
  defaultExpanded = false,
  twoLineClamp = false,
  placeholder = "",
}: TextCellPopoverProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [dirtyNotice, setDirtyNotice] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Edited (Workspace value differs from the original flow value):
  // subtle dot on the trigger + restore UI in the panel. Absent
  // original (or equal values) → no restore affordance at all. An
  // explicit `showRestore` override (Meta Lead Ads: computed against
  // the raw ingested answer) wins when provided.
  const edited =
    showRestoreOverride ??
    (originalValue !== undefined && originalValue !== value);

  function focusTrigger() {
    triggerRef.current?.focus();
  }

  function focusEditorEnd() {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    try {
      el.setSelectionRange(el.value.length, el.value.length);
    } catch {
      // Non-textual edge cases keep default caret placement.
    }
  }

  /** Explicit discard paths: Cancel button + Escape. */
  function discardAndClose() {
    setDraft(value);
    setDirtyNotice(false);
    setExpanded(false);
    setOpen(false);
    focusTrigger();
  }

  async function handleSave() {
    if (!editable || saving) return;
    setSaving(true);
    try {
      const ok = await onSave?.(draft);
      if (ok === false) return;
      setDirtyNotice(false);
      setExpanded(false);
      setOpen(false);
      focusTrigger();
    } finally {
      setSaving(false);
    }
  }

  function requestClose() {
    if (editable && isDirtyDraft(draft, value)) {
      setDirtyNotice(true);
      return;
    }
    discardAndClose();
  }

  async function handleRestore() {
    if (saving) return;
    setSaving(true);
    try {
      const ok = await onRestore?.();
      if (ok === false) return;
      setDraft(originalValue ?? "");
      setDirtyNotice(false);
      setExpanded(false);
      setOpen(false);
      focusTrigger();
    } finally {
      setSaving(false);
    }
  }

  function handleOpenChange(
    next: boolean,
    details?: { reason?: unknown },
  ) {
    if (next) {
      setDraft(value);
      setExpanded(false);
      setDirtyNotice(false);
      setOpen(true);
      // Cursor lands naturally at the end once mounted.
      window.setTimeout(focusEditorEnd, 0);
      return;
    }
    // Escape is an explicit cancel (discard); every other passive
    // dismissal (outside press, trigger toggle) must NOT silently
    // discard unsaved changes — stay open with a notice instead.
    if (details?.reason === "escape-key") {
      discardAndClose();
      return;
    }
    if (editable && isDirtyDraft(draft, value)) {
      setDirtyNotice(true);
      return;
    }
    setDirtyNotice(false);
    setExpanded(false);
    setOpen(false);
  }

  return (
    <span
      className="block min-w-0"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          render={
            <button
              ref={triggerRef}
              type="button"
              title={editable ? "Click to edit" : "Click to view full text"}
              aria-label={`${fieldLabel} value`}
              className="flex min-h-8 w-full cursor-pointer items-center rounded px-1 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
          }
        >
          <span
            className={cn(
              "min-w-0 flex-1 hover:underline hover:underline-offset-2 hover:decoration-dotted",
              // Wide long-text columns show up to 2 wrapped lines
              // with an ellipsis (visual only — the full value
              // stays in the trigger markup, editor, and DB).
              // Every other column keeps single-line truncation.
              twoLineClamp
                ? "line-clamp-2 leading-[22px] whitespace-normal break-words"
                : "truncate",
              value === "" && "text-muted-foreground",
            )}
          >
            {value}
          </span>
          {edited && (
            <span
              aria-label="Edited"
              title={
                originalValue
                  ? `Edited — original: ${originalValue}`
                  : "Edited"
              }
              className="ml-1 inline-block size-1.5 shrink-0 rounded-full bg-blue-500"
            />
          )}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          className={cn(
            expanded ? "w-[min(94vw,44rem)]" : "w-[min(92vw,24rem)]",
          )}
        >
          <TextEditorPanel
            fieldLabel={fieldLabel}
            draft={draft}
            editable={editable}
            saving={saving}
            expanded={expanded}
            dirtyNotice={dirtyNotice}
            placeholder={placeholder}
            textareaRef={textareaRef}
            originalValue={originalValue}
            showRestore={edited}
            onRestore={() => void handleRestore()}
            onDraftChange={(v) => {
              setDraft(v);
              setDirtyNotice(false);
            }}
            onToggleExpand={() => setExpanded((v) => !v)}
            onCloseRequest={requestClose}
            onCancel={discardAndClose}
            onSave={() => void handleSave()}
          />
        </PopoverContent>
      </Popover>
    </span>
  );
}
