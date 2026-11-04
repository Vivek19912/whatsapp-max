// ============================================================
// CallVault presence sweep — the monitor behind
// GET /api/callvault/presence-cron.
//
// Reads stale device rows with the service client and opens
// one callvault_device_events row per stale device. Pure
// coordination rules:
//
//   * Only non-revoked rows alert. Revoked (remote-logout)
//     rows are skipped — their state displays as remote_logout,
//     never as a disconnect.
//   * Rows whose session aged past 60 days close silently with
//     reason='session_expired' (history only, no banner).
//   * Idempotent under concurrent runs: the partial unique
//     index (account_id, device_id) WHERE reconnected_at IS
//     NULL is the dedupe — a duplicate INSERT raises 23505 and
//     is ignored, no app locks.
//   * Infra failure: a failed candidate SELECT throws (the
//     route maps it to 503) BEFORE any write, so the monitor
//     never marks on a partial/unverified read. Per-row insert
//     failures are logged and skipped, never fatal.
//   * The monitor NEVER revokes, NEVER touches tokens or
//     GoTrue sessions — it only appends event rows.
//
// No I/O beyond the injected admin client; `now` is injected
// so vitest can freeze time.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  DISCONNECT_TIMEOUT_S,
  isRevokedDevice,
  isSessionExpired,
  isStale,
} from './presence';

export interface PresenceSweepResult {
  checked: number;
  disconnected: number;
  expired: number;
}

/**
 * One live sidecar socket, as reported by
 * GET /internal/presence-snapshot. All identifiers come from the
 * socket's authenticated handshake (never from the phone frame
 * alone) and lastHeartbeatAtMs is the server-side receipt stamp.
 */
export interface LivePresence {
  accountId: string;
  userId: string;
  deviceId: string;
  sessionId: string | null;
  lastHeartbeatAtMs: number;
}

export type SnapshotFetchResult =
  | { ok: true; connections: LivePresence[] }
  | { ok: false; reason: string };

/** Fetches + validates the sidecar live-presence snapshot. */
export type FetchSnapshot = () => Promise<SnapshotFetchResult>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate one raw snapshot entry. Malformed entries are dropped
 * (never suppress, never alert) — a corrupt entry must neither
 * hide a dead device nor implicate another account's device.
 */
export function parseSnapshotEntry(raw: unknown): LivePresence | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const accountId = typeof r.account_id === 'string' ? r.account_id : '';
  const userId = typeof r.user_id === 'string' ? r.user_id : '';
  const deviceId = typeof r.device_id === 'string' ? r.device_id : '';
  if (!UUID_RE.test(accountId) || !UUID_RE.test(userId) || !deviceId) return null;
  const sessionRaw = r.session_id;
  const sessionId =
    typeof sessionRaw === 'string' && UUID_RE.test(sessionRaw) ? sessionRaw : null;
  const hbRaw = r.last_heartbeat_at;
  const hbMs = typeof hbRaw === 'string' ? Date.parse(hbRaw) : NaN;
  if (!Number.isFinite(hbMs)) return null;
  return { accountId, userId, deviceId, sessionId, lastHeartbeatAtMs: hbMs };
}

/**
 * Live-suppression check: does the snapshot prove THIS exact
 * (account, user, device, session) heartbeated within the
 * timeout? Session equality is required when both sides know
 * the session — an old session's heartbeat must never suppress
 * the current session's disconnection, and a null-session
 * entry never suppresses (conservative).
 */
export function isLiveInSnapshot(
  row: { account_id: string; user_id: string; device_id: string; session_id: string | null },
  connections: LivePresence[],
  nowMs: number,
): boolean {
  for (const c of connections) {
    if (c.accountId !== row.account_id) continue;
    if (c.userId !== row.user_id) continue;
    if (c.deviceId !== row.device_id) continue;
    if (!c.sessionId || !row.session_id || c.sessionId !== row.session_id) continue;
    if (nowMs - c.lastHeartbeatAtMs <= DISCONNECT_TIMEOUT_S * 1000) return true;
  }
  return false;
}

interface CandidateRow {
  account_id: string;
  user_id: string;
  device_id: string;
  session_id: string | null;
  revoked_session_id: string | null;
  revoked_at: string | null;
  last_seen_at: string | null;
  created_at: string;
}

const CANDIDATE_COLUMNS =
  'account_id, user_id, device_id, session_id, revoked_session_id, revoked_at, last_seen_at, created_at';

