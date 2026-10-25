import type { AssignPerson } from '@/types'

/**
 * Automation-specific assignment — lightweight people belonging to one
 * automation only (NOT CRM users/agents, no login, no roles).
 *
 * Header written to sheets for the selected person's name.
 */
export const ASSIGN_HEADER = 'Assign'
/**
 * Internal answer-column key for the Assign value. Prefixed so it can
 * never collide with a user-authored flow var_key / node_key.
 */
export const ASSIGN_KEY = '__assign'
/**
 * Internal answer-column key for the hidden Flow Run ID on Completed
 * sheets (Assign-enabled only). Gives already-synced Completed rows an
 * exact update identity (same header string as incomplete sheets).
 */
export const COMPLETED_RUN_ID_KEY = '__run_id'
export const COMPLETED_RUN_ID_HEADER = 'Flow Run ID'

export interface AssignmentPickRow {
  id: string
  automation_id: string
  account_id: string
  contact_id: string | null
  flow_run_id: string | null
  log_id: string | null
  step_key: string
  person_name: string
  person_index: number
  percentage: number
  message: string
  /** 'text' = WhatsApp text; 'image' = image with caption. Defaults 'text'. */
  message_type: string
  /** Public image URL Meta fetches. Set only when message_type is 'image'. */
  media_url: string | null
  tag_id: string | null
  created_at: string
}

interface DbLike {
  // Chainable PostgREST builder — structurally deep; typed as any
  // like the sibling call sites below (lines ~448/~458).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc?(fn: string, args?: Record<string, unknown>): any
}

/**
 * Runtime validation (defense in depth — activation validation in
 * validate.ts catches these at save time; the engine re-checks so a
 * hand-edited step_config can never produce a silent wrong pick).
 * Throws on invalid config.
 */
export function normalizePersons(raw: unknown): AssignPerson[] {
  const persons = (raw as { persons?: unknown })?.persons ?? raw
  if (!Array.isArray(persons) || persons.length === 0) {
    throw new Error('assign_person needs at least one person')
  }
  const seen = new Set<string>()
  let total = 0
  const out: AssignPerson[] = persons.map((p, i) => {
    const name = typeof (p as AssignPerson)?.name === 'string' ? (p as AssignPerson).name.trim() : ''
    const percentage = Number((p as AssignPerson)?.percentage)
    const rawType = (p as AssignPerson)?.message_type
    // Absent = 'text' (configs saved before message types existed).
    const message_type: 'text' | 'image' = rawType === 'image' ? 'image' : 'text'
    const message = typeof (p as AssignPerson)?.message === 'string' ? (p as AssignPerson).message : ''
    const media_url =
      typeof (p as AssignPerson)?.media_url === 'string' ? (p as AssignPerson).media_url!.trim() : ''
    const tag_id = typeof (p as AssignPerson)?.tag_id === 'string' ? (p as AssignPerson).tag_id.trim() : ''
    if (!name) throw new Error(`assign_person person ${i + 1} needs a name`)
    const lower = name.toLowerCase()
    if (seen.has(lower)) throw new Error(`assign_person names must be unique (${name})`)
    seen.add(lower)
    if (!Number.isFinite(percentage) || percentage <= 0) {
      throw new Error(`assign_person person ${i + 1} needs percentage > 0`)
    }
    total += percentage
    if (!message.trim()) throw new Error(`assign_person person ${i + 1} needs a message`)
    if (message_type === 'image' && !media_url) {
      throw new Error(`assign_person person ${i + 1} needs an image when message type is image`)
    }
    if (!tag_id) throw new Error(`assign_person person ${i + 1} needs a tag`)
    return { name, percentage, message_type, message, media_url, tag_id }
  })
  if (Math.abs(total - 100) > 0.001) {
    throw new Error(`assign_person percentages must total 100 (currently ${total})`)
  }
  return out
}

/**
 * Weighted random index — legacy random path, kept for fallback and
 * tests. New assignments use claimSwrrIndex (deterministic SWRR).
 * Randomness happens ONCE per execution — the caller persists the
 * result via claimAssignmentPick so retries reuse the stored winner
 * instead of re-drawing.
 */
