// ============================================================
// Meta Lead Ads → WhatsApp auto-send — template variable support.
//
// Meta-only. Nothing here is imported by Flow Tables, All Sheets,
// broadcasts, or the generic template sender.
//
// Model:
//   * A template's send-time variables are identified as slots:
//     `body:<N>` for body {{N}}, `header:1` for a text-header
//     {{1}}, and `button:<buttonIndex>:1` for a URL button's
//     {{1}} suffix. QUICK_REPLY / PHONE_NUMBER buttons need no
//     parameters; COPY_CODE buttons fall back to the template's
//     stored example (existing Meta API behavior) and take no
//     mapping. Media headers carry no variables — a media header
//     without a stored file still blocks the template.
//   * Each slot maps to one Workspace field key: a standard key
//     (`name`, `phone`, `email`, …) or `answer:<questionKey>`
//     for an Instant Form answer. Mappings are stored per table
//     AND per template (never shared).
//   * Resolution always runs against the lead's OWN Workspace row
//     (flow_runs.vars + agent overrides + contact + provenance),
//     fresh on every attempt — including retries — so a corrected
//     row or mapping heals the send without re-enqueueing. The
//     rendered Inbox row is the audit trail of what was sent.
//
// Field values reuse the Sheets field-map builder so variable
// values are byte-identical to what the Workspace table and the
// Sheets sync show for the same lead (same precedence: agent
// override wins, option labels applied, contact row wins for
// Name/Phone). The Sheets modules are Meta-only, so sharing
// their pure builder keeps one source of truth without touching
// Flow Tables.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildLeadFieldMap,
  resolveBusinessDisplays,
} from "@/lib/meta-lead-sheets/mapping";
import {
  applyOptionLabelsToAnswers,
  buildOptionLabelMap,
  choiceQuestionKeys,
  type StoredFormQuestion,
} from "@/lib/meta-lead-ads/option-labels";
import { standardContactFromAnswers } from "@/lib/meta-lead-ads/normalize";
import {
  META_SOURCE_COLUMN_KEY,
  questionVarKeys,
} from "@/lib/meta-lead-ads/virtual-flow";
import { formatColumnLabel } from "@/lib/flows/column-label";
import { resolveFlowAnswers } from "@/lib/flows/flow-tables";
import { extractVariableIndices } from "@/lib/whatsapp/template-validators";
import type { MessageTemplate, TemplateButton } from "@/types";
import type { SendTimeParams } from "@/lib/whatsapp/template-send-builder";

export type VariableComponent = "body" | "header" | "button";

export interface TemplateVariableSlot {
  /** Stable identity: `body:<N>`, `header:1`, `button:<btnIdx>:1`. */
  key: string;
  component: VariableComponent;
  /** 1-based variable number within its component. */
  position: number;
  /** 0-based button index — set only for button slots. */
  buttonIndex?: number;
}

export function formatSlotKey(
  component: VariableComponent,
  position: number,
  buttonIndex?: number,
): string {
  return component === "button"
    ? `button:${buttonIndex ?? 0}:${position}`
    : `${component}:${position}`;
}

const SLOT_KEY_PATTERN = /^(body:[1-9]\d*|header:[1-9]\d*|button:\d+:[1-9]\d*)$/;

export function isSlotKey(value: string): boolean {
  return SLOT_KEY_PATTERN.test(value);
}

/**
 * All send-time variable slots of an approved template row.
 * Pure. COPY_CODE / QUICK_REPLY / PHONE_NUMBER buttons contribute
 * no slots (example fallback / no parameters); media headers
 * contribute none either (no variables possible — a missing file
 * is a structural blocker, not a mapping).
 */
export function getTemplateVariableSlots(
  template: Pick<
    MessageTemplate,
    "header_type" | "header_content" | "body_text" | "buttons"
  >,
): TemplateVariableSlot[] {
  const slots: TemplateVariableSlot[] = [];
  if (template.header_type === "text") {
    for (const n of extractVariableIndices(template.header_content ?? "")) {
      slots.push({
        key: formatSlotKey("header", n),
        component: "header",
        position: n,
      });
    }
  }
  for (const n of extractVariableIndices(template.body_text ?? "")) {
    slots.push({
      key: formatSlotKey("body", n),
      component: "body",
      position: n,
    });
  }
  const buttons: TemplateButton[] = template.buttons ?? [];
  buttons.forEach((btn, buttonIndex) => {
    if (btn.type !== "URL" || typeof btn.url !== "string") return;
    for (const n of extractVariableIndices(btn.url)) {
      slots.push({
        key: formatSlotKey("button", n, buttonIndex),
        component: "button",
        position: n,
        buttonIndex,
      });
    }
  });
  return slots;
}

