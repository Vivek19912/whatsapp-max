// ============================================================
// Workspace follow-up → reminder link (pure, client-safe).
//
// Meta Lead Ads Tables let agents set a "Next Follow-up Date &
// Time" per lead. Saving it offers a "Create Follow-up Reminder"
// dialog that schedules exactly one linked reminder through the
// EXISTING whatsapp_followups system (same table, lifecycle,
// scheduler, and delivery — nothing parallel).
//
// Association identity: source_kind = 'meta_workspace_followup'
// plus source_run_id = the lead's flow_runs.id, scoped by
// account_id. Manual reminders (both columns NULL) are never
// matched by the link queries, so they keep working unchanged.
//
// Pure and dependency-free — unit tested directly. Flow Tables
// never import this module.
// ============================================================

/** Linkage discriminator stored in whatsapp_followups.source_kind. */
export const WORKSPACE_FOLLOWUP_SOURCE_KIND = "meta_workspace_followup";

/** Canonical Workspace column name carrying the per-lead follow-up. */
export const WORKSPACE_FOLLOWUP_FIELD_NAME = "next follow-up date & time";

/**
 * Whether a workspace field name is the canonical follow-up column.
 * Case/whitespace-insensitive; never matches non-text input.
 */
export function isWorkspaceFollowupFieldName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    name.trim().toLowerCase() === WORKSPACE_FOLLOWUP_FIELD_NAME
  );
}

/**
 * Default reminder message when the agent leaves the message blank.
 * Never emits literal "undefined"/"null"/template variables: a
 * missing name falls back to "this lead" and a missing phone omits
 * the Phone line entirely.
 *
 * Exact shape (both present):
 *   Follow up with <name>
 *   Phone: <phone>
 *
 *   Remember to contact this lead at the scheduled time.
 */
export function buildWorkspaceFollowupMessage(args: {
  name?: string | null;
  phone?: string | null;
}): string {
  const name = (args.name ?? "").trim();
  const phone = (args.phone ?? "").trim();
  const lines = [`Follow up with ${name !== "" ? name : "this lead"}`];
  if (phone !== "") lines.push(`Phone: ${phone}`);
  lines.push("", "Remember to contact this lead at the scheduled time.");
  return lines.join("\n");
}

/**
 * Display formatting for a stored follow-up instant. Mirrors the
 * Workspace datetime cell (day, month, hour, minute in the viewer's
 * locale); invalid input renders an em dash, never "Invalid Date".
 */
export function formatWorkspaceFollowupDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