export function pickWeightedIndex(
  persons: AssignPerson[],
  rand: () => number = Math.random,
): number {
  const total = persons.reduce((s, p) => s + Number(p.percentage), 0)
  let r = rand() * total
  for (let i = 0; i < persons.length; i += 1) {
    r -= Number(persons[i]!.percentage)
    if (r < 0) return i
  }
  return persons.length - 1
}

/**
 * SWRR index via atomic DB RPC. Returns 0-based index.
 * Falls back to pickWeightedIndex if RPC unavailable (pre-migration).
 */
export async function claimSwrrIndex(
  db: DbLike,
  automationId: string,
  stepKey: string,
  persons: AssignPerson[],
  rand?: () => number,
): Promise<number> {
  const names = persons.map((p) => p.name)
  const weights = persons.map((p) => Number(p.percentage))
  if (db.rpc) {
    const { data, error } = await db.rpc('claim_assignment_swrr_pick', {
      p_automation_id: automationId,
      p_step_key: stepKey,
      p_person_names: names,
      p_person_weights: weights,
    })
    if (!error && typeof data === 'number' && Number.isInteger(data) && data >= 0 && data < persons.length) {
      return data
    }
    // Fall through to random fallback on RPC error (e.g., function not yet deployed)
    if (error) console.error('[assignment] SWRR RPC failed, falling back to random:', error)
  }
  // Fallback: weighted random (pre-migration compat)
  return pickWeightedIndex(persons, rand ?? Math.random)
}

/**
 * Durable claim: exactly one pick per (automation_id, log_id, step_key).
 * Read-before-write for retries; INSERT ... ON CONFLICT DO NOTHING for
 * concurrent workers (loser re-reads the winner). Never throws for a
 * conflict — always converges on the stored row.
 */
