import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  toErrorResponse,
  type AccountContext,
} from "@/lib/auth/account";
import {
  parseAssigneeParam,
  serializeAssigneeSelection,
  validateWorkspaceDateRange,
  COLUMN_FILTER_VALUES_MAX,
  COLUMN_FILTER_VALUE_MAX,
  type WorkspaceDateRange,
  type WorkspaceAssigneeSelection,
} from "@/lib/flows/workspace-filters";
import { standardContactFromAnswers } from "@/lib/meta-lead-ads/normalize";
import { metaWorkspaceDisplayName } from "@/lib/meta-lead-ads/workspace-name";
import {
  applyOptionLabelsToAnswers,
  buildOptionLabelMap,
  choiceQuestionKeys,
  mapAnswerValue,
  type StoredFormQuestion,
} from "@/lib/meta-lead-ads/option-labels";
import {
  parseFormQuestions,
  questionVarKeys,
} from "@/lib/meta-lead-ads/virtual-flow";
import {
  buildAllMetaFormAnswers,
  type AllMetaFormAnswer,
} from "@/lib/workspace/all-meta-leads";
import { latestByContact } from "@/lib/recordings/recordings";
import { uploaderNamesByUserId } from "@/lib/recordings/uploaders";
import type {
  AttachmentMediaEntry,
  LatestRecordingEntry,
} from "@/lib/flows/flow-tables";

/**
 * GET /api/workspace/all-meta-leads
 *
 * Virtual combined view: one row per Meta lead across every Meta Lead
 * Ads table for the account. Canonical source is meta_lead_submissions
 * (account_id + meta_lead_id), joined to the authoritative processed
 * flow_runs row. No duplicate rows, no copies, no flow/run rewrites.
 *
 * Query params (all optional, AND-combined, server-side):
 *   search, page, pageSize, dateFrom, dateTo, assignee,
 *   tableId (originating flow id), stage[], leadType[], callStatus[],
 *   followUpStatus[]
 *
 * Returns:
 *   {
 *     meta: { total, assignedTotal, tablesCount, page, pageSize,
 *             filters: { dateFrom, dateTo, assignee, tableId } },
 *     tables: [{ flowId, tableName, formName, enabled }],
 *     rows: [{ runId, flowId, flowName, tableName, contactId,
 *              conversationId, name, phone, startedAt, source,
 *              formAnswers: [{ key, question, answer, legacy }],
 *              assignedTo, type, stage, callStatus, followUpStatus,
 *              nextFollowUp, metaDetails, ... }],
 *     customValues, mediaByConversation, latestRecordingByContact
 *   }
 *
 * Every row retains its originating flowId + runId; actions must use
 * those (never the virtual id). Hidden + disabled forms contribute
 * historical leads. Dummy test leads stay visible. RLS + tenant
 * isolation follow the existing Workspace patterns.
 */

interface AllMetaRpcRow {
  meta_lead_id: string | null;
  submission_form_id: string | null;
  submission_form_name: string | null;
  ad_id: string | null;
  ad_name: string | null;
  campaign_name: string | null;
  is_organic: boolean | null;
  meta_created_time: string | null;
  submission_answers: Record<string, unknown> | null;
  run_id: string;
  flow_id: string;
  flow_name: string | null;
  meta_form_db_id: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  conversation_id: string | null;
  run_status: string;
  started_at: string;
  last_advanced_at: string | null;
  ended_at: string | null;
  vars: Record<string, unknown> | null;
}

function parseMultiValues(url: URL, key: string): string[] | null {
  const raw = url.searchParams.getAll(key);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const v = entry.trim();
    if (v === "" || seen.has(v)) continue;
    if (v.length > COLUMN_FILTER_VALUE_MAX) {
      throw new Error(
        `Filter values must be ${COLUMN_FILTER_VALUE_MAX} characters or fewer.`,
      );
    }
    seen.add(v);
    out.push(v);
  }
  if (out.length > COLUMN_FILTER_VALUES_MAX) {
    throw new Error(
      `At most ${COLUMN_FILTER_VALUES_MAX} values per filter.`,
    );
  }
  return out.length > 0 ? out : null;
}

