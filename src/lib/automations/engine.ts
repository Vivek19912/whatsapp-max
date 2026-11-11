import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  AssignPersonStepConfig,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  SendMediaRotationMessage,
  SendMediaStepConfig,
  SendMessageStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  TagTriggerConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
} from '@/types'
import { supabaseAdmin } from './admin-client'
import { engineSendText, engineSendTemplate } from './meta-send'
import {
  claimAssignmentPick,
  normalizePersons,
  resolveFlowRunId,
} from './assignment'
import { enrichAssignmentSheets } from '@/lib/sheets/assign-enrich'
import { resolveWorkspaceOwnerForContact } from '@/lib/inbox/assignment-sync'
import { DEFAULT_CURRENCY } from '@/lib/currency'
// The Flows engine's media sender is fully shared: it performs the same
// account-scoped contact/config lookup, phone-variant retry, Meta send,
// message-row persistence, and conversation preview update that the
// automation text/template senders do. Reusing it here (rather than
// re-implementing a second media path) keeps image/video/document sends
// identical to the Flows `send_media` node.
import { engineSendMedia } from '../flows/meta-send'

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string
  /** Conversation the event belongs to, if any. */
  conversation_id?: string
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string
  /**
   * Exact Flow run this execution belongs to, when applicable.
   * Identity for sheet enrichment — never derived from contact/phone.
   * NULL = independent automation (message/tag still work, no sheets).
   */
  flow_run_id?: string | null
}

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
  /**
   * Exact Flow run id when the trigger originates from a Flow context.
   * Validated against (account_id, contact_id) before use; preferred
   * over context.flow_run_id when both are present.
   */
  flowRunId?: string | null
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(input: DispatchInput): Promise<void> {
  try {
    const db = supabaseAdmin()

    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs through the service-role
    // client, which bypasses RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const { data: owned, error: ownErr } = await db
        .from('contacts')
        .select('id')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle()
      if (ownErr) {
        console.error('[automations] contact ownership check failed:', ownErr)
        return
      }
      if (!owned) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        return
      }
    }

    const { data: automations, error } = await db
      .from('automations')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('trigger_type', input.triggerType)
      .eq('is_active', true)

    if (error) {
      console.error('[automations] fetch failed:', error)
      return
    }
    if (!automations || automations.length === 0) return

    // Exact Flow-run linkage (never contact/phone/latest). Prefer the
    // explicit flowRunId, fall back to context.flow_run_id for callers
    // that embed it (manual POSTs, chained dispatches). Validated
    // against (account_id, contact_id); invalid → NULL (independent).
    const candidateFlowRunId = input.flowRunId ?? input.context?.flow_run_id ?? null
    const flowRunId = await resolveFlowRunId(
      db,
      input.accountId,
      input.contactId ?? null,
      candidateFlowRunId,
    )

    for (const automation of automations as Automation[]) {
      if (!triggerMatches(automation, input.context)) continue
      try {
        await executeAutomation(automation, input, flowRunId)
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
  }
}

/**
 * Fan a tag addition out to any `tag_added` automations watching that tag.
 *
 * Fire-and-forget: never awaited, never throws — a slow or failing
 * automation must not block whatever added the tag (a flow's set_tag node,
 * an automation's add_tag step, or a manual UI action). This is the single
 * entry point every tag-write path calls so the trigger fires consistently.
 */