export async function claimAssignmentPick(
  db: DbLike,
  args: {
    automationId: string
    accountId: string
    contactId: string | null
    flowRunId: string | null
    logId: string | null
    stepKey: string
    persons: AssignPerson[]
    rand?: () => number
  },
): Promise<AssignmentPickRow> {
  // Retry fast-path: an existing pick for this execution wins.
  if (args.logId) {
    const { data: existing } = await db
      .from('automation_assignment_picks')
      .select('*')
      .eq('automation_id', args.automationId)
      .eq('log_id', args.logId)
      .eq('step_key', args.stepKey)
      .maybeSingle()
    if (existing) return existing as AssignmentPickRow
  }

  // Early reservation fast-path: if this Flow Run already has a reserved assignment
  // (created synchronously at set_tag before sheet insertion), reuse it without
  // running SWRR again. This ensures the sheet's initial row and the later
  // Assign Person step use the SAME person, and exactly one SWRR turn is consumed.
  if (args.flowRunId) {
    let reserved: unknown = null
    try {
      const res = await db
        .from('automation_assignment_reservations')
        .select('*')
        .eq('flow_run_id', args.flowRunId)
        .eq('automation_id', args.automationId)
        .eq('step_key', args.stepKey)
        .maybeSingle()
      reserved = res.data
    } catch {
      reserved = null
    }
    const r = reserved as AssignmentReservationRow | null
    if (r) {
      // Create execution-level pick from reservation snapshot if not already exists
      // (retry already handled above, so this is first execution for this log_id)
      if (args.logId) {
        const payload = {
          automation_id: args.automationId,
          account_id: args.accountId,
          contact_id: args.contactId,
          flow_run_id: args.flowRunId,
          log_id: args.logId,
          step_key: args.stepKey,
          person_name: r.person_name,
          person_index: r.person_index,
          percentage: Number(r.percentage),
          message: r.message,
          message_type: r.message_type,
          media_url: r.media_url,
          tag_id: r.tag_id,
        }
        await db
          .from('automation_assignment_picks')
          .upsert(payload, { onConflict: 'automation_id,log_id,step_key', ignoreDuplicates: true })
        const { data: winner } = await db
          .from('automation_assignment_picks')
          .select('*')
          .eq('automation_id', args.automationId)
          .eq('log_id', args.logId)
          .eq('step_key', args.stepKey)
          .maybeSingle()
        if (winner) return winner as AssignmentPickRow
        return {
          id: `fallback-reserved-${Date.now()}`,
          automation_id: args.automationId,
          account_id: args.accountId,
          contact_id: args.contactId,
          flow_run_id: args.flowRunId,
          log_id: args.logId,
          step_key: args.stepKey,
          person_name: r.person_name,
          person_index: r.person_index,
          percentage: Number(r.percentage),
          message: r.message,
          message_type: r.message_type,
          media_url: r.media_url,
          tag_id: r.tag_id,
          created_at: new Date().toISOString(),
        }
      }
    }
  }

  // Degraded mode (no log row — should not happen in practice):
  // return a transient pick via SWRR so the send can still proceed; without a
  // log_id there is no unique key to dedupe retries against.
  if (!args.logId) {
    const idx = await claimSwrrIndex(db, args.automationId, args.stepKey, args.persons, args.rand)
    const p = args.persons[idx]!
    return {
      id: `transient-${Date.now()}`,
      automation_id: args.automationId,
      account_id: args.accountId,
      contact_id: args.contactId,
      flow_run_id: args.flowRunId,
      log_id: null,
      step_key: args.stepKey,
      person_name: p.name,
      person_index: idx,
      percentage: Number(p.percentage),
      message: p.message,
      message_type: p.message_type ?? 'text',
      media_url: p.media_url ?? null,
      tag_id: p.tag_id,
      created_at: new Date().toISOString(),
    }
  }

  // Atomic SWRR + durable pick: exactly one SWRR turn per successful new assignment.
  // The RPC locks SWRR row, checks existing pick (retry), computes SWRR candidate,
  // inserts picks, and only on winner commits SWRR advancement. Loser reuses winner
  // without consuming another turn. See 070 migration header for two-worker proof.
  if (db.rpc) {
    const names = args.persons.map((p) => p.name)
    const weights = args.persons.map((p) => Number(p.percentage))
    const messages = args.persons.map((p) => p.message)
    const messageTypes = args.persons.map((p) => p.message_type ?? 'text')
    const mediaUrls = args.persons.map((p) => p.media_url ?? '')
    const tagIds = args.persons.map((p) => p.tag_id)
    const percentages = weights
    try {
      const { data: pickedIdx, error: rpcErr } = await db.rpc('claim_assignment_pick_swrr', {
        p_automation_id: args.automationId,
        p_account_id: args.accountId,
        p_contact_id: args.contactId,
        p_flow_run_id: args.flowRunId,
        p_log_id: args.logId,
        p_step_key: args.stepKey,
        p_person_names: names,
        p_person_weights: weights,
        p_person_messages: messages,
        p_person_message_types: messageTypes,
        p_person_media_urls: mediaUrls,
        p_person_tag_ids: tagIds,
        p_person_percentages: percentages,
      })
      if (!rpcErr && typeof pickedIdx === 'number' && Number.isInteger(pickedIdx) && pickedIdx >= 0 && pickedIdx < args.persons.length) {
        const { data: winner } = await db
          .from('automation_assignment_picks')
          .select('*')
          .eq('automation_id', args.automationId)
          .eq('log_id', args.logId)
          .eq('step_key', args.stepKey)
          .maybeSingle()
        if (winner) return winner as AssignmentPickRow
        // Fallback: RPC succeeded but pick row not yet visible (should not happen) — construct from index
        const person = args.persons[pickedIdx]!
        return {
          id: `fallback-${Date.now()}`,
          automation_id: args.automationId,
          account_id: args.accountId,
          contact_id: args.contactId,
          flow_run_id: args.flowRunId,
          log_id: args.logId,
          step_key: args.stepKey,
          person_name: person.name,
          person_index: pickedIdx,
          percentage: Number(person.percentage),
          message: person.message,
          message_type: person.message_type ?? 'text',
          media_url: person.media_url ?? null,
          tag_id: person.tag_id,
          created_at: new Date().toISOString(),
        }
      }
      if (rpcErr) console.error('[assignment] atomic SWRR pick RPC failed, falling back:', rpcErr)
    } catch (e) {
      console.error('[assignment] atomic SWRR pick threw, falling back:', e)
    }
  }

  // Fallback path (pre-070 or RPC error): SWRR via claimSwrrIndex + separate upsert.
  // This may waste one SWRR turn on same-log_id concurrent loser, but preserves correctness
  // when the atomic RPC is unavailable. Post-migration this path is not taken.
  const index = await claimSwrrIndex(db, args.automationId, args.stepKey, args.persons, args.rand)
  const person = args.persons[index]!

  const payload = {
    automation_id: args.automationId,
    account_id: args.accountId,
    contact_id: args.contactId,
    flow_run_id: args.flowRunId,
    log_id: args.logId,
    step_key: args.stepKey,
    person_name: person.name,
    person_index: index,
    percentage: Number(person.percentage),
    message: person.message,
    message_type: person.message_type ?? 'text',
    media_url: person.media_url ?? null,
    tag_id: person.tag_id,
  }
  // Atomic converge: winner inserts, loser hits the unique constraint
  // and falls through to the re-read below.
  await db
    .from('automation_assignment_picks')
    .upsert(payload, { onConflict: 'automation_id,log_id,step_key', ignoreDuplicates: true })

  const { data: winner } = await db
    .from('automation_assignment_picks')
    .select('*')
    .eq('automation_id', args.automationId)
    .eq('log_id', args.logId)
    .eq('step_key', args.stepKey)
    .maybeSingle()
  if (winner) return winner as AssignmentPickRow
  // Extremely defensive: if the mock/DB returned nothing, fall back to
  // the just-computed person rather than failing the send.
  return {
    id: `fallback-${Date.now()}`,
    ...payload,
    created_at: new Date().toISOString(),
  }
}

