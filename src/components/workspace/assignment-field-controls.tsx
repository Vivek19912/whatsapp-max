"use client";

import { useId, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ChevronDown, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  decodeTemplateKey,
  encodeTemplateKey,
  type TemplateDetail,
} from "./assignment-template-utils";
import { TemplatePreviewEye, TemplatePreviewPopover } from "./template-preview";
import { SearchableSelect } from "./searchable-select";

/** Fixed India country prefix shown beside every assignment phone field. */
export const INDIA_COUNTRY_CODE = "+91";

/**
 * Standard percentage shares offered by the Assignment wizard.
 * Saved legacy values outside this set are preserved as a temporary
 * extra option until the user picks a standard one (never silently
 * rewritten).
 */
export const SHARE_OPTIONS = ["10", "20", "30", "40", "50", "60", "70", "80", "90", "100"] as const;

/**
 * Legacy share label for a saved non-standard value (kept selected
 * and disabled until the user picks a standard share). Null when the
 * value is standard or empty. Pure.
 */
export function legacyShareLabel(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if ((SHARE_OPTIONS as readonly string[]).includes(trimmed)) return null;
  return `${trimmed}% (legacy value)`;
}

/**
 * Percentage share control (Step 1 Add/Edit): one unified control
 * with an editable numeric input, an inside % suffix, and a
 * quick-select chevron. Typing `35` and picking `30%` update the
 * identical draft field. Any whole number from 0 to 100 is accepted
 * (not only multiples of 10); a stored legacy value outside the
 * quick picks is preserved verbatim until the user changes it. The
 * options popover anchors to the input's left edge, stays in the
 * viewport via collision handling, and closes on selection,
 * outside click, or Escape (base Popover dismiss behavior wired
 * through onOpenChange).
 */
