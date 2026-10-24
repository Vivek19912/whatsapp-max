// GET /api/integrations/meta-lead-ads/sheets/fields
//
// Forms + selectable columns for the Meta Sheets settings UI
// (members+). Everything is account-scoped server-side: only this
// account's Instant Forms and their questions are ever returned.
// Tokens are never involved. Meta-only: never touches Flow Tables.

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { STANDARD_SHEETS_FIELDS, buildDynamicFieldOptions } from "@/lib/meta-lead-sheets/columns";
import { parseFormQuestions, questionVarKeys } from "@/lib/meta-lead-ads/virtual-flow";

interface FormRow {
  id: string;
  form_id: string;
  form_name: string | null;
  page_id: string;
  enabled: boolean;
  questions: unknown;
}

interface PageRow {
  page_id: string;
  page_name: string | null;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const [{ data: forms }, { data: pages }, { data: config }] = await Promise.all([
      ctx.supabase
        .from("meta_lead_forms")
        .select("id, form_id, form_name, page_id, enabled, questions")
        .eq("account_id", ctx.accountId)
        .order("form_name", { ascending: true }),
      ctx.supabase
        .from("meta_lead_pages")
        .select("page_id, page_name")
        .eq("account_id", ctx.accountId),
      ctx.supabase
        .from("meta_lead_sheets_configs")
        .select("form_ids, column_config")
        .eq("account_id", ctx.accountId)
        .maybeSingle(),
    ]);
    const pageNames = new Map(
      ((pages ?? []) as PageRow[]).map((p) => [p.page_id, p.page_name ?? p.page_id]),
    );
    const formRows = ((forms ?? []) as FormRow[]).map((f) => {
      const questions = parseFormQuestions(f.questions);
      const keys = questionVarKeys(questions);
      return {
        id: f.id,
        form_id: f.form_id,
        form_name: f.form_name,
        page_id: f.page_id,
        page_name: pageNames.get(f.page_id) ?? f.page_id,
        enabled: f.enabled,
        question_count: questions.length,
        // Stable answer keys (same derivation ingestion uses) with
        // human labels for the column picker.
        questions: questions.map((q, index) => ({
          key: keys[index] ?? `question_${index}`,
          label: (q.label ?? "").trim() || (q.key ?? "").trim() || `Question ${index + 1}`,
        })),
      };
    });
    const cfg = config as { form_ids?: string[] | null; column_config?: unknown } | null;
    return NextResponse.json({
      forms: formRows,
      standard: STANDARD_SHEETS_FIELDS.map((f) => ({ ...f })),
      dynamic: buildDynamicFieldOptions(
        formRows.map((f) => ({ form_name: f.form_name, questions: f.questions })),
      ),
      selected: {
        form_ids: Array.isArray(cfg?.form_ids) ? cfg.form_ids : null,
        columns: Array.isArray(cfg?.column_config) ? cfg.column_config : null,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