export interface AssignmentReservationRow {
  id: string
  flow_run_id: string
  automation_id: string
  step_key: string
  person_index: number
  person_name: string
  percentage: number
  message: string
  message_type: string
  media_url: string | null
  tag_id: string | null
  created_at: string
}

/**
 * Early reservation: synchronously reserve SWRR winner for a Flow Run's
 * future Assign Person execution, before the Flow inserts its sheet row.
 * Uses atomic RPC reserve_assignment_for_flow_run (070+071) which locks
 * SWRR state and inserts reservation ON CONFLICT DO NOTHING.
 * Same flow_run+automation+step → one SWRR turn, both callers get same winner.
 */
export async function reserveAssignmentForFlowRun(
  db: DbLike,
  args: {
    flowRunId: string
    automationId: string
    stepKey: string
    persons: AssignPerson[]
  },
): Promise<number | null> {
  const persons = normalizePersons(args.persons)
  const names = persons.map((p) => p.name)
  const weights = persons.map((p) => Number(p.percentage))
  const messages = persons.map((p) => p.message)
  const messageTypes = persons.map((p) => p.message_type ?? 'text')
  const mediaUrls = persons.map((p) => p.media_url ?? '')
  const tagIds = persons.map((p) => p.tag_id)
  const percentages = weights
  if (db.rpc) {
    const { data, error } = await db.rpc('reserve_assignment_for_flow_run', {
      p_flow_run_id: args.flowRunId,
      p_automation_id: args.automationId,
      p_step_key: args.stepKey,
      p_person_names: names,
      p_person_weights: weights,
      p_person_messages: messages,
      p_person_message_types: messageTypes,
      p_person_media_urls: mediaUrls,
      p_person_tag_ids: tagIds,
      p_person_percentages: percentages,
    })
    if (!error && typeof data === 'number' && Number.isInteger(data) && data >= 0 && data < persons.length) {
      return data
    }
    if (error) console.error('[assignment] reserve RPC failed:', error)
  }
  return null
}

/**
 * Reserve for all active assign_person automations triggered by a tag.
 * Called synchronously from Flow set_tag before the Flow continues to
 * sheet insertion. Uses same trigger matching as runAutomationsForTrigger
 * (tag_added with exact tag_id). Fast and atomic per automation+step.
 */
