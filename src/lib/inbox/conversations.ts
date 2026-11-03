import type { Conversation, Contact, Tag } from "@/types";
import { pickContactFlowRun, type ContactFlowRun } from "./contact-flow";
import type { InboxLeadSource } from "./search";

/**
 * Lead Source filter values. `null` (component state) means "All Sources";
 * the validated `InboxLeadSource` union is what travels in the search key
 * and the `source` API param.
 */
export type LeadSourceFilter = InboxLeadSource | null;

/**
 * Whether a contact carries valid Click-to-WhatsApp attribution.
 *
 * Mirrors the RPC facet in 147_inbox_search_lead_source.sql exactly:
 * non-blank `source_url` OR non-blank `ctwa_clid`, where "blank" is
 * SQL `btrim(value) = ''` (spaces only). Removing every ASCII space and
 * comparing against '' is equivalent for the emptiness check, including
 * for tabs/newlines (which btrim does NOT strip, so they count as
 * valid in both implementations).
 */
export function hasValidCtwaAttribution(
  contact:
    | Pick<Contact, "source_url" | "ctwa_clid">
    | null
    | undefined
): boolean {
  if (!contact) return false;
  const url = contact.source_url;
  const clid = contact.ctwa_clid;
  return (
    (typeof url === "string" && url.replace(/ /g, "") !== "") ||
    (typeof clid === "string" && clid.replace(/ /g, "") !== "")
  );
}

/**
 * Whether the normal Inbox list must withhold the Lead Source filter
 * right now instead of filtering on an incomplete submission set.
 *
 * Server-side search never waits (its EXISTS runs in Postgres and its
 * results bypass client filtering); ctwa/all never need the lookup
 * (contact fields are already inline). Only instant_form/other on the
 * normal list block while the lookup is loading or failed.
 */
export function isSourceFilterBlocked(
  searching: boolean,
  source: LeadSourceFilter,
  submissionLinksReady: boolean
): boolean {
  if (searching) return false;
  if (source !== "instant_form" && source !== "other") return false;
  return !submissionLinksReady;
}

/**
 * Whether a conversation matches the Lead Source filter.
 *
 * Classification rules (identical to the server-side `p_source` facet):
 * - "all" (or null): everything matches.
 * - "instant_form": the conversation's contact has at least one
 *   `processed` Meta Instant Form submission. The caller passes the set
 *   of contact ids with such submissions (loaded in ONE batched query,
 *   never N+1); repeat submissions never duplicate the thread.
 * - "ctwa": the contact carries valid CTWA attribution (either field).
 * - "other": NEITHER signal.
 *
 * Overlap is intentional: a conversation with both signals matches BOTH
 * the "instant_form" and "ctwa" filters — no precedence is forced.
 */
export function matchesLeadSource(
  conversation: Pick<Conversation, "contact_id"> & {
    contact?: Pick<Contact, "source_url" | "ctwa_clid"> | null;
  },
  source: LeadSourceFilter,
  submissionContactIds: ReadonlySet<string>
): boolean {
  if (source === null || source === "all") return true;
  const hasSubmission = submissionContactIds.has(conversation.contact_id);
  const hasCtwa = hasValidCtwaAttribution(conversation.contact ?? null);
  if (source === "instant_form") return hasSubmission;
  if (source === "ctwa") return hasCtwa;
  // "other"
  return !hasSubmission && !hasCtwa;
}

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(...))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`.
 *
 * Also embeds the contact's `flow_runs` (with the flow id/name joined),
 * which the same flattening reduces to `contact.flow_id`/`contact.flow_name`
 * (active run first, else most recent) for the Inbox flow filter and the
 * contact panel's FLOW display.
 *
 * Explicit column lists replace `*` to reduce Postgres egress:
 * - conversations: only fields rendered/filtered/sorted (id, contact_id,
 *   status, assigned_agent_id, last_message_*, unread_count, timestamps)
 * - contacts: only fields used by list + sidebar (id, phone, name, email,
 *   company, avatar_url, source_url/ctwa, plus tags/flow_runs joins)
 * - tags: id,name,color (no user_id/created_at)
 * This preserves all Inbox functionality while shrinking each row.
 */
export const CONVERSATION_SELECT =
  "id, user_id, contact_id, status, assigned_agent_id, last_message_text, last_message_at, unread_count, created_at, updated_at, contact:contacts(id, phone, name, email, company, avatar_url, source_url, source_type, ctwa_clid, contact_tags(tags(id, name, color)), flow_runs(id, status, started_at, flow:flows(id, name)))";

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening.
 * Partial<Contact> because SELECT is narrowed to only needed columns
 * (egress optimization) — missing columns are simply undefined at runtime
 * but normalized via spread; callers use optional chaining.
 * Tags are also narrowed to id,name,color (no user_id/created_at).
 */
type RawContact = Partial<Contact> & {
  contact_tags?: { tags: Partial<Tag> | Partial<Tag>[] | null }[];
  flow_runs?: (ContactFlowRun & { flow?: { id: string; name: string } | { id: string; name: string }[] | null })[];
};
type RawConversation = Omit<Conversation, "contact"> & {
  // Supabase may return embedded `contact` as object or array depending on
  // PostgREST inference; handle both.
  contact?: RawContact | RawContact[] | null;
};

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`,
 * and the embedded `flow_runs` join into `contact.flow_id`/`flow_name`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const rawContactRaw = raw.contact;
  if (!rawContactRaw) return raw as Conversation;
  const rawContact = Array.isArray(rawContactRaw) ? rawContactRaw[0] : rawContactRaw;
  if (!rawContact) return raw as Conversation;

  const { contact_tags, flow_runs, ...contact } = rawContact;
  const flowRun = pickContactFlowRun(flow_runs ?? []);
  // contact_tags.tags may be object or array (PostgREST); normalize to single
  const tags: Tag[] = (contact_tags ?? [])
    .map((ct) => {
      const t = ct.tags;
      if (!t) return null;
      if (Array.isArray(t)) return (t[0] as Tag) ?? null;
      return t as Tag;
    })
    .filter((t): t is Tag => t != null);
  // flow may be object or array; pickContactFlowRun handles array
  const flowObj = flowRun?.flow;
  const flowId = Array.isArray(flowObj) ? (flowObj[0]?.id ?? null) : (flowObj?.id ?? null);
  const flowName = Array.isArray(flowObj) ? (flowObj[0]?.name ?? null) : (flowObj?.name ?? null);
  return {
    ...raw,
    contact: {
      ...(contact as Contact),
      tags,
      flow_id: flowId,
      flow_name: flowName,
    } as Contact,
  };
}