/**
 * Structural problems mappings can never fix (media header with
 * no stored file). Variable slots are NOT blockers — they are
 * satisfied by mappings. Pure.
 */
export function templateMediaBlockers(
  template: Pick<MessageTemplate, "header_type"> & {
    header_media_url?: string | null;
  },
): string[] {
  if (
    (template.header_type === "image" ||
      template.header_type === "video" ||
      template.header_type === "document") &&
    !template.header_media_url
  ) {
    return [`${template.header_type} header has no media file`];
  }
  return [];
}

export interface VariableFieldDef {
  /** Stable identity: standard key or `answer:<questionKey>`. */
  key: string;
  /** Display label for the mapping dropdown. */
  label: string;
}

/** Standard variable fields — same keys the Sheets sync projects. */
export const STANDARD_VARIABLE_FIELDS: ReadonlyArray<VariableFieldDef> = [
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "form_name", label: "Form Name" },
  { key: "campaign_name", label: "Campaign" },
  { key: "ad_name", label: "Ad" },
  { key: "source", label: "Source" },
  { key: "submitted_at", label: "Submitted At" },
  { key: "assignee", label: "Assigned To" },
  { key: "lead_type", label: "Lead Type" },
  { key: "stage", label: "Stage" },
  { key: "meta_lead_id", label: "Meta Lead ID" },
];

/**
 * Available mapping targets for one table: standard fields plus
 * one `answer:<key>` per Instant Form question (same derivation
 * the ingestion path uses, so a selected field always resolves).
 * Pure.
 */
export function buildAvailableVariableFields(
  questions: ReadonlyArray<{ key?: string | null; label?: string | null }>,
): VariableFieldDef[] {
  const out: VariableFieldDef[] = STANDARD_VARIABLE_FIELDS.map((f) => ({
    ...f,
  }));
  const seen = new Set(out.map((f) => f.key));
  const keys = questionVarKeys(questions);
  questions.forEach((q, index) => {
    const key = keys[index];
    if (!key) return;
    const fieldKey = `answer:${key}`;
    if (seen.has(fieldKey)) return;
    seen.add(fieldKey);
    const label =
      (q.label ?? "").trim() || (q.key ?? "").trim() || `Question ${index + 1}`;
    out.push({ key: fieldKey, label });
  });
  return out;
}

/**
 * Mapping targets labeled with one Meta Lead Ads table's ACTUAL
 * Workspace headers (what the grid shows): the fixed system
 * columns render as "Submission Time", "Name"/"WhatsApp Name",
 * and "Phone Number", while each Instant Form question column
 * renders under its effective header (a stored custom rename
 * wins, else the formatted question label — exactly the grid's
 * rule). Keys are byte-identical to
 * {@link buildAvailableVariableFields}, so saved mappings,
 * validation (`validateVariableMappings`), and send-time
 * resolution (`resolveLeadVariableFieldMap`) behave exactly as
 * before — only the display labels change. Pure.
 *
 * @param questions the table form's stored questions (form order).
 * @param renames custom header overrides keyed by storage id
 *   (`flow:<questionKey>`, as rendered by the grid); unknown keys
 *   are ignored.
 */
export function buildTableVariableFields(
  questions: ReadonlyArray<{ key?: string | null; label?: string | null }>,
  renames?: Readonly<Record<string, string>>,
): VariableFieldDef[] {
  const out: VariableFieldDef[] = STANDARD_VARIABLE_FIELDS.map((f) => {
    if (f.key === "submitted_at") return { ...f, label: "Submission Time" };
    if (f.key === "phone") return { ...f, label: "Phone Number" };
    return { ...f };
  });
  const keys = questionVarKeys(questions);
  // System "Name" renders as "WhatsApp Name" when the table has its
  // own Name question column (mirrors buildFlowTableColumns'
  // display rule, evaluated on the same raw question labels).
  const rendersAsName = (q: { key?: string | null; label?: string | null }, index: number): boolean => {
    const base = ((q.label ?? "").trim() || (q.key ?? "").trim() || keys[index] || "").trim();
    return base.toLowerCase() === "name";
  };
  if (questions.some((q, index) => rendersAsName(q, index))) {
    const nameEntry = out.find((f) => f.key === "name");
    if (nameEntry) nameEntry.label = "WhatsApp Name";
  }
  const seen = new Set(out.map((f) => f.key));
  questions.forEach((q, index) => {
    const key = keys[index];
    if (!key) return;
    const fieldKey = `answer:${key}`;
    if (seen.has(fieldKey)) return;
    seen.add(fieldKey);
    const baseLabel =
      (q.label ?? "").trim() || (q.key ?? "").trim() || `Question ${index + 1}`;
    const custom = renames?.[`flow:${key}`];
    out.push({
      key: fieldKey,
      label:
        typeof custom === "string" && custom.trim() !== ""
          ? custom
          : formatColumnLabel(baseLabel),
    });
  });
  return out;
}