export function dispatchTagAdded(
  accountId: string,
  contactId: string,
  tagId: string,
  conversationId?: string,
  vars?: Record<string, unknown>,
  flowRunId?: string | null,
): void {
  void runAutomationsForTrigger({
    accountId,
    triggerType: 'tag_added',
    contactId,
    context: {
      tag_id: tagId,
      conversation_id: conversationId,
      ...(vars ? { vars } : {}),
      ...(flowRunId ? { flow_run_id: flowRunId } : {}),
    },
    flowRunId: flowRunId ?? null,
  }).catch((err) => console.error('[automations] tag_added dispatch failed:', err))
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext
  flow_run_id?: string | null
}): Promise<void> {
  const db = supabaseAdmin()
  const { data: automation, error } = await db
    .from('automations')
    .select('*')
    .eq('id', pending.automation_id)
    .single()

  if (error || !automation) {
    console.error('[automations] resume: missing automation', pending.automation_id, error)
    await markPending(pending.id, 'failed')
    return
  }

  // A `tag_added` follow-up should only fire if the tag that triggered it is
  // still on the contact when the wait elapses. If the tag was removed in the
  // meantime — e.g. a flow's "Remove tag" node ran because the contact finished
  // — the reason for the reminder no longer holds, so skip the remaining steps
  // instead of sending. Catches every removal path (flow, automation, manual UI)
  // because it checks at send time rather than at removal time.
  const triggerTagId =
    (automation as Automation).trigger_type === 'tag_added'
      ? (pending.context?.tag_id ?? null)
      : null
  if (triggerTagId && pending.contact_id) {
    const { count } = await db
      .from('contact_tags')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', pending.contact_id)
      .eq('tag_id', triggerTagId)
    if ((count ?? 0) === 0) {
      await finalizeLog(pending.log_id, 'success', null)
      await markPending(pending.id, 'done')
      return
    }
  }

  // Re-inject the persisted flow_run_id so resumed steps stay pinned
  // to the exact Flow run even if the stored context was compacted.
  // Explicit column wins; fall back to whatever the context carries.
  const resumedFlowRunId =
    (pending as { flow_run_id?: string | null }).flow_run_id ??
    pending.context?.flow_run_id ??
    null

  try {
    await executeStepsFrom({
      automation: automation as Automation,
      contactId: pending.contact_id,
      context: { ...(pending.context ?? {}), flow_run_id: resumedFlowRunId },
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
    })
    await markPending(pending.id, 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed')
  }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

async function executeAutomation(
  automation: Automation,
  input: DispatchInput,
  flowRunId: string | null = null,
) {
  const db = supabaseAdmin()

  const baseLogRow = {
    automation_id: automation.id,
    // Tenancy: matches automation.account_id (NOT NULL post-017).
    account_id: automation.account_id,
    // Audit: keeps the historical "author of this automation"
    // pointer so logs still attribute to the right user even
    // after teammates join the account.
    user_id: automation.user_id,
    contact_id: input.contactId ?? null,
    trigger_event: input.triggerType,
    steps_executed: [],
    status: 'success',
    // Exact Flow run linkage (NULL = independent automation).
    // Column added in migration 069.
    flow_run_id: flowRunId,
  }
  let { data: log, error: logErr } = await db
    .from('automation_logs')
    .insert(baseLogRow)
    .select()
    .single()

  // Deploy-ordering tolerance: if this code runs against a DB where
  // migration 069 has not applied yet, retry without the new column so
  // automations keep running (the execution simply becomes independent
  // for sheets). Any other insert failure still aborts below.
  if (logErr && /flow_run_id/i.test(logErr.message ?? '')) {
    const { flow_run_id: _dropped, ...legacyRow } = baseLogRow
    void _dropped
    const retry = await db.from('automation_logs').insert(legacyRow).select().single()
    log = retry.data
    logErr = retry.error
  }

  if (logErr || !log) {
    console.error('[automations] cannot create log:', logErr)
    return
  }

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: { ...(input.context ?? {}), flow_run_id: flowRunId },
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
  })

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  const { error: rpcErr } = await db.rpc('increment_automation_execution_count', {
    p_automation_id: automation.id,
  })
  if (rpcErr) {
    console.error('[automations] increment counter failed:', rpcErr)
  }
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
}

