// Meta Sheets latency — prompt-trigger wiring + no-regression pins.
//
// The shared processing path (`processSubmissionById`, used by the
// poll sweep, historical imports, and retries) schedules a prompt
// drain whenever a genuinely new outbox row is queued, while the
// five-minute cron stays the fallback. These source assertions pin
// that contract:
//   * prompt drains are per-account, bounded, post-commit, and caught;
//   * no new scheduler, no polling/lead/email/CAPI changes;
//   * no new Google credentials or env vars; Flow Tables untouched.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const src = (p: string) => readFileSync(`${root}/${p}`, "utf8");

describe("prompt drain — webhook (new lead path)", () => {
  it("drains per affected account inside the existing after() block", () => {
    const s = src("src/app/api/integrations/meta-lead-ads/webhook/route.ts");
    expect(s).toContain("drainSheetsQueue(admin, { limit: 20, onlyAccountId: accountId })");
    expect(s).toContain("sheetAccounts");
    // Ack + lead pipeline untouched.
    expect(s).toContain("EVENT_RECEIVED");
    expect(s).toContain("verifyMetaWebhookSignature");
    expect(s).toContain("recordLeadgenNotification");
    expect(s).toContain("processSubmissionById");
    expect(s).toContain("maxDuration = 60");
    // Exactly one tracked after() level: the drain awaits inside the
    // existing after-block (no nested after()).
    expect(s.match(/^\s+after\(/gm) ?? []).toHaveLength(1);
  });
});

describe("prompt drain — interactive routes (assign / cell / config)", () => {
  it("manual assignment schedules a post-response drain", () => {
    const s = src("src/app/api/flows/[id]/leads/[runId]/assign/route.ts");
    expect(s).toContain("scheduleSheetsDrainSoon({ accountId })");
    // Assignment + notification behavior untouched.
    expect(s).toContain("manualAssign(supabase, {");
    expect(s).toContain("maybeEnqueueForRun(supabaseAdmin(), {");
  });

  it("workspace cell save + clear schedule a drain only on Meta tables", () => {
    const s = src("src/app/api/flows/[id]/workspace-values/route.ts");
    expect(s.match(/scheduleSheetsDrainSoon\(\{ accountId \}\)/g) ?? []).toHaveLength(2);
    expect(s).toContain("recordWorkspaceStatusChanged");
  });

  it("sheets config save schedules a drain (import path still drains inline)", () => {
    const s = src("src/app/api/integrations/meta-lead-ads/sheets/config/route.ts");
    expect(s).toContain("scheduleSheetsDrainSoon({ accountId: ctx.accountId })");
    expect(s).toContain("backfillAccountSheets(admin, ctx.accountId, 500)");
    expect(s).toContain("getSheetsAccessToken");
  });
});

describe("prompt drain — trigger helper contract", () => {
  it("uses the tracked after() primitive, never a detached promise", () => {
    const s = src("src/lib/meta-lead-sheets/trigger.ts");
    expect(s).toContain('from "next/server"');
    expect(s).toContain("after(() => {");
    expect(s).not.toContain("setTimeout");
    expect(s).not.toContain("setInterval");
    expect(s).not.toContain("queueMicrotask");
  });

  it("shares the cron's drain, budget, and isolation", () => {
    const s = src("src/lib/meta-lead-sheets/trigger.ts");
    expect(s).toContain("drainSheetsQueue(supabaseAdmin(), {");
    expect(s).toContain("PROMPT_DRAIN_LIMIT");
    expect(s).toContain("onlyAccountId");
    expect(s).toContain(".catch(");
  });

  it("stays Meta-only with no new credentials", () => {
    const s = src("src/lib/meta-lead-sheets/trigger.ts");
    expect(s).not.toContain("google_connections");
    expect(s).not.toContain("flow_sheet_configs");
    expect(s).not.toContain("@/lib/flows/sheet-");
    expect(s).not.toContain("@/lib/google/");
    expect(s).not.toContain("GOOGLE_");
  });
});

describe("prompt drain — shared processing path (poll / import / retry)", () => {
  it("a newly processed lead schedules a prompt drain only when newly queued", () => {
    const s = src("src/lib/meta-lead-ads/process-lead.ts");
    expect(s).toContain("const { enqueued } = await maybeEnqueueSheetsSync(db, {");
    expect(s).toContain("if (enqueued) {");
    expect(s).toContain("scheduleSheetsDrainSoon({ accountId: submission.account_id });");
    // Scheduling is best-effort: it can never fail the committed lead.
    expect(s).toContain("prompt drain scheduling failed");
  });

  it("poll + import + retry still funnel through the shared path untouched", () => {
    const sync = src("src/lib/meta-lead-ads/sync.ts");
    // Retrieval logic unchanged: the poll sweep and historical
    // imports both ingest through processSubmissionById, which now
    // owns the prompt schedule.
    expect(sync).toContain("processSubmissionById(db, config, rec.submissionId)");
    expect(sync).not.toContain("scheduleSheetsDrainSoon");
    expect(sync).not.toContain("meta-lead-sheets");
    // Polling budget and cadence unchanged.
    expect(sync).toContain("POLL_PAGE_SIZE");
    expect(sync).toContain("POLL_MAX_PAGES");
    expect(sync).toContain("POLL_DEFAULT_LIMIT");
    // The due-retry loop also funnels through the shared path.
    const proc = src("src/lib/meta-lead-ads/process-lead.ts");
    expect(proc).toContain("processSubmissionById(db, config, row.id)");
  });

  it("manual import and retry routes ride the shared path (no direct sheets wiring)", () => {
    const importRoute = src(
      "src/app/api/integrations/meta-lead-ads/forms/import/route.ts",
    );
    expect(importRoute).toContain("importFormLeads(admin, config, {");
    expect(importRoute).not.toContain("meta-lead-sheets");
    const retryRoute = src("src/app/api/integrations/meta-lead-ads/retry/route.ts");
    expect(retryRoute).toContain("processSubmissionById(admin, config, submissionId)");
    expect(retryRoute).toContain("runDueRetries(admin, config, 20, ctx.accountId)");
    expect(retryRoute).not.toContain("meta-lead-sheets");
  });
});

describe("form + column selection — settings and enforcement", () => {
  it("config save validates forms and columns before touching the sheet", () => {
    const s = src("src/app/api/integrations/meta-lead-ads/sheets/config/route.ts");
    expect(s).toContain("Unknown form selected. Choose only forms from this account.");
    expect(s).toContain("validateColumnConfig(body.columns, allowedKeys)");
    expect(s).toContain("remapLayoutChunk(");
    expect(s).toContain("enqueueFormsDelta(admin, ctx.accountId, addedForms)");
    // Still admin-only, still validates spreadsheet access first.
    expect(s).toContain('requireRole("admin")');
    expect(s).toContain("getSheetsAccessToken");
    expect(s).toContain("maxDuration = 60");
  });

  it("cleanup requires an explicit confirmation and verified mappings", () => {
    const s = src("src/app/api/integrations/meta-lead-ads/sheets/cleanup/route.ts");
    expect(s).toContain("confirmed");
    expect(s).toContain("cleanupDeselectedRows");
    expect(s).toContain('requireRole("admin")');
    expect(s).toContain("status: 400");
  });

  it("fields endpoint is account-scoped and exposes stable keys", () => {
    const s = src("src/app/api/integrations/meta-lead-ads/sheets/fields/route.ts");
    expect(s).toContain(".eq(\"account_id\", ctx.accountId)");
    expect(s).toContain("buildDynamicFieldOptions");
    expect(s).toContain("STANDARD_SHEETS_FIELDS");
  });

  it("UI keeps form and column configuration inside the sheets card", () => {
    const s = src("src/components/settings/meta-lead-sheets-settings.tsx");
    expect(s).toContain("Meta Forms to Sync");
    expect(s).toContain("Choose Spreadsheet Columns");
    expect(s).toContain("Save Configuration");
    expect(s).toContain("No forms selected");
    expect(s).toContain("Meta Lead ID is always pinned to column A");
  });
});

describe("fallback + schedules unchanged", () => {
  it("the five-minute cron still drains inline (fallback preserved)", () => {
    const s = src("src/app/api/integrations/meta-lead-ads/cron/route.ts");
    expect(s).toContain("drainSheetsQueue(db, { limit: 20 })");
    expect(s).toContain("runDueRetries");
    expect(s).toContain("runLeadPolls(db, config, POLL_DEFAULT_LIMIT)");
    expect(s).toContain("drainMetaLeadNotifications(db)");
  });

  it("no new cron scheduler was added", () => {
    const vercel = readFileSync(`${root}/vercel.json`, "utf8");
    expect(vercel.match(/meta-lead-ads\/cron/g) ?? []).toHaveLength(1);
    // No Meta-Sheets cron path (the pre-existing all-sheets cron is
    // unrelated and untouched).
    expect(vercel).not.toContain("meta-lead-ads/sheets");
    const crons = JSON.parse(vercel) as { crons: Array<{ path: string; schedule: string }> };
    expect(crons.crons.map((c) => c.path)).toEqual([
      "/api/flows/cron",
      "/api/followups/cron",
      "/api/automations/cron",
      "/api/all-sheets/cron",
      "/api/integrations/meta-lead-ads/cron",
    ]);
  });

  it("no duplicate Google env vars or credentials were introduced", () => {
    const example = readFileSync(`${root}/.env.local.example`, "utf8");
    expect(example.match(/^#? ?GOOGLE_CLIENT_ID=/gm) ?? []).toHaveLength(1);
    expect(example.match(/^#? ?GOOGLE_CLIENT_SECRET=/gm) ?? []).toHaveLength(1);
    expect(example).not.toContain("META_SHEETS_GOOGLE");
    // The whole Meta Sheets lib references exactly the two existing
    // env vars via process.env (META_SHEETS_GOOGLE_SCOPES is only a
    // scope-constant name, not a credential).
    const libFiles = [
      "src/lib/meta-lead-sheets/oauth.ts",
      "src/lib/meta-lead-sheets/queue.ts",
      "src/lib/meta-lead-sheets/sheets-client.ts",
      "src/lib/meta-lead-sheets/trigger.ts",
      "src/lib/meta-lead-sheets/mapping.ts",
      "src/lib/meta-lead-sheets/columns.ts",
      "src/lib/meta-lead-sheets/constants.ts",
    ];
    for (const f of libFiles) {
      const matches = src(f).match(/process\.env\.(GOOGLE_[A-Z_]+)/g) ?? [];
      for (const m of matches) {
        expect(["process.env.GOOGLE_CLIENT_ID", "process.env.GOOGLE_CLIENT_SECRET"]).toContain(m);
      }
    }
  });
});