export async function reserveAssignmentsForTagTrigger(
  db: DbLike,
  accountId: string,
  flowRunId: string,
  tagId: string,
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: automations, error } = (await (db as any).from('automations').select('id, trigger_config').eq('account_id', accountId).eq('trigger_type', 'tag_added').eq('is_active', true)) as { data: Array<{ id: string; trigger_config: unknown }> | null; error: unknown }
    if (error || !automations || automations.length === 0) return
    const matching = automations.filter((a) => {
      const cfg = a.trigger_config as Record<string, unknown> | null
      return cfg?.tag_id === tagId
    })
    if (matching.length === 0) return
    // For each matching automation, find its assign_person step(s) (at most one after validation)
    for (const auto of matching) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: steps } = (await (db as any).from('automation_steps').select('step_config, step_type').eq('automation_id', auto.id)) as { data: Array<{ step_config: unknown; step_type: string }> | null }
      const assignSteps = (steps ?? []).filter((s) => s.step_type === 'assign_person')
      // Enforce single assign_person per automation (validate.ts) — if multiple, pick first deterministically
      const step = assignSteps[0]
      if (!step) continue
      const cfg = step.step_config as { assignment_key?: unknown; persons?: unknown }
      const stepKey = typeof cfg.assignment_key === 'string' && cfg.assignment_key.trim() ? cfg.assignment_key.trim() : null
      if (!stepKey) continue
      const persons = cfg.persons
      if (!Array.isArray(persons) || persons.length === 0) continue
      // Fire reservation (atomic, handles concurrent same flow_run)
      await reserveAssignmentForFlowRun(db, { flowRunId, automationId: auto.id, stepKey, persons: persons as AssignPerson[] }).catch(() => {})
    }
  } catch {
    // Reservation is best-effort for sheet timing; never break Flow
  }
}

/**
 * Sheets resolver — exact flow_run_id only. Never phone/contact/latest.
 * Checks both reservations (early, before sheet insert) and picks (late,
 * after execution). Reservations are visible to sheet before picks exist.
 * Last-successful-assignment wins when multiple automations/steps wrote
 * picks for the SAME run (documented deterministic rule; no name merging).
 * For multiple automations on same run, deterministic priority is
 * latest created_at (same as 069) — ideally prevented at activation
 * (see validate.ts single assign_person per automation).
 */
export async function getAssignForFlowRun(
  db: DbLike,
  flowRunId: string | null | undefined,
): Promise<string | null> {
  if (!flowRunId) return null
  const map = await getAssignsForFlowRuns(db, [flowRunId])
  return map.get(flowRunId) ?? null
}

/**
 * Batch resolver for sync paths (one indexed query for N runs per table).
 * Returns runId → person_name for runs with a pick or reservation; absent = no pick.
 * Prefers most recent created_at across both tables, deterministic.
 */
export async function getAssignsForFlowRuns(
  db: DbLike,
  flowRunIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(flowRunIds.filter(Boolean))]
  if (ids.length === 0) return out
  // Query both reservations (early) and picks (late) — union, latest wins
  const [picksRes, resvRes] = await Promise.all([
    db
      .from('automation_assignment_picks')
      .select('flow_run_id, person_name, created_at')
      .in('flow_run_id', ids)
      .order('created_at', { ascending: false }),
    db
      .from('automation_assignment_reservations')
      .select('flow_run_id, person_name, created_at')
      .in('flow_run_id', ids)
      .order('created_at', { ascending: false }),
  ])
  const picksData = (picksRes as { data?: unknown[] })?.data ?? []
  const resvData = (resvRes as { data?: unknown[] })?.data ?? []
  // Merge both, sort by created_at DESC so latest across both wins deterministically
  const all = [...(picksData as Array<Record<string, unknown>>), ...(resvData as Array<Record<string, unknown>>)].sort((a, b) => {
    const av = String(a.created_at ?? '')
    const bv = String(b.created_at ?? '')
    return av < bv ? 1 : av > bv ? -1 : 0
  })
  for (const row of all as Array<{ flow_run_id?: unknown; person_name?: unknown }>) {
    const id = typeof row.flow_run_id === 'string' ? row.flow_run_id : null
    const name = typeof row.person_name === 'string' ? row.person_name : null
    if (id && name && !out.has(id)) out.set(id, name)
  }
  return out
}

/**
 * Validate that a caller-supplied flow_run_id belongs to the same
 * account + contact before accepting it. Returns the id when valid,
 * null otherwise (independent automation — sheets enrichment skipped,
 * message/tag behavior continues normally).
 */
export async function resolveFlowRunId(
  db: DbLike,
  accountId: string,
  contactId: string | null,
  flowRunId: string | null | undefined,
): Promise<string | null> {
  if (!flowRunId || !contactId) return null
  const { data } = await db
    .from('flow_runs')
    .select('id, account_id, contact_id')
    .eq('id', flowRunId)
    .maybeSingle()
  const row = data as { id?: string; account_id?: string; contact_id?: string | null } | null
  if (!row?.id) return null
  if (row.account_id !== accountId) return null
  if (row.contact_id !== contactId) return null
  return row.id
}