async function executeStepsFrom(args: ExecuteArgs): Promise<void> {
  const db = supabaseAdmin()

  const baseQuery = db
    .from('automation_steps')
    .select('*')
    .eq('automation_id', args.automation.id)
    .gte('position', args.startPosition)
    .order('position', { ascending: true })

  const scoped =
    args.parentStepId === null
      ? baseQuery.is('parent_step_id', null)
      : baseQuery.eq('parent_step_id', args.parentStepId).eq('branch', args.branch ?? 'yes')

  const { data: steps, error: stepsErr } = await scoped

  if (stepsErr) {
    await finalizeLog(args.logId, 'failed', stepsErr.message)
    return
  }
  if (!steps || steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(args.logId, 'success', null)
    }
    return
  }

  const results: AutomationLogStepResult[] = []
  let status: 'success' | 'partial' | 'failed' = 'success'
  let errorMessage: string | null = null

  for (const step of steps as AutomationStep[]) {
    // `wait` is the suspension point: enqueue and stop processing this
    // scope. The cron endpoint will pick it up later.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      const pendingRow = {
        automation_id: args.automation.id,
        // Tenancy: account_id required NOT NULL post-017.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        contact_id: args.contactId,
        log_id: args.logId,
        parent_step_id: args.parentStepId,
        branch: args.branch,
        next_step_position: step.position + 1,
        context: args.context,
        // Exact Flow-run pin survives resume via column + context.
        // Column added in migration 069 (see executeAutomation fallback).
        flow_run_id: args.context?.flow_run_id ?? null,
        run_at: new Date(Date.now() + ms).toISOString(),
        status: 'pending',
      }
      const { error: pendingErr } = await db
        .from('automation_pending_executions')
        .insert(pendingRow)
      if (pendingErr && /flow_run_id/i.test(pendingErr.message ?? '')) {
        const { flow_run_id: _dropped, ...legacyPending } = pendingRow
        void _dropped
        await db.from('automation_pending_executions').insert(legacyPending)
      }
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      })
      status = 'partial'
      await appendResults(args.logId, results, status, errorMessage)
      return
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        })
        continue
      }

      const detail = await runStep(step, args)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      status = 'failed'
      errorMessage = msg
      break
    }
  }

  if (args.parentStepId === null) {
    await appendResults(args.logId, results, status, errorMessage)
  } else {
    // Nested branch — just append results; parent scope decides final status.
    await appendResults(args.logId, results, null, errorMessage)
  }
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  const db = supabaseAdmin()

  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error('send_message needs a contact')
      const text = interpolate(cfg.text, args)
      if (!text.trim()) throw new Error('send_message has empty text')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      return `sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error('send_template needs a contact')
      if (!cfg.template_name) throw new Error('send_template needs template_name')
      const conversationId = await resolveConversationId(args)
      // Meta templates use positional {{1}}, {{2}}, … placeholders, so
      // we MUST emit params in strict numeric order. Lexicographic sort
      // of "1", "2", …, "10" yields "1", "10", "2", … which silently
      // scrambles every template with ≥10 variables.
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a)
              const nb = Number(b)
              const aNum = Number.isFinite(na)
              const bNum = Number.isFinite(nb)
              if (aNum && bNum) return na - nb
              if (aNum) return -1
              if (bNum) return 1
              return a.localeCompare(b)
            })
            .map((k) => String(cfg.variables![k]))
        : []
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'send_media': {
      const cfg = step.step_config as SendMediaStepConfig
      if (!args.contactId) throw new Error('send_media needs a contact')
      // Rotation: when the step is configured with selection_mode
      // 'rotate', claim the next index for THIS contact + node first.
      // The claim RPC is atomic (row-locked upsert), so concurrent runs
      // for the same contact can't grab the same index. The claimed
      // message's fields are overlaid onto the step config so the send
      // below is byte-for-byte the fixed-mode path.
      const rotation = rotationMessages(cfg)
      if (!rotation && !cfg.media_url?.trim()) {
        // Fixed mode keeps the original guard, in the original position,
        // before the conversation lookup. Rotate mode validates the
        // chosen entry below instead.
        throw new Error('send_media needs media_url')
      }
      const conversationId = await resolveConversationId(args)
      // Caption supports the same {{ vars.* }} / {{ message.text }}
      // interpolation as send_message text. media_url stays static (the
      // file was uploaded when the automation was authored) — matching
      // the Flows send_media node, which does not interpolate the URL.
      let claimed: { stepKey: string; count: number; global: boolean } | null = null
      let sendCfg: SendMediaStepConfig = cfg
      if (rotation) {
        // rotation_key is a stable id persisted inside step_config
        // (step row UUIDs change on every save — see steps-tree.ts).
        // Legacy/hand-edited rotate configs without a key fall back to
        // the step row id, which still scopes per node within a run.
        const stepKey = cfg.rotation_key?.trim() || step.id
        // rotation_scope 'global' shares ONE counter across all contacts
        // of the automation (consecutive contacts get different messages);
        // the default 'contact' scope gives every contact its own sequence
        // starting at Message 1. Absent scope on legacy rows = 'contact'.
        const globalScope = cfg.rotation_scope === 'global'
        const { data: claimedIndex, error: claimErr } = globalScope
          ? await db.rpc('claim_automation_media_index_global', {
              p_automation_id: args.automation.id,
              p_step_key: stepKey,
              p_message_count: rotation.length,
            })
          : await db.rpc('claim_automation_media_index', {
              p_automation_id: args.automation.id,
              p_contact_id: args.contactId,
              p_step_key: stepKey,
              p_message_count: rotation.length,
            })
        if (claimErr) {
          throw new Error(`send_media rotation claim failed: ${claimErr.message}`)
        }
        const idx = Number(claimedIndex)
        if (!Number.isInteger(idx)) {
          throw new Error('send_media rotation claim returned no index')
        }
        const message = rotation[((idx % rotation.length) + rotation.length) % rotation.length]
        if (!message?.media_url?.trim()) {
          throw new Error(`send_media rotation message ${idx + 1} needs media_url`)
        }
        claimed = { stepKey, count: rotation.length, global: globalScope }
        sendCfg = {
          ...cfg,
          media_type: message.media_type,
          media_url: message.media_url,
          caption: message.caption,
          filename: message.filename,
        }
      }

      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: args.automation.account_id,
          userId: args.automation.user_id,
          conversationId,
          contactId: args.contactId,
          kind: sendCfg.media_type,
          link: sendCfg.media_url,
          caption: sendCfg.caption ? interpolate(sendCfg.caption, args) : undefined,
          filename: sendCfg.filename,
        })
        return `media sent via Meta (${whatsapp_message_id})`
      } catch (err) {
        // Failed send: roll the rotation counter back so the SAME
        // message is retried on the next execution instead of being
        // skipped. Best-effort — a release failure must not mask the
        // original send error.
        if (claimed) {
          const { error: releaseErr } = claimed.global
            ? await db.rpc('release_automation_media_index_global', {
                p_automation_id: args.automation.id,
                p_step_key: claimed.stepKey,
                p_message_count: claimed.count,
              })
            : await db.rpc('release_automation_media_index', {
                p_automation_id: args.automation.id,
                p_contact_id: args.contactId,
                p_step_key: claimed.stepKey,
                p_message_count: claimed.count,
              })
          if (releaseErr) {
            console.error('[automations] send_media rotation release failed:', releaseErr)
          }
        }
        throw err
      }
    }

    case 'add_tag': {
      // contact_tags has no account_id column; cross-tenant protection for
      // the attacker-supplied contactId comes from the ownership guard in
      // runAutomationsForTrigger.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('add_tag needs contact + tag_id')
      await db
        .from('contact_tags')
        .upsert(
          { contact_id: args.contactId, tag_id: cfg.tag_id },
          { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
        )
      // A tag add can itself be an automation trigger — fan out to any
      // tag_added automations watching this tag. Fire-and-forget so a slow
      // downstream automation doesn't block this run. (No cycle detection:
      // an add_tag step that adds this automation's own trigger tag will
      // loop — the same footgun the docs already warn about for waits.)
      // Forward the exact flow_run_id + vars so chained automations stay
      // pinned to the same Flow run instead of becoming independent.
      dispatchTagAdded(
        args.automation.account_id,
        args.contactId,
        cfg.tag_id,
        args.context.conversation_id,
        args.context.vars,
        args.context.flow_run_id ?? null,
      )
      return `tag ${cfg.tag_id} added`
    }

    case 'remove_tag': {
      // See add_tag: tenant scoping relies on the runAutomationsForTrigger
      // ownership guard, since contact_tags carries no account_id.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('remove_tag needs contact + tag_id')
      await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.tag_id)
      return `tag ${cfg.tag_id} removed`
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error('assign_conversation needs a contact')
      let agentId = cfg.agent_id
      if (cfg.mode === 'round_robin') {
        // Pick any member of the account. The existing implementation
        // only ever returned the automation's author; preserving that
        // shape until a real round-robin algorithm replaces it.
        const { data: profiles } = await db
          .from('profiles')
          .select('user_id')
          .eq('account_id', args.automation.account_id)
          .limit(1)
        agentId = profiles?.[0]?.user_id
      }
      if (!agentId) return 'no agent resolved'
      // Meta-linked threads follow Workspace ownership: when the
      // contact has exactly one Workspace owner, the thread stays
      // with them instead of moving to the automation target. No
      // unique owner -> the configured target stands (existing
      // behavior for unrelated conversations).
      let targetId = agentId
      try {
        const wsOwner = await resolveWorkspaceOwnerForContact(
          db,
          args.automation.account_id,
          args.contactId
        )
        if (wsOwner.ownerId && wsOwner.ownerId !== agentId) {
          targetId = wsOwner.ownerId
        }
      } catch {
        // Resolution is best-effort; fall back to the configured target.
      }
      await db
        .from('conversations')
        .update({ assigned_agent_id: targetId })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
      return `assigned to ${targetId}`
    }

    case 'assign_person': {
      // Lightweight automation-specific assignment (NOT a CRM agent).
      // Exactly ONE person per execution: durable claim BEFORE send,
      // that person's message via existing Meta infra, tag ONLY after
      // send + message persistence succeed. Retries reuse the stored
      // winner via UNIQUE(automation_id, log_id, step_key).
      const cfg = step.step_config as AssignPersonStepConfig
      if (!args.contactId) throw new Error('assign_person needs a contact')
      const persons = normalizePersons(cfg)
      // Stable step identity: step rows are re-inserted with fresh UUIDs
      // on every save (steps-tree.ts) — same reason as rotation_key.
      const stepKey =
        typeof cfg.assignment_key === 'string' && cfg.assignment_key.trim()
          ? cfg.assignment_key.trim()
          : step.id
      const flowRunId = args.context?.flow_run_id ?? null
      const pick = await claimAssignmentPick(db, {
        automationId: args.automation.id,
        accountId: args.automation.account_id,
        contactId: args.contactId,
        flowRunId,
        logId: args.logId,
        stepKey,
        persons,
      })
      const text = interpolate(pick.message, args)
      if (!text.trim()) throw new Error('assign_person message is empty')
      const conversationId = await resolveConversationId(args)
      // Text uses the existing text-message path; Text with Image uses
      // the existing image/media path (same transport as Send Media
      // steps: account-scoped lookup, phone-variant retry, Meta send,
      // message-row persistence). The person's message is the caption.
      const isImage = (pick.message_type ?? 'text') === 'image'
      if (isImage && !pick.media_url?.trim()) {
        throw new Error('assign_person image message needs media_url')
      }
      let whatsappId: string
      try {
        if (isImage) {
          const sent = await engineSendMedia({
            accountId: args.automation.account_id,
            userId: args.automation.user_id,
            conversationId,
            contactId: args.contactId,
            kind: 'image',
            link: pick.media_url!,
            caption: text,
          })
          whatsappId = sent.whatsapp_message_id
        } else {
          const sent = await engineSendText({
            accountId: args.automation.account_id,
            userId: args.automation.user_id,
            conversationId,
            contactId: args.contactId,
            text,
          })
          whatsappId = sent.whatsapp_message_id
        }
      } catch (err) {
        // Durable pick is kept for retry; tag is NOT added on failure.
        // Best-effort sheets enrichment still runs so an already-synced
        // row can show Assign even when the send failed (pick exists).
        await enrichAssignmentSheets(args.automation.account_id, pick.flow_run_id).catch(() => {})
        throw err
      }
      // Tag ONLY after successful send + persistence (engineSendText
      // throws when the messages INSERT fails, so reaching here means
      // both Meta 2xx and DB persistence succeeded).
      if (pick.tag_id) {
        const { count } = await db
          .from('contact_tags')
          .select('id', { count: 'exact', head: true })
          .eq('contact_id', args.contactId)
          .eq('tag_id', pick.tag_id)
        if ((count ?? 0) === 0) {
          await db.from('contact_tags').insert({
            contact_id: args.contactId,
            tag_id: pick.tag_id,
          })
          // Only dispatch when a NEW row was created — a contact that
          // already had the tag must not refire tag_added automations
          // (recursion protection scoped to this new step; existing
          // add_tag fan-out is intentionally untouched). Additionally,
          // never dispatch when the person's tag IS this automation's
          // own tag_added trigger (self-loop guard for the new step).
          const ownTriggerTag =
            args.automation.trigger_type === 'tag_added'
              ? ((args.automation.trigger_config as TagTriggerConfig | undefined)?.tag_id ?? null)
              : null
          if (pick.tag_id !== ownTriggerTag) {
            dispatchTagAdded(
              args.automation.account_id,
              args.contactId,
              pick.tag_id,
              args.context.conversation_id,
              args.context.vars,
              flowRunId,
            )
          }
        }
      }
      // Best-effort sheets enrichment for already-synced rows (exact
      // flow_run_id identity only; never phone/contact fallback).
      // Never fails the step — sync-time resolver covers not-yet-synced.
      await enrichAssignmentSheets(args.automation.account_id, pick.flow_run_id).catch(() => {})
      return `assigned ${pick.person_name} via Meta (${whatsappId})`
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error('update_contact_field needs a contact')
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = interpolate(cfg.value, args)

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length)
        if (!customFieldId) {
          return `field ${cfg.field} not writable from automations`
        }
        // Defense in depth: the service-role client bypasses RLS, so confirm
        // the field definition belongs to this account before writing.
        const { data: field } = await db
          .from('custom_fields')
          .select('id')
          .eq('id', customFieldId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle()
        if (!field) {
          return `field ${cfg.field} not writable from automations`
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the entry-point ownership guard.
        await db
          .from('contact_custom_values')
          .upsert(
            { contact_id: args.contactId, custom_field_id: customFieldId, value },
            { onConflict: 'contact_id,custom_field_id' },
          )
        return `custom field updated`
      }

      const allowed = new Set(['name', 'email', 'company'])
      if (!allowed.has(cfg.field)) {
        return `field ${cfg.field} not writable from automations`
      }
      // Defense in depth: scope the service-role write to the account so
      // a future caller that skips the entry-point ownership guard still
      // cannot write across tenants.
      await db
        .from('contacts')
        .update({ [cfg.field]: value, updated_at: new Date().toISOString() })
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
      return `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error('create_deal needs pipeline + stage')
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule (issue #218). Fall back to DEFAULT_CURRENCY if the row
      // is somehow missing the value (pre-021 forks).
      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', args.automation.account_id)
        .maybeSingle()
      await db.from('deals').insert({
        // Tenancy + audit, same split as automation_logs above.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        pipeline_id: cfg.pipeline_id,
        stage_id: cfg.stage_id,
        contact_id: args.contactId,
        title: interpolate(cfg.title, args),
        value: cfg.value ?? 0,
        currency: acct?.default_currency ?? DEFAULT_CURRENCY,
        status: 'open',
      })
      return 'deal created'
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      const body = cfg.body_template ? interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error('close_conversation needs a contact')
      await db
        .from('conversations')
        .update({ status: 'closed', updated_at: new Date().toISOString() })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
      return 'conversation closed'
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) return fromCtx
  if (!args.contactId) throw new Error('cannot resolve conversation: no contact')
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('account_id', args.automation.account_id)
    .eq('contact_id', args.contactId)
    .maybeSingle()
  if (error) throw new Error(`conversation lookup failed: ${error.message}`)
  if (!data?.id) throw new Error('no conversation for contact')
  return data.id as string
}

