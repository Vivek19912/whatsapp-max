// ============================================================
// Inbox hidden-conversations — tenant-scoped hiding of whole threads.
//
// A row in `inbox_hidden_conversations` removes a conversation from
// Inbox surfaces only. Nothing is deleted: conversation, message,
// contact and every other module row is preserved, and unhiding
// restores visibility without reconstructing data.
//
// Pure helpers here are unit-testable; the two I/O functions take a
// minimal structural client type so tests can stub them.
// ============================================================

/** Minimal shape of the Supabase client surface used below. */
export interface HiddenQueryClient {
  from(table: string): {
    select(
      columns: string,
    ): PromiseLike<{
      data: { conversation_id: string }[] | null;
      error: { message: string } | null;
    }>;
  };
}

/**
 * Fetch the hidden conversation ids visible to the caller.
 * RLS (`inbox_hidden_select`) already scopes rows to accounts the
 * caller belongs to, so no account filter is sent from the client.
 */
export async function getHiddenConversationIds(
  supabase: HiddenQueryClient,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("inbox_hidden_conversations")
    .select("conversation_id");
  if (error || !data) return new Set();
  return new Set(data.map((r) => r.conversation_id));
}

/** True when the conversation id is in the hidden set. */
export function isHidden(hiddenIds: ReadonlySet<string>, id: string): boolean {
  return hiddenIds.has(id);
}

/** Drop hidden conversations from a list (preserves order). */
export function filterHidden<T extends { id: string }>(
  list: readonly T[],
  hiddenIds: ReadonlySet<string>,
): T[] {
  if (hiddenIds.size === 0) return [...list];
  return list.filter((c) => !hiddenIds.has(c.id));
}

/** Drop hidden ids from a candidate id list (search hydration). */
export function filterHiddenIds(
  ids: readonly string[],
  hiddenIds: ReadonlySet<string>,
): string[] {
  if (hiddenIds.size === 0) return [...ids];
  return ids.filter((id) => !hiddenIds.has(id));
}
