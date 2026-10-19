// ============================================================
// Workspace (Flow Tables) foundation — shared row/column model.
//
// One row = ONE flow_runs row (flow_run_id is the identity; the
// same contact may legitimately own several rows). Columns are
// derived from the selected flow's own nodes (never hardcoded),
// plus a small fixed set of system columns. Completion is a pure
// classification over execution reach — it never terminates runs
// and never duplicates data: the table is a view over the
// existing flow_runs / contacts / flow_run_events.
// ============================================================

import {
  deriveFlowColumns,
  orderNodesForSheets,
  type FlowNodeLite,
} from "./sheet-columns";
import type {
  WorkspaceField,
  WorkspaceValuesByRun,
} from "./workspace-fields";

export type FlowTableView = "all" | "completed" | "incomplete";

export type FlowTableStatus = "completed" | "incomplete";

export interface FlowTableColumn {
  /** Stable identity: system id or the flow variable/node key. */
  key: string;
  /** Display label. Answer labels come from the flow, not prompt text identity. */
  label: string;
  system: boolean;
  /**
   * Fixed choices for buttons/list questions (button titles / list
   * row titles from node config), when the question offers them.
   * Absent for free-text questions and system columns. Display and
   * override editors read this — Sheets and Travel CRM never do.
   */
  options?: string[];
}

/**
 * Stable UNIQUE React rendering key for one flow-table column.
 * A flow answer can legally share its logical key with a system
 * column (e.g. a `var_key` of exactly "name" sits beside the
 * system Name column) — keying by `c.key` alone then renders
 * siblings with duplicate keys. Namespacing by column kind keeps
 * display names, data, and order untouched while guaranteeing
 * sibling uniqueness: stable DB/field ids first (custom fields
 * keep `f.id` at the call site), then this kind-qualified key.
 */
export function flowColumnRenderKey(
  column: Pick<FlowTableColumn, "key" | "system">,
): string {
  return `${column.system ? "sys" : "flow"}:${column.key}`;
}

export interface FlowTableMeta {
  flowId: string;
  flowName: string;
  /**
   * Flow origin. `meta_lead_ads` flows are virtual (one per enabled
   * Instant Form) and have no conversational builder — the Workspace
   * hides the builder links for them. Optional for older responses.
   */
  kind?: string | null;
  /** Nullable: NULL = END node decides (backwards compatible). */
  completionNodeId: string | null;
  view: FlowTableView;
  total: number;
  page: number;
  pageSize: number;
  /**
   * Echo of the applied Workspace filters (additive, migration
   * 094). Absent on older responses — always treated as inactive.
   * dateFrom/dateTo are ISO instants or null; assignee is "all" |
   * "unassigned" | <member user_id>.
   */
  filters?: {
    dateFrom: string | null;
    dateTo: string | null;
    assignee: string;
  } | null;
}

export interface FlowTableRow {
  runId: string;
  contactId: string | null;
  conversationId: string | null;
  name: string | null;
  phone: string | null;
  startedAt: string;
  lastAdvancedAt: string | null;
  /** Classification timestamp: reach time (custom point) or ended_at. */
  completedAt: string | null;
  status: FlowTableStatus;
  /** Raw runtime status, preserved for future expansion. */
  runStatus: string;
  /** Vars projected onto the flow's answer columns (missing → null). */
  answers: Record<string, string | null>;
  /**
   * First-touch CTWA ad URL for the Ad Source column. NOT part of
   * the RPC projection — attached per page by the table route from
   * contacts.source_url (batched, never N+1).
   */
  sourceUrl?: string | null;
}

