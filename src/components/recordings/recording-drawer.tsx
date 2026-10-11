'use client';

import Link from 'next/link';
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Clock3,
  ExternalLink,
  Link2,
  Minus,
  Pause,
  Phone,
  Play,
  User,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { WhatsappIcon } from '@/components/icons/whatsapp-icon';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { workspaceContactHref } from '@/lib/flows/flow-tables';
import {
  formatDurationLong,
} from '@/lib/recordings/library';
import {
  formatRecordedIndia,
  type CallRecording,
} from '@/lib/recordings/recordings';
import { leadInitial } from './recordings-table';
import { cn } from '@/lib/utils';

const SPEEDS = [1, 1.25, 1.5, 2] as const;

function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Prominent player over the EXISTING secure endpoint
 * (/api/recordings/[id]/audio → 60s signed URL, preloaded only
 * on play). No storage URLs, no second playback API.
 */
function SecurePlayer({ recordingId, autoplay }: { recordingId: string; autoplay: boolean }) {
  // Remounted per recording (key={recording.id} at the call site),
  // so initial state is always fresh — no reset effect needed.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(Number.NaN);
  const [speed, setSpeed] = useState<number>(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) el.pause();
    else void el.play().catch(() => undefined);
  };

  return (
    <div className="rounded-xl border border-border bg-muted/40 p-4">
      <audio
        ref={audioRef}
        src={`/api/recordings/${recordingId}/audio`}
        preload="none"
        autoPlay={autoplay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onEnded={() => setPlaying(false)}
      />
      <div className="flex items-center gap-3">
        <Button
          size="icon"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={toggle}
          className="h-11 w-11 shrink-0 rounded-full bg-blue-600 hover:bg-blue-600"
        >
          {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
        </Button>
        <input
          type="range"
          min={0}
          max={1000}
          value={Number.isFinite(duration) && duration > 0 ? Math.round((time / duration) * 1000) : 0}
          onChange={(e) => {
            const el = audioRef.current;
            if (el && Number.isFinite(duration) && duration > 0) {
              el.currentTime = (Number(e.target.value) / 1000) * duration;
            }
          }}
          aria-label="Seek"
          className="h-1.5 flex-1 cursor-pointer accent-blue-600"
        />
        <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">
          {fmtClock(time)} / {Number.isFinite(duration) ? fmtClock(duration) : '0:00'}
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <Button
              key={s}
              variant={speed === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setSpeed(s);
                if (audioRef.current) audioRef.current.playbackRate = s;
              }}
              className={cn('h-7 px-2 text-xs', speed === s && 'bg-blue-600 hover:bg-blue-600')}
              aria-pressed={speed === s}
            >
              {s}x
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={muted ? 'Unmute' : 'Mute'}
            onClick={() => {
              const el = audioRef.current;
              const next = !muted;
              setMuted(next);
              if (el) el.muted = next;
            }}
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(e) => {
              const v = Number(e.target.value) / 100;
              setVolume(v);
              const el = audioRef.current;
              if (el) {
                el.volume = v;
                if (v > 0 && muted) {
                  setMuted(false);
                  el.muted = false;
                }
              }
            }}
            aria-label="Volume"
            className="h-1.5 w-24 cursor-pointer accent-blue-600"
          />
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <span className="text-muted-foreground">{icon}</span>
        {label}
      </span>
      <span className="text-right text-sm font-medium text-foreground">{children}</span>
    </div>
  );
}

/**
 * Right-side recording drawer: lead header, secure player,
 * metadata (only fields with data), Open in Workspace for linked
 * leads, Find/Link Lead for unlinked ones, and a notes box that
 * is honestly non-persistent (no recording-notes storage exists
 * — see report; no fake "saved" state).
 */