/**
 * Validate a stored mapping against a template's slots and a
 * table's available fields. Returns the first problem, or null
 * when every required variable is mapped to a known field.
 * Pure — the route calls this with server-derived slots/fields.
 */
export function validateVariableMappings(
  slots: TemplateVariableSlot[],
  mappings: Record<string, string>,
  availableKeys: ReadonlySet<string>,
): string | null {
  for (const [slotKey, fieldKey] of Object.entries(mappings)) {
    if (!isSlotKey(slotKey)) {
      return `Unknown variable "${slotKey}".`;
    }
    if (typeof fieldKey !== "string" || fieldKey.trim() === "") {
      return `Variable ${slotKey} needs a selected field.`;
    }
    if (!availableKeys.has(fieldKey)) {
      return `Variable ${slotKey} maps to an unknown field "${fieldKey}" for this table.`;
    }
  }
  for (const slot of slots) {
    const fieldKey = mappings[slot.key];
    if (typeof fieldKey !== "string" || fieldKey.trim() === "") {
      return `Variable {{${slot.position}}} (${slot.component}) needs a mapped Workspace field.`;
    }
    if (!availableKeys.has(fieldKey)) {
      return `Variable {{${slot.position}}} maps to an unknown field for this table.`;
    }
  }
  return null;
}

export interface MissingVariableValue {
  slotKey: string;
  fieldKey: string;
}

/**
 * Resolve every slot to its trimmed field value. Values that are
 * missing or empty are reported — never replaced with
 * placeholders. Pure.
 */
export function resolveVariableValues(
  slots: TemplateVariableSlot[],
  mappings: Record<string, string>,
  fieldMap: Record<string, string>,
): { values: Record<string, string>; missing: MissingVariableValue[] } {
  const values: Record<string, string> = {};
  const missing: MissingVariableValue[] = [];
  for (const slot of slots) {
    const fieldKey = mappings[slot.key];
    if (typeof fieldKey !== "string" || fieldKey.trim() === "") {
      missing.push({ slotKey: slot.key, fieldKey: "" });
      continue;
    }
    const raw = fieldMap[fieldKey] ?? "";
    const value = raw.trim();
    if (value === "") {
      missing.push({ slotKey: slot.key, fieldKey });
      continue;
    }
    values[slot.key] = value;
  }
  return { values, missing };
}

/**
 * Build the Meta send-time params from resolved values. Throws
 * when any slot is unresolved — the caller converts this into a
 * failed (retryable) queue row, never a malformed send. Pure.
 */
export function buildVariableSendParams(
  template: Pick<
    MessageTemplate,
    "header_type" | "header_content" | "body_text" | "buttons"
  >,
  slots: TemplateVariableSlot[],
  values: Record<string, string>,
): SendTimeParams {
  const need = (slotKey: string): string => {
    const value = values[slotKey];
    if (typeof value !== "string" || value === "") {
      throw new Error(`Variable ${slotKey} has no resolved value.`);
    }
    return value;
  };
  const params: SendTimeParams = {};

  const bodyIndices = extractVariableIndices(template.body_text ?? "");
  if (bodyIndices.length > 0) {
    const max = Math.max(...bodyIndices);
    const body: string[] = [];
    for (let n = 1; n <= max; n++) {
      body.push(need(formatSlotKey("body", n)));
    }
    params.body = body;
  }

  if (template.header_type === "text") {
    const headerIndices = extractVariableIndices(template.header_content ?? "");
    if (headerIndices.length > 0) {
      params.headerText = need(formatSlotKey("header", headerIndices[0]));
    }
  }

  const buttonParams: Record<number, string> = {};
  for (const slot of slots) {
    if (slot.component !== "button" || slot.buttonIndex === undefined) continue;
    buttonParams[slot.buttonIndex] = need(slot.key);
  }
  if (Object.keys(buttonParams).length > 0) {
    params.buttonParams = buttonParams;
  }
  return params;
}

