// ============================================================
// Reconcile Workspace <-> Inbox ownership.
//
// DRY-RUN by default: reports mismatches, changes nothing.
//   node scripts/reconcile-workspace-inbox.mjs
//   node scripts/reconcile-workspace-inbox.mjs --account <uuid>
// APPLY safe fixes (NULL-only adoption):
//   node scripts/reconcile-workspace-inbox.mjs --fix
//
// Rules (mirrors src/lib/inbox/assignment-sync.ts):
//   Case A (NULL inbox owner + exactly one valid member owner) -> adopt.
//   Case B (different non-NULL owners) -> REPORT ONLY, never overwrite.
//   Case C (conflicting workspace owners) -> REPORT ONLY.
//   External / non-member / non-UUID values are ignored (no-owner).
//   All writes are conditional (eq NULL + account scoping), idempotent.
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSIGNED_TO = "assigned to";

const args = new Set(process.argv.slice(2));
const FIX = args.has("--fix");
const accountFilter = (() => {
  const i = process.argv.indexOf("--account");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function paged(table, select, eq, pageSize = 500) {
  const out = [];
  let from = 0;
  for (;;) {
    let q = db.from(table).select(select).range(from, from + pageSize - 1);
    if (eq) for (const [k, v] of Object.entries(eq)) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

const isUuidOwner = (v) =>
  typeof v === "string" && v.trim() !== "" && v.trim().toLowerCase() !== "unassigned" && UUID_RE.test(v.trim());

const accounts = accountFilter
  ? [{ id: accountFilter }]
  : await paged("accounts", "id");

let totals = { match: 0, adoptable: 0, adopted: 0, conflict: 0, diverged: 0, noOwner: 0, noField: 0, externalOnly: 0 };
const report = [];

for (const a of accounts) {
  const accountId = a.id;
  const profiles = await paged("profiles", "user_id", { account_id: accountId });
  const liveMembers = new Set(profiles.map((p) => p.user_id));
  const conversations = await paged(
    "conversations",
    "id, contact_id, assigned_agent_id",
    { account_id: accountId },
  );
  // Only conversations linked to a contact matter.
  const withContact = conversations.filter((c) => c.contact_id);
  // Batch flow_runs for these contacts.
  const contactIds = [...new Set(withContact.map((c) => c.contact_id))];
  const runsByContact = new Map();
  for (let i = 0; i < contactIds.length; i += 100) {
    const chunk = contactIds.slice(i, i + 100);
    const { data, error } = await db
      .from("flow_runs")
      .select("id, contact_id, flow_id")
      .eq("account_id", accountId)
      .in("contact_id", chunk);
    if (error) throw error;
    for (const r of data ?? []) {
      if (!runsByContact.has(r.contact_id)) runsByContact.set(r.contact_id, []);
      runsByContact.get(r.contact_id).push(r);
    }
  }
  // Flows kind + assignee fields.
  const allFlowIds = [...new Set([...runsByContact.values()].flat().map((r) => r.flow_id).filter(Boolean))];
  const kindByFlow = new Map();
  const fieldByFlow = new Map();
  for (let i = 0; i < allFlowIds.length; i += 100) {
    const chunk = allFlowIds.slice(i, i + 100);
    const { data: flows } = await db.from("flows").select("id, kind").eq("account_id", accountId).in("id", chunk);
    for (const f of flows ?? []) kindByFlow.set(f.id, f.kind);
    const { data: fields } = await db
      .from("workspace_fields")
      .select("id, flow_id, name")
      .eq("account_id", accountId)
      .in("flow_id", chunk);
    for (const fld of fields ?? []) {
      if (typeof fld.name === "string" && fld.name.trim().toLowerCase() === ASSIGNED_TO) {
        if (!fieldByFlow.has(fld.flow_id)) fieldByFlow.set(fld.flow_id, fld.id);
      }
    }
  }
  // Workspace values for relevant runs.
  const allRunIds = [...runsByContact.values()].flat().map((r) => r.id);
  const valueByRun = new Map();
  for (let i = 0; i < allRunIds.length; i += 200) {
    const chunk = allRunIds.slice(i, i + 200);
    const { data } = await db
      .from("workspace_values")
      .select("flow_run_id, field_id, value_text")
      .eq("account_id", accountId)
      .in("flow_run_id", chunk);
    for (const v of data ?? []) valueByRun.set(`${v.field_id}:${v.flow_run_id}`, v.value_text);
  }

  for (const conv of withContact) {
    const runs = runsByContact.get(conv.contact_id) ?? [];
    const metaRuns = runs.filter((r) => kindByFlow.get(r.flow_id) === "meta_lead_ads");
    const relevant = metaRuns.length > 0 ? metaRuns : [];
    if (relevant.length === 0) continue; // unrelated conversation: preserve as-is.
    const owners = new Set();
    let hasField = false;
    let externalSeen = false;
    for (const r of relevant) {
      const fieldId = fieldByFlow.get(r.flow_id);
      if (!fieldId) continue;
      hasField = true;
      const stored = valueByRun.get(`${fieldId}:${r.id}`) ?? null;
      if (stored === null || stored === undefined) continue;
      if (typeof stored === "string" && stored.trim().toLowerCase() === "unassigned") continue;
      if (!isUuidOwner(stored)) {
        externalSeen = true;
        continue;
      }
      const uid = stored.trim();
      if (!liveMembers.has(uid)) {
        externalSeen = true;
        continue;
      }
      owners.add(uid);
    }
    if (!hasField) {
      totals.noField++;
      continue;
    }
    const inboxOwner = typeof conv.assigned_agent_id === "string" && conv.assigned_agent_id.trim() !== "" ? conv.assigned_agent_id.trim() : null;
    if (owners.size === 0) {
      totals.noOwner++;
      if (externalSeen) totals.externalOnly++;
      continue;
    }
    if (owners.size > 1) {
      totals.conflict++;
      report.push({ accountId, conversationId: conv.id, contactId: conv.contact_id, kind: "conflict", owners: [...owners], inboxOwner });
      continue;
    }
    const [wsOwner] = [...owners];
    if (inboxOwner === wsOwner) {
      totals.match++;
      continue;
    }
    if (inboxOwner === null) {
      totals.adoptable++;
      report.push({ accountId, conversationId: conv.id, contactId: conv.contact_id, kind: "adoptable", wsOwner });
      if (FIX) {
        // Conditional NULL-only adoption: never clobbers a concurrent manual assign.
        const { error } = await db
          .from("conversations")
          .update({ assigned_agent_id: wsOwner })
          .eq("id", conv.id)
          .eq("account_id", accountId)
          .is("assigned_agent_id", null);
        if (!error) totals.adopted++;
        else report.push({ accountId, conversationId: conv.id, kind: "adopt-error", message: error.message });
      }
      continue;
    }
    // Different non-NULL owners: report, never overwrite.
    totals.diverged++;
    report.push({ accountId, conversationId: conv.id, contactId: conv.contact_id, kind: "diverged", wsOwner, inboxOwner });
  }
}

console.log(JSON.stringify({ fix: FIX, accountFilter: accountFilter ?? null, totals, mismatches: report.slice(0, 200), mismatchCount: report.length }, null, 2));
if (!FIX && totals.adoptable > 0) {
  console.log(`\nDry-run: ${totals.adoptable} conversation(s) would be adopted. Re-run with --fix to apply NULL-only adoption.`);
}