function isDuplicateInsert(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    String((err as Record<string, unknown>).code) === '23505'
  );
}

export async function runPresenceSweep(
  admin: SupabaseClient,
  now: Date = new Date(),
  fetchSnapshot?: FetchSnapshot,
): Promise<PresenceSweepResult> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const cutoffIso = new Date(nowMs - DISCONNECT_TIMEOUT_S * 1000).toISOString();

  // Live reconciliation first: a stale last_seen_at with a fresh
  // sidecar heartbeat suppresses the event (failed touch writes
  // must never produce false alerts). An unavailable snapshot
  // fails the whole sweep with zero writes — inability to
  // inspect live connections is never proof of disconnection.
  let live: LivePresence[] = [];
  if (fetchSnapshot) {
    const snap = await fetchSnapshot();
    if (!snap.ok) {
      throw new Error(`presence snapshot unavailable: ${snap.reason}`);
    }
    live = snap.connections;
  }

  // Candidates: unseen since the cutoff (null last_seen = never
  // reported = stale). The JS-side isStale recheck below stays
  // authoritative so a misbehaving filter can only narrow, and
  // a failed SELECT throws before any write (503, zero marks).
  const { data, error } = await admin
    .from('callvault_devices')
    .select(CANDIDATE_COLUMNS)
    .or(`last_seen_at.is.null,last_seen_at.lt.${cutoffIso}`);
  if (error) throw error;
  const rows = ((data ?? []) as CandidateRow[]).filter(
    (row) =>
      typeof row.account_id === 'string' &&
      typeof row.user_id === 'string' &&
      typeof row.device_id === 'string' &&
      row.device_id !== '',
  );

  const result: PresenceSweepResult = {
    checked: rows.length,
    disconnected: 0,
    expired: 0,
  };

  const pending: Array<{
    row: CandidateRow;
    reason: 'disconnect' | 'session_expired';
  }> = [];

  for (const row of rows) {
    const revoked = isRevokedDevice({
      revokedAt: row.revoked_at,
      revokedSessionId: row.revoked_session_id,
      sessionId: row.session_id,
    });
    // Revoked rows never alert — remote_logout is not a disconnect.
    if (revoked) continue;
    // Belt-and-suspenders: skip rows the SELECT filter should
    // already have excluded (fresh, or healed between read and
    // write). Never mark on an unverified read.
    if (!isStale(row.last_seen_at, nowMs)) continue;

    const reason = isSessionExpired(row.created_at, nowMs)
      ? 'session_expired'
      : 'disconnect';
    // Live suppression (reconciled): a fresh sidecar heartbeat
    // for this exact session wins over a stale timestamp.
    if (
      reason === 'disconnect' &&
      isLiveInSnapshot(
        {
          account_id: row.account_id,
          user_id: row.user_id,
          device_id: row.device_id,
          session_id: row.session_id,
        },
        live,
        nowMs,
      )
    ) {
      continue;
    }
    pending.push({ row, reason });
  }

  // Final freshness: a heartbeat may have landed while the sweep
  // above was evaluating. Re-read the snapshot and drop any
  // candidate that is live now — only survivors are inserted.
  if (fetchSnapshot && pending.length > 0) {
    const snap = await fetchSnapshot();
    if (!snap.ok) {
      throw new Error(`presence snapshot unavailable: ${snap.reason}`);
    }
    live = snap.connections;
  }

  for (const { row, reason } of pending) {
    if (
      reason === 'disconnect' &&
      fetchSnapshot &&
      isLiveInSnapshot(
        {
          account_id: row.account_id,
          user_id: row.user_id,
          device_id: row.device_id,
          session_id: row.session_id,
        },
        live,
        nowMs,
      )
    ) {
      continue;
    }
    const { error: insertError } = await admin.from('callvault_device_events').insert({
      account_id: row.account_id,
      user_id: row.user_id,
      device_id: row.device_id,
      session_id: row.session_id,
      last_seen_at: row.last_seen_at,
      disconnected_at: nowIso,
      reason,
    });
    if (!insertError) {
      result[reason === 'disconnect' ? 'disconnected' : 'expired'] += 1;
    } else if (!isDuplicateInsert(insertError)) {
      // Duplicate (23505) = another sweep already opened this
      // device's event — idempotent, not an error. Anything
      // else is logged and skipped, never fatal to the sweep.
      console.warn('[presence-cron] event insert failed: duplicate-safe skip');
    }
  }

  return result;
}
