// GET /api/integrations/meta-crm/preview?flow_id=&run_id=
//
// Backend-generated send preview for the manual Lead Quality →
// Meta CRM flow. Read-only: never writes, never touches Meta.
// Returns the effective status, mapped event, dataset + Meta Lead
// IDs, the timestamp behavior, the FULL payload JSON built by the
// SAME builder the send path uses, and the latest ledger state for
// the lead — plus a server-generated preview id the send endpoint
// revalidates (stale-preview protection).
//
// Any authenticated workspace member may preview (viewer-safe:
// no tokens, no secrets in the response).

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { assembleLeadQualityPreview } from "@/lib/meta-crm/preview";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const url = new URL(request.url);
    const flowId = (url.searchParams.get("flow_id") ?? "").trim();
    const runId = (url.searchParams.get("run_id") ?? "").trim();
    if (!flowId || !runId) {
      return NextResponse.json(
        { error: "flow_id and run_id are required." },
        { status: 400 },
      );
    }

    const preview = await assembleLeadQualityPreview(ctx.supabase, {
      accountId: ctx.accountId,
      flowId,
      runId,
    });
    return NextResponse.json({ ok: true, preview });
  } catch (err) {
    return toErrorResponse(err);
  }
}