/**
 * Render body preview text with resolved values substituted.
 * Unresolved variables keep their {{N}} placeholder — this is
 * display-only (the sender never transmits placeholders).
 * Pure.
 */
export function renderVariablePreview(
  bodyText: string,
  values: Record<string, string>,
): string {
  return bodyText.replace(/\{\{(\d+)\}\}/g, (placeholder, raw: string) => {
    const value = values[formatSlotKey("body", Number(raw))];
    return value === undefined ? placeholder : value;
  });
}

interface LeadSubmissionLite {
  id: string;
  meta_lead_id: string;
  flow_run_id: string | null;
  form_id: string | null;
  form_name: string | null;
  campaign_name: string | null;
  ad_name: string | null;
  source: string | null;
  meta_created_time: string | null;
  created_at: string;
  contact_id: string | null;
}

function toStoredQuestions(raw: unknown): StoredFormQuestion[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((entry) => {
    const e =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    const rawOptions = Array.isArray(e.options) ? e.options : [];
    return {
      key: typeof e.key === "string" ? e.key : null,
      label: typeof e.label === "string" ? e.label : null,
      type: typeof e.type === "string" ? e.type : null,
      options: rawOptions.map((o) => {
        const oo =
          o && typeof o === "object" ? (o as Record<string, unknown>) : {};
        return {
          key: typeof oo.key === "string" ? oo.key : null,
          value: typeof oo.value === "string" ? oo.value : null,
        };
      }),
    };
  });
}

/**
 * Resolve the full variable field map for ONE lead's Workspace
 * row: run vars with agent overrides applied, Instant Form
 * option labels mapped to display text, provenance from the
 * submission, business displays from workspace values + roster,
 * and the contact row winning for Name/Phone (same precedence
 * the Workspace table renders). Returns null when the lead has
 * no Workspace run (nothing mappable yet).
 */