export interface FlowTablePayload {
  meta: FlowTableMeta;
  columns: FlowTableColumn[];
  rows: FlowTableRow[];
  /**
   * Workspace custom columns for this flow (phase 2). Absent on
   * older responses — always treated as []. Rendered AFTER all
   * flow columns; never sent to Google Sheets.
   */
  customFields?: WorkspaceField[];
  /** Custom cell values by run id, then field id. */
  customValues?: WorkspaceValuesByRun;
  /**
   * Agent overrides for flow-derived cells, by run id then
   * question key. Present key (even null) = edited (display wins);
   * absent key = show the original flow answer. Deleting an
   * override restores the original. Absent on older responses —
   * always treated as {}.
   */
  flowOverrides?: Record<string, Record<string, string | null>>;
  /**
   * Media messages per conversation for this page's runs, keyed by
   * conversation id. Additive, read-only enrichment (same pattern as
   * sourceUrl/customValues/flowOverrides): lets the Workspace render a
   * flow-answer filename that came from an inbound document/image as a
   * clickable link that opens the ACTUAL stored media URL (the existing
   * `/api/whatsapp/media/{mediaId}` proxy — never a new file-serving
   * system). Absent on older responses — always treated as {}.
   */
  mediaByConversation?: Record<string, AttachmentMediaEntry[]>;
  /**
   * Latest call recording per contact for this page's rows,
   * keyed by contact id. Additive, read-only enrichment (same
   * pattern as mediaByConversation): one batched query + one
   * profiles join, never N+1. Contacts without a recording have
   * no entry. Absent on older responses — always treated as {}.
   */
  latestRecordingByContact?: Record<string, LatestRecordingEntry>;
}

/**
 * Latest call recording for one contact — the subset the
 * Workspace needs for the "Latest Recording" column and the
 * lead drawer. Metadata only: audio streams on demand through
 * the existing `/api/recordings/[id]/audio` proxy, never here.
 */
export interface LatestRecordingEntry {
  /** The `call_recordings` row id (playback URL key). */
  id: string;
  contact_id: string;
  duration_seconds: number | null;
  recorded_at: string | null;
  created_at: string;
  file_name: string | null;
  /** Resolved uploader (`full_name` → `email` → `'Unknown'`). */
  uploader_name: string | null;
}

export const FLOW_TABLE_PAGE_SIZE = 25;

/**
 * One media message in a conversation (the subset the Workspace
 * needs to turn a captured attachment filename into a clickable
 * link). `contentText` is exactly what the flow captured as the
 * answer (`caption || filename` for documents, caption for images),
 * so matching is an exact equality, never fuzzy.
 */
export interface AttachmentMediaEntry {
  /** The flow-captured answer text (message content_text). */
  contentText: string | null;
  /** The existing file URL WACRM already uses for the attachment. */
  mediaUrl: string | null;
  /** Meta MIME type (image/pdf/document…) — display/decoration only. */
  contentType: string | null;
}

/**
 * Resolve the clickable file URL for a Workspace flow-answer cell.
 *
 * 1. When the cell value matches a media message in the run's
 *    conversation (a filename/caption captured from an inbound
 *    document/image), return the ACTUAL stored media URL — the
 *    existing `/api/whatsapp/media/{mediaId}` proxy WACRM already
 *    uses, which serves images/PDFs inline (never a download).
 * 2. Otherwise, when the value is itself an http(s) URL (e.g. a
 *    flow answer that stored the public link directly), return it
 *    unchanged.
 * 3. Otherwise null — the cell renders as plain text, exactly as
 *    today.
 *
 * Pure + exported for unit testing; never reads storage.
 */
