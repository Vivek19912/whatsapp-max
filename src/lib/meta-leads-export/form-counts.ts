// ============================================================
// Meta Lead Ads Export — Step-1 form lead counts.
//
// Server computes both integers (GET meta-export?counts=1); this
// module only formats labels and normalizes the response shape.
// Client-provided counts are never trusted: non-finite or
// negative values coerce to 0, unknown keys are dropped.
// ============================================================

export interface FormLeadCounts {
  total: number;
  matching: number;
}

export interface FormCountsResponse {
  all: FormLeadCounts;
  byFlowId: Record<string, FormLeadCounts>;
}

function toCount(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Dropdown suffix for one option, e.g. " (250 total · 85
 * matching)". Empty string when counts are unavailable (still
 * loading or fetch failed) so the bare name renders instead of
 * a misleading zero.
 */
export function formatFormCountsSuffix(
  counts: FormLeadCounts | null | undefined
): string {
  if (!counts) return '';
  return ` (${toCount(counts.total)} total · ${toCount(counts.matching)} matching)`;
}

/**
 * Normalize a counts=1 response into All + per-flow counts.
 * Visible forms with no server entry are zero-filled so every
 * dropdown option shows both counts.
 */
export function normalizeFormCountsResponse(
  data: unknown,
  visibleFlowIds: readonly string[]
): FormCountsResponse {
  const byFlowId: Record<string, FormLeadCounts> = {};
  const forms = (data as { forms?: unknown } | null)?.forms;
  if (Array.isArray(forms)) {
    for (const f of forms) {
      const entry = f as {
        flowId?: unknown;
        total?: unknown;
        matching?: unknown;
      };
      if (typeof entry?.flowId !== 'string' || entry.flowId === '') continue;
      byFlowId[entry.flowId] = {
        total: toCount(entry.total),
        matching: toCount(entry.matching),
      };
    }
  }
  for (const id of visibleFlowIds) {
    byFlowId[id] ??= { total: 0, matching: 0 };
  }
  const all = (data as { all?: unknown } | null)?.all as
    { total?: unknown; matching?: unknown } | null | undefined;
  return {
    all: {
      total: toCount(all?.total),
      matching: toCount(all?.matching),
    },
    byFlowId,
  };
}