function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  // tag_added fires only for the specific tag the automation watches — the
  // dispatcher passes the added tag in ctx.tag_id. Without this guard every
  // tag_added automation would run for every tag, since the branch below
  // only special-cases keyword_match.
  if (automation.trigger_type === 'tag_added') {
    const cfg = automation.trigger_config as TagTriggerConfig
    return Boolean(cfg?.tag_id) && ctx?.tag_id === cfg.tag_id
  }
  if (automation.trigger_type !== 'keyword_match') return true
  const cfg = automation.trigger_config as KeywordMatchTriggerConfig
  if (!cfg?.keywords || cfg.keywords.length === 0) return false
  const text = (ctx?.message_text ?? '').toString()
  if (!text) return false
  const haystack = cfg.case_sensitive ? text : text.toLowerCase()
  return cfg.keywords.some((raw) => {
    const k = cfg.case_sensitive ? raw : raw.toLowerCase()
    return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
  })
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  const db = supabaseAdmin()
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false
      // contact_tags has no account_id column (its RLS keys off the parent
      // contact), so tenant scoping here relies on the contact-ownership
      // guard in runAutomationsForTrigger.
      const { count } = await db
        .from('contact_tags')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.operand)
      return (count ?? 0) > 0
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the service-role client.
      const { data } = await db
        .from('contacts')
        .select(cfg.operand)
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle()
      const v = (data as Record<string, unknown> | null)?.[cfg.operand]
      return v != null && String(v) === String(cfg.value ?? '')
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'time_of_day': {
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00").
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return false
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t
    }
    default:
      return false
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs =
    cfg.unit === 'seconds'
      ? 1_000
      : cfg.unit === 'days'
        ? 86_400_000
        : cfg.unit === 'hours'
          ? 3_600_000
          : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