function textOrNull(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t !== "" ? t : null;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

export async function GET(request: Request) {
  try {
    const ctx: AccountContext = await getCurrentAccount();
    const { supabase, accountId, userId, role } = ctx;
    const url = new URL(request.url);

    const search = url.searchParams.get("search")?.slice(0, 120) ?? "";
    const page = Math.max(Number(url.searchParams.get("page") ?? 0) || 0, 0);
    const pageSize = Math.min(
      Math.max(Number(url.searchParams.get("pageSize") ?? 25) || 25, 1),
      100,
    );

    let dateRange: WorkspaceDateRange | null = null;
    const rawFrom = url.searchParams.get("dateFrom");
    const rawTo = url.searchParams.get("dateTo");
    if (rawFrom !== null || rawTo !== null) {
      if (!rawFrom || !rawTo) {
        return NextResponse.json(
          { error: "dateFrom and dateTo are required together." },
          { status: 400 },
        );
      }
      try {
        dateRange = validateWorkspaceDateRange({ from: rawFrom, to: rawTo });
      } catch {
        return NextResponse.json(
          { error: "dateFrom/dateTo must be valid ISO datetimes with from <= to." },
          { status: 400 },
        );
      }
    }

    let assignee: WorkspaceAssigneeSelection;
    try {
      assignee = parseAssigneeParam(url.searchParams.get("assignee"));
    } catch {
      return NextResponse.json({ error: "Invalid assignee filter." }, { status: 400 });
    }

    // Agent isolation: agents WITHOUT View All see only their own assigned
    // leads (same rule as GET /api/flows/[id]/table). Force the assignee
    // filter server-side so the client cannot override it.
    if (role === "agent") {
      try {
        const { resolveWorkspaceVisibility } = await import(
          "@/lib/inbox/assignment-access"
        );
        const { restricted } = await resolveWorkspaceVisibility(
          supabase,
          accountId,
          userId,
          role,
        );
        if (restricted) {
          assignee = { type: "member", userId };
        }
      } catch {
        // Fail closed on lookup failure is handled by the table route with
        // 403; here we conservatively restrict to own leads.
        assignee = { type: "member", userId };
      }
    }

    const rawTableId = url.searchParams.get("tableId")?.trim() ?? "";
    const tableId = rawTableId !== "" ? rawTableId : null;
    // Validate tableId belongs to this account when provided (foreign ids
    // read as not-found, never an existence oracle for another tenant).
    if (tableId) {
      const { data: flowCheck } = await supabase
        .from("flows")
        .select("id")
        .eq("id", tableId)
        .eq("account_id", accountId)
        .eq("kind", "meta_lead_ads")
        .maybeSingle();
      if (!flowCheck) {
        return NextResponse.json({ error: "Table not found." }, { status: 404 });
      }
    }

    let stage: string[] | null = null;
    let leadType: string[] | null = null;
    let callStatus: string[] | null = null;
    let followUpStatus: string[] | null = null;
    try {
      stage = parseMultiValues(url, "stage");
      leadType = parseMultiValues(url, "leadType");
      // Accept `type` as an alias for `leadType` (spec column is "Type").
      const typeAlias = parseMultiValues(url, "type");
      if (typeAlias && !leadType) leadType = typeAlias;
      else if (typeAlias && leadType) {
        const seen = new Set(leadType);
        for (const v of typeAlias) if (!seen.has(v)) leadType.push(v);
      }
      callStatus = parseMultiValues(url, "callStatus");
      followUpStatus = parseMultiValues(url, "followUpStatus");
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid filter." },
        { status: 400 },
      );
    }

    // Discover all Meta Lead Ads virtual flows for the account (including
    // hidden + disabled — they still contribute historical leads).
    const { data: flowsData, error: flowsErr } = await supabase
      .from("flows")
      .select("id, name, meta_form_id")
      .eq("account_id", accountId)
      .eq("kind", "meta_lead_ads")
      .order("name", { ascending: true });
    if (flowsErr) throw flowsErr;
    const metaFlows = ((flowsData ?? []) as Array<{
      id: string;
      name: string | null;
      meta_form_id: string | null;
    }>).filter((f) => typeof f.id === "string");
    const flowIds = metaFlows.map((f) => f.id);
    const flowNameById = new Map(metaFlows.map((f) => [f.id, f.name ?? "Untitled"]));

    if (metaFlows.length === 0) {
      return NextResponse.json({
        meta: {
          total: 0,
          assignedTotal: 0,
          tablesCount: 0,
          page,
          pageSize,
          filters: {
            dateFrom: dateRange?.from ?? null,
            dateTo: dateRange?.to ?? null,
            assignee: serializeAssigneeSelection(assignee),
            tableId,
          },
        },
        tables: [],
        rows: [],
        customValues: {},
        mediaByConversation: {},
        latestRecordingByContact: {},
      });
    }

    // Paginated combined read (server-side, no browser fan-out).
    const { data: rpcData, error: rpcErr } = await supabase.rpc(
      "get_all_meta_leads",
      {
        p_search: search || null,
        p_page: page,
        p_page_size: pageSize,
        p_started_from: dateRange?.from ?? null,
        p_started_to: dateRange?.to ?? null,
        p_assignee: serializeAssigneeSelection(assignee),
        p_flow_id: tableId,
        p_stage: stage,
        p_lead_type: leadType,
        p_call_status: callStatus,
        p_followup_status: followUpStatus,
      },
    );
    if (rpcErr) {
      // Missing migration (local dev without 179 applied) surfaces here.
      // Return a clear 500 rather than an empty table that looks correct.
      return NextResponse.json(
        { error: `All Meta Leads read failed: ${rpcErr.message}` },
        { status: 500 },
      );
    }
    const total = Number((rpcData as { total?: unknown })?.total ?? 0) || 0;
    const assignedTotal =
      Number((rpcData as { assigned_total?: unknown })?.assigned_total ?? 0) || 0;
    const rpcRows = ((rpcData as { rows?: unknown })?.rows ?? []) as AllMetaRpcRow[];

    // Per-form question definitions (batched, never N+1).
    const { data: formsData } = await supabase
      .from("meta_lead_forms")
      .select("id, form_id, form_name, questions, enabled")
      .eq("account_id", accountId);
    const formsById = new Map(
      ((formsData ?? []) as Array<{
        id: string;
        form_id: string | null;
        form_name: string | null;
        questions: unknown;
        enabled: boolean | null;
      }>).map((f) => [f.id, f]),
    );
    // flowId → { questions, questionKeys, optionLabels, choiceKeys }
    const formDefByFlow = new Map<
      string,
      {
        questions: Array<{ key: string | null; label: string | null; type: string | null; options: Array<{ key: string | null; value: string | null }> }>;
        questionKeys: string[];
        optionLabels: Map<string, Map<string, string>>;
        choiceKeys: Set<string>;
      }
    >();
    for (const flow of metaFlows) {
      const form = flow.meta_form_id ? formsById.get(flow.meta_form_id) : null;
      const rawQuestions = form?.questions;
      const parsed = parseFormQuestions(rawQuestions);
      const keys = questionVarKeys(parsed);
      const stored: StoredFormQuestion[] = (Array.isArray(rawQuestions) ? rawQuestions : []).map(
        (entry) => {
          const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
          const rawOptions = Array.isArray(e.options) ? e.options : [];
          return {
            key: typeof e.key === "string" ? e.key : null,
            label: typeof e.label === "string" ? e.label : null,
            type: typeof e.type === "string" ? e.type : null,
            options: rawOptions.map((o) => {
              const oo = o && typeof o === "object" ? (o as Record<string, unknown>) : {};
              return {
                key: typeof oo.key === "string" ? oo.key : null,
                value: typeof oo.value === "string" ? oo.value : null,
              };
            }),
          };
        },
      );
      formDefByFlow.set(flow.id, {
        questions: parsed.map((q) => ({
          key: q.key ?? null,
          label: q.label ?? null,
          type: q.type ?? null,
          options: [],
        })),
        questionKeys: keys,
        optionLabels: buildOptionLabelMap(stored, keys),
        choiceKeys: choiceQuestionKeys(stored, keys),
      });
      // Keep original labels for the tooltip (parsed strips options only).
      const withLabels = parsed.map((q) => ({
        key: q.key ?? null,
        label: q.label ?? null,
        type: q.type ?? null,
        options: [] as Array<{ key: string | null; value: string | null }>,
      }));
      const existing = formDefByFlow.get(flow.id);
      if (existing) existing.questions = withLabels;
    }

    // Workspace business fields for all Meta flows (batched).
    const { data: fieldsData } = await supabase
      .from("workspace_fields")
      .select("id, flow_id, name, field_type, options, default_value")
      .eq("account_id", accountId)
      .in("flow_id", flowIds);
    const fieldsByFlow = new Map<string, Array<{ id: string; name: string }>>();
    for (const f of ((fieldsData ?? []) as Array<{ id: string; flow_id: string; name: string }>)) {
      if (!fieldsByFlow.has(f.flow_id)) fieldsByFlow.set(f.flow_id, []);
      fieldsByFlow.get(f.flow_id)!.push({ id: f.id, name: f.name });
    }
    const fieldIdByFlowAndName = new Map<string, Map<string, string>>();
    for (const [flowIdKey, fields] of fieldsByFlow) {
      const byName = new Map<string, string>();
      for (const f of fields) byName.set(f.name.trim().toLowerCase(), f.id);
      fieldIdByFlowAndName.set(flowIdKey, byName);
    }
    const findFieldId = (flowIdKey: string, names: string[]): string | null => {
      const byName = fieldIdByFlowAndName.get(flowIdKey);
      if (!byName) return null;
      for (const n of names) {
        const id = byName.get(n.trim().toLowerCase());
        if (id) return id;
      }
      return null;
    };

    const runIds = rpcRows.map((r) => r.run_id);
    const customValues: Record<string, Record<string, string | null>> = {};
    const valueByRunAndField = new Map<string, Map<string, string | null>>();
    if (runIds.length > 0) {
      const { data: valueRows } = await supabase
        .from("workspace_values")
        .select("flow_run_id, field_id, value_text")
        .in("flow_run_id", runIds);
      for (const v of ((valueRows ?? []) as Array<{
        flow_run_id: string;
        field_id: string;
        value_text: string | null;
      }>)) {
        (customValues[v.flow_run_id] ??= {})[v.field_id] = v.value_text;
        if (!valueByRunAndField.has(v.flow_run_id)) {
          valueByRunAndField.set(v.flow_run_id, new Map());
        }
        valueByRunAndField.get(v.flow_run_id)!.set(v.field_id, v.value_text);
      }
    }
    const readValue = (runId: string, flowIdKey: string, names: string[]): string | null => {
      const fieldId = findFieldId(flowIdKey, names);
      if (!fieldId) return null;
      const m = valueByRunAndField.get(runId);
      const v = m?.get(fieldId);
      return v ?? null;
    };

    // Media + recordings (batched, never N+1 — same pattern as table route).
    const contactIds = [...new Set(rpcRows.map((r) => r.contact_id).filter(Boolean))] as string[];
    const conversationIds = [...new Set(rpcRows.map((r) => r.conversation_id).filter(Boolean))] as string[];
    const mediaByConversation: Record<string, AttachmentMediaEntry[]> = {};
    if (conversationIds.length > 0) {
      const { data: mediaRows } = await supabase
        .from("messages")
        .select("conversation_id, content_text, media_url, content_type")
        .in("conversation_id", conversationIds)
        .not("media_url", "is", null)
        .order("created_at", { ascending: true });
      for (const m of ((mediaRows ?? []) as Array<{
        conversation_id: string;
        content_text: string | null;
        media_url: string | null;
        content_type: string | null;
      }>)) {
        if (!m.media_url) continue;
        (mediaByConversation[m.conversation_id] ??= []).push({
          contentText: m.content_text,
          mediaUrl: m.media_url,
          contentType: m.content_type,
        });
      }
    }
    const latestRecordingByContact: Record<string, LatestRecordingEntry> = {};
    if (contactIds.length > 0) {
      try {
        const { data: recordingRows, error: recErr } = await supabase
          .from("call_recordings")
          .select("id, contact_id, duration_seconds, recorded_at, created_at, file_name, uploaded_by")
          .eq("account_id", accountId)
          .in("contact_id", contactIds)
          .order("contact_id", { ascending: true })
          .order("recorded_at", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false })
          .order("id", { ascending: false });
        if (!recErr) {
          const latest = latestByContact(
            (((recordingRows ?? []) as Array<Record<string, unknown>>).map((r) => ({
              id: r.id as string,
              contact_id: (r.contact_id as string | null) ?? null,
              duration_seconds: (r.duration_seconds as number | null) ?? null,
              recorded_at: (r.recorded_at as string | null) ?? null,
              created_at: r.created_at as string,
              file_name: (r.file_name as string | null) ?? null,
              uploaded_by: (r.uploaded_by as string | null) ?? null,
            }))),
            (r) => r.contact_id,
          );
          const winnerIds = [...latest.values()].map((r) => r.uploaded_by).filter(Boolean) as string[];
          const names = await uploaderNamesByUserId(supabase, winnerIds);
          for (const [contactIdKey, r] of latest) {
            latestRecordingByContact[contactIdKey] = {
              id: r.id,
              contact_id: contactIdKey,
              duration_seconds: r.duration_seconds,
              recorded_at: r.recorded_at,
              created_at: r.created_at,
              file_name: r.file_name,
              uploader_name: r.uploaded_by ? (names[r.uploaded_by] ?? "Unknown") : null,
            };
          }
        }
      } catch (err) {
        console.error("all-meta-leads recordings read failed", err);
      }
    }

    const stripPrefix = (name: string | null): string => {
      const t = (name ?? "").trim();
      if (t === "") return "Untitled Flow";
      return t.replace(/^Meta Lead Ads\s*·\s*/, "");
    };

    const rows = rpcRows.map((r) => {
      const vars = ((r.vars ?? {}) as Record<string, unknown>);
      const def = formDefByFlow.get(r.flow_id);
      const questions = def?.questions ?? [];
      const questionKeys = def?.questionKeys ?? [];
      const optionLabels = def?.optionLabels ?? new Map();
      const choiceKeys = def?.choiceKeys ?? new Set<string>();

      // Display-mapped answers (same rules as the individual table route).
      const rawAnswers: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(vars)) {
        if (typeof v === "string") rawAnswers[k] = v === "" ? null : v;
        else if (typeof v === "number" || typeof v === "boolean") rawAnswers[k] = String(v);
        else rawAnswers[k] = null;
      }
      const displayAnswers = applyOptionLabelsToAnswers(rawAnswers, optionLabels, choiceKeys);
      const displayFor = (key: string, raw: string): string => {
        const mapped = mapAnswerValue(optionLabels.get(key), raw, choiceKeys.has(key));
        return mapped ?? raw;
      };
      void displayAnswers;

      const formAnswers: AllMetaFormAnswer[] = buildAllMetaFormAnswers({
        vars,
        questions,
        questionKeys,
        displayFor,
      });

      const fallback = standardContactFromAnswers(vars as Record<string, string | null | undefined>);
      const name = metaWorkspaceDisplayName(vars, r.contact_name);
      const phone = r.contact_phone ?? fallback.phone ?? null;

      const sourceRaw = textOrNull(vars["meta_lead_source"]);
      const source = sourceRaw ?? "Other";

      const assignedTo = readValue(r.run_id, r.flow_id, ["assigned to"]);
      const type =
        readValue(r.run_id, r.flow_id, ["lead type"]) ?? "Fresh";
      const stageVal =
        readValue(r.run_id, r.flow_id, ["stage"]) ?? "New Lead";
      const callStatusVal = readValue(r.run_id, r.flow_id, ["call status"]);
      const followUpStatusVal = readValue(r.run_id, r.flow_id, ["follow-up status"]);
      const nextFollowUp = readValue(r.run_id, r.flow_id, ["next follow-up date & time"]);

      const verifiedRaw =
        textOrNull((r.submission_answers as Record<string, unknown> | null)?.["phone_number_verified"]) ??
        textOrNull(vars["phone_number_verified"]);

      const flowName = r.flow_name ?? flowNameById.get(r.flow_id) ?? "Untitled";
      const tableName = stripPrefix(flowName);

      return {
        runId: r.run_id,
        flowId: r.flow_id,
        flowName,
        tableName,
        metaLeadId: r.meta_lead_id,
        formId: r.submission_form_id,
        contactId: r.contact_id,
        conversationId: r.conversation_id,
        name,
        phone,
        startedAt: r.started_at,
        lastAdvancedAt: r.last_advanced_at,
        source,
        formAnswers,
        assignedTo,
        type,
        stage: stageVal,
        callStatus: callStatusVal,
        followUpStatus: followUpStatusVal,
        nextFollowUp,
        fieldIds: {
          assignedTo: findFieldId(r.flow_id, ["assigned to"]),
          type: findFieldId(r.flow_id, ["lead type"]),
          stage: findFieldId(r.flow_id, ["stage"]),
          callStatus: findFieldId(r.flow_id, ["call status"]),
          followUpStatus: findFieldId(r.flow_id, ["follow-up status"]),
          nextFollowUp: findFieldId(r.flow_id, ["next follow-up date & time"]),
        },
        metaDetails: {
          metaLeadId: textOrNull(r.meta_lead_id),
          formId: textOrNull(r.submission_form_id),
          adId: textOrNull(r.ad_id),
          adName: textOrNull(r.ad_name),
          campaignName: textOrNull(r.campaign_name),
          isOrganic: typeof r.is_organic === "boolean" ? r.is_organic : null,
          metaCreatedTime: textOrNull(r.meta_created_time),
          phoneNumberVerified: verifiedRaw,
        },
      };
    });

    const tables = metaFlows.map((f) => {
      const form = f.meta_form_id ? formsById.get(f.meta_form_id) : null;
      return {
        flowId: f.id,
        flowName: f.name,
        tableName: stripPrefix(f.name),
        formId: form?.form_id ?? null,
        formName: form?.form_name ?? null,
        enabled: form?.enabled ?? null,
      };
    });

    return NextResponse.json({
      meta: {
        total,
        assignedTotal,
        tablesCount: metaFlows.length,
        page,
        pageSize,
        filters: {
          dateFrom: dateRange?.from ?? null,
          dateTo: dateRange?.to ?? null,
          assignee: serializeAssigneeSelection(assignee),
          tableId,
        },
      },
      tables,
      rows,
      customValues,
      mediaByConversation,
      latestRecordingByContact,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
