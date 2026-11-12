"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Check, Eye, Loader2, Pause, Play, Plus, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  ConfigDialog,
  ConfigSection,
  ConfigStatusBadge,
} from "./config-dialog";
import { SearchableSelect } from "./searchable-select";
import { AssigneeSequenceEditor, type SequenceFieldDef, type SequenceItem, type SequenceTemplateOption } from "./assignee-sequence-editor";
import {
  IndiaPhoneInput,
  ShareSelect,
  WhatsappNumbersEditor,
} from "./assignment-field-controls";
import { ASSIGNMENT_TIMEZONE } from "@/lib/lead-assignment/table-validation";
import { salespersonKeyFor } from "@/lib/meta-lead-whatsapp/assignee-sequences";

/** "29 Oct, 5:00 PM IST" from a stored UTC instant (display only). */
function formatPausedUntilFull(iso: string): string {  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ASSIGNMENT_TIMEZONE,
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("day")} ${get("month")}, ${get("hour")}:${get("minute")} ${get("dayPeriod")} IST`.replace("  ", " ");
  } catch {
    return iso;
  }
}

/**
 * Display an alert-delivery Detail value: ISO timestamps render as
 * `DD-MM-YYYY hh:mm AM/PM` in Asia/Kolkata; everything else
 * (template errors, "retrying", empty) passes through byte-for-byte
 * so non-date details are never mangled. Pure.
 */
export function formatDeliveryDetail(value: string | null | undefined): string {
  if (!value) return value ?? "";
  const text = value.trim();
  // Only reformat ISO-like timestamps — never guess at error text.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return value;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return value;
  try {
    const parts = new Intl.DateTimeFormat("en-IN", {
      timeZone: ASSIGNMENT_TIMEZONE,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(new Date(at));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const dayPeriod = get("dayPeriod").toUpperCase();
    const date = `${get("day")}-${get("month")}-${get("year")}`;
    const time = `${get("hour")}:${get("minute")}`;
    if (!get("day") || !get("month") || !get("year") || !get("hour") || !get("minute")) {
      return value;
    }
    return dayPeriod ? `${date} ${time} ${dayPeriod}` : `${date} ${time}`;
  } catch {
    return value;
  }
}

/**
 * One Recent alert deliveries Detail cell. A tiny component (rather
 * than inline JSX) so the ISO→IST formatting is covered by a
 * render test: if this cell ever stops calling
 * formatDeliveryDetail, the rendered HTML regresses to raw ISO and
 * the test fails. Pure presentation — no fetching or mutation.
 */
export function AssignmentDeliveryDetailCell({
  notification,
}: {
  notification: Pick<NotificationRow, "status" | "sent_at" | "last_error">;
}) {
  const detail = formatDeliveryDetail(
    notification.status === "sent" ? notification.sent_at : notification.last_error ?? "retrying",
  );
  return (
    <TableCell className="text-muted-foreground max-w-64 truncate text-xs" title={detail}>
      {detail}
    </TableCell>
  );
}

/**
 * Maximum WhatsApp numbers per assignee in the editor (mirrors the
 * server cap in table-validation.ts — the server re-validates).
 */
export const MAX_WHATSAPP_NUMBERS_PER_ASSIGNEE = 10;

/**
 * Normalize a phone input the India-only way required across the
 * Assignment wizard: strip spaces/dashes/parens/dots, then accept
 * only `+91` followed by exactly 10 digits. Users never type the
 * country code (the UI pins it); a bare 10-digit entry without the
 * prefix is rejected so a missing +91 can never slip through.
 * Returns the E.164 number or null. Pure.
 */
export function normalizeWhatsappNumberInput(raw: string): string | null {
  const stripped = raw.replace(/[\s\-().]/g, "");
  const match = /^\+91(\d{10})$/.exec(stripped);
  if (!match) return null;
  return `+91${match[1]}`;
}

/**
 * Validate an assignee draft's extra WhatsApp numbers: cap, E.164
 * shape, and no duplicates (including against the draft's legacy
 * `phone` field). Returns the first problem or null. Pure.
 */
export function validateWhatsappNumberDrafts(
  numbers: ReadonlyArray<{ phone: string }>,
  legacyPhone: string,
  displayName: string,
): string | null {
  if (numbers.length > MAX_WHATSAPP_NUMBERS_PER_ASSIGNEE) {
    return `${displayName}: at most ${MAX_WHATSAPP_NUMBERS_PER_ASSIGNEE} WhatsApp numbers per assignee.`;
  }
  const seen = new Set<string>();
  const legacy = normalizeWhatsappNumberInput(legacyPhone);
  if (legacy) seen.add(legacy);
  for (let i = 0; i < numbers.length; i++) {
    const normalized = normalizeWhatsappNumberInput(numbers[i]?.phone ?? "");
    if (!normalized) {
      return `${displayName}: WhatsApp number ${i + 1} is invalid. Use international format with country code, e.g. +911234567890.`;
    }
    if (seen.has(normalized)) {
      return `${displayName}: ${normalized} is already configured for this assignee.`;
    }
    seen.add(normalized);
  }
  return null;
}

/**
 * Saved assignees for per-row lookups. The unconfigured-table GET
 * response omits `assignees`; anything iterating it must go
 * through here instead of crashing the render the moment a local
 * draft exists. Pure.
 */
export function payloadAssignees(
  payload: AssignmentPayload | null | undefined,
): AssigneeView[] {
  return Array.isArray(payload?.assignees) ? payload.assignees : [];
}

/**
 * Resolve the `enabled` flag to persist on save.
 *
 * New configurations (no persisted config yet) with at least one
 * active assignee and no weight error activate automatically — the
 * user never needs a separate toggle. Invalid drafts stay paused.
 * Existing configurations always preserve their persisted state so
 * ordinary settings edits never flip activation — except an
 * explicitly saved EMPTY roster, which stays enabled so the table
 * engine (not the legacy global rule) owns new leads as
 * unassigned. Without this, disabling the table would hand leads
 * back to the legacy fallback and reassign members that were just
 * removed. Pure.
 */
export function resolveEnabledOnSave(args: {
  isNew: boolean;
  persistedEnabled: boolean;
  hasActiveAssignee: boolean;
  weightInvalid: boolean;
  /** True when the user explicitly saved with zero assignees. */
  explicitEmpty?: boolean;
}): boolean {
  if (args.explicitEmpty) return true;
  if (!args.isNew) return args.persistedEnabled;
  if (!args.hasActiveAssignee) return false;
  if (args.weightInvalid) return false;
  return true;
}

/** One send-eligible WhatsApp template from the templates endpoint. */
export type { AssignmentTemplateOption } from "./assignment-template-utils";
import type { AssignmentTemplateOption } from "./assignment-template-utils";
import {
  decodeTemplateKey,
  encodeTemplateKey,
  isTemplateSelectionValid,
  toTemplateDetails,
  toTemplateOptions,
  type TemplateDetail,
} from "./assignment-template-utils";
import {
  TemplatePreviewCard,
  TemplatePreviewEye,
  TemplatePreviewPopover,
} from "./template-preview";
export {
  decodeTemplateKey,
  encodeTemplateKey,
  formatTemplateCategory,
  isTemplateSelectionValid,
  toTemplateOptions,
} from "./assignment-template-utils";

/**
 * Per-table Lead Assignment settings (Meta Lead Ads tables and
 * Flow tables alike). Opened from the Workspace header via
 * "Assignment". One compact single-panel dialog: status,
 * distribution method, assignees, pauses, and notification
 * preferences live in sections (no step flow). All times are
 * Indian Standard Time. Every read and write is scoped to this
 * table server-side.
 */

interface AssigneeView {
  id: string;
  user_id: string | null;
  display_name: string;
  email: string | null;
  phone: string | null;
  /**
   * Extra WhatsApp recipients, each with its own template.
   * Empty = legacy single-number behavior.
   */
  whatsapp_numbers: Array<{
    phone: string;
    template_name: string | null;
    template_language: string;
  }>;
  position: number;
  weight: number;
  is_active: boolean;
  paused_until: string | null;
  pause_reason: string | null;
  pause_scope: "table" | "account";
  notify_email: boolean;
  notify_whatsapp: boolean;
  available: boolean;
  unavailable_reason: "active" | "paused" | "ineligible-member" | null;
  status_label: string;
}

interface AssignmentPayload {
  flow: { id: string; kind: string; form_db_id: string | null };
  config: {
    id: string;
    enabled: boolean;
    mode: "round_robin" | "percentage";
    timezone: string;
    whatsapp_template_name: string | null;
    whatsapp_template_language: string;
  } | null;
  assignees: AssigneeView[];
}

interface RosterMember {
  user_id: string;
  full_name: string | null;
  email: string | null;
  role: string;
}

interface NotificationRow {
  id: string;
  channel: string;
  to_email: string | null;
  to_phone: string | null;
  subject: string | null;
  status: string;
  attempt: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
}

/** One salesperson's customer-facing sequence draft (delay is a raw input string). */
interface SequenceDraft {
  delay_seconds: string;
  items: SequenceItem[];
}

type Draft = {
  key: string;
  user_id: string | null;
  display_name: string;
  email: string;
  phone: string;
  /**
   * Extra WhatsApp numbers for this assignee. `template_name`
   * empty = this table's default WhatsApp template at send time.
   */
  whatsapp_numbers: Array<{
    phone: string;
    template_name: string;
    template_language: string;
  }>;
  weight: string;
  is_active: boolean;
  notify_email: boolean;
  notify_whatsapp: boolean;
  /** Customer-facing sequence for this salesperson (Meta tables only); null = not loaded. */
  sequence: SequenceDraft | null;
  /** True once the user edited the sequence (must be persisted on save). */
  sequenceDirty: boolean;
  /** The salesperson key `sequence` was loaded for (dedupes re-fetches). */
  sequenceLoadedKey: string | null;
};

/** Stable salesperson key for a draft (shared with the assignment engine). */
function draftKey(d: { user_id: string | null; email: string; phone: string }): string | null {
  return salespersonKeyFor({
    user_id: d.user_id,
    email: d.email || null,
    phone: d.phone || null,
  });
}

/**
 * Compact avatar for the member list: initials on a tinted circle.
 * Pure presentation — no images, no extra requests.
 */
function MemberInitials({ name }: { name: string }) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
    >
      {initials}
    </span>
  );
}

/**
 * One-line customer-sequence status for the "Messages to leads"
 * section and the inline member editor: how many templates the
 * salesperson will send a newly assigned lead, or that none is
 * configured. Pure.
 */
export function sequenceStatusText(draft: {
  sequence: { items: unknown[] } | null;
}): string {
  if (!draft.sequence) return "No sequence configured";
  if (draft.sequence.items.length === 0) return "No sequence configured";
  return `Sequence configured · ${draft.sequence.items.length} template${draft.sequence.items.length === 1 ? "" : "s"}`;
}

const emptyDraft = (): Draft => ({
  key: `new-${Date.now()}`,
  user_id: null,
  display_name: "",
  email: "",
  phone: "",
  whatsapp_numbers: [],
  weight: "0",
  is_active: true,
  // Email notifications default OFF — the user opts in per
  // salesperson in Step 2. A roster email never auto-enables them.
  notify_email: false,
  notify_whatsapp: false,
  sequence: null,
  sequenceDirty: false,
  sequenceLoadedKey: null,
});

/**
 * Validate the open assignee editor exactly the way Done does:
 * display name required, some contact channel required, no duplicate
 * team link. Returns the user-facing error or null. Pure.
 */
export function validateAssigneeForm(
  form: Pick<Draft, "key" | "user_id" | "display_name" | "email" | "phone">,
  drafts: ReadonlyArray<Pick<Draft, "key" | "user_id">>,
): string | null {
  if (!form.display_name.trim()) {
    return "Give the assignee a display name.";
  }
  if (!form.user_id && !form.email.trim() && !form.phone.trim()) {
    return "Link a team member or enter an email address or phone number.";
  }
  if (form.user_id) {
    const clash = drafts.some(
      (d) => d.key !== form.key && d.user_id === form.user_id,
    );
    if (clash) {
      return "That team member is already on this table.";
    }
  }
  return null;
}

/**
 * True when the Add panel was opened but nothing was typed — saving
 * must silently disregard it rather than block on an empty form.
 * Pure.
 */
export function isPristineNewAssigneeForm(
  form: Pick<
    Draft,
    "user_id" | "display_name" | "email" | "phone" | "whatsapp_numbers"
  >,
): boolean {
  return (
    !form.user_id &&
    form.display_name.trim() === "" &&
    form.email.trim() === "" &&
    form.phone.trim() === "" &&
    form.whatsapp_numbers.length === 0
  );
}

/**
 * Merge the open editor form into the draft list (what Done does),
 * computed synchronously so Save can validate + submit the merged
 * list in the same tick instead of validating the stale drafts while
 * the panel is open. Caller must run validateAssigneeForm first.
 * `newKey` is used for the "__new__" case. Pure.
 */
export function mergeOpenFormEdit<T extends { key: string }>(
  drafts: T[],
  editingKey: string | null,
  form: T,
  newKey: string,
): T[] {
  if (editingKey === "__new__") {
    return [...drafts, { ...form, key: newKey }];
  }
  return drafts.map((d) => (d.key === form.key ? { ...form } : d));
}

/**
 * The wizard's four logical stages. A single authoritative assignment
 * draft (drafts + mode + notify + template + sequences) flows through
 * all four — steps never keep parallel copies of any field.
 */
export type AssignmentStep = "assign" | "notify" | "sequences" | "review";

export const ASSIGNMENT_STEPS: ReadonlyArray<{ key: AssignmentStep; label: string }> = [
  { key: "assign", label: "Team Members & Allocation" },
  { key: "notify", label: "Salesperson Notifications" },
  { key: "sequences", label: "WhatsApp Template to Lead" },
  { key: "review", label: "Review & Save" },
];

/** Minimal shape validateAssignStep needs (Draft-compatible). */
export type AssignStepDraft = Pick<Draft, "key" | "is_active" | "weight">;

/**
 * Validate STEP 1 (assign): an empty roster is a valid intentional
 * configuration (new leads stay Unassigned until members are added),
 * so zero members passes. With members present: at least one must
 * be eligible (active), and — for percentage mode — active shares
 * must total exactly 100%. Returns the user-facing error or null.
 * Pure.
 */
export function validateAssignStep(
  drafts: ReadonlyArray<AssignStepDraft>,
  mode: "round_robin" | "percentage",
): string | null {
  if (drafts.length === 0) {
    return null;
  }
  if (!drafts.some((d) => d.is_active)) {
    return "At least one included member is required — every included member receives new leads.";
  }
  if (mode === "percentage") {
    const total = drafts
      .filter((d) => d.is_active)
      .reduce((sum, d) => sum + (Number.parseInt(d.weight, 10) || 0), 0);
    if (total !== 100) {
      return `Active percentages must total exactly 100% (currently ${total}%).`;
    }
  }
  return null;
}

/** Minimal shape validateNotifyStep needs (Draft-compatible). */
export type NotifyStepDraft = Pick<
  Draft,
  | "display_name"
  | "user_id"
  | "email"
  | "phone"
  | "whatsapp_numbers"
  | "notify_email"
  | "sequence"
  | "sequenceDirty"
>;

/**
 * Validate the customer-sequence step (sequences): every edited
 * customer sequence carries a sane delay. Returns the first problem
 * or null. Pure — the delay bounds mirror validateNotifyStep's
 * sequence check so both gates stay identical.
 */
export function validateSequencesStep(args: {
  drafts: ReadonlyArray<NotifyStepDraft>;
  isMetaTable: boolean;
}): string | null {
  if (!args.isMetaTable) return null;
  for (const d of args.drafts) {
    if (!d.sequenceDirty || !d.sequence || d.sequence.items.length === 0) continue;
    const delayNum = Number(d.sequence.delay_seconds);
    if (!Number.isInteger(delayNum) || delayNum < 0 || delayNum > 86400) {
      return "Delay must be a whole number of seconds between 0 and 86400.";
    }
  }
  return null;
}

/**
 * Validate one typed or picked share percentage (Step 1 Add/Edit).
 * Any whole number from 0 to 100 is accepted — values are not
 * restricted to multiples of 10, so 15%, 35%, 65% etc. are valid.
 * Returns the user-facing error or null. Pure. Used both by the
 * inline commit and by tests covering manual entry.
 */
export function validateShareValue(weight: string, displayName: string): string | null {
  const share = Number.parseInt(weight, 10);
  if (weight.trim() === "" || !Number.isInteger(share) || share < 0 || share > 100) {
    return `Enter a share percentage between 0 and 100 for "${displayName.trim() || "Unnamed assignee"}".`;
  }
  return null;
}

/**
 * Validate the member form for the Step 1 (members) context: only the
 * team-link uniqueness is enforced here. Display name, email and phone
 * are collected in Step 2 (notification cards), so Step 1 must not
 * block on them. Full validation still runs on commit elsewhere and
 * at save time.
 */
export function validateMemberStep1(
  form: Pick<Draft, "key" | "user_id">,
  drafts: ReadonlyArray<Pick<Draft, "key" | "user_id">>,
): string | null {
  if (form.user_id) {
    const clash = drafts.some(
      (d) => d.key !== form.key && d.user_id === form.user_id,
    );
    if (clash) {
      return "That team member is already on this table.";
    }
  }
  return null;
}

/**
 * Validate the notification step: team template selected when
 * enabled (and still approved), every email alert has a reachable
 * recipient, every phone number is valid E.164, and — when
 * `checkSequences` is set — edited customer sequences carry a sane
 * delay. Returns the first problem or null. Pure — the same function
 * gates Continue and the final save. External contacts (no linked
 * member) must always carry a display name, since nothing else
 * identifies them.
 */
export function validateNotifyStep(args: {
  notifyEnabled: boolean;
  templateName: string;
  templateStale: boolean;
  drafts: ReadonlyArray<NotifyStepDraft>;
  rosterEmailFor: (userId: string | null) => string;
  checkSequences: boolean;
}): string | null {
  if (args.notifyEnabled && args.templateName.trim() === "") {
    return "Choose a notification template or turn notifications off.";
  }
  if (args.notifyEnabled && args.templateStale) {
    return `Template "${args.templateName.trim()}" is no longer approved or available — choose a replacement before saving.`;
  }
  for (const d of args.drafts) {
    const name = d.display_name.trim() || "Unnamed assignee";
    // External contacts have no linked member identity — they always
    // need an entered display name (collected in Step 2).
    if (!d.user_id && d.display_name.trim() === "") {
      return "Give each external contact a display name in Step 2.";
    }
    if (d.notify_email && d.email.trim() === "" && !args.rosterEmailFor(d.user_id)) {
      return `Email alerts are on for "${name}" but there is no email address — enter one or turn Email alerts off.`;
    }
    if (d.phone.trim() !== "" && !normalizeWhatsappNumberInput(d.phone)) {
      return `${name}: phone number is invalid. Use international format with country code, e.g. +911234567890.`;
    }
    const numbersError = validateWhatsappNumberDrafts(
      d.whatsapp_numbers,
      d.phone,
      name,
    );
    if (numbersError) return numbersError;
  }
  if (args.checkSequences) {
    for (const d of args.drafts) {
      if (!d.sequenceDirty || !d.sequence || d.sequence.items.length === 0) continue;
      const delayNum = Number(d.sequence.delay_seconds);
      if (!Number.isInteger(delayNum) || delayNum < 0 || delayNum > 86400) {
        return "Delay must be a whole number of seconds between 0 and 86400.";
      }
    }
  }
  return null;
}

/**
 * Step progress indicator for the wizard header: current step (blue),
 * completed steps (green check, clickable to go back), upcoming steps
 * (neutral gray). Pure presentation.
 *
 * `layout="horizontal"` renders the legacy top stepper (kept as the
 * compact fallback on small screens); `layout="vertical"` renders the
 * persistent left-sidebar navigation. Both share the same step order,
 * completion state, and go-back-only interaction.
 */
export function AssignmentStepper({
  step,
  completedSteps,
  onStepClick,
  layout = "horizontal",
  invalidSteps = [],
}: {
  step: AssignmentStep;
  completedSteps: ReadonlyArray<AssignmentStep>;
  onStepClick?: (target: AssignmentStep) => void;
  layout?: "horizontal" | "vertical";
  /** Steps failing validation — shown with an error dot, still navigable back. */
  invalidSteps?: ReadonlyArray<AssignmentStep>;
}) {
  const order: AssignmentStep[] = ["assign", "notify", "sequences", "review"];
  const activeIndex = order.indexOf(step);
  if (layout === "vertical") {
    return (
      <nav aria-label="Assignment progress">
        <ol className="flex flex-col gap-1">
          {ASSIGNMENT_STEPS.map((s) => {
            const index = order.indexOf(s.key);
            const completed = completedSteps.includes(s.key);
            const current = s.key === step;
            const invalid = invalidSteps.includes(s.key);
            const clickable = !current && index < activeIndex && completed && !!onStepClick;
            const circleClass = current
              ? "bg-primary text-primary-foreground"
              : completed
                ? "bg-emerald-500 text-white"
                : "bg-muted text-muted-foreground";
            const content =
              current || !completed ? (
                <span aria-hidden>{index + 1}</span>
              ) : (
                <Check aria-hidden className="size-3.5" />
              );
            const inner = (
              <>
                <span
                  aria-hidden
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${circleClass}`}
                >
                  {content}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-sm font-medium ${current ? "text-foreground" : "text-muted-foreground"}`}>
                    {s.label}
                  </span>
                  <span className="sr-only">{`Step ${index + 1}: ${s.label}${current ? " (current step)" : completed ? " (completed)" : ""}${invalid ? " (needs attention)" : ""}`}</span>
                  {invalid && !current ? (
                    <span className="block text-xs font-medium text-destructive">Needs attention</span>
                  ) : null}
                </span>
              </>
            );
            return (
              <li key={s.key} data-step={s.key}>
                {clickable ? (
                  <button
                    type="button"
                    onClick={() => onStepClick?.(s.key)}
                    aria-label={`Go back to Step ${index + 1}: ${s.label}`}
                    aria-current={current ? "step" : undefined}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-muted/60"
                  >
                    {inner}
                  </button>
                ) : (
                  <span
                    aria-current={current ? "step" : undefined}
                    aria-label={current ? `Step ${index + 1}: ${s.label} (current step)` : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 ${current ? "bg-primary/10" : ""}`}
                  >
                    {inner}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    );
  }
  return (
    <ol aria-label="Assignment progress" className="flex items-center gap-1 sm:gap-2">
      {ASSIGNMENT_STEPS.map((s, i) => {
        const index = order.indexOf(s.key);
        const completed = completedSteps.includes(s.key);
        const current = s.key === step;
        const clickable = !current && index < activeIndex && completed && !!onStepClick;
        const circleClass = current
          ? "bg-primary text-primary-foreground"
          : completed
            ? "bg-emerald-500 text-white"
            : "bg-muted text-muted-foreground";
        const content =
          current || !completed ? (
            <span aria-hidden>{index + 1}</span>
          ) : (
            <Check aria-hidden className="size-3.5" />
          );
        const inner = (
          <>
            <span
              aria-hidden
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${circleClass}`}
            >
              {content}
            </span>
            <span
              className={`hidden text-xs font-medium sm:inline ${current ? "text-foreground" : "text-muted-foreground"}`}
            >
              {s.label}
            </span>
            <span className="sr-only">{`Step ${index + 1}: ${s.label}${current ? " (current step)" : completed ? " (completed)" : ""}`}</span>
          </>
        );
        return (
          <li key={s.key} data-step={s.key} className="flex items-center gap-1 sm:gap-2">
            {i > 0 ? (
              <span aria-hidden className={`h-px w-4 sm:w-8 ${index <= activeIndex ? "bg-primary/60" : "bg-border"}`} />
            ) : null}
            {clickable ? (
              <button
                type="button"
                onClick={() => onStepClick?.(s.key)}
                aria-label={`Go back to Step ${index + 1}: ${s.label}`}
                className="flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-muted/60"
              >
                {inner}
              </button>
            ) : (
              <span
                aria-current={current ? "step" : undefined}
                aria-label={current ? `Step ${index + 1}: ${s.label} (current step)` : undefined}
                className="flex items-center gap-1.5 px-1 py-0.5"
              >
                {inner}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Mask an email for review display (`priya@example.com` →
 * `p***@example.com`). Falls back to a dash for empty values. Pure.
 */
export function maskContactEmail(email: string | null | undefined): string {
  const trimmed = (email ?? "").trim();
  if (!trimmed) return "—";
  const at = trimmed.indexOf("@");
  if (at <= 0) return "—";
  return `${trimmed[0]}***${trimmed.slice(at)}`;
}

/**
 * Mask a phone number for review display (`+911234567890` →
 * `+91****7890`). Falls back to a dash for empty values. Pure.
 */
export function maskContactPhone(phone: string | null | undefined): string {
  const trimmed = (phone ?? "").trim();
  if (trimmed.length < 4) return trimmed === "" ? "—" : "••••";
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`;
}

/**
 * Read-only review summary of the complete draft: distribution,
 * members, per-salesperson notification settings, customer
 * sequences, and the activation state. Pure presentation — values
 * come from the live draft so the review can never drift from what
 * Save submits.
 */
export function AssignmentReviewSummary({
  mode,
  drafts,
  activeWeightTotal,
  notifyEnabled,
  templateName,
  templateLanguage,
  enabled,
  isNew,
}: {
  mode: "round_robin" | "percentage";
  drafts: ReadonlyArray<
    Pick<Draft, "display_name" | "weight" | "is_active" | "notify_email" | "sequence"> &
      Partial<Pick<Draft, "user_id" | "email" | "phone" | "notify_whatsapp" | "whatsapp_numbers">>
  >;
  activeWeightTotal: number;
  notifyEnabled: boolean;
  templateName: string;
  templateLanguage: string;
  enabled: boolean;
  isNew: boolean;
}) {
  const emailOn = drafts.filter((d) => d.notify_email).length;
  const whatsappOn = drafts.filter((d) => d.notify_whatsapp === true).length;
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Review assignment">
        <p className="text-sm font-semibold text-foreground">Assignment</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Distribution method: {mode === "percentage" ? "Percentage-based" : "Round robin"}
          {mode === "percentage" ? ` · Total allocation: ${activeWeightTotal}%` : ""}
        </p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {drafts.map((d, i) => (
            <li
              key={`${d.display_name}-${i}`}
              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <MemberInitials name={d.display_name} />
                <span className="truncate font-medium text-foreground">
                  {d.display_name || "—"}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {mode === "percentage" ? `${d.weight}% · ` : ""}
                {d.is_active ? "Receives new leads" : "Paused"}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Review notifications">
        <p className="text-sm font-semibold text-foreground">Salesperson Notifications</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Team WhatsApp notifications: {notifyEnabled ? "Enabled" : "Disabled"}
          {notifyEnabled && templateName.trim() !== ""
            ? ` · Template: ${templateName.trim()}${templateLanguage.trim() ? ` (${templateLanguage.trim()})` : ""}`
            : ""}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Email notifications: {emailOn === 0 ? "Disabled" : `${emailOn} of ${drafts.length} members`}
          {` · WhatsApp notifications: ${whatsappOn === 0 ? "Disabled" : `${whatsappOn} of ${drafts.length} members`}`}
        </p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {drafts.map((d, i) => {
            const extraNumbers = (d.whatsapp_numbers ?? [])
              .map((n) => n.phone.trim())
              .filter(Boolean);
            return (
              <li
                key={`${d.display_name}-${i}`}
                className="rounded-lg border border-border bg-card px-3 py-2 text-xs"
              >
                <p className="truncate text-sm font-medium text-foreground">
                  {d.display_name || "—"}
                </p>
                <p className="mt-0.5 break-words text-muted-foreground" title={d.email?.trim() || undefined}>
                  Email: {d.notify_email ? `On${d.email?.trim() ? ` (${d.email.trim()})` : d.user_id ? " (roster email)" : ""}` : "Off"}
                </p>
                <p className="mt-0.5 break-words text-muted-foreground" title={d.phone?.trim() || undefined}>
                  WhatsApp: {d.notify_whatsapp === true ? `On${d.phone?.trim() ? ` (${d.phone.trim()})` : ""}` : "Off"}
                  {extraNumbers.length > 0 ? ` · Also: ${extraNumbers.join(", ")}` : ""}
                </p>
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-label="Review customer messages">
        <p className="text-sm font-semibold text-foreground">WhatsApp Template to Lead</p>
        <ul className="mt-1 flex flex-col gap-1">
          {drafts.map((d, i) => (
            <li key={`${d.display_name}-${i}`} className="text-xs text-muted-foreground">
              {d.display_name || "—"} —{" "}
              {d.sequence && d.sequence.items.length > 0
                ? `${d.sequence.items.length} message${d.sequence.items.length === 1 ? "" : "s"} configured`
                : "No sequence configured"}
              {d.sequence && d.sequence.items.length > 0
                ? ` · Templates: ${d.sequence.items.map((t) => t.template_name).join(", ")} · Delay ${d.sequence.delay_seconds}s`
                : ""}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Review activation">
        <p className="text-sm font-semibold text-foreground">Activation</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Status: {enabled ? "Active" : "Paused"}
          {isNew && enabled ? " — this assignment activates on save." : ""}
          {isNew && !enabled ? " — resolve the errors above to activate on save." : ""}
        </p>
      </section>
    </div>
  );
}

export function TableAssignmentDialog({
  flowId,
  flowName,
  tableKind,
  open,
  onOpenChange,
  viewMode = false,
}: {
  flowId: string;
  flowName?: string | null;
  tableKind?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Read-only inspection: every input is disabled, every
   * mutating button is hidden, the footer offers Close only, and
   * the save/pause submitters refuse to run. Saved
   * configuration still renders exactly as stored.
   */
  viewMode?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [payload, setPayload] = useState<AssignmentPayload | null>(null);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<"round_robin" | "percentage">("round_robin");
  const [templateName, setTemplateName] = useState("");
  const [templateLanguage, setTemplateLanguage] = useState("");
  // Send-eligible templates for the picker: null until the first
  // load resolves (unknown), [] when the account has none.
  const [templates, setTemplates] = useState<readonly AssignmentTemplateOption[] | null>(null);
  const [templateDetails, setTemplateDetails] = useState<ReadonlyMap<string, TemplateDetail>>(new Map());
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [senderConnected, setSenderConnected] = useState<boolean | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  // Individual salesperson WhatsApp switches are the single source
  // of truth — there is no master on/off. The shared template below
  // shows whenever at least one salesperson has WhatsApp alerts on;
  // a saved template stays in memory when all are off so
  // re-enabling restores the previous pick (saving while all off
  // persists a null template, as before).
  const notifyEnabled = drafts.some((d) => d.notify_whatsapp);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [form, setForm] = useState<Draft>(emptyDraft());
  // Inline member editor disclosure (everything lives in this one
  // dialog — no Sheet, no drawer, no nested modal). Add opens with
  // only the essential fields visible; Edit reveals the advanced
  // toggle. Advanced groups stay collapsed until explicitly opened.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [openGroup, setOpenGroup] = useState<null | "contact" | "notify" | "avail" | "msg">(null);
  // Two-click inline remove confirmation (no modal): first click arms
  // the row, second click removes the draft. Closing or saving the
  // dialog without saving discards everything anyway.
  const [confirmRemoveKey, setConfirmRemoveKey] = useState<string | null>(null);
  // Wizard navigation: exactly one step's content renders at a time.
  // The single authoritative draft (drafts + mode + notify +
  // template + sequences) is shared across steps — Continue commits
  // the open editor, validates the step, then advances.
  const [step, setStep] = useState<AssignmentStep>("assign");
  const [completedSteps, setCompletedSteps] = useState<AssignmentStep[]>([]);
  // Which inline-editor slot owns the open editor: the STEP 1 member
  // list, the STEP 2 message list, or the STEP 2 advanced list. One
  // editor is ever open, so only that slot renders it.
  const [editorSlot, setEditorSlot] = useState<"members" | "messages" | "advanced">("members");
  // Collapsed "Advanced notification settings" disclosure in STEP 2.
  const [showStepAdvanced, setShowStepAdvanced] = useState(false);
  // Inline preview of the selected notification template (name,
  // language, category, status — the picker endpoint carries no body
  // text, so details are the honest preview).
  const [templatePreviewOpen, setTemplatePreviewOpen] = useState(false);
  const [pauseFor, setPauseFor] = useState<string | null>(null);
  const [pauseMode, setPauseMode] = useState<"today" | "days" | "until" | "resume">("today");
  const [pauseDays, setPauseDays] = useState("1");
  const [pauseUntil, setPauseUntil] = useState("");
  const [pauseReason, setPauseReason] = useState("");
  const [pauseScope, setPauseScope] = useState<"table" | "account">("table");
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Customer-facing sequence support (Meta Lead Ads tables only —
  // Flow Tables never resolve the config endpoint). The catalog
  // (approved templates + slots + fields) is loaded once per open;
  // each salesperson's saved sequence is loaded and attached to
  // its draft so View mode can render order + metadata read-only.
  const [sequenceCatalog, setSequenceCatalog] = useState<{
    templates: SequenceTemplateOption[];
    fields: SequenceFieldDef[];
    sample: Record<string, string> | null;
    configuredKeys: string[];
  } | null>(null);
  const [sequenceCatalogLoading, setSequenceCatalogLoading] = useState(false);

  // Customer-facing sequences are a Meta Lead Ads feature; Flow
  // tables keep assignment but never touch the WhatsApp config
  // endpoint (which resolves Flow tables to 404).
  const isMetaTable = tableKind === "meta_lead_ads";

  const readJson = useCallback(async (res: Response) => {
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        typeof json.error === "string" ? json.error : `Request failed (${res.status})`,
      );
    }
    return json;
  }, []);

  const toDraft = useCallback((a: AssigneeView): Draft => {
    // Included assignees are always eligible to receive leads —
    // there is no per-member off switch in the wizard. Availability
    // pauses (table/account windows) remain the way to pause
    // someone temporarily; new drafts default to active.
    return {
      key: a.id,
      user_id: a.user_id,
      display_name: a.display_name,
      email: a.email ?? "",
      phone: a.phone ?? "",
      whatsapp_numbers: (Array.isArray(a.whatsapp_numbers) ? a.whatsapp_numbers : []).map((n) => ({
        phone: n.phone,
        template_name: n.template_name ?? "",
        template_language: n.template_language || "en_US",
      })),
      weight: String(a.weight ?? 0),
      is_active: true,
      // Notification channels are strictly opt-in: a missing
      // preference defaults to OFF (never auto-enabled by a roster
      // email). An explicitly saved `true` is preserved as-is.
      notify_email: a.notify_email === true,
      notify_whatsapp: a.notify_whatsapp === true,
      sequence: null,
      sequenceDirty: false,
      sequenceLoadedKey: null,
    };
  }, []);

  const configUrl = useCallback(
    (scope?: string) =>
      `/api/integrations/meta-lead-ads/whatsapp/tables/${encodeURIComponent(flowId)}/config` +
      (scope ? `?assignee_key=${encodeURIComponent(scope)}` : ""),
    [flowId],
  );

  /**
   * Load the customer-sequence catalog (approved templates with
   * variable slots, this table's mapping fields, sample preview
   * values, and which salespeople already have a saved sequence).
   * Meta tables only; failures leave the catalog null so the
   * sequence editor degrades to a retry hint without blocking
   * assignment editing.
   */
  const loadSequenceCatalog = useCallback(async () => {
    setSequenceCatalogLoading(true);
    try {
      const json = (await readJson(await fetch(configUrl(), { cache: "no-store" }))) as {
        approved_templates?: unknown;
        fields?: unknown;
        sample_values?: unknown;
        configured_keys?: unknown;
      };
      const rawTemplates = Array.isArray(json.approved_templates)
        ? json.approved_templates
        : [];
      const templates: SequenceTemplateOption[] = (rawTemplates as Array<Record<string, unknown>>)
        .filter(
          (t) =>
            typeof t.template_name === "string" &&
            t.template_name !== "" &&
            typeof t.template_language === "string",
        )
        .map((t) => ({
          template_name: t.template_name as string,
          template_language: t.template_language as string,
          category: typeof t.category === "string" ? t.category : null,
          status: typeof t.status === "string" ? t.status : "APPROVED",
          preview: typeof t.preview === "string" ? t.preview : null,
          body_text: typeof t.body_text === "string" ? t.body_text : "",
          variables: Array.isArray(t.variables)
            ? (t.variables as SequenceTemplateOption["variables"])
            : [],
        }));
      const rawFields = Array.isArray(json.fields) ? json.fields : [];
      const fields: SequenceFieldDef[] = (rawFields as Array<Record<string, unknown>>)
        .filter((f) => typeof f.key === "string" && f.key !== "")
        .map((f) => ({
          key: f.key as string,
          label: typeof f.label === "string" ? f.label : (f.key as string),
        }));
      const sample =
        json.sample_values && typeof json.sample_values === "object"
          ? (json.sample_values as Record<string, string>)
          : null;
      const configuredKeys = Array.isArray(json.configured_keys)
        ? (json.configured_keys as unknown[]).filter(
            (k): k is string => typeof k === "string",
          )
        : [];
      setSequenceCatalog({ templates, fields, sample, configuredKeys });
    } catch {
      setSequenceCatalog(null);
    } finally {
      setSequenceCatalogLoading(false);
    }
  }, [readJson, configUrl]);

  /** Load one salesperson's saved customer sequence (empty when none). */
  const loadSequenceFor = useCallback(
    async (key: string): Promise<SequenceDraft> => {
      const json = (await readJson(await fetch(configUrl(key), { cache: "no-store" }))) as {
        assignee?: { delay_seconds?: unknown; items?: unknown } | null;
      };
      const a = json.assignee;
      const items = Array.isArray(a?.items)
        ? ((a?.items as Array<Record<string, unknown>>)
            .filter(
              (t) =>
                typeof t.template_name === "string" &&
                typeof t.template_language === "string",
            )
            .map((t) => ({
              template_name: t.template_name as string,
              template_language: t.template_language as string,
              variable_mappings:
                t.variable_mappings && typeof t.variable_mappings === "object"
                  ? (t.variable_mappings as Record<string, string>)
                  : {},
            })) as SequenceItem[])
        : [];
      return {
        delay_seconds: String(a?.delay_seconds ?? 0),
        items,
      };
    },
    [readJson, configUrl],
  );

  /**
   * Attach each saved assignee's customer sequence to its draft
   * (Meta tables only). Runs after the assignment payload loads so
   * View mode and the compact table both show the real saved order.
   */
  const attachSequences = useCallback(
    async (assignees: AssigneeView[]) => {
      if (!isMetaTable) return;
      const entries = await Promise.all(
        assignees.map(async (a) => {
          const key = draftKey({ user_id: a.user_id, email: a.email ?? "", phone: a.phone ?? "" });
          if (!key) return null;
          try {
            return [a.id, await loadSequenceFor(key)] as const;
          } catch {
            return null;
          }
        }),
      );
      const seqById = new Map(
        entries.filter((e): e is readonly [string, SequenceDraft] => e !== null),
      );
      if (seqById.size > 0) {
        setDrafts((prev) =>
          prev.map((d) => {
            const seq = seqById.get(d.key);
            if (!seq) return d;
            const key = draftKey(d);
            return { ...d, sequence: seq, sequenceLoadedKey: key };
          }),
        );
      }
    },
    [isMetaTable, loadSequenceFor],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [assignJson, rosterJson] = await Promise.all([
        readJson(
          await fetch(`/api/flows/${encodeURIComponent(flowId)}/assignment`, {
            cache: "no-store",
          }),
        ),
        readJson(await fetch(`/api/account/members`, { cache: "no-store" })).catch(
          () => ({ members: [] }),
        ),
      ]);
      const data = assignJson as unknown as AssignmentPayload;
      // Normalize once at the boundary: unconfigured tables arrive
      // without an `assignees` key, and every render lookup below
      // assumes an array.
      const assignees = payloadAssignees(data);
      setPayload({ ...data, assignees });
      setEnabled(data.config?.enabled ?? false);
      setMode(data.config?.mode ?? "round_robin");
      setTemplateName(data.config?.whatsapp_template_name ?? "");
      // Show a language only when a template is saved; the save
      // path falls back to "en_US" for the empty state.
      setTemplateLanguage(
        data.config?.whatsapp_template_name
          ? (data.config?.whatsapp_template_language ?? "")
          : "",
      );
      setDrafts(assignees.map(toDraft));
      const members = (rosterJson as { members?: RosterMember[] }).members ?? [];
      setRoster(members);
      void attachSequences(assignees);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load assignment settings.");
    } finally {
      setLoading(false);
    }
  }, [flowId, toDraft, attachSequences, readJson]);

  /**
   * Send-eligible templates for this account (APPROVED only,
   * verified server-side). Runs on every open so a newly synced
   * template is pickable without stale state; failures leave the
   * previous list (if any) in place with a retry affordance.
   */
  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError(null);
    try {
      const json = (await readJson(
        await fetch(`/api/flows/${encodeURIComponent(flowId)}/assignment/templates`, {
          cache: "no-store",
        }),
      )) as {
        templates?: Array<{ name?: unknown; language?: unknown; status?: unknown; category?: unknown }>;
        details?: Array<Record<string, unknown>>;
        sender_connected?: unknown;
      };
      const rows = Array.isArray(json.templates) ? json.templates : [];
      setTemplates(
        rows
          .filter(
            (t): t is { name: string; language: string; status: string; category: string | null } =>
              !!t &&
              typeof t.name === "string" &&
              t.name !== "" &&
              typeof t.language === "string" &&
              t.language !== "" &&
              typeof t.status === "string" &&
              t.status !== "" &&
              (t.category === null || t.category === undefined || typeof t.category === "string"),
          )
          .map((t) => ({
            name: t.name,
            language: t.language,
            status: t.status,
            category: typeof t.category === "string" ? t.category : null,
          })),
      );
      setSenderConnected(json.sender_connected === true);
      // Full template content for hover previews (same rows, never
      // fabricated — missing details render an unavailable state).
      setTemplateDetails(
        toTemplateDetails(Array.isArray(json.details) ? json.details : []),
      );
    } catch (err) {
      setTemplatesError(
        err instanceof Error ? err.message : "Could not load WhatsApp templates.",
      );
    } finally {
      setTemplatesLoading(false);
    }
  }, [flowId, readJson]);

  useEffect(() => {
    if (open) {
      setEditingKey(null);
      setForm(emptyDraft());
      setStep("assign");
      setCompletedSteps([]);
      setEditorSlot("members");
      setShowStepAdvanced(false);
      setShowAdvanced(false);
      setOpenGroup(null);
      setConfirmRemoveKey(null);
      setTemplatePreviewOpen(false);
      setPauseFor(null);
      setShowNotifications(false);
      setNotifications(null);
      setSequenceCatalog(null);
      void load();
      void loadTemplates();
      if (isMetaTable) {
        void loadSequenceCatalog();
      }
    }
  }, [open, load, loadTemplates, loadSequenceCatalog, isMetaTable]);

  const rosterById = useMemo(() => {
    return new Map(roster.map((m) => [m.user_id, m]));
  }, [roster]);

  // Saved rows by id for the per-draft status cells below. Built
  // from the normalized payload, so local drafts on an
  // unconfigured table (no `assignees` key in the GET) look up
  // safely instead of crashing.
  const savedById = useMemo(
    () => new Map(payloadAssignees(payload).map((a) => [a.id, a] as const)),
    [payload],
  );

  const rosterOptions = useMemo(
    () =>
      roster.map((m) => ({
        value: m.user_id,
        label: m.full_name?.trim() || m.email || m.user_id,
        hint: m.role,
      })),
    [roster]
  );

  // The customer-sequence key of the assignee being edited, derived
  // live from the form identity. null while the form has no
  // identifying field yet (no linked member, no email/phone).
  const formKey = useMemo(
    () => draftKey({ user_id: form.user_id, email: form.email, phone: form.phone }),
    [form.user_id, form.email, form.phone],
  );

  // Load the edited salesperson's saved customer sequence whenever
  // the form identity settles on a new key (linking a member, or
  // typing an email/phone — debounced so free text doesn't spam the
  // endpoint). Already-loaded keys are skipped, and in-progress
  // edits are never clobbered by the same identity.
  useEffect(() => {
    if (!isMetaTable || !editingKey) return;
    if (!formKey) {
      setForm((f) =>
        f.sequence === null && f.sequenceLoadedKey === null
          ? f
          : { ...f, sequence: null, sequenceLoadedKey: null, sequenceDirty: false },
      );
      return;
    }
    if (form.sequenceLoadedKey === formKey) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void loadSequenceFor(formKey)
        .then((seq) => {
          if (cancelled) return;
          setForm((f) =>
            draftKey({ user_id: f.user_id, email: f.email, phone: f.phone }) === formKey
              ? { ...f, sequence: seq, sequenceLoadedKey: formKey, sequenceDirty: false }
              : f,
          );
        })
        .catch(() => {
          if (cancelled) return;
          setForm((f) =>
            draftKey({ user_id: f.user_id, email: f.email, phone: f.phone }) === formKey
              ? { ...f, sequence: null, sequenceLoadedKey: formKey, sequenceDirty: false }
              : f,
          );
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [formKey, form.sequenceLoadedKey, isMetaTable, editingKey, loadSequenceFor]);

  const activeWeightTotal = useMemo(() => {
    return drafts
      .filter((d) => d.is_active)
      .reduce((sum, d) => sum + (Number.parseInt(d.weight, 10) || 0), 0);
  }, [drafts]);

  const weightError =
    mode === "percentage" && drafts.some((d) => d.is_active) && activeWeightTotal !== 100
      ? `Active percentages must total exactly 100% (currently ${activeWeightTotal}%).`
      : null;

  const templateOptions = useMemo(() => toTemplateOptions(templates ?? []), [templates]);

  // Selector value for the current (name, language); empty when no
  // template is set so the placeholder shows.
  const templateKey =
    templateName.trim() === ""
      ? ""
      : encodeTemplateKey({ name: templateName.trim(), language: templateLanguage.trim() });

  // A saved template that vanished from the approved list (renamed,
  // removed, or unapproved) needs a valid replacement before the
  // settings can be saved with WhatsApp alerts enabled. Unknown
  // lists (not yet loaded / failed) never block saving.
  const templateStale =
    templateName.trim() !== "" &&
    templates !== null &&
    !isTemplateSelectionValid(templates, templateName, templateLanguage);

  const selectTemplate = (value: string) => {
    const parsed = decodeTemplateKey(value);
    if (!parsed) return;
    setTemplateName(parsed.name);
    setTemplateLanguage(parsed.language);
  };

  const clearTemplate = () => {
    setTemplateName("");
    setTemplateLanguage("");
  };

  const patchDraft = (key: string, patch: Partial<Draft>) => {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  };

  const removeDraft = (key: string) => {
    setDrafts((prev) => prev.filter((d) => d.key !== key));
  };

  const startAdd = () => {
    if (readOnly) return;
    if (!commitOpenEditor()) return;
    setEditingKey("__new__");
    setEditorSlot("members");
    setForm(emptyDraft());
    // Add opens with only the essential fields visible; advanced
    // groups stay collapsed until explicitly requested.
    setShowAdvanced(false);
    setOpenGroup(null);
    setConfirmRemoveKey(null);
  };

  const startEdit = (d: Draft, slot: "members" | "messages" | "advanced" = "members") => {
    if (readOnly) return;
    if (!commitOpenEditor()) return;
    setEditingKey(d.key);
    setEditorSlot(slot);
    setForm({ ...d });
    setShowAdvanced(false);
    setOpenGroup(null);
    setConfirmRemoveKey(null);
  };

  /**
   * Open the compact customer-sequence panel for one salesperson,
   * from the "Messages to leads" section. This is NOT the member
   * editor: no link, name, share, availability, or notification
   * fields — only that salesperson's WhatsApp sequence, edited
   * through the same form state and saved by the same persistence.
   */
  const openMessages = (d: Draft) => {
    if (readOnly) return;
    if (!commitOpenEditor()) return;
    setEditingKey(d.key);
    setEditorSlot("messages");
    setForm({ ...d });
    setShowAdvanced(false);
    setOpenGroup(null);
    setConfirmRemoveKey(null);
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setForm(emptyDraft());
    setShowAdvanced(false);
    setOpenGroup(null);
    setPauseFor(null);
  };

  /**
   * Commit the compact Step 3 sequence panel into the drafts (what
   * its Done button does). Only the customer-sequence fields merge
   * back — member identity, share, availability, and notification
   * preferences are never touched here, so no member validation
   * runs. Returns the merged drafts. Callers must not run this in
   * view mode (all entry points are readOnly-guarded).
   */
  const commitSequenceEditor = (): Draft[] | null => {
    if (!editingKey || editingKey === "__new__") return drafts;
    const next = drafts.map((d) =>
      d.key === form.key
        ? {
            ...d,
            sequence: form.sequence,
            sequenceDirty: form.sequenceDirty,
            sequenceLoadedKey: form.sequenceLoadedKey,
          }
        : d,
    );
    setDrafts(next);
    cancelEdit();
    return next;
  };

  /**
   * Commit the open inline editor into the drafts (what Done does),
   * synchronously so Save — and opening another editor — can
   * validate + submit the merged list in the same tick instead of
   * validating a stale draft while the panel is open. Returns the
   * merged drafts, or null when validation blocks (the form stays
   * open with the error surfaced). A pristine Add panel is
   * disregarded on implicit commits (navigation, Save), but an
   * explicit Done click always commits — that is how a Step 1
   * external placeholder (no link yet, named in Step 2) is created.
   * Callers must not run this in view mode (all entry points are
   * readOnly-guarded).
   */
  const commitOpenEditor = (opts?: { explicit?: boolean }): Draft[] | null => {
    if (!editingKey) return drafts;
    // The Step 3 sequence panel edits customer templates only — it
    // merges just the sequence fields and never runs member
    // validation. Kept separate from the general member editor.
    if (editorSlot === "messages") return commitSequenceEditor();
    if (
      editingKey === "__new__" &&
      !opts?.explicit &&
      isPristineNewAssigneeForm(form)
    ) {
      cancelEdit();
      return drafts;
    }
    // Linked members take their display name from the roster when the
    // Step 1 form carries no typed name (Step 1 no longer asks for
    // one). Resolve before validation so the roster name satisfies it.
    if (form.user_id) {
      const member = rosterById.get(form.user_id);
      if (member && !form.display_name.trim()) {
        form.display_name = member.full_name?.trim() || member.email || form.user_id;
      }
    }
    // Step 1 (members slot) collects only the team link + share —
    // names and contact details live in Step 2 — so it validates
    // link uniqueness only. Every other editor runs the full form
    // validation (name, contact channel, duplicates).
    const problem =
      editorSlot === "members"
        ? validateMemberStep1(form, drafts)
        : validateAssigneeForm(form, drafts);
    if (problem) {
      setSaveError(problem);
      toast.error(problem);
      return null;
    }
    // Percentage shares are edited in the Add/Edit form (the member
    // list shows them read-only). Validate the typed value on commit
    // so a bad share blocks with the form preserved — Never
    // rebalance or overwrite other members silently. Round Robin
    // ignores the field entirely.
    if (mode === "percentage") {
      const shareProblem = validateShareValue(form.weight, form.display_name);
      if (shareProblem) {
        setSaveError(shareProblem);
        toast.error(shareProblem);
        return null;
      }
    }
    if (form.user_id) {
      const member = rosterById.get(form.user_id);
      if (member && !form.display_name.trim()) {
        form.display_name = member.full_name?.trim() || member.email || form.user_id;
      }
    }
    const next =
      editingKey === "__new__"
        ? mergeOpenFormEdit(drafts, editingKey, form, `new-${Date.now()}`)
        : mergeOpenFormEdit(drafts, editingKey, form, form.key);
    setDrafts(next);
    cancelEdit();
    return next;
  };

  const confirmEdit = () => {
    if (readOnly) return;
    commitOpenEditor({ explicit: true });
  };

  /**
   * Wizard navigation. Continue commits the open inline editor first
   * (same stale-state fix as Save: the visible form merges into the
   * draft before anything validates), validates the current step, and
   * advances only on success. Back preserves every entered value.
   * The stepper can return to completed steps but never skip ahead.
   */
  const markStepComplete = (done: AssignmentStep) => {
    setCompletedSteps((prev) => (prev.includes(done) ? prev : [...prev, done]));
  };

  const notifyArgsFor = (activeDrafts: Draft[]) => ({
    notifyEnabled,
    templateName,
    templateStale,
    drafts: activeDrafts,
    rosterEmailFor: (userId: string | null) =>
      (userId ? rosterById.get(userId)?.email : null)?.trim() || "",
    checkSequences: isMetaTable,
  });

  const goNext = () => {
    if (readOnly || busy !== null) return;
    // Commit-before-validate: a typed-but-unconfirmed editor merges
    // into the drafts before the step validates them.
    const activeDrafts = commitOpenEditor();
    if (!activeDrafts) return;
    if (step === "assign") {
      const problem = validateAssignStep(activeDrafts, mode);
      if (problem) {
        setSaveError(problem);
        toast.error(problem);
        return;
      }
      setSaveError(null);
      markStepComplete("assign");
      setStep("notify");
    } else if (step === "notify") {
      // Step 2 covers notification channels only — sequence delays
      // belong to Step 3 (validateSequencesStep).
      const problem = validateNotifyStep({ ...notifyArgsFor(activeDrafts), checkSequences: false });
      if (problem) {
        setSaveError(problem);
        toast.error(problem);
        return;
      }
      setSaveError(null);
      markStepComplete("notify");
      setStep("sequences");
    } else if (step === "sequences") {
      const problem = validateSequencesStep({
        drafts: activeDrafts,
        isMetaTable,
      });
      if (problem) {
        setSaveError(problem);
        toast.error(problem);
        return;
      }
      setSaveError(null);
      markStepComplete("sequences");
      setStep("review");
    }
  };

  const goBack = () => {
    if (readOnly || busy !== null || step === "assign") return;
    const activeDrafts = commitOpenEditor();
    if (!activeDrafts) return;
    setSaveError(null);
    setStep(step === "review" ? "sequences" : step === "sequences" ? "notify" : "assign");
  };

  const goToStep = (target: AssignmentStep) => {
    if (readOnly || busy !== null || target === step) return;
    const order: AssignmentStep[] = ["assign", "notify", "sequences", "review"];
    // Only completed earlier steps are reachable via the stepper —
    // never skip uncompleted required steps.
    if (order.indexOf(target) >= order.indexOf(step)) return;
    if (!completedSteps.includes(target)) return;
    const activeDrafts = commitOpenEditor();
    if (!activeDrafts) return;
    setSaveError(null);
    setStep(target);
  };

  /**
   * Two-click inline remove confirmation (no modal): the first click
   * arms the row ("Confirm?"), the second removes the draft. Removal
   * only takes effect on the main Save — closing the dialog without
   * saving restores the member.
   */
  const requestRemove = (d: Draft) => {
    if (readOnly) return;
    if (confirmRemoveKey === d.key) {
      removeDraft(d.key);
      setConfirmRemoveKey(null);
      return;
    }
    setConfirmRemoveKey(d.key);
  };

  const linkMember = (userId: string) => {
    if (!userId) {
      setForm((f) => ({ ...f, user_id: null }));
      return;
    }
    const member = rosterById.get(userId);
    setForm((f) => {
      // Switching salespeople must not retain the previous
      // person's address: reset to the newly linked member's
      // roster email (or empty). Re-selecting the same member
      // keeps any explicitly typed address.
      const changed = f.user_id !== userId;
      return {
        ...f,
        user_id: userId,
        display_name: f.display_name.trim() || member?.full_name?.trim() || member?.email || userId,
        email: changed ? member?.email || "" : f.email.trim() || member?.email || "",
      };
    });
  };

  /**
   * Persist one salesperson's customer sequence through the existing
   * per-salesperson config endpoint (empty list clears it).
   */
  const saveSequence = async (key: string, seq: SequenceDraft) => {
    // An empty sequence deletes the row; the delay is then irrelevant
    // (send 0) so a stale delay string can never block clearing.
    const items = seq.items;
    let delayNum = 0;
    if (items.length > 0) {
      delayNum = Number(seq.delay_seconds);
      if (!Number.isInteger(delayNum) || delayNum < 0 || delayNum > 86400) {
        throw new Error("Delay must be a whole number of seconds between 0 and 86400.");
      }
    }
    await readJson(
      await fetch(configUrl(key), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          delay_seconds: delayNum,
          assignee_key: key,
          templates: items.map((t) => ({
            template_name: t.template_name,
            template_language: t.template_language,
            variable_mappings: t.variable_mappings,
          })),
        }),
      }),
    );
  };

  const save = async () => {
    if (readOnly || busy !== null) return;
    // Commit the open inline editor first (add form, row editor, or
    // message configuration). Save validates and submits `drafts`,
    // but the editor edits a separate `form` state that only merges
    // on commit — saving with a panel open used to silently drop the
    // typed values and validate the stale draft instead. A pristine
    // Add panel is disregarded, not committed. Null (blocked
    // validation) leaves the editor open with the error surfaced.
    const activeDrafts = commitOpenEditor();
    if (!activeDrafts) return;
    // Weight totals are recomputed from the committed drafts (the
    // memo above still reflects the pre-commit list while the panel
    // is open).
    const activeWeightTotal = activeDrafts
      .filter((d) => d.is_active)
      .reduce((sum, d) => sum + (Number.parseInt(d.weight, 10) || 0), 0);
    const activeWeightError =
      mode === "percentage" &&
      activeDrafts.some((d) => d.is_active) &&
      activeWeightTotal !== 100
        ? `Active percentages must total exactly 100% (currently ${activeWeightTotal}%).`
        : null;
    if (activeWeightError) {
      toast.error(activeWeightError);
      return;
    }
    // Notification validation is shared with STEP 2's Continue gate
    // (template required/stale, email recipients, E.164 numbers,
    // sequence delays) so the review step can never submit something
    // the wizard itself would have blocked. Off persists null but
    // keeps the in-memory pick so re-enabling restores it.
    const notifyProblem = validateNotifyStep(notifyArgsFor(activeDrafts));
    if (notifyProblem) {
      setSaveError(notifyProblem);
      toast.error(notifyProblem);
      return;
    }
    setBusy("save");
    setSaveError(null);
    setConfirmRemoveKey(null);
    try {
      const isNewConfig = !payload?.config;
      const hasActiveAssignee = activeDrafts.some((d) => d.is_active);
      // An explicitly saved empty roster stays enabled so the table
      // engine (not the legacy global rule) owns new leads as
      // unassigned — disabling here would hand leads back to the
      // legacy fallback and reassign removed members.
      const enabledToSave = resolveEnabledOnSave({
        isNew: isNewConfig,
        persistedEnabled: enabled,
        hasActiveAssignee,
        weightInvalid: activeWeightError !== null,
        explicitEmpty: activeDrafts.length === 0,
      });
      const json = (await readJson(
        await fetch(`/api/flows/${encodeURIComponent(flowId)}/assignment`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled: enabledToSave,
            mode,
            timezone: ASSIGNMENT_TIMEZONE,
            whatsapp_template_name:
              notifyEnabled && templateName.trim() !== "" ? templateName.trim() : null,
            whatsapp_template_language: templateLanguage.trim() || "en_US",
            assignees: activeDrafts.map((d) => ({
              user_id: d.user_id,
              display_name: d.display_name.trim(),
              email: d.email.trim() || null,
              phone: d.phone.trim() || null,
              whatsapp_numbers: d.whatsapp_numbers.map((n) => ({
                phone: n.phone.trim(),
                template_name: n.template_name.trim() || null,
                template_language: n.template_language.trim() || "en_US",
              })),
              weight: Number.parseInt(d.weight, 10) || 0,
              // Included assignees are always eligible — there is
              // no per-member off switch. Availability pauses stay
              // separate and untouched here.
              is_active: true,
              notify_email: d.notify_email,
              notify_whatsapp: d.notify_whatsapp,
            })),
          }),
        }),
      )) as unknown as { config: AssignmentPayload["config"] };
      toast.success("Assignment settings saved for this table.");
      if (json.config) {
        setPayload((p) =>
          p ? { ...p, config: { ...json.config!, }, assignees: p.assignees } : p,
        );
        setEnabled(json.config.enabled);
      }
      // Persist customer sequences for the drafts the user actually
      // changed. Each is keyed by that salesperson's own identity,
      // so saving one never overwrites another's sequence. A
      // sequence failure is surfaced without undoing the assignment
      // save — but the dialog stays open so the user can retry.
      let sequencesOk = true;
      if (isMetaTable) {
        const dirty = activeDrafts.filter((d) => d.sequenceDirty && d.sequence);
        for (const d of dirty) {
          const key = draftKey(d);
          if (!key) continue;
          try {
            await saveSequence(key, d.sequence!);
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "Failed to save a customer sequence.";
            toast.error(message);
            sequencesOk = false;
          }
        }
      }
      // Refresh the dialog data first so the workspace state is
      // current, then close. Only a full success (assignment API +
      // every touched sequence) reaches here: validation failures
      // return early and API failures throw above, so the dialog
      // stays open whenever the user must correct something.
      await load();
      if (sequencesOk) {
        onOpenChange(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save assignment settings.";
      setSaveError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const submitPause = async () => {
    if (readOnly || !pauseFor) return;
    setBusy("pause");
    try {
      const body: Record<string, unknown> = {
        assignee_id: pauseFor,
        mode: pauseMode,
        scope: pauseScope,
      };
      if (pauseMode === "days") body.days = Number.parseInt(pauseDays, 10);
      if (pauseMode === "until") body.until = pauseUntil;
      if (pauseReason.trim()) body.reason = pauseReason.trim();
      await readJson(
        await fetch(`/api/flows/${encodeURIComponent(flowId)}/assignment/pause`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      toast.success(pauseMode === "resume" ? "Assignee resumed." : "Pause updated.");
      setPauseFor(null);
      setPauseReason("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update the pause.");
    } finally {
      setBusy(null);
    }
  };

  /**
   * Pause or resume automatic assignment for this table. Narrowly
   * scoped: only the enabled flag is persisted server-side, so
   * unsaved distribution or assignee edits are never overwritten.
   * Displayed status updates only after the backend confirms.
   */
  const submitStatus = async (action: "pause" | "resume") => {
    if (readOnly || busy !== null) return;
    setBusy("status");
    setSaveError(null);
    try {
      const json = (await readJson(
        await fetch(`/api/flows/${encodeURIComponent(flowId)}/assignment/status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        }),
      )) as unknown as { config: { enabled: boolean } };
      setEnabled(json.config.enabled);
      toast.success(
        action === "pause"
          ? "Automatic assignment paused. New leads will stay unassigned."
          : "Automatic assignment resumed.",
      );
      await load();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update assignment status.";
      setSaveError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const loadNotifications = async () => {
    setShowNotifications(true);
    try {
      const json = (await readJson(
        await fetch(`/api/flows/${encodeURIComponent(flowId)}/assignment/notifications`, {
          cache: "no-store",
        }),
      )) as unknown as { notifications: NotificationRow[] };
      setNotifications(json.notifications ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load deliveries.");
    }
  };

  /**
   * Inline member editor shared by the Add form (below the member
   * list) and the per-row Edit form (below that member's row). Only
   * one editor is ever open (single `editingKey`), so this renders in
   * at most one slot. Uses the same form state, validation, and
   * persistence as the main Save — no parallel source of truth.
   *
   * Step 1 (members slot) stays compact on purpose: link and share
   * only. Display names come from the linked roster member
   * automatically; external contacts are named in Step 2, and contact
   * details live in Step 2 notification cards. Availability and
   * Customer messages groups remain available in the full editor
   * used by the advanced slot. Step 3 never uses this editor — it
   * renders the dedicated compact sequence panel instead.
   */
  const renderMemberEditor = (isNew: boolean, basicOnly = false) => (
    <div className="rounded-lg border border-dashed border-border bg-card/50 p-3">
      <div className="flex flex-col gap-4">
        <p className="text-sm font-medium text-foreground">
          {isNew ? "Add member" : "Edit member"}
        </p>
        <section aria-label="Member">
          <div className="grid gap-3 sm:grid-cols-2">
            {isNew ? (
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label>Link team member (optional)</Label>
                <SearchableSelect
                  value={form.user_id ?? ""}
                  options={[
                    { value: "", label: "External contact (no login)" },
                    ...rosterOptions,
                  ]}
                  onChange={(v) => linkMember(v)}
                  placeholder="External contact (no login)"
                  searchPlaceholder="Search team members…"
                  emptyText="No team members match."
                  ariaLabel="Link team member"
                />
                <p className="text-xs text-muted-foreground">
                  Leave unlinked to add an external contact — you will name it in Step 2.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label>Team member</Label>
                <p className="text-sm font-medium text-foreground">
                  {form.display_name.trim() || "External contact"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {form.user_id ? "Linked team member" : "External contact (no login)"}
                </p>
              </div>
            )}
            {!basicOnly ? (
              <div className="flex flex-col gap-1.5">
                <Label>Display name</Label>
                <Input
                  value={form.display_name}
                  onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
                  placeholder="Priya Sharma"
                />
              </div>
            ) : null}
            {mode === "percentage" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="assign-share">Share percentage</Label>
                <ShareSelect
                  id="assign-share"
                  value={form.weight}
                  onChange={(v) => setForm((f) => ({ ...f, weight: v }))}
                  displayName={form.display_name}
                  autoFocus={isNew}
                />
              </div>
            ) : null}
          </div>
        </section>
        {form.user_id ? (
          <p className="-mt-2 text-xs text-muted-foreground">
            Linked members take ownership in the Assigned To column. External
            contacts receive notifications only — the lead stays Unassigned.
          </p>
        ) : (
          <p className="-mt-2 text-xs text-muted-foreground">
            External contact — name and notification details are collected in Step 2.
          </p>
        )}
        {basicOnly ? null : (
          <>
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
              >
                {showAdvanced ? "Hide advanced options" : "Show advanced options"}
              </Button>
            </div>
            {showAdvanced ? (
              <div className="flex flex-col gap-4">
                <section aria-label="Availability">
                  <div className="mb-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-sm font-semibold"
                      onClick={() => setOpenGroup(openGroup === "avail" ? null : "avail")}
                      aria-expanded={openGroup === "avail"}
                    >
                      Availability
                    </Button>
                  </div>
                  {openGroup === "avail" ? (
                    <div className="flex flex-col gap-2">
                      {editingSaved ? (
                        editingSaved.paused_until ? (
                          <p className="text-xs text-muted-foreground">
                            Paused until {formatPausedUntilFull(editingSaved.paused_until)}
                            {editingSaved.pause_reason ? ` — ${editingSaved.pause_reason}` : ""}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            {editingSaved.available ? "Available — eligible for new leads." : editingSaved.status_label}
                          </p>
                        )
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          Availability applies after the first save.
                        </p>
                      )}
                      {editingSaved ? (
                        <div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setPauseFor(pauseFor ? null : editingSaved.id)}
                          >
                            {pauseFor
                              ? "Close pause controls"
                              : editingSaved.paused_until
                                ? "Resume / extend pause"
                                : "Pause temporarily"}
                          </Button>
                        </div>
                      ) : null}
                      {pausingSaved ? (
                        <Card className="border-dashed">
                          <CardContent className="flex flex-col gap-3 pt-4">
                            <p className="text-sm font-medium">
                              Pause {pausingSaved.display_name}
                            </p>
                                <p className="text-xs text-muted-foreground">
                                  Pauses take effect immediately for new leads. Existing ownership never changes. All times are in Indian Standard Time (IST).
                                </p>
                            {pausingSaved.paused_until ? (
                              <p className="text-muted-foreground text-xs">
                                Current: Paused until{" "}
                                {formatPausedUntilFull(pausingSaved.paused_until)}
                                {pausingSaved.pause_reason ? ` — ${pausingSaved.pause_reason}` : ""} (
                                {pausingSaved.pause_scope === "account" ? "whole account" : "this table"})
                              </p>
                            ) : null}
                                <div className="flex flex-wrap gap-2">
                                  {(
                                    [
                                      ["today", "Pause for today"],
                                      ["days", "Pause N days"],
                                      ["until", "Pause until…"],
                                      ["resume", "Resume now"],
                                    ] as const
                                  ).map(([value, label]) => (
                                    <Button
                                      key={value}
                                      type="button"
                                      variant={pauseMode === value ? "default" : "outline"}
                                      size="sm"
                                      onClick={() => setPauseMode(value)}
                                    >
                                      {label}
                                    </Button>
                                  ))}
                                </div>
                                {pauseMode === "days" && (
                                  <div className="flex flex-col gap-1.5">
                                    <Label>Days (1–365)</Label>
                                    <Input
                                      value={pauseDays}
                                      inputMode="numeric"
                                      className="w-28"
                                      onChange={(e) =>
                                        setPauseDays(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))
                                      }
                                    />
                                  </div>
                                )}
                                {pauseMode === "until" && (
                                  <div className="flex flex-col gap-1.5">
                                    <Label>Resume date and time (IST)</Label>
                                    <Input
                                      type="datetime-local"
                                      value={pauseUntil}
                                      onChange={(e) => setPauseUntil(e.target.value)}
                                    />
                                  </div>
                                )}
                                {pauseMode !== "resume" && (
                                  <>
                                    <div className="flex flex-col gap-1.5">
                                      <Label>Reason (optional)</Label>
                                      <Input
                                        value={pauseReason}
                                        onChange={(e) => setPauseReason(e.target.value)}
                                        placeholder="On leave"
                                        maxLength={280}
                                      />
                                    </div>
                                    <div className="flex gap-2">
                                      <Button
                                        type="button"
                                        variant={pauseScope === "table" ? "default" : "outline"}
                                        size="sm"
                                        onClick={() => setPauseScope("table")}
                                      >
                                        This table only
                                      </Button>
                                      <Button
                                        type="button"
                                        variant={pauseScope === "account" ? "default" : "outline"}
                                        size="sm"
                                        onClick={() => setPauseScope("account")}
                                      >
                                        Whole account
                                      </Button>
                                    </div>
                                  </>
                                )}
                                <div className="flex justify-end gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setPauseFor(null)}
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    disabled={busy === "pause"}
                                    onClick={submitPause}
                                  >
                                    {pauseMode === "resume" ? "Resume" : "Pause"}
                                  </Button>
                                </div>
                              </CardContent>
                            </Card>
                          ) : null}
                      </div>
                  ) : null}
                </section>
                {isMetaTable ? (
                  <section aria-label="Customer messages">
                    <div className="mb-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-sm font-semibold"
                        onClick={() => setOpenGroup(openGroup === "msg" ? null : "msg")}
                        aria-expanded={openGroup === "msg"}
                      >
                        WhatsApp messages to lead
                      </Button>
                    </div>
                    <p className="text-xs leading-snug text-muted-foreground">
                      {sequenceStatusText(form)} These templates are sent to a
                      lead on initial assignment only — reassignment does not
                      resend them.
                    </p>
                    {openGroup === "msg" ? (
                      <div className="mt-2 flex flex-col gap-2">
                        {!formKey ? (
                          <p className="text-xs text-muted-foreground">
                            Link a team member or enter an email address or phone number to
                            configure customer templates.
                          </p>
                        ) : sequenceCatalogLoading && sequenceCatalog === null ? (
                          <p className="text-xs text-muted-foreground">
                            Loading customer templates…
                          </p>
                        ) : sequenceCatalog === null ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <p role="alert" className="text-xs text-destructive">
                              Could not load customer templates.
                            </p>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void loadSequenceCatalog()}
                            >
                              Retry
                            </Button>
                          </div>
                        ) : (
                          <AssigneeSequenceEditor
                            templates={sequenceCatalog.templates}
                            fields={sequenceCatalog.fields}
                            sample={sequenceCatalog.sample}
                            delay={form.sequence?.delay_seconds ?? "0"}
                            items={form.sequence?.items ?? []}
                            readOnly={false}
                            templateDetails={templateDetails}
                            onDelayChange={(v) =>
                              setForm((f) => ({
                                ...f,
                                sequence: {
                                  delay_seconds: v,
                                  items: f.sequence?.items ?? [],
                                },
                                sequenceDirty: true,
                              }))
                            }
                            onItemsChange={(items) =>
                              setForm((f) => ({
                                ...f,
                                sequence: {
                                  delay_seconds: f.sequence?.delay_seconds ?? "0",
                                  items,
                                },
                                sequenceDirty: true,
                              }))
                            }
                          />
                        )}
                      </div>
                    ) : null}
                  </section>
                ) : null}
              </div>
            ) : null}
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={cancelEdit}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={confirmEdit}>
            {isNew ? "Add member" : "Save member"}
          </Button>
        </div>
      </div>
    </div>
  );

  /**
   * Compact Step 3 customer-sequence panel — deliberately separate
   * from renderMemberEditor. One salesperson's WhatsApp templates
   * only: no team link, display name, share, availability, or
   * notification fields. Approved templates with full preview come
   * from the existing catalog; edits ride the same form state and
   * per-salesperson persistence, committed sequence-only (no member
   * validation) via commitSequenceEditor.
   */
  const renderSequencePanel = () => (
    <div className="rounded-lg border border-dashed border-border bg-card/50 p-3">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-foreground">
          WhatsApp messages to lead
        </p>
        <p className="text-xs leading-snug text-muted-foreground">
          {sequenceStatusText(form)} These templates are sent to a
          lead on initial assignment only — reassignment does not
          resend them.
        </p>
        {!formKey ? (
          <p className="text-xs text-muted-foreground">
            Link a team member or enter an email address or phone number to
            configure customer templates.
          </p>
        ) : sequenceCatalogLoading && sequenceCatalog === null ? (
          <p className="text-xs text-muted-foreground">
            Loading customer templates…
          </p>
        ) : sequenceCatalog === null ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-xs text-destructive">
              Could not load customer templates.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadSequenceCatalog()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <AssigneeSequenceEditor
            templates={sequenceCatalog.templates}
            fields={sequenceCatalog.fields}
            sample={sequenceCatalog.sample}
            delay={form.sequence?.delay_seconds ?? "0"}
            items={form.sequence?.items ?? []}
            readOnly={false}
            templateDetails={templateDetails}
            onDelayChange={(v) =>
              setForm((f) => ({
                ...f,
                sequence: {
                  delay_seconds: v,
                  items: f.sequence?.items ?? [],
                },
                sequenceDirty: true,
              }))
            }
            onItemsChange={(items) =>
              setForm((f) => ({
                ...f,
                sequence: {
                  delay_seconds: f.sequence?.delay_seconds ?? "0",
                  items,
                },
                sequenceDirty: true,
              }))
            }
          />
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={cancelEdit}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={confirmSequenceEdit}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );

  const confirmSequenceEdit = () => {
    commitSequenceEditor();
  };

  const kindLabel = tableKind === "meta_lead_ads" ? "Meta Lead Ads table" : "Flow table";
  // View mode renders the same saved state with every mutation
  // path closed: disabled inputs, hidden action buttons, a
  // Close-only footer, and guarded submitters (so no keyboard
  // path can persist anything either).
  const readOnly = viewMode === true;

  // Saved row for the member open in the editor (availability and
  // pause controls exist only for persisted assignees).
  const editingSaved =
    editingKey && editingKey !== "__new__" ? savedById.get(editingKey) : undefined;

  // Pause target for the inline pause card: only when the editor is
  // open on the saved member currently being paused. Hoisted out of
  // the JSX so the card needs no inline IIFE.
  const pausingSaved =
    pauseFor && editingSaved && pauseFor === editingSaved.id
      ? savedById.get(pauseFor)
      : undefined;

  // Review validation summary: recomputed from the live drafts so
  // the review can never drift from what Save submits. Reaching the
  // review step implies committed editors (Continue commits first),
  // so these mirror the save-time checks.
  const reviewAssignProblem = validateAssignStep(drafts, mode);
  const reviewNotifyProblem = validateNotifyStep(notifyArgsFor(drafts));
  const reviewSequencesProblem = validateSequencesStep({
    drafts,
    isMetaTable,
  });

  // Sidebar "needs attention" markers: surface step problems without
  // navigating away. Same validators, recomputed from live drafts.
  const invalidSteps: AssignmentStep[] = (() => {
    const out: AssignmentStep[] = [];
    if (validateAssignStep(drafts, mode)) out.push("assign");
    if (validateNotifyStep({ ...notifyArgsFor(drafts), checkSequences: false }))
      out.push("notify");
    if (validateSequencesStep({ drafts, isMetaTable })) out.push("sequences");
    return out;
  })();

  return (
    <ConfigDialog
      open={open}
      onOpenChange={onOpenChange}
      width="assignment"
      icon={<UserPlus aria-hidden />}
      title="Assignment"
      tableLine={`${flowName ?? "This table"} · ${kindLabel}`}
      description={
        readOnly
          ? "Settings apply to this table only. Viewing — switch to Edit to make changes."
          : "Settings apply to this table only. Saving never rewrites existing lead owners."
      }
      status={
        readOnly ? (
          <ConfigStatusBadge tone={enabled ? "default" : "secondary"}>
            {enabled ? "Automatic" : "Manual"}
          </ConfigStatusBadge>
        ) : undefined
      }
      loading={loading}
      loadingText="Loading assignment settings…"
      error={saveError}
      footer={
        readOnly ? (
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        ) : step === "review" ? (
          <div className="flex flex-col items-end gap-2">
            <div
              className="flex items-center justify-end gap-2"
              aria-label="Assignment status"
            >
              {enabled ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  <span
                    className="size-1.5 rounded-full bg-emerald-500"
                    aria-hidden
                  />
                  Active
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                  <span
                    className="size-1.5 rounded-full bg-amber-500"
                    aria-hidden
                  />
                  Paused
                </span>
              )}
              {enabled ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void submitStatus("pause")}
                  disabled={loading || busy !== null}
                  aria-label="Pause automatic assignment"
                >
                  <Pause className="mr-1.5 size-4" aria-hidden />
                  Pause
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void submitStatus("resume")}
                  disabled={loading || busy !== null}
                  aria-label="Resume automatic assignment"
                >
                  <Play className="mr-1.5 size-4" aria-hidden />
                  Resume
                </Button>
              )}
            </div>
            <div
              className="w-full border-t border-border"
              aria-hidden
              role="separator"
            />
            <div className="flex items-center justify-end gap-2 pt-0.5">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={busy !== null}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={goBack}
                disabled={loading || busy !== null}
              >
                ← Back
              </Button>
              <Button
                type="button"
                onClick={save}
                disabled={loading || busy !== null}
              >
                {busy === "save" ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Saving…
                  </>
                ) : (
                  "Save Assignment"
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy !== null}
            >
              Cancel
            </Button>
            {step !== "assign" ? (
              <Button
                type="button"
                variant="outline"
                onClick={goBack}
                disabled={loading || busy !== null}
              >
                ← Back
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={goNext}
              disabled={loading || busy !== null}
            >
              Continue →
            </Button>
          </div>
        )
      }
    >
      {!loading && (
        <div className="flex flex-col gap-5">
          {/* Compact top stepper on small screens; the persistent
              left sidebar below takes over on md+ screens. */}
          <div className="md:hidden">
            <AssignmentStepper
              step={readOnly ? "review" : step}
              completedSteps={readOnly ? ["assign", "notify", "sequences"] : completedSteps}
              onStepClick={readOnly ? undefined : goToStep}
            />
          </div>
          <div className="flex min-h-0 flex-col gap-5 md:flex-row">
            <aside
              aria-label="Assignment steps"
              className="hidden shrink-0 md:block md:w-56"
            >
              <div className="md:sticky md:top-0">
                <AssignmentStepper
                  layout="vertical"
                  step={readOnly ? "review" : step}
                  completedSteps={readOnly ? ["assign", "notify", "sequences"] : completedSteps}
                  onStepClick={readOnly ? undefined : goToStep}
                  invalidSteps={invalidSteps}
                />
              </div>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col gap-5">
          {!readOnly && step === "assign" ? (
          <>
          <section aria-label="How should leads be assigned?">
            <ConfigSection title="How should leads be assigned?">
              <RadioGroup
                value={mode}
                onValueChange={(v) => {
                  if (v === "round_robin" || v === "percentage") setMode(v);
                }}
                aria-label="How should leads be assigned?"
                className="grid gap-2 sm:grid-cols-2"
              >
                <label
                  htmlFor="assign-mode-rr"
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors",
                    mode === "round_robin"
                      ? "border-primary/60 bg-primary/5"
                      : "border-border bg-card hover:bg-muted/50"
                  )}
                >
                  <RadioGroupItem value="round_robin" id="assign-mode-rr" className="mt-0.5" disabled={readOnly} />
                  <span>
                    <span className="block text-sm font-medium text-foreground">Round robin</span>
                    <span className="block text-xs text-muted-foreground">
                      Distribute leads equally among team members.
                    </span>
                  </span>
                </label>
                <label
                  htmlFor="assign-mode-pct"
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors",
                    mode === "percentage"
                      ? "border-primary/60 bg-primary/5"
                      : "border-border bg-card hover:bg-muted/50"
                  )}
                >
                  <RadioGroupItem value="percentage" id="assign-mode-pct" className="mt-0.5" disabled={readOnly} />
                  <span>
                    <span className="block text-sm font-medium text-foreground">
                      Percentage-based
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Distribute leads according to each member&apos;s assigned share.
                    </span>
                  </span>
                </label>
              </RadioGroup>
            </ConfigSection>
          </section>

          <section aria-label="Assigned team members">
            <ConfigSection
              title="Assigned team members"
              hint={
                mode === "percentage"
                  ? "Set each member's share in the Add/Edit form. Shares must total exactly 100%."
                  : undefined
              }
              action={
                !readOnly ? (
                  <Button type="button" variant="outline" size="sm" onClick={startAdd}>
                    <Plus className="mr-1.5 size-4" aria-hidden /> Add member
                  </Button>
                ) : undefined
              }
            >
              {weightError ? (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {weightError}
                </p>
              ) : null}
              {drafts.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center">
                  <p className="text-sm font-medium text-foreground">No members yet</p>
                  <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                    Add team members to start distributing new leads automatically.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {drafts.map((d) => (
                    <Fragment key={d.key}>
                    <div
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2",
                        !d.is_active && "opacity-60"
                      )}
                    >
                      <MemberInitials name={d.display_name} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {d.display_name || "—"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {d.user_id ? "Team member" : "External contact"}
                        </p>
                      </div>
                      {mode === "percentage" ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {d.weight}%
                        </span>
                      ) : null}
                      {readOnly ? null : (
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 px-2 text-xs"
                            onClick={() => startEdit(d)}
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => requestRemove(d)}
                            aria-label={confirmRemoveKey === d.key ? `Confirm remove ${d.display_name || "member"}` : `Remove ${d.display_name || "member"}`}
                            className={confirmRemoveKey === d.key ? "h-8 px-2 text-xs text-destructive" : "h-8 w-8 px-0 text-destructive"}
                          >
                            {confirmRemoveKey === d.key ? (
                              "Confirm?"
                            ) : (
                              <Trash2 className="size-4" aria-hidden />
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                    {editingKey === d.key && editorSlot === "members" ? renderMemberEditor(false, true) : null}
                    </Fragment>
                  ))}
                  {mode === "percentage" ? (
                    <p className="pt-1 text-xs text-muted-foreground">
                      Total allocation: {activeWeightTotal}%
                    </p>
                  ) : null}
                </div>
              )}
              {editingKey === "__new__" ? renderMemberEditor(true, true) : null}
              </ConfigSection>
            </section>
          </>
          ) : null}
          {!readOnly && step === "notify" ? (
          <>
          <section aria-label="Notify assigned team member">
            <ConfigSection
              title="Notify assigned team member"
              hint="Send a WhatsApp notification when a new lead is assigned."
            >
              <div className="flex flex-col gap-3">
                {notifyEnabled || drafts.length === 0 ? (
                  <div className="flex flex-col gap-1.5">
                    <Label>WhatsApp template</Label>
                    {templatesLoading && templates === null ? (
                      <div
                        className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-sm text-muted-foreground"
                        role="status"
                      >
                        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                        Loading templates…
                      </div>
                    ) : (
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <SearchableSelect
                            value={templateKey}
                            options={templateOptions}
                            onChange={selectTemplate}
                            placeholder="Select a template…"
                            searchPlaceholder="Search templates…"
                            emptyText={
                              templatesError
                                ? "Could not load templates."
                                : "No approved templates found."
                            }
                            ariaLabel="WhatsApp template (optional)"
                            disabled={readOnly}
                            renderOptionPreview={(o) => {
                              const detail = templateDetails.get(o.value);
                              if (!detail) return null;
                              return (
                                <TemplatePreviewPopover
                                  detail={detail}
                                  label={`Preview template ${detail.name}`}
                                >
                                  <TemplatePreviewEye label={`Preview template ${detail.name}`} />
                                </TemplatePreviewPopover>
                              );
                            }}
                          />
                        </div>
                        {templateKey !== "" ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setTemplatePreviewOpen((v) => !v)}
                            aria-label="Preview notification template"
                            aria-expanded={templatePreviewOpen}
                            className="h-9 shrink-0 px-2.5"
                          >
                            <Eye className="size-4" aria-hidden />
                          </Button>
                        ) : null}
                        {templateName.trim() !== "" && !readOnly ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={clearTemplate}
                            aria-label="Clear template selection"
                            className="h-9 shrink-0 px-2.5"
                          >
                            Clear
                          </Button>
                        ) : null}
                      </div>
                    )}
                    {templatePreviewOpen && templateKey !== "" ? (() => {
                      const selected = templateOptions.find((o) => o.value === templateKey);
                      const detail = templateDetails.get(templateKey);
                      return (
                        <TemplatePreviewCard
                          detail={
                            detail ?? {
                              name: selected?.label ?? templateName.trim(),
                              language: templateLanguage.trim(),
                              status: "",
                              category: null,
                              headerType: null,
                              headerContent: null,
                              headerMediaUrl: null,
                              bodyText: "",
                              footerText: null,
                              buttons: [],
                              sampleValues: {},
                            }
                          }
                        />
                      );
                    })() : null}
                    {templatesError ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <p role="alert" className="text-xs text-destructive">
                          {templatesError}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void loadTemplates()}
                          disabled={templatesLoading}
                        >
                          Retry
                        </Button>
                      </div>
                    ) : null}
                    {templates !== null &&
                    templateOptions.length === 0 &&
                    !templatesError ? (
                      <p className="text-xs text-muted-foreground">
                        No APPROVED templates for this account yet — sync them from
                        WhatsApp Templates.
                      </p>
                    ) : null}
                    {senderConnected === false ? (
                      <p className="text-xs text-muted-foreground">
                        WhatsApp sender is not connected for this account — connect it
                        in Settings → WhatsApp before relying on these alerts.
                      </p>
                    ) : null}
                    {templateStale ? (
                      <p role="alert" className="text-xs font-medium text-amber-600 dark:text-amber-400">
                        Saved template “{templateName.trim()}” (
                        {templateLanguage.trim() || "unknown language"}) is no longer
                        approved or available — choose a replacement below.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Email alerts are set for each member.
                </p>
              </div>
            </ConfigSection>
          </section>

          <section aria-label="Salesperson notifications">
            <ConfigSection
              title="Salesperson notifications"
              hint="Choose how each salesperson is notified when they receive a new lead. Contact details are only needed for enabled channels."
            >
              {drafts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No team members assigned. Salesperson notifications are not configured.
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {drafts.map((d) => {
                    const rosterEmail = d.user_id ? rosterById.get(d.user_id)?.email?.trim() || "" : "";
                    return (
                    <div
                      key={d.key}
                      className="rounded-lg border border-border bg-card px-3 py-2.5"
                    >
                      <div className="flex items-center gap-2.5">
                        <MemberInitials name={d.display_name} />
                        <div className="min-w-0 flex-1">
                          {d.display_name.trim() ? (
                            <p className="truncate text-sm font-medium text-foreground">
                              {d.display_name}
                            </p>
                          ) : (
                            <p className="truncate text-sm font-medium text-muted-foreground">
                              External contact — add a name below
                            </p>
                          )}
                          <p className="truncate text-xs text-muted-foreground">
                            {d.user_id ? "Team member" : "External contact"}
                            {mode === "percentage" ? ` · ${d.weight}%` : ""}
                            {` · ${d.is_active ? "Receives new leads" : "Paused"}`}
                          </p>
                        </div>
                        <label className="flex shrink-0 items-center gap-1.5 text-xs">
                          <Switch
                            checked={d.notify_email}
                            onCheckedChange={(v) => patchDraft(d.key, { notify_email: v })}
                            aria-label={`Email alerts for ${d.display_name.trim() || "member"}`}
                            disabled={readOnly}
                          />
                          Email
                        </label>
                        <label className="flex shrink-0 items-center gap-1.5 text-xs">
                          <Switch
                            checked={d.notify_whatsapp}
                            onCheckedChange={(v) => patchDraft(d.key, { notify_whatsapp: v })}
                            aria-label={`WhatsApp alerts for ${d.display_name.trim() || "member"}`}
                            disabled={readOnly}
                          />
                          WhatsApp
                        </label>
                      </div>
                      {!d.user_id ? (
                        <div className="mt-2 flex flex-col gap-1.5">
                          <Label htmlFor={`notify-name-${d.key}`}>
                            Display name <span className="text-destructive">*</span>
                          </Label>
                          <Input
                            id={`notify-name-${d.key}`}
                            value={d.display_name}
                            onChange={(e) => patchDraft(d.key, { display_name: e.target.value })}
                            placeholder="Priya Sharma"
                            disabled={readOnly}
                          />
                        </div>
                      ) : null}
                      {d.notify_whatsapp ? (
                        <div className="mt-2 flex flex-col gap-2">
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`notify-phone-${d.key}`}>Phone number</Label>
                            <IndiaPhoneInput
                              id={`notify-phone-${d.key}`}
                              value={d.phone}
                              onChange={(phone) => patchDraft(d.key, { phone })}
                              ariaLabel={`WhatsApp phone number for ${d.display_name.trim() || "member"}`}
                              disabled={readOnly}
                            />
                          </div>
                          <WhatsappNumbersEditor
                            numbers={d.whatsapp_numbers}
                            onChange={(whatsapp_numbers) => patchDraft(d.key, { whatsapp_numbers })}
                            templateOptions={templateOptions}
                            templateDetails={templateDetails}
                            disabled={readOnly}
                            assigneeName={d.display_name.trim() || "member"}
                            maxNumbers={MAX_WHATSAPP_NUMBERS_PER_ASSIGNEE}
                          />
                        </div>
                      ) : null}
                      {d.notify_email ? (
                        <div className="mt-2 flex flex-col gap-1.5">
                          <Label htmlFor={`notify-email-${d.key}`}>Email address</Label>
                          <Input
                            id={`notify-email-${d.key}`}
                            value={d.email}
                            onChange={(e) => patchDraft(d.key, { email: e.target.value })}
                            placeholder={rosterEmail || "priya@example.com"}
                            inputMode="email"
                            disabled={readOnly}
                          />
                          {rosterEmail ? (
                            <p className="text-xs text-muted-foreground">
                              Leave empty to use the roster address ({rosterEmail}).
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                      {!d.notify_email && !d.notify_whatsapp ? (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          Both channels are off — no contact details needed.
                        </p>
                      ) : null}
                    </div>
                    );
                  })}
                </div>
              )}
            </ConfigSection>
          </section>

          <section aria-label="Advanced member settings">
            <ConfigSection
              title="Advanced member settings"
              hint="Availability pauses and customer messages per member. Notification channels live on each card above."
            >
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowStepAdvanced((v) => !v)}
                  aria-expanded={showStepAdvanced}
                >
                  {showStepAdvanced ? "Hide advanced member settings" : "Show advanced member settings"}
                </Button>
              </div>
              {showStepAdvanced ? (
                drafts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Add members in Step 1 to configure advanced settings.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {drafts.map((d) => (
                      <Fragment key={d.key}>
                        <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2">
                          <MemberInitials name={d.display_name} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-foreground">
                              {d.display_name || "—"}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {d.user_id ? "Team member" : "External contact"}
                              {d.whatsapp_numbers.length > 0
                                ? ` · ${d.whatsapp_numbers.length} extra number${d.whatsapp_numbers.length === 1 ? "" : "s"}`
                                : ""}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {[
                                d.notify_email ? "Email on" : "Email off",
                                d.notify_whatsapp ? "WhatsApp on" : "WhatsApp off",
                              ].join(" · ")}
                            </p>
                          </div>
                          {readOnly ? null : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-xs"
                              onClick={() => startEdit(d, "advanced")}
                            >
                              Edit
                            </Button>
                          )}
                        </div>
                        {editingKey === d.key && editorSlot === "advanced" ? renderMemberEditor(false) : null}
                      </Fragment>
                    ))}
                  </div>
                )
              ) : null}
            </ConfigSection>
          </section>
          </>
          ) : null}
          {!readOnly && step === "sequences" ? (
          <>
          {isMetaTable ? (
            <section aria-label="Messages to leads">
              <ConfigSection
                title="WhatsApp Template to Lead"
                hint="Automatically send WhatsApp messages to customers after lead assignment. Each salesperson has their own sequence."
              >
                {drafts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No team members assigned. There are no customer message sequences to configure.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {drafts.map((d) => (
                      <Fragment key={d.key}>
                      <div
                        className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2"
                      >
                        <MemberInitials name={d.display_name} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-foreground">
                            {d.display_name || "—"}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {d.sequence === null && savedById.get(d.key)
                              ? "Loading…"
                              : sequenceStatusText(d)}
                          </p>
                        </div>
                        {readOnly ? null : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 shrink-0 px-2.5 text-xs"
                            onClick={() => openMessages(d)}
                          >
                            Configure
                          </Button>
                        )}
                      </div>
                      {editingKey === d.key && editorSlot === "messages" ? renderSequencePanel() : null}
                      </Fragment>
                    ))}
                  </div>
                )}
              </ConfigSection>
            </section>
          ) : (
            <section aria-label="Messages to leads">
              <ConfigSection
                title="WhatsApp Template to Lead"
                hint="Customer messages are configured per salesperson."
              >
                <p className="text-xs text-muted-foreground">
                  Customer WhatsApp sequences are available on Meta Lead Ads tables. Flow
                  tables keep assignment without customer messaging — continue to review.
                </p>
              </ConfigSection>
            </section>
          )}
          </>
          ) : null}
          {(readOnly || step === "review") ? (
          <>
          <section aria-label="Review and save">
            <ConfigSection
              title="Review & save"
              hint="Confirm the complete configuration before saving."
            >
              <AssignmentReviewSummary
                mode={mode}
                drafts={drafts}
                activeWeightTotal={
                  drafts
                    .filter((d) => d.is_active)
                    .reduce((sum, d) => sum + (Number.parseInt(d.weight, 10) || 0), 0)
                }
                notifyEnabled={notifyEnabled}
                templateName={templateName}
                templateLanguage={templateLanguage}
                enabled={enabled && drafts.length > 0}
                isNew={!!(!payload?.config && drafts.length > 0)}
              />
              {drafts.length === 0 && !readOnly ? (
                <p className="text-xs text-muted-foreground">
                  No team members assigned — automatic team assignment is
                  inactive and new leads will stay Unassigned until members
                  are added. Existing lead ownership is unchanged.
                </p>
              ) : null}
              {reviewAssignProblem || reviewNotifyProblem || reviewSequencesProblem ? (
                <div className="flex flex-col gap-1.5" role="alert">
                  {reviewAssignProblem ? (
                    <p className="text-xs font-medium text-destructive">{reviewAssignProblem}</p>
                  ) : null}
                  {reviewNotifyProblem ? (
                    <p className="text-xs font-medium text-destructive">{reviewNotifyProblem}</p>
                  ) : null}
                  {reviewSequencesProblem ? (
                    <p className="text-xs font-medium text-destructive">{reviewSequencesProblem}</p>
                  ) : null}
                  {!readOnly ? (
                    <p className="text-xs text-muted-foreground">
                      Go back to fix the highlighted configuration before saving.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Everything looks good — save to apply this configuration to the table.
                </p>
              )}
            </ConfigSection>
          </section>

          <section aria-label="Alert deliveries">
            <Accordion
              value={showNotifications ? ["deliveries"] : []}
              onValueChange={(v: unknown) => {
                const open = Array.isArray(v) && v.includes("deliveries");
                setShowNotifications(open);
                if (open && notifications === null) void loadNotifications();
              }}
            >
              <AccordionItem value="deliveries" className="rounded-lg border border-border bg-card/50 px-3">
                <AccordionTrigger className="py-2.5 text-sm font-semibold hover:no-underline">
                  Recent alert deliveries
                  {notifications && notifications.length > 0 ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      · {notifications.length} shown
                    </span>
                  ) : null}
                </AccordionTrigger>
                <AccordionContent className="pb-3">
                  {!showNotifications && notifications === null ? (
                    <p className="text-xs text-muted-foreground">
                      Expand to load the latest email and WhatsApp delivery attempts for this
                      table, with per-row status and error details.
                    </p>
                  ) : notifications === null ? (
                    <p className="text-xs text-muted-foreground">Loading…</p>
                  ) : notifications.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No alerts sent yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Channel</TableHead>
                          <TableHead>To</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Detail</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {notifications.slice(0, 20).map((n) => (
                          <TableRow key={n.id}>
                            <TableCell className="text-xs">{n.channel}</TableCell>
                            <TableCell className="max-w-40 truncate text-xs">
                              {n.to_email || n.to_phone || "—"}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={n.status === "sent" ? "default" : "secondary"}
                              >
                                {n.status}
                                {n.status === "failed" ? ` (try ${n.attempt})` : ""}
                              </Badge>
                            </TableCell>
                    <AssignmentDeliveryDetailCell notification={n} />
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    </div>
                  )}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </section>
          </>
          ) : null}
          </div>
        </div>
        </div>
      )}
    </ConfigDialog>
  );
}

export function AssignmentButtonIcon() {
  return <UserPlus className="mr-1.5 size-4" />;
}