export async function resolveLeadVariableFieldMap(
  db: SupabaseClient,
  accountId: string,
  submission: LeadSubmissionLite,
): Promise<Record<string, string> | null> {
  if (!submission.flow_run_id) return null;

  const { data: run } = await db
    .from("flow_runs")
    .select("flow_id, vars, started_at, contact_id")
    .eq("id", submission.flow_run_id)
    .eq("account_id", accountId)
    .maybeSingle();
  const runRow = run as {
    flow_id?: string | null;
    vars?: unknown;
    started_at?: string | null;
    contact_id?: string | null;
  } | null;
  if (!runRow) return null;

  const rawVars =
    runRow.vars && typeof runRow.vars === "object"
      ? (runRow.vars as Record<string, unknown>)
      : {};
  const rawAnswers: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(rawVars)) {
    if (typeof v === "string") rawAnswers[k] = v;
    else if (typeof v === "number" || typeof v === "boolean")
      rawAnswers[k] = String(v);
    else if (v === null || v === undefined) rawAnswers[k] = null;
  }

  const overrides: Record<string, string | null> = {};
  let fields: Array<{ id: string; name: string }> = [];
  let values: Array<{ field_id: string; value_text: string | null }> = [];
  if (runRow.flow_id) {
    const [{ data: fieldRows }, { data: valueRows }] = await Promise.all([
      db
        .from("workspace_fields")
        .select("id, name")
        .eq("account_id", accountId)
        .eq("flow_id", runRow.flow_id),
      db
        .from("workspace_values")
        .select("field_id, value_text")
        .eq("account_id", accountId)
        .eq("flow_run_id", submission.flow_run_id),
    ]);
    fields = (fieldRows ?? []) as Array<{ id: string; name: string }>;
    values = (valueRows ?? []) as Array<{
      field_id: string;
      value_text: string | null;
    }>;
    try {
      const { data: overrideRows } = await db
        .from("workspace_flow_overrides")
        .select("field_key, value_text")
        .eq("account_id", accountId)
        .eq("flow_id", runRow.flow_id)
        .eq("flow_run_id", submission.flow_run_id);
      for (const o of (overrideRows ?? []) as Array<{
        field_key: string;
        value_text: string | null;
      }>) {
        if (typeof o.field_key === "string" && o.field_key !== "") {
          overrides[o.field_key] = o.value_text ?? null;
        }
      }
    } catch {
      // Best-effort: without overrides the originals stand.
    }
  }

  // Display answers = override ?? original, then option labels.
  const withOverrides = resolveFlowAnswers(rawAnswers, overrides);
  let displayAnswers: Record<string, string | null> = { ...withOverrides };
  let sourceFromWorkspace: string | null = null;
  try {
    if (submission.form_id) {
      const { data: formRow } = await db
        .from("meta_lead_forms")
        .select("questions, form_name")
        .eq("account_id", accountId)
        .eq("form_id", submission.form_id)
        .maybeSingle();
      const stored = toStoredQuestions(
        (formRow as { questions?: unknown } | null)?.questions,
      );
      const keys = questionVarKeys(stored);
      const labelMap = buildOptionLabelMap(stored, keys);
      const choiceKeys = choiceQuestionKeys(stored, keys);
      if (labelMap.size > 0 || choiceKeys.size > 0) {
        displayAnswers = applyOptionLabelsToAnswers(
          withOverrides,
          labelMap,
          choiceKeys,
        );
      }
    }
  } catch {
    // Best-effort: values stay as stored.
  }
  if (
    typeof displayAnswers[META_SOURCE_COLUMN_KEY] === "string" &&
    (displayAnswers[META_SOURCE_COLUMN_KEY] as string).trim() !== ""
  ) {
    sourceFromWorkspace = displayAnswers[META_SOURCE_COLUMN_KEY] as string;
  }

  const { data: profiles } = await db
    .from("profiles")
    .select("user_id, full_name")
    .eq("account_id", accountId);
  const roster = (profiles ?? []) as Array<{
    user_id: string;
    full_name: string | null;
  }>;
  const business = resolveBusinessDisplays({ fields, values, roster });

  const answersForMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(displayAnswers)) {
    if (typeof v === "string" && v !== "") answersForMap[k] = v;
  }

  let contactName: string | null = null;
  let contactPhone: string | null = null;
  const contactId = submission.contact_id ?? runRow.contact_id ?? null;
  if (contactId) {
    try {
      const { data: contact } = await db
        .from("contacts")
        .select("name, phone")
        .eq("id", contactId)
        .eq("account_id", accountId)
        .maybeSingle();
      const c = contact as { name?: unknown; phone?: unknown } | null;
      if (typeof c?.name === "string" && c.name.trim() !== "")
        contactName = c.name;
      if (typeof c?.phone === "string" && c.phone.trim() !== "")
        contactPhone = c.phone;
    } catch {
      // Best-effort: fall back to answers below.
    }
  }
  const standard = standardContactFromAnswers(
    displayAnswers as Record<string, string | null | undefined>,
  );
  const workspaceName = contactName ?? standard.name ?? null;
  const workspacePhone = contactPhone ?? standard.phone ?? null;
  const workspaceEmail = standard.email ?? null;

  const { data: formRow } = submission.form_id
    ? await db
        .from("meta_lead_forms")
        .select("form_name")
        .eq("account_id", accountId)
        .eq("form_id", submission.form_id)
        .maybeSingle()
    : { data: null };
  const formName =
    (formRow as { form_name?: unknown } | null)?.form_name ??
    submission.form_name;

  const fieldMap = buildLeadFieldMap({
    metaLeadId: submission.meta_lead_id,
    submittedAt:
      runRow.started_at ?? submission.meta_created_time ?? submission.created_at,
    answers: answersForMap,
    formName: typeof formName === "string" ? formName : null,
    campaignName: submission.campaign_name,
    adName: submission.ad_name,
    source: sourceFromWorkspace ?? submission.source,
    assigneeDisplay: business.assigneeDisplay,
    leadType: business.leadType,
    stage: business.stage,
  });
  if (workspaceName !== null) fieldMap["name"] = workspaceName;
  if (workspacePhone !== null) fieldMap["phone"] = workspacePhone;
  if (workspaceEmail !== null) fieldMap["email"] = workspaceEmail;
  return fieldMap;
}

/**
 * Latest processed lead's field map for one table — powers the
 * dialog's sample preview ("using the selected row data where
 * available"). Best-effort: null when no processed lead exists.
 * Never throws.
 */
export async function getLatestLeadFieldMap(
  db: SupabaseClient,
  accountId: string,
  formId: string,
): Promise<Record<string, string> | null> {
  try {
    const { data, error } = await db
      .from("meta_lead_submissions")
      .select(
        "id, meta_lead_id, flow_run_id, form_id, form_name, campaign_name, ad_name, source, meta_created_time, created_at, contact_id",
      )
      .eq("account_id", accountId)
      .eq("form_id", formId)
      .eq("status", "processed")
      .not("flow_run_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return resolveLeadVariableFieldMap(
      db,
      accountId,
      data as LeadSubmissionLite,
    );
  } catch {
    return null;
  }
}