export function resolveAttachmentUrl(
  mediaByConversation: Record<string, AttachmentMediaEntry[]>,
  conversationId: string | null | undefined,
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  if (conversationId) {
    const entry = (mediaByConversation[conversationId] ?? []).find(
      (m) => Boolean(m.mediaUrl) && m.contentText === value,
    );
    if (entry?.mediaUrl) return entry.mediaUrl;
  }
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

/** Shape of one row as returned by get_flow_table_rows(). */
export interface FlowTableRpcRow {
  run_id: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  conversation_id: string | null;
  status: string;
  started_at: string;
  last_advanced_at: string | null;
  ended_at: string | null;
  /** Set only when a custom point is configured AND reached. */
  reached_at: string | null;
  is_completed: boolean;
  vars: Record<string, unknown>;
}

/**
 * Table classification for one run. Source of truth = execution
 * reach of the configured node (custom point → reached_at; no
 * custom point → runtime status 'completed', i.e. the END-node
 * behavior every existing flow already has). Never column
 * fill-rate, message counts, or inactivity.
 */
export function classifyFlowRun(args: {
  status: string;
  reachedAt: string | null;
  completionNodeId: string | null;
}): FlowTableStatus {
  if (args.completionNodeId) return args.reachedAt ? "completed" : "incomplete";
  return args.status === "completed" ? "completed" : "incomplete";
}

/** When the run completed, if it did (reach time wins over ended_at). */
export function completedAtFor(args: {
  status: FlowTableStatus;
  reachedAt: string | null;
  endedAt: string | null;
}): string | null {
  if (args.status !== "completed") return null;
  return args.reachedAt ?? args.endedAt;
}

function answerText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") {
    return Number.isFinite(Number(value)) ? String(value) : null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Build the column list for a flow: fixed system columns plus one
 * column per question node (collect_input var_key, buttons/list
 * node_key), in flow order. Mirrors the Sheets column derivation
 * so the table and the sheets agree on what "the flow's fields"
 * are — but stored nowhere: pure view, recomputed per request.
 *
 * Column order invariant (Workspace requirement): Submission Time
 * is ALWAYS index 0, followed by Name, Phone Number, the dynamic
 * flow columns, Latest Recording at the end of those flow columns,
 * and Status last — for every flow, both views.
 *
 * When the flow itself collects a name, that flow-derived "Name"
 * column sits IMMEDIATELY after Submission Time (index 1), with
 * the system contact column ("WhatsApp Name") and Phone Number
 * following it:
 *   No. | Submission Time | Name | WhatsApp Name | Phone Number | …
 * Without a flow Name field the system order is unchanged:
 *   No. | Submission Time | Name | Phone Number | …
 * Only the display order of that one column moves — keys, flags,
 * answerKeys, values, visibility ids, and widths all stay exactly
 * as derived, so filters, Sheets, Travel CRM, and saved column
 * configurations keep working untouched.
 *
 * Name disambiguation (display-only): when the flow itself
 * collects a name (a flow-derived column labelled "Name"), the
 * system contact column renders as "WhatsApp Name" so the two
 * are never confused. The system column keeps key "name" and
 * `system: true`; the flow column keeps its own key, label, and
 * answer values. Nothing is removed, merged, or re-keyed —
 * Sheets, filters, Travel CRM, exports, visibility, and stored
 * submissions all keep working on the original identities.
 */
export function buildFlowTableColumns(
  nodes: FlowNodeLite[],
  entryNodeKey: string | null,
): { columns: FlowTableColumn[]; nameKey: string | null; answerKeys: string[] } {
  const ordered = orderNodesForSheets(entryNodeKey, nodes);
  const derived = deriveFlowColumns(ordered, true);
  const choiceOptions = choiceOptionsByKey(ordered);
  const answerKeys: string[] = [];
  const columns: FlowTableColumn[] = [
    { key: "submission_time", label: "Submission Time", system: true },
    { key: "name", label: "Name", system: true },
    { key: "phone", label: "Phone Number", system: true },
  ];
  if (derived.name) {
    answerKeys.push(derived.name.key);
    columns.push({
      key: derived.name.key,
      label: derived.name.header,
      system: false,
      options: choiceOptions.get(derived.name.key),
    });
  }
  for (const col of derived.rest) {
    answerKeys.push(col.key);
    columns.push({
      key: col.key,
      label: col.header,
      system: false,
      options: choiceOptions.get(col.key),
    });
  }
  // Latest call recording, placed at the END of the flow-derived
  // headers (after every flow column, just before Status). A
  // system column (never a flow answer, never sent to Sheets —
  // Sheets derives its own columns from nodes via
  // deriveFlowColumns/orderNodesForSheets, not from here).
  // Renders through a dedicated audio cell, not cellText.
  columns.push({ key: "latest_recording", label: "Latest Recording", system: true });
  columns.push({ key: "status", label: "Status", system: true });
  // Rename by column identity (system vs flow-derived), never by
  // blind label matching: only the SYSTEM name column is relabelled,
  // and only when a FLOW-DERIVED column actually renders as "Name".
  // A flow "Name" question stays visible as "Name"; custom business
  // fields live outside this column list and never trigger this.
  const flowHasNameColumn = columns.some(
    (c) => !c.system && c.label.trim().toLowerCase() === "name",
  );
  if (flowHasNameColumn) {
    const systemName = columns.find((c) => c.system && c.key === "name");
    if (systemName) systemName.label = "WhatsApp Name";
  }
  // Position the flow-collected "Name" column immediately after
  // Submission Time (index 1), ahead of the system WhatsApp Name
  // and Phone Number columns. Name-promoted questions already land
  // nearby; a "Name"-labelled question arriving via the general
  // flow order is relocated from among the other fields.
  // Display order only: the column object (key, label, flag) moves
  // as-is, so visibility, widths, and data resolution are unaffected.
  const flowNameIdx = columns.findIndex(
    (c) => !c.system && c.label.trim().toLowerCase() === "name",
  );
  if (flowNameIdx > 1) {
    const [flowNameCol] = columns.splice(flowNameIdx, 1);
    columns.splice(1, 0, flowNameCol);
  }
  return { columns, nameKey: derived.name?.key ?? null, answerKeys };
}

/** Display label for the Workspace flow selector. The UUID stays
 *  the internal value; a missing name must never surface as one. */
export function flowDisplayName(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? "";
  return trimmed ? trimmed : "Untitled Flow";
}

/**
 * Choice titles offered by buttons/list question nodes, keyed by
 * the same identity rule deriveFlowColumns uses (collect_input →
 * var_key, buttons/list → node_key). First-included-wins, skipped
 * nodes (non-questions, sheet_include: false, duplicates) never
 * contribute — mirroring derivation so options always belong to
 * the column that renders them. Pure.
 */
export function choiceOptionsByKey(
  nodes: FlowNodeLite[],
): Map<string, string[]> {
  const seen = new Set<string>();
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    if (!["collect_input", "send_buttons", "send_list"].includes(n.node_type)) {
      continue;
    }
    const cfg = n.config as {
      var_key?: string;
      sheet_include?: boolean;
      buttons?: Array<{ title?: string }>;
      sections?: Array<{ rows?: Array<{ title?: string }> }>;
    };
    if (cfg.sheet_include === false) continue;
    const isCollect = n.node_type === "collect_input";
    const key = isCollect ? cfg.var_key : n.node_key;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (isCollect) continue;
    const titles: string[] =
      n.node_type === "send_buttons"
        ? (cfg.buttons ?? [])
            .map((b) => (typeof b?.title === "string" ? b.title.trim() : ""))
            .filter((t) => t !== "")
        : (cfg.sections ?? []).flatMap((s) =>
            (s?.rows ?? [])
              .map((r) => (typeof r?.title === "string" ? r.title.trim() : ""))
              .filter((t) => t !== ""),
          );
    if (titles.length > 0) out.set(key, [...new Set(titles)]);
  }
  return out;
}

