// ============================================================
// Meta delivery-error persistence — pure builders + thin writer.
//
// `handleStatusUpdate` mirrors only `status` onto `messages`; the
// callback `errors[]` (code/title/message) used to be discarded,
// making delivery failures undiagnosable. This module builds one
// `message_delivery_errors` row per error entry. It never throws:
// persistence must not break webhook intake.
// ============================================================

export interface StatusErrorEntry {
  code?: number;
  title?: string;
  message?: string;
  href?: string;
  error_data?: { details?: string };
}

export interface DeliveryErrorRow {
  account_id: string;
  message_id: string | null;
  provider_message_id: string;
  code: number | null;
  title: string | null;
  message: string | null;
  details: Record<string, unknown>;
  provider_timestamp: string | null;
}

/** Minimal structural client surface used by the writer. */
export interface DeliveryErrorClient {
  from(table: string): {
    insert(
      rows: DeliveryErrorRow[],
    ): PromiseLike<{ error: { message: string } | null }>;
  };
}

/**
 * Build one row per Meta error entry. Returns [] when there are no
 * errors. Only safe scalar fields are kept (code/title/message/href);
 * never tokens, payloads or message contents. WAMIDs that match no
 * local message still yield rows with a null message_id so the error
 * is recorded against the tenant rather than dropped — callers must
 * still resolve the tenant first and skip unattributable wamids.
 */
export function buildDeliveryErrorRows(args: {
  accountId: string;
  messageIds: readonly string[];
  providerMessageId: string;
  errors: readonly StatusErrorEntry[] | null | undefined;
  providerTimestampIso: string | null;
}): DeliveryErrorRow[] {
  const { accountId, messageIds, providerMessageId, errors } = args;
  if (!errors || errors.length === 0) return [];
  const targets = messageIds.length > 0 ? [...messageIds] : [null];
  const rows: DeliveryErrorRow[] = [];
  for (const target of targets) {
    for (const entry of errors) {
      const details: Record<string, unknown> = {};
      if (typeof entry.href === "string" && entry.href !== "") {
        details.href = entry.href;
      }
      // Meta's nested human-readable detail (e.g. why media fetch
      // failed). Scalar string only; never tokens or payloads.
      const nested =
        typeof entry.error_data === "object" &&
        entry.error_data !== null &&
        typeof entry.error_data.details === "string"
          ? entry.error_data.details
          : null;
      if (nested) details.error_data_details = nested;
      rows.push({
        account_id: accountId,
        message_id: target,
        provider_message_id: providerMessageId,
        code: typeof entry.code === "number" ? entry.code : null,
        title: typeof entry.title === "string" ? entry.title : null,
        message: typeof entry.message === "string" ? entry.message : null,
        details,
        provider_timestamp: args.providerTimestampIso,
      });
    }
  }
  return rows;
}

/** Best-effort insert. Resolves to the inserted count (0 on failure). */
export async function persistDeliveryErrors(
  supabase: DeliveryErrorClient,
  rows: readonly DeliveryErrorRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  try {
    const { error } = await supabase
      .from("message_delivery_errors")
      .insert([...rows]);
    if (error) {
      console.error("[delivery-errors] insert error:", {
        message: error.message,
      });
      return 0;
    }
    return rows.length;
  } catch (err) {
    console.error("[delivery-errors] insert threw:", err);
    return 0;
  }
}
