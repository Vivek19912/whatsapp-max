'use client';

import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const SPEEDS = [1, 1.25, 1.5, 2] as const;

function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Full recording audio player over the EXISTING secure endpoint
 * (/api/recordings/[id]/audio → 60s signed URL, preloaded only
 * on play). No storage URLs, no second playback API. Single
 * source for every playback surface (table popover) — never
 * duplicated.
 *
 * Lifecycle: the player unmounts when its popover closes, and
 * unmount explicitly pauses the element, so closing the popover
 * always stops playback and no stale audio events can leak into
 * the next recording (callers also `key` by recording id, so
 * switching recordings resets all progress/speed/volume state).
 */
export function RecordingPlayer({
  recordingId,
  autoplay,
}: {
  recordingId: string;
  autoplay: boolean;
}) {
  // Remounted per recording (key={recording.id} at the call site),
  // so initial state is always fresh — no reset effect needed.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(Number.NaN);
  const [speed, setSpeed] = useState<number>(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  // Closing the popover unmounts the player: pause explicitly so
  // playback (and its listeners) never outlive the UI, even if
  // the browser keeps a detached element alive briefly.
  useEffect(() => {
    const el = audioRef.current;
    return () => {
      el?.pause();
    };
  }, []);

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