/**
 * Apply Workspace flow overrides onto original answers for
 * DISPLAY: override wins per key (explicit null clears to blank),
 * absent keys keep the original. Only keys present in `answers`
 * are eligible, so overrides for deleted questions never surface.
 * Pure — originals are never mutated (a copy is returned).
 */
export function resolveFlowAnswers(
  answers: Record<string, string | null>,
  overrides: Record<string, string | null> | null | undefined,
): Record<string, string | null> {
  if (!overrides) return { ...answers };
  const out = { ...answers };
  for (const [key, value] of Object.entries(overrides)) {
    if (key in out) out[key] = value;
  }
  return out;
}
/**
 * Key of the exact flow-derived Workspace "Name" column, if the
 * column list contains one. Identity-based (a NON-SYSTEM column
 * whose display label is exactly "Name", case-insensitive) — the
 * same identity the table renders, so Travel CRM prefills and any
 * other consumer read the very same question's answer. Returns
 * null when no flow-derived Name column exists (system Name,
 * custom business fields, and other name-like labels never
 * match). Pure and deterministic.
 */
export function findFlowNameAnswerKey(
  columns: readonly Pick<FlowTableColumn, "key" | "label" | "system">[],
): string | null {
  const col = columns.find(
    (c) => !c.system && c.label.trim().toLowerCase() === "name",
  );
  return col?.key ?? null;
}

