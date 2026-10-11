"use client"

import {
  Mic,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Clock3,
  Unlink,
  Users,
} from 'lucide-react'
import { WhatsappIcon } from '@/components/icons/whatsapp-icon'
import { CallMetricTile } from './call-metric-tile'
import { formatTalkTime } from '@/lib/calls/formatters'
import { mergedWhatsappRecordings, type RecordingMetrics } from '@/lib/calls/aggregate'

function fmtCount(n: number): string {
  return n.toLocaleString('en-US')
}

/** Talk seconds → "8m 58s"; null (nothing measured) → "—", never 0. */
function fmtDuration(totalSecs: number | null): string {
  return totalSecs === null ? '—' : formatTalkTime(totalSecs)
}

interface CallPeriodCardProps {
  title: string
  dateLabel: string
  /** Null while loading (skeleton state lives in the parent). */
  metrics: RecordingMetrics | null
}

/**
 * One period card: title + date header, then the fixed 8-metric
 * recording grid. Counts come straight from call_recordings —
 * no call-log inference anywhere on this card. WhatsApp is the
 * single merged reporting category (whatsapp + whatsapp_business);
 * there is no separate WhatsApp Business KPI.
 */
export function CallPeriodCard({ title, dateLabel, metrics }: CallPeriodCardProps) {
  return (
    <section
      aria-label={`${title} recordings summary`}
      className="rounded-xl border border-border bg-card p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-6"
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="text-[13px] text-muted-foreground">{dateLabel}</p>
      </header>

      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <CallMetricTile
          value={metrics ? fmtCount(metrics.recordingCount) : '—'}
          label="Recordings"
          icon={Mic}
        />
        <CallMetricTile
          value={metrics ? fmtDuration(metrics.recordingDurationSecs) : '—'}
          label="Recording Duration"
          icon={Clock3}
        />
        <CallMetricTile
          value={metrics ? fmtCount(metrics.incomingRecordings) : '—'}
          label="Incoming Recordings"
          icon={PhoneIncoming}
          tone="green"
        />
        <CallMetricTile
          value={metrics ? fmtCount(metrics.outgoingRecordings) : '—'}
          label="Outgoing Recordings"
          icon={PhoneOutgoing}
          tone="orange"
        />
        <CallMetricTile
          value={metrics ? fmtCount(metrics.phoneRecordings) : '—'}
          label="Phone"
          icon={Phone}
        />
        <CallMetricTile
          value={metrics ? fmtCount(mergedWhatsappRecordings(metrics)) : '—'}
          label="WhatsApp"
          icon={WhatsappIcon}
        />
        <CallMetricTile
          value={metrics ? fmtCount(metrics.uniqueClients) : '—'}
          label="Unique Clients"
          icon={Users}
        />
        <CallMetricTile
          value={metrics ? fmtCount(metrics.unlinkedRecordings) : '—'}
          label="Unlinked Recordings"
          icon={Unlink}
        />
      </div>
    </section>
  )
}
