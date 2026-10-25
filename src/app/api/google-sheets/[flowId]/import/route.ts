import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { getValidAccessToken } from "@/lib/google/oauth";
import {
  appendRows,
  formatSubmissionTimeIST,
} from "@/lib/google/sheets";
import { resolveFlowSheetColumns } from "@/lib/flows/sheet-sync";
import {
  buildCompletedHeader,
  buildCompletedRow,
  completedAnswerOffset,
  stringifySheetCell,
} from "@/lib/flows/sheet-layout";
import {
  ASSIGN_KEY,
  COMPLETED_RUN_ID_KEY,
  getAssignsForFlowRuns,
} from "@/lib/automations/assignment";
import { setSheetColumnHidden } from "@/lib/google/sheets";
import { NextResponse } from "next/server";

/** Minimal shape of the flow_runs rows this route reads. */
type FlowRunRow = {
  id: string;
  contact_id?: string | null;
  vars?: unknown;
  started_at?: string | null;
  ended_at?: string | null;
};

function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export async function POST(
  request: Request,
  context: { params: Promise<{ flowId: string }> },
) {
  try {
    const { flowId } = await context.params;
    const ctx = await getCurrentAccount();

    // Optional date-range filter on started_at (from inclusive, to
    // exclusive). Absent/empty body imports everything.
    const body = await request.json().catch(() => ({}));
    const from = parseIsoDate((body as Record<string, unknown>)?.from);
    const to = parseIsoDate((body as Record<string, unknown>)?.to);

    const token = await getValidAccessToken(ctx.supabase, ctx.accountId);
    if (!token) {
      return NextResponse.json(
        { error: "Connect a Google account first." },
        { status: 400 },
      );
    }

    let runsQuery = ctx.supabase
      .from("flow_runs")
      .select("id, contact_id, vars, started_at, ended_at")
      .eq("flow_id", flowId)
      .eq("status", "completed");
    if (from) runsQuery = runsQuery.gte("started_at", from);
    if (to) runsQuery = runsQuery.lt("started_at", to);
    const { data: runs } = await runsQuery.order("started_at", {
      ascending: true,
    });

    if (!runs || runs.length === 0) {
      return NextResponse.json({ imported: 0 });
    }

    const assignMap = await getAssignsForFlowRuns(
      ctx.supabase,
      (runs as Array<{ id: string }>).map((r) => r.id),
    ).catch(() => new Map<string, string>());

    const resolved = await resolveFlowSheetColumns(ctx.supabase, flowId, token, {
      includeAssign: assignMap.size > 0,
    });
    if (!resolved || resolved.sheet.account_id !== ctx.accountId) {
      return NextResponse.json(
        { error: "Sheet not linked for this flow." },
        { status: 400 },
      );
    }

    const { sheet, nameKey, nameHeader, keys: answerColumns, headers: answerHeaders, activeKeys } = resolved;

    const contactIds = [...new Set(runs.map((r) => r.contact_id).filter(Boolean))];
    const contactMap = new Map<string, { phone?: string }>();
    if (contactIds.length > 0) {
      const { data: contacts } = await ctx.supabase
        .from("contacts")
        .select("id, phone")
        .in("id", contactIds as string[]);
      for (const c of contacts ?? []) {
        contactMap.set(c.id, { phone: c.phone });
      }
    }

    // Versioned layout (see sheet-layout.ts): V1/V2 sheets keep their
    // frozen Flow Name / User ID columns; V3 sheets omit them. V3 needs no
    // flows.name lookup (no Flow Name cell).
    const isV3 = (sheet.schema_version ?? 1) >= 3;
    const { data: flow } = isV3
      ? { data: null as { name?: string } | null }
      : await ctx.supabase
        .from("flows")
        .select("name")
        .eq("id", flowId)
        .maybeSingle();

    const resolvedNameHeader = nameKey ? (nameHeader ?? "Name") : null;

    const rows: (string | number)[][] = runs.map((run: FlowRunRow) => {
      const contact = run.contact_id ? contactMap.get(run.contact_id) : null;
      const vars = (run.vars ?? {}) as Record<string, unknown>;
      const varsWithAssign: Record<string, unknown> = { ...vars };
      if (answerColumns.includes(ASSIGN_KEY)) {
        varsWithAssign[ASSIGN_KEY] = assignMap.get(run.id) ?? "";
      }
      if (answerColumns.includes(COMPLETED_RUN_ID_KEY)) {
        varsWithAssign[COMPLETED_RUN_ID_KEY] = run.id;
      }
      return buildCompletedRow({
        schemaVersion: sheet.schema_version ?? 1,
        nameHeader: resolvedNameHeader,
        nameValue: nameKey ? stringifySheetCell(vars[nameKey]) : null,
        contactPhone: contact?.phone ?? "",
        flowName: flow?.name ?? "",
        submissionTime: formatSubmissionTimeIST(run.ended_at ?? run.started_at),
        contactId: run.contact_id ?? "",
        answerKeys: answerColumns,
        answerHeaders,
        activeKeys,
        vars: varsWithAssign,
      });
    });

    const toWrite = sheet.header_written
      ? rows
      : [buildCompletedHeader({
        schemaVersion: sheet.schema_version ?? 1,
        nameHeader: resolvedNameHeader,
        nameValue: null,
        contactPhone: "",
        flowName: "",
        submissionTime: "",
        contactId: "",
        answerKeys: answerColumns,
        answerHeaders,
        activeKeys,
        vars: {},
      }), ...rows];

    await appendRows(token, sheet.spreadsheet_id, sheet.sheet_tab, toWrite);

    if (!sheet.header_written) {
      await ctx.supabase
        .from("flow_sheet_configs")
        .update({ header_written: true })
        .eq("flow_id", flowId);
    }

    if (answerColumns.includes(COMPLETED_RUN_ID_KEY)) {
      try {
        const runIdCol =
          completedAnswerOffset(sheet.schema_version ?? 1, !!resolvedNameHeader) +
          answerColumns.indexOf(COMPLETED_RUN_ID_KEY);
        await setSheetColumnHidden(
          token,
          sheet.spreadsheet_id,
          sheet.sheet_tab,
          runIdCol,
          true,
        );
      } catch (err) {
        console.error("[import] could not hide Completed Run ID column:", err);
      }
    }

    return NextResponse.json({ imported: rows.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