/** Display fallback for a run that has no contact row (see below). */
export interface FlowTableIdentityFallback {
  name?: string | null;
  phone?: string | null;
}

/** Shape one RPC row into a table row (identity = flow_run_id). */
export function toFlowTableRow(
  rpc: FlowTableRpcRow,
  completionNodeId: string | null,
  nameKey: string | null,
  answerKeys: string[],
  identityFallback?: FlowTableIdentityFallback | null,
): FlowTableRow {
  const status = classifyFlowRun({
    status: rpc.status,
    reachedAt: rpc.reached_at,
    completionNodeId,
  });
  const vars = rpc.vars ?? {};
  const answers: Record<string, string | null> = {};
  for (const key of answerKeys) {
    answers[key] = key in vars ? answerText(vars[key]) : null;
  }
  return {
    runId: rpc.run_id,
    contactId: rpc.contact_id,
    conversationId: rpc.conversation_id,
    // The system slot always carries the canonical WhatsApp/contact
    // name — never the flow-collected answer, even when the flow
    // asked for one (that value lives in `answers` under its own
    // question key and renders in its own "Name" column). No
    // inference, no merging: the two values stay separate.
    //
    // Exception: a Meta Instant Form lead with no contact row (its
    // phone was absent/unusable) still HAS the name/phone Meta
    // supplied. Callers pass that normalized pair as a display
    // fallback; it is used ONLY when the contact field is empty and
    // is never written back. Contact data always wins.
    name: rpc.contact_name ?? identityFallback?.name ?? null,
    phone: rpc.contact_phone ?? identityFallback?.phone ?? null,
    startedAt: rpc.started_at,
    lastAdvancedAt: rpc.last_advanced_at,
    completedAt: completedAtFor({
      status,
      reachedAt: rpc.reached_at,
      endedAt: rpc.ended_at,
    }),
    status,
    runStatus: rpc.status,
    answers,
  };
}

/**
 * Deep-link target for a lead: the Workspace table filtered to
 * nothing, with `?contact=` carrying the canonical `contacts.id`.
 * The Workspace page selects the first row for that contact (see
 * `findWorkspaceRowForContact`), opening the same drawer a row
 * click opens — no parallel lead UI, no new route.
 */
export function workspaceContactHref(contactId: string): string {
  return `/workspace?contact=${encodeURIComponent(contactId)}`;
}

/**
 * Which Workspace row a `?contact=` deep link opens: the first row
 * whose `contactId` matches, in table order. Null for blank ids or
 * no match — the table then simply shows with nothing selected
 * (unknown/foreign ids and contacts without flow rows degrade to
 * the plain table, never an error).
 */
export function findWorkspaceRowForContact(
  rows: FlowTableRow[],
  contactId: string | null | undefined
): FlowTableRow | null {
  if (!contactId) return null;
  return rows.find((row) => row.contactId === contactId) ?? null;
}

/**
 * Deep-link locate result (`GET /api/workspace/locate-contact`).
 * Coordinates the client needs to bring a contact's row into the
 * loaded window through the NORMAL table path (flow + view + page
 * state) — the row itself is never fabricated, so the drawer keeps
 * its full payload context (custom values, overrides, media).
 */
export type LocateContactView = Exclude<FlowTableView, 'all'>;

export interface LocateContactHit {
  found: true;
  /** Flow holding the contact's most relevant run. */
  flow_id: string;
  /** Tab the run belongs to under Workspace classification. */
  view: LocateContactView;
  /** Zero-based page holding the run at the requested page size. */
  page: number;
  /** The located flow_run id (debug/verification only). */
  run_id: string;
}

export type LocateContactResponse =
  | LocateContactHit
  | { found: false };