export function RecordingDrawer({
  recording,
  onClose,
  onFindLead,
  autoplay,
}: {
  recording: CallRecording | null;
  onClose: () => void;
  onFindLead: (r: CallRecording) => void;
  autoplay: boolean;
}) {
  const linked = !!recording?.contact_id;
  const leadName = recording?.contact_name ?? null;
  const leadPhone = recording?.phone_number ?? recording?.contact_phone ?? null;

  const directionLabel =
    recording?.direction === 'in'
      ? 'Incoming'
      : recording?.direction === 'out'
        ? 'Outgoing'
        : 'Unknown';
  // Merged reporting category: stored `whatsapp` and
  // `whatsapp_business` both display as "WhatsApp" with the single
  // shared brand icon. The stored value stays distinct (recording
  // authorization depends on it).
  const isWhatsappType =
    recording?.call_type === 'whatsapp' || recording?.call_type === 'whatsapp_business';
  const typeLabel =
    recording?.call_type === 'phone' ? 'Phone' : isWhatsappType ? 'WhatsApp' : null;

  return (
    <Sheet open={recording !== null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col overflow-y-auto sm:max-w-md">
        <SheetHeader className="flex-row items-center justify-between">
          <SheetTitle>Call Recording</SheetTitle>
        </SheetHeader>

        {recording ? (
          <div className="flex flex-col gap-5 pb-6">
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className={cn(
                  'flex h-12 w-12 items-center justify-center rounded-full text-lg font-semibold',
                  linked
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {linked ? leadInitial(leadName) : 'U'}
              </span>
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-foreground">
                  {linked ? (leadName ?? 'Unlinked') : 'Unlinked'}
                </p>
                {leadPhone ? (
                  <p className="truncate text-[13px] text-muted-foreground">{leadPhone}</p>
                ) : null}
              </div>
            </div>

            <SecurePlayer key={recording.id} recordingId={recording.id} autoplay={autoplay} />

            <section aria-label="Recording details">
              <h3 className="mb-1 text-sm font-semibold text-foreground">Recording Details</h3>
              <DetailRow icon={<User className="h-4 w-4" />} label="Lead">
                {linked ? (
                  <span className="text-blue-600 dark:text-blue-400">{leadName ?? 'Unlinked'}</span>
                ) : (
                  <span className="font-normal text-muted-foreground">Unlinked</span>
                )}
              </DetailRow>
              {linked && recording.contact_id ? (
                <div className="flex justify-end py-1">
                  <Button variant="outline" size="sm" render={<Link href={workspaceContactHref(recording.contact_id)} />}>
                    Open in Workspace <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : null}
              {leadPhone ? (
                <DetailRow icon={<Phone className="h-4 w-4" />} label="Phone Number">
                  <span className="tabular-nums">{leadPhone}</span>
                </DetailRow>
              ) : null}
              {typeLabel ? (
                <DetailRow
                  icon={
                    isWhatsappType ? (
                      <WhatsappIcon size={16} />
                    ) : (
                      <Phone className="h-4 w-4" />
                    )
                  }
                  label="Call Type"
                >
                  {typeLabel}
                </DetailRow>
              ) : null}
              <DetailRow
                icon={
                  recording.direction === 'in' ? (
                    <ArrowDown className="h-4 w-4" />
                  ) : recording.direction === 'out' ? (
                    <ArrowUp className="h-4 w-4" />
                  ) : (
                    <Minus className="h-4 w-4" />
                  )
                }
                label="Direction"
              >
                {directionLabel}
              </DetailRow>
              <DetailRow icon={<CalendarDays className="h-4 w-4" />} label="Recorded">
                {formatRecordedIndia(recording.recorded_at, recording.created_at)}
              </DetailRow>
              <DetailRow icon={<Clock3 className="h-4 w-4" />} label="Duration">
                {formatDurationLong(recording.duration_seconds)}
              </DetailRow>
              <DetailRow icon={<User className="h-4 w-4" />} label="Uploaded By">
                {recording.uploader_name ?? 'Unknown'}
              </DetailRow>
            </section>

            {!linked ? (
              <Button variant="outline" onClick={() => onFindLead(recording)}>
                <Link2 className="h-4 w-4" /> Find / Link Lead
              </Button>
            ) : null}

            <section aria-label="Notes">
              <h3 className="mb-2 text-sm font-semibold text-foreground">Notes</h3>
              <textarea
                disabled
                placeholder="Add notes about this recording..."
                aria-label="Recording notes (not yet supported)"
                className="min-h-[90px] w-full resize-y rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground placeholder:text-muted-foreground"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Recording notes need a database migration and aren&apos;t stored yet.
              </p>
              <div className="mt-2 flex justify-end">
                <Button size="sm" disabled>
                  Save
                </Button>
              </div>
            </section>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