export function normalizeConversations(
  rows: RawConversation[]
): Conversation[] {
  return rows.map(normalizeConversation);
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
  /**
   * Flow id (from contact.flow_id), NO_FLOW_FILTER_ID for conversations
   * whose contact has no associated flow, or null for no flow filter.
   */
  flowId?: string | null;
}

/**
 * Sentinel flow-filter value for "No flow" (conversations whose contact
 * has no associated flow run). A `__`-prefixed value can never collide
 * with a real flow UUID. The flow resolution itself is untouched —
 * matching reads the same hydrated `contact.flow_id` that
 * {@link normalizeConversation} derives via `pickContactFlowRun`.
 */
export const NO_FLOW_FILTER_ID = "__no_flow__";

export type ConversationDateFilter = "all" | "today" | "yesterday" | "custom";

export interface ConversationDateRange {
  from: Date;
  to: Date;
}

export interface ConversationDateFilterState {
  filter: ConversationDateFilter;
  customFrom?: string;
  customTo?: string;
}

function parseLocalDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function localDayRange(date: Date): ConversationDateRange {
  return {
    from: new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      0,
      0,
      0,
      0
    ),
    to: new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      23,
      59,
      59,
      999
    ),
  };
}

/**
 * Builds inclusive local-day boundaries for Inbox date filters.
 * The returned Date objects can be sent to Supabase as ISO strings:
 * construction happens in the browser's local timezone, while
 * `toISOString()` converts those exact instants to UTC for TIMESTAMPTZ.
 */
export function getConversationDateRange(
  { filter, customFrom, customTo }: ConversationDateFilterState,
  now = new Date()
): ConversationDateRange | null {
  if (filter === "all") return null;

  if (filter === "today") {
    return localDayRange(now);
  }

  if (filter === "yesterday") {
    return localDayRange(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
    );
  }

  const fromDate = customFrom ? parseLocalDateInput(customFrom) : null;
  const toDate = customTo ? parseLocalDateInput(customTo) : null;
  if (!fromDate || !toDate) return null;

  const fromRange = localDayRange(fromDate);
  const toRange = localDayRange(toDate);

  return fromRange.from <= toRange.to
    ? { from: fromRange.from, to: toRange.to }
    : { from: toRange.from, to: fromRange.to };
}

export function matchesConversationDateFilter(
  conversation: Pick<Conversation, "last_message_at">,
  range: ConversationDateRange | null
): boolean {
  if (!range) return true;
  if (!conversation.last_message_at) return false;

  const activity = new Date(conversation.last_message_at);
  return activity >= range.from && activity <= range.to;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds`, null `company` and null `flowId` are no-ops, so the
 * default (no filters) always matches. Tags use OR logic, consistent with
 * Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company, flowId }: ContactFilters
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  if (flowId != null) {
    if (flowId === NO_FLOW_FILTER_ID) {
      // No associated flow: same `contact.flow_id` resolution, inverted.
      if (conversation.contact?.flow_id != null) return false;
    } else if (conversation.contact?.flow_id !== flowId) {
      return false;
    }
  }

  return true;
}

/**
 * Whether an incoming conversation row represents genuine new activity
 * relative to the row currently in the Inbox list.
 *
 * The Inbox sorts by `last_message_at` desc, so only a strictly newer
 * `last_message_at` changes sort position. Read-state updates
 * (`unread_count` → 0), status/assignment changes, and the incidental
 * `updated_at` bump from the `set_updated_at` trigger carry the same
 * (or no) `last_message_at` and must patch in place — bubbling them
 * to the top is the "open chat jumps to position 1" bug.
 */
export function hasNewerConversationActivity(
  current: Pick<Conversation, "last_message_at">,
  incoming: Pick<Conversation, "last_message_at">
): boolean {
  if (!incoming.last_message_at) return false;
  const incomingMs = Date.parse(incoming.last_message_at);
  if (Number.isNaN(incomingMs)) return false;
  if (!current.last_message_at) return true;
  const currentMs = Date.parse(current.last_message_at);
  if (Number.isNaN(currentMs)) return true;
  return incomingMs > currentMs;
}
