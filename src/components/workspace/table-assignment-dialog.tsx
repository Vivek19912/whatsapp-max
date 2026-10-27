"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Pause, Play, Plus, Trash2, UserPlus } from "lucide-react";
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
  ConfigFooterActions,
  ConfigSection,
  ConfigStatusBadge,
} from "./config-dialog";
import { SearchableSelect } from "./searchable-select";
import { AssigneeSequenceEditor, type SequenceFieldDef, type SequenceItem, type SequenceTemplateOption } from "./assignee-sequence-editor";
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

/** One send-eligible WhatsApp template from the templates endpoint. */
export type { AssignmentTemplateOption } from "./assignment-template-utils";
import type { AssignmentTemplateOption } from "./assignment-template-utils";
import {
  decodeTemplateKey,
  encodeTemplateKey,
  isTemplateSelectionValid,
  toTemplateOptions,
} from "./assignment-template-utils";
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
 * Compact, read-only customer-sequence summary for the assignee
 * table/cards: "No customer templates" when unconfigured, else the
 * ordered template names (with language) joined by arrows. Keeps
 * the main list dense; the full editor carries category/status.
 */
function SequenceSummary({ draft }: { draft: Draft }) {
  const seq = draft.sequence;
  if (seq === null) {
    // Not loaded yet (or load failed) — distinct from "configured
    // empty" so a saved sequence never flashes as "No templates".
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  if (seq.items.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">No customer templates</span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5 text-xs">
      <span className="text-muted-foreground">
        {seq.items.length} template{seq.items.length === 1 ? "" : "s"}
      </span>
      <span className="max-w-56 truncate text-foreground" title={seq.items.map((t) => `${t.template_name} (${t.template_language})`).join(" → ")}>
        {seq.items.map((t) => `${t.template_name} (${t.template_language})`).join(" → ")}
      </span>
    </span>
  );
}

const emptyDraft = (): Draft => ({
  key: `new-${Date.now()}`,
  user_id: null,
  display_name: "",
  email: "",
  phone: "",
  weight: "0",
  is_active: true,
  notify_email: true,
  notify_whatsapp: false,
  sequence: null,
  sequenceDirty: false,
  sequenceLoadedKey: null,
});

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
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [senderConnected, setSenderConnected] = useState<boolean | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [form, setForm] = useState<Draft>(emptyDraft());
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
    return {
      key: a.id,
      user_id: a.user_id,
      display_name: a.display_name,
      email: a.email ?? "",
      phone: a.phone ?? "",
      weight: String(a.weight ?? 0),
      is_active: a.is_active,
      notify_email: a.notify_email,
      notify_whatsapp: a.notify_whatsapp,
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
    setEditingKey("__new__");
    setForm(emptyDraft());
  };

  const startEdit = (d: Draft) => {
    setEditingKey(d.key);
    setForm({ ...d });
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setForm(emptyDraft());
  };

  const confirmEdit = () => {
    if (readOnly) return;
    const name = form.display_name.trim();
    if (!name) {
      toast.error("Give the assignee a display name.");
      return;
    }
    if (!form.user_id && !form.email.trim() && !form.phone.trim()) {
      toast.error("Link a team member or enter an email address or phone number.");
      return;
    }
    if (form.user_id) {
      const clash = drafts.some((d) => d.key !== form.key && d.user_id === form.user_id);
      if (clash) {
        toast.error("That team member is already on this table.");
        return;
      }
      const member = rosterById.get(form.user_id);
      if (member && !form.display_name.trim()) {
        form.display_name = member.full_name?.trim() || member.email || form.user_id;
      }
    }
    if (editingKey === "__new__") {
      setDrafts((prev) => [...prev, { ...form, key: `new-${Date.now()}` }]);
    } else {
      setDrafts((prev) => prev.map((d) => (d.key === form.key ? { ...form } : d)));
    }
    cancelEdit();
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
    if (weightError) {
      toast.error(weightError);
      return;
    }
    if (templateStale) {
      const message = `Template "${templateName.trim()}" is no longer approved or available — choose a replacement before saving.`;
      setSaveError(message);
      toast.error(message);
      return;
    }
    // An enabled email alert with no possible recipient can never
    // deliver: block the save with an actionable message instead of
    // persisting the misconfiguration. Internal members fall back
    // to the linked roster email; external recipients need a typed
    // address. Drafts are preserved so nothing is lost.
    for (const d of drafts) {
      if (!d.notify_email || d.email.trim() !== "") continue;
      const rosterEmail =
        (d.user_id ? rosterById.get(d.user_id)?.email : null)?.trim() || "";
      if (!rosterEmail) {
        const message = `Email alerts are on for "${d.display_name.trim() || "Unnamed assignee"}" but there is no email address — enter one or turn Email alerts off.`;
        setSaveError(message);
        toast.error(message);
        return;
      }
    }
    // Client-side sequence guard (the server re-validates templates,
    // mappings, and delay): a malformed delay must never be sent.
    if (isMetaTable) {
      for (const d of drafts) {
        if (!d.sequenceDirty || !d.sequence || d.sequence.items.length === 0) continue;
        const delayNum = Number(d.sequence.delay_seconds);
        if (!Number.isInteger(delayNum) || delayNum < 0 || delayNum > 86400) {
          toast.error("Delay must be a whole number of seconds between 0 and 86400.");
          return;
        }
      }
    }
    setBusy("save");
    setSaveError(null);
    try {
      const json = (await readJson(
        await fetch(`/api/flows/${encodeURIComponent(flowId)}/assignment`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled,
            mode,
            timezone: ASSIGNMENT_TIMEZONE,
            whatsapp_template_name: templateName.trim() || null,
            whatsapp_template_language: templateLanguage.trim() || "en_US",
            assignees: drafts.map((d) => ({
              user_id: d.user_id,
              display_name: d.display_name.trim(),
              email: d.email.trim() || null,
              phone: d.phone.trim() || null,
              weight: Number.parseInt(d.weight, 10) || 0,
              is_active: d.is_active,
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
      }
      // Persist customer sequences for the drafts the user actually
      // changed. Each is keyed by that salesperson's own identity,
      // so saving one never overwrites another's sequence. Failures
      // are surfaced without undoing the assignment save.
      if (isMetaTable) {
        const dirty = drafts.filter((d) => d.sequenceDirty && d.sequence);
        for (const d of dirty) {
          const key = draftKey(d);
          if (!key) continue;
          try {
            await saveSequence(key, d.sequence!);
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "Failed to save a customer sequence.";
            toast.error(message);
          }
        }
      }
      await load();
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

  const kindLabel = tableKind === "meta_lead_ads" ? "Meta Lead Ads table" : "Flow table";
  // View mode renders the same saved state with every mutation
  // path closed: disabled inputs, hidden action buttons, a
  // Close-only footer, and guarded submitters (so no keyboard
  // path can persist anything either).
  const readOnly = viewMode === true;

  return (
    <ConfigDialog
      open={open}
      onOpenChange={onOpenChange}
      width="xl"
      icon={<UserPlus aria-hidden />}
      title="Assignment"
      tableLine={`${flowName ?? "This table"} · ${kindLabel}`}
      description={
        readOnly
          ? "Settings apply to this table only. Viewing — switch to Edit to make changes."
          : "Settings apply to this table only. Saving never rewrites existing lead owners."
      }
      status={
        <ConfigStatusBadge tone={enabled ? "default" : "secondary"}>
          {enabled ? "Automatic" : "Manual"}
        </ConfigStatusBadge>
      }
      loading={loading}
      loadingText="Loading assignment settings…"
      error={saveError}
      footer={
        readOnly ? (
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        ) : (
          <ConfigFooterActions
            onClose={() => onOpenChange(false)}
            closeLabel="Cancel"
            onSave={save}
            saveLabel="Save Assignment Settings"
            saving={busy === "save"}
            saveDisabled={loading}
          />
        )
      }
    >
      {!loading && (
        <div className="flex flex-col gap-5">
          <section aria-label="Automatic assignment">
            <ConfigSection
              title="Automatic assignment"
              hint={
                enabled
                  ? "New leads are distributed to eligible assignees."
                  : "Off — new leads stay unassigned until someone assigns them."
              }
              action={
                <Switch
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  aria-label="Automatic assignment"
                  disabled={readOnly}
                />
              }
            >
              <div />
            </ConfigSection>
          </section>

          <section aria-label="Distribution method">
            <ConfigSection
              title="Distribution method"
              hint={
                mode === "round_robin"
                  ? "Leads go to each eligible assignee in turn."
                  : "A paused assignee's share is redistributed across the remaining eligible assignees; shares always total 100% of the active pool."
              }
            >
              <RadioGroup
                value={mode}
                onValueChange={(v) => {
                  if (v === "round_robin" || v === "percentage") setMode(v);
                }}
                aria-label="Distribution method"
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
                      Equal rotation across everyone eligible.
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
                      Weighted shares; paused members drop out and the rest absorb their share.
                    </span>
                  </span>
                </label>
              </RadioGroup>
            </ConfigSection>
          </section>

          <section aria-label="WhatsApp notifications">
            <ConfigSection
              title="WhatsApp notifications"
              hint="Separate from assignment ownership: these alerts notify assignees without changing who owns the lead. They send only when the template below is set, APPROVED, and the account sender is connected. Email alerts use SMTP."
            >
              <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label>WhatsApp template (optional)</Label>
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
                            />
                          </div>
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
              </div>
            </ConfigSection>
          </section>

          <section aria-label="Assignees">
            <ConfigSection
              title={`Assignees (${drafts.length})`}
              hint={
                mode === "percentage"
                  ? `Active shares must total exactly 100% — current active total: ${activeWeightTotal}%.`
                  : "Everyone listed takes turns receiving new leads while eligible."
              }
              action={
                !readOnly ? (
                  <Button type="button" variant="outline" size="sm" onClick={startAdd}>
                    <Plus className="mr-1.5 size-4" aria-hidden /> Add assignee
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
                  <p className="text-sm font-medium text-foreground">No assignees yet</p>
                  <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                    Link a team member or add an external contact. New leads stay
                    unassigned until someone is eligible.
                  </p>
                </div>
              ) : (
                <>
                <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Contact</TableHead>
                        {mode === "percentage" && <TableHead className="w-20">Share %</TableHead>}
                        <TableHead>Status</TableHead>
                        {isMetaTable ? <TableHead>Customer sequence</TableHead> : null}
                        {readOnly ? null : <TableHead className="text-right">Actions</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {drafts.map((d) => {
                        const saved = savedById.get(d.key);
                        return (
                          <TableRow key={d.key} className={cn(!d.is_active && "opacity-60")}>
                            <TableCell>
                              <p className="text-sm font-medium">{d.display_name || "—"}</p>
                              <p className="text-muted-foreground text-xs">
                                {d.user_id
                                  ? `Team member${rosterById.get(d.user_id)?.full_name ? ` · ${rosterById.get(d.user_id)?.full_name}` : ""}`
                                  : "External recipient"}
                              </p>
                            </TableCell>
                            <TableCell>
                              <p className="text-xs">{d.email || "—"}</p>
                              <p className="text-muted-foreground text-xs">{d.phone || ""}</p>
                              <p className="text-muted-foreground text-xs">
                                {d.notify_email ? "Email on" : "Email off"} ·{" "}
                                {d.notify_whatsapp ? "WhatsApp on" : "WhatsApp off"}
                              </p>
                            </TableCell>
                            {mode === "percentage" && (
                              <TableCell>
                              <Input
                                value={d.weight}
                                inputMode="numeric"
                                className="w-16"
                                aria-label={`Share percentage for ${d.display_name}`}
                                disabled={readOnly}
                                onChange={(e) =>
                                  patchDraft(d.key, { weight: e.target.value.replace(/[^0-9]/g, "").slice(0, 3) })
                                }
                              />
                              </TableCell>
                            )}
                      <TableCell>
                        {saved ? (
                          <div className="flex flex-col items-start gap-1">
                            <span className="flex items-center gap-1">
                              <Badge variant={saved.available ? "default" : "secondary"}>
                                {saved.available ? "Available" : saved.status_label}
                              </Badge>
                              {!d.is_active && (
                                <Badge variant="secondary">
                                  Inactive
                                </Badge>
                              )}
                            </span>
                            {saved.paused_until && (
                              <span className="text-[11px] tabular-nums text-muted-foreground">
                                until {formatPausedUntilFull(saved.paused_until)}
                              </span>
                            )}
                          </div>
                        ) : (
                          <Badge variant="outline">Unsaved</Badge>
                        )}
                      </TableCell>
                      {isMetaTable ? (
                        <TableCell>
                          <SequenceSummary draft={d} />
                        </TableCell>
                      ) : null}
                            {readOnly ? null : (
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => patchDraft(d.key, { is_active: !d.is_active })}
                                  aria-label={d.is_active ? "Deactivate" : "Activate"}
                                >
                                  {d.is_active ? "Deactivate" : "Activate"}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => startEdit(d)}
                                >
                                  Edit
                                </Button>
                                {saved && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setPauseFor(saved.id)}
                                    aria-label={saved.paused_until ? "Resume or extend pause" : "Pause"}
                                  >
                                    {saved.paused_until ? <Play className="size-4" /> : <Pause className="size-4" />}
                                  </Button>
                                )}
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => removeDraft(d.key)}
                                  aria-label="Remove"
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              </div>
                            </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                    </Table>
                  </div>
                  <div className="flex flex-col gap-2 md:hidden">
                    {drafts.map((d) => {
                      const saved = savedById.get(d.key);
                      return (
                        <div
                          key={d.key}
                          className={cn(
                            "rounded-lg border border-border bg-card p-3",
                            !d.is_active && "opacity-60"
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-foreground">
                                {d.display_name || "—"}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {d.user_id ? "Team member" : "External recipient"}
                              </p>
                            </div>
                            {saved ? (
                              <Badge variant={saved.available ? "default" : "secondary"} className="shrink-0">
                                {saved.status_label}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="shrink-0">
                                Unsaved
                              </Badge>
                            )}
                          </div>
                          <dl className="mt-2 space-y-1 text-xs">
                            <div className="flex gap-1.5">
                              <dt className="w-16 shrink-0 text-muted-foreground">Contact</dt>
                              <dd className="min-w-0 flex-1 truncate text-foreground">
                                {[d.email, d.phone].filter(Boolean).join(" · ") || "—"}
                              </dd>
                            </div>
                            {mode === "percentage" ? (
                              <div className="flex items-center gap-1.5">
                                <dt className="w-16 shrink-0 text-muted-foreground">Share</dt>
                                <dd className="flex flex-1 items-center gap-1">
                                  <Input
                                    value={d.weight}
                                    inputMode="numeric"
                                    className="h-8 w-20"
                                    aria-label={`Share percentage for ${d.display_name}`}
                                    disabled={readOnly}
                                    onChange={(e) =>
                                      patchDraft(d.key, {
                                        weight: e.target.value.replace(/[^0-9]/g, "").slice(0, 3),
                                      })
                                    }
                                  />
                                  <span className="text-muted-foreground">%</span>
                                </dd>
                              </div>
                            ) : null}
                            <div className="flex gap-1.5">
                              <dt className="w-16 shrink-0 text-muted-foreground">Alerts</dt>
                              <dd className="flex-1 text-foreground">
                                {d.notify_email ? "Email on" : "Email off"} ·{" "}
                                {d.notify_whatsapp ? "WhatsApp on" : "WhatsApp off"}
                              </dd>
                            </div>
                            {isMetaTable ? (
                              <div className="flex gap-1.5">
                                <dt className="w-16 shrink-0 text-muted-foreground">To lead</dt>
                                <dd className="min-w-0 flex-1">
                                  <SequenceSummary draft={d} />
                                </dd>
                              </div>
                            ) : null}
                          </dl>
                            <div className="mt-2 flex flex-wrap gap-1">
                              {readOnly ? null : (
                              <>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 px-2 text-xs"
                                onClick={() => patchDraft(d.key, { is_active: !d.is_active })}
                              >
                                {d.is_active ? "Deactivate" : "Activate"}
                              </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-xs"
                              onClick={() => startEdit(d)}
                            >
                              Edit
                            </Button>
                            {saved ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 px-2 text-xs"
                                onClick={() => setPauseFor(saved.id)}
                              >
                                {saved.paused_until ? "Resume / extend" : "Pause"}
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-xs text-destructive"
                              onClick={() => removeDraft(d.key)}
                              aria-label={`Remove ${d.display_name || "assignee"}`}
                            >
                              <Trash2 className="size-4" aria-hidden /> Remove
                            </Button>
                              </>
                              )}
                            </div>
                          </div>
                      );
                    })}
                  </div>
                  </>
                )}
              </ConfigSection>
            </section>

                {!readOnly && (editingKey || pauseFor) && (
                  <section aria-label="Assignee editor">
                    <ConfigSection
                      title={pauseFor ? "Pause controls" : editingKey === "__new__" ? "Add assignee" : "Edit assignee"}
                      hint={
                        pauseFor
                          ? "Pauses take effect immediately for new leads. Existing ownership never changes."
                          : "Link a team member for ownership, or enter contact details for a notification-only recipient."
                      }
                    >
                      <div className="flex flex-col gap-3">
                  {editingKey && (
                  <Card className="border-dashed">
                    <CardContent className="flex flex-col gap-3 pt-4">
                      <p className="text-sm font-medium">
                        {editingKey === "__new__" ? "Add assignee" : "Edit assignee"}
                      </p>
                      <div className="grid gap-3 sm:grid-cols-2">
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
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>Display name</Label>
                          <Input
                            value={form.display_name}
                            onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
                            placeholder="Priya Sharma"
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="assign-email">Email for notifications (optional)</Label>
                          <Input
                            id="assign-email"
                            value={form.email}
                            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                            placeholder="priya@example.com"
                            inputMode="email"
                          />
                          <p className="text-xs leading-snug text-muted-foreground">
                            This address receives notifications. If left empty, the linked team
                            member&apos;s roster email is used.
                          </p>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>Phone (with country code)</Label>
                          <Input
                            value={form.phone}
                            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                            placeholder="+911234567890"
                            inputMode="tel"
                          />
                        </div>
                      </div>
                      {form.user_id && (
                        <p className="text-muted-foreground text-xs">
                          Linked members take ownership in the Assigned To column. External
                          contacts receive notifications only — the lead stays Unassigned.
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-4">
                        <label className="flex items-center gap-2 text-sm">
                          <Switch
                            checked={form.notify_email}
                            onCheckedChange={(v) => setForm((f) => ({ ...f, notify_email: v }))}
                          />
                          Email alerts
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <Switch
                            checked={form.notify_whatsapp}
                            onCheckedChange={(v) => setForm((f) => ({ ...f, notify_whatsapp: v }))}
                          />
                          WhatsApp alerts
                        </label>
                      </div>
                      {isMetaTable ? (
                        <div className="flex flex-col gap-2 border-t border-border pt-3">
                          <div className="flex flex-col gap-0.5">
                            <p className="text-sm font-semibold text-foreground">
                              WhatsApp messages to lead
                            </p>
                            <p className="text-xs leading-snug text-muted-foreground">
                              These templates are sent to a lead when this salesperson receives
                              the lead&apos;s initial assignment. Reassignment does not send
                              customer-facing templates.
                            </p>
                          </div>
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
                      <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={cancelEdit}>
                          Cancel
                        </Button>
                        <Button type="button" size="sm" onClick={confirmEdit}>
                          {editingKey === "__new__" ? "Add" : "Done"}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {pauseFor &&
                  (() => {
                    const target = savedById.get(pauseFor);
                    return (
                      <Card className="border-dashed">
                        <CardContent className="flex flex-col gap-3 pt-4">
                          <p className="text-sm font-medium">
                            {target ? `Pause ${target.display_name}` : "Pause assignee"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            All times are in Indian Standard Time (IST).
                          </p>
                      {target?.paused_until ? (
                        <p className="text-muted-foreground text-xs">
                          Current: Paused until{" "}
                          {formatPausedUntilFull(target.paused_until)}
                          {target.pause_reason ? ` — ${target.pause_reason}` : ""} (
                          {target.pause_scope === "account" ? "whole account" : "this table"})
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
                    );
                  })()}
                    </div>
                  </ConfigSection>
                </section>
              )}

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
        </div>
      )}
    </ConfigDialog>
  );
}

export function AssignmentButtonIcon() {
  return <UserPlus className="mr-1.5 size-4" />;
}