export function ShareSelect({
  id,
  value,
  onChange,
  displayName,
  autoFocus,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  displayName: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const trimmed = value.trim();
  const isStandard = (SHARE_OPTIONS as readonly string[]).includes(trimmed);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="flex h-9 w-32 max-w-full items-center rounded-lg border border-border bg-card pr-1 shadow-xs transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40 focus-within:outline-none disabled:opacity-50">
        <Input
          id={id}
          value={trimmed}
          onChange={(e) => {
            // Digits only, max three characters; the commit-time
            // validator enforces the 0–100 integer range.
            onChange(e.target.value.replace(/[^0-9]/g, "").slice(0, 3));
          }}
          placeholder="25"
          inputMode="numeric"
          aria-label={`Share percentage for ${displayName.trim() || "member"}`}
          autoFocus={autoFocus}
          disabled={disabled}
          className="h-full min-w-0 flex-1 border-0 bg-transparent px-2.5 text-left shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        <span className="shrink-0 pr-1 text-sm text-muted-foreground" aria-hidden>
          %
        </span>
        <PopoverTrigger
          aria-label={`Choose a preset share percentage for ${displayName.trim() || "member"}`}
          disabled={disabled}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ChevronDown className="size-4" aria-hidden />
        </PopoverTrigger>
      </div>
      <PopoverContent
        className="w-44 p-1"
        align="start"
        side="bottom"
        sideOffset={4}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        collisionPadding={8}
      >
        <div role="listbox" aria-label="Preset share percentages" className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
          {!isStandard && trimmed !== "" ? (
            // Legacy/custom saved value: shown as-is and kept
            // selected until the user picks a standard share.
            // Never silently rewritten.
            <button
              type="button"
              role="option"
              aria-selected="true"
              disabled
              className="rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground"
            >
              {legacyShareLabel(trimmed)}
            </button>
          ) : null}
          {SHARE_OPTIONS.map((o) => (
            <button
              key={o}
              type="button"
              role="option"
              aria-selected={o === trimmed}
              onClick={() => {
                onChange(o);
                setOpen(false);
              }}
              className={cn(
                "rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                o === trimmed
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {o}%
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Convert a stored value to the digits shown in the India-only
 * field. A stored `+91` + up-to-10-digit value shows just the
 * 10-digit part. Anything else (legacy non-Indian formats) is shown
 * as its raw digits so it is never silently truncated — validation
 * flags it for correction instead.
 */
export function indiaLocalDigits(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (text === "") return "";
  if (/^\+91/.test(text)) return text.slice(3).replace(/\D/g, "");
  return text.replace(/\D/g, "");
}

/**
 * Normalize typed digits to E.164, or null when incomplete/invalid.
 * Always produces `+91` + exactly 10 digits — the country code can
 * never be typed, duplicated, or omitted. Over-long input is
 * rejected (not silently truncated); the input control caps typing
 * separately via {@link capIndiaDigits}.
 */
export function normalizeIndiaMobile(digits: string): string | null {
  const clean = digits.replace(/\D/g, "");
  if (/^\d{10}$/.test(clean)) return `${INDIA_COUNTRY_CODE}${clean}`;
  return null;
}

/**
 * Cap typed input at 10 subscriber digits. A legacy saved value
 * longer than that stays visible until edited (validation flags it
 * first), so nothing is ever silently truncated.
 */
export function capIndiaDigits(digits: string): string {
  return digits.replace(/\D/g, "").slice(0, 10);
}

/**
 * India-only phone field: fixed non-editable +91 prefix, 10-digit
 * numeric input. Emits E.164 (`+91` + digits, partial while typing)
 * so the existing E.164 validators flag incomplete entries; emits
 * "" when cleared.
 */
export function IndiaPhoneInput({
  id,
  value,
  onChange,
  disabled,
  placeholder = "98765 43210",
  ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (e164OrEmpty: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel: string;
}) {
  const local = indiaLocalDigits(value);
  return (
    <div className="flex items-center gap-1.5">
      <span
        aria-hidden
        className="flex h-9 shrink-0 items-center rounded-lg border border-border bg-muted px-2.5 text-sm font-medium text-muted-foreground select-none"
      >
        {INDIA_COUNTRY_CODE}
      </span>
      <Input
        id={id}
        value={local}
        onChange={(e) => {
          const digits = capIndiaDigits(e.target.value);
          if (digits === "") {
            onChange("");
            return;
          }
          // Partial entries stay namespaced under +91; validators
          // reject them as incomplete until 10 digits are present.
          onChange(`${INDIA_COUNTRY_CODE}${digits}`);
        }}
        placeholder={placeholder}
        inputMode="numeric"
        autoComplete="tel-national"
        aria-label={ariaLabel}
        disabled={disabled}
        className="min-w-0 flex-1"
      />
    </div>
  );
}

export interface ExtraNumberDraft {
  phone: string;
  template_name: string;
  template_language: string;
}

/**
 * Per-salesperson extra WhatsApp numbers with per-number template
 * overrides. Operates on the same `whatsapp_numbers` shape the
 * assignment API persists — no new storage, no new table.
 */
export function WhatsappNumbersEditor({
  numbers,
  onChange,
  templateOptions,
  templateDetails,
  disabled,
  assigneeName,
  maxNumbers,
}: {
  numbers: ExtraNumberDraft[];
  onChange: (numbers: ExtraNumberDraft[]) => void;
  templateOptions: Array<{ value: string; label: string; hint?: string | null }>;
  templateDetails: ReadonlyMap<string, TemplateDetail>;
  disabled?: boolean;
  assigneeName: string;
  maxNumbers: number;
}) {
  const describedBy = useId();
  return (
    <div className="flex flex-col gap-2">
      <span id={describedBy} className="text-xs font-medium text-foreground">
        WhatsApp numbers
      </span>
      {numbers.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No extra numbers — alerts use the primary number above.
        </p>
      ) : null}
      {numbers.map((n, i) => {
        const templateKey =
          n.template_name.trim() === ""
            ? ""
            : encodeTemplateKey({
                name: n.template_name.trim(),
                language: n.template_language.trim() || "en_US",
              });
        const detail = templateKey !== "" ? (templateDetails.get(templateKey) ?? null) : null;
        return (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-lg border border-border p-2 sm:flex-row sm:items-start"
            aria-label={`Extra WhatsApp number ${i + 1} for ${assigneeName}`}
          >
            <div className="min-w-0 flex-1">
              <IndiaPhoneInput
                value={n.phone}
                onChange={(phone) =>
                  onChange(numbers.map((m, j) => (j === i ? { ...m, phone } : m)))
                }
                ariaLabel={`Extra WhatsApp number ${i + 1} for ${assigneeName}`}
                disabled={disabled}
              />
            </div>
            <div className="min-w-0 flex-1">
              <SearchableSelect
                value={templateKey}
                options={templateOptions}
                onChange={(v) => {
                  const parsed = decodeTemplateKey(v);
                  onChange(
                    numbers.map((m, j) =>
                      j === i
                        ? {
                            ...m,
                            template_name: parsed ? parsed.name : "",
                            template_language: parsed ? parsed.language : "en_US",
                          }
                        : m,
                    ),
                  );
                }}
                placeholder="Table default template"
                searchPlaceholder="Search templates…"
                emptyText="No approved templates found."
                ariaLabel={`Template for extra WhatsApp number ${i + 1} for ${assigneeName}`}
                disabled={disabled}
                renderOptionPreview={(o) => {
                  const d = templateDetails.get(o.value) ?? null;
                  if (!d) return null;
                  return (
                    <TemplatePreviewPopover detail={d} label={`Preview template ${d.name}`}>
                      <TemplatePreviewEye label={`Preview template ${d.name}`} />
                    </TemplatePreviewPopover>
                  );
                }}
              />
              {detail ? (
                <p className="mt-1 truncate text-xs text-muted-foreground" title={detail.bodyText}>
                  {detail.bodyText.slice(0, 80)}
                  {detail.bodyText.length > 80 ? "…" : ""}
                </p>
              ) : templateKey !== "" ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Preview unavailable for this template.
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Empty template = this table&apos;s default WhatsApp template at send time.
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove extra WhatsApp number ${i + 1}`}
              disabled={disabled}
              onClick={() => onChange(numbers.filter((_, j) => j !== i))}
              className={cn("h-9 w-9 shrink-0 self-end px-0 text-destructive sm:self-start")}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        );
      })}
      {numbers.length < maxNumbers ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={disabled}
          onClick={() =>
            onChange([...numbers, { phone: "", template_name: "", template_language: "en_US" }])
          }
        >
          + Add WhatsApp Number
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          Maximum {maxNumbers} WhatsApp numbers per assignee.
        </p>
      )}
    </div>
  );
}