/**
 * The ordered rotation list for a `send_media` step, or null when the
 * step is fixed-mode. A missing/absent selection_mode (every legacy
 * config) is fixed — backward compatibility without migration.
 */
function rotationMessages(cfg: SendMediaStepConfig): SendMediaRotationMessage[] | null {
  if (cfg.selection_mode !== 'rotate') return null
  const msgs = cfg.messages
  if (!Array.isArray(msgs) || msgs.length === 0) return null
  return msgs
}

function interpolate(s: string, args: ExecuteArgs): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(args.context.message_text ?? '')
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '')
    return ''
  })
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null,
) {
  if (!logId) return
  const db = supabaseAdmin()
  const { data: existing } = await db
    .from('automation_logs')
    .select('steps_executed, status')
    .eq('id', logId)
    .single()
  const merged = [
    ...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ?? []),
    ...newItems,
  ]
  const update: Record<string, unknown> = { steps_executed: merged }
  // Only overwrite status on the outermost scope — nested branches pass null.
  if (status !== null) {
    update.status = status
  }
  if (errorMessage) update.error_message = errorMessage
  await db.from('automation_logs').update(update).eq('id', logId)
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  await supabaseAdmin()
    .from('automation_logs')
    .update({ status, error_message: errorMessage })
    .eq('id', logId)
}

async function markPending(id: string, status: 'done' | 'failed') {
  await supabaseAdmin()
    .from('automation_pending_executions')
    .update({ status })
    .eq('id', id)
}
