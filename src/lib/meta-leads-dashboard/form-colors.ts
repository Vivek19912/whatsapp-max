// Deterministic form → color mapping for the Meta Lead Ads charts.
//
// Series are keyed by Instant Form display name (form_name, else
// form_id — the same key the RPC groups by), so a form keeps its
// color across the daily and monthly charts and across reloads.
// Reuses the shared dashboard palette + hash assignment so Meta
// forms sit in the same visual language as flow charts.
import { assignFlowColors } from '@/lib/dashboard/flow-colors'

/** Stable color per form name. Empty input → empty map. */
export function assignFormColors(names: string[]): Map<string, string> {
  return assignFlowColors([...new Set(names)].filter((n) => n !== ''))
}
