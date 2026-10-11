'use client';

import { AudioLines, Clock3, Phone, Unlink } from 'lucide-react';
import type { ComponentType } from 'react';

import { Skeleton } from '@/components/dashboard/skeleton';
import { formatTalkTime } from '@/lib/calls/formatters';
import { WhatsappIcon } from '@/components/icons/whatsapp-icon';
import type { RecordingsSummary } from '@/lib/recordings/library';
import { cn } from '@/lib/utils';

function Card({
  icon: Icon,
  label,
  value,
  iconClassName,
  valueClassName,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  iconClassName?: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
          iconClassName ?? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400'
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className={cn('text-xl leading-7 font-bold tracking-tight tabular-nums text-foreground', valueClassName)}>
          {value}
        </p>
      </div>
    </div>
  );
}

/**
 * Library summary strip — one aggregate over the filtered set,
 * never one query per card. All values come from
 * GET /api/recordings?summary=1.
 */
export function SummaryCards({
  summary,
  loading,
}: {
  summary: RecordingsSummary | null;
  loading: boolean;
}) {
  if (loading || !summary) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5" aria-label="Loading summary">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[68px] w-full rounded-xl" />
        ))}
      </div>
    );
  }
  const fmt = (n: number) => n.toLocaleString('en-US');
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      <Card
        icon={AudioLines}
        label="Total Recordings"
        value={fmt(summary.total)}
        iconClassName="bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400"
      />
      <Card
        icon={Clock3}
        label="Total Duration"
        value={formatTalkTime(summary.totalDurationSecs)}
        iconClassName="bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400"
      />
      <Card
        icon={Phone}
        label="Phone Calls"
        value={fmt(summary.phone)}
        iconClassName="bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400"
      />
      {/*
        Merged reporting category: `summary.whatsapp` already folds
        stored whatsapp + whatsapp_business (route + migration 115),
        so one "WhatsApp Calls" card covers both. No separate
        WhatsApp Business card.
      */}
      <Card
        icon={WhatsappIcon}
        label="WhatsApp Calls"
        value={fmt(summary.whatsapp)}
        iconClassName="bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400"
      />
      <Card
        icon={Unlink}
        label="Unlinked"
        value={fmt(summary.unlinked)}
        iconClassName="bg-rose-50 text-rose-500 dark:bg-rose-500/10 dark:text-rose-400"
        valueClassName="text-rose-600 dark:text-rose-400"
      />
    </div>
  );
}
