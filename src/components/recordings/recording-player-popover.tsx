'use client';

import { Pause, Play, X } from 'lucide-react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { RecordingPlayer } from './recording-player';

/**
 * Shared recording play-button + floating player popover.
 *
 * This is the Recordings page player shell (see
 * `recordings-table.tsx`, the authoritative reference),
 * extracted so the Calls Recent Calls column and the Workspace
 * recording header render the EXACT same experience: one small
 * blue Play button plus duration, opening a portaled popover
 * (side="top" with flip/shift collision handling, so it is
 * never clipped by scroll containers) that hosts the single
 * shared `RecordingPlayer` keyed by recording id.
 *
 * Single-open discipline stays with the caller: pass one
 * `open` boolean per recording plus `onOpenChange`, and keep a
 * single `openId` in list parents so starting a second
 * recording unmounts (and therefore pauses) the first. The
 * `RecordingPlayer` remounts per recording id, so progress,
 * speed, and volume never leak across recordings, and unmount
 * pauses the element — no background playback, no stale
 * events.
 *
 * Security: playback goes through the existing signed-URL
 * endpoint (/api/recordings/[id]/audio) inside
 * `RecordingPlayer` — no storage URLs, no new endpoints.
 */
export function RecordingPlayerPopover({
  recordingId,
  open,
  autoplay,
  onOpenChange,
  onPlayIntent,
  onClose,
  playLabel,
  durationText,
  footer,
}: {
  recordingId: string;
  open: boolean;
  autoplay: boolean;
  onOpenChange: (next: boolean) => void;
  /** Sets autoplay intent (called on cell and Play-button clicks). */
  onPlayIntent: () => void;
  onClose: () => void;
  playLabel: string;
  durationText: string;
  footer?: React.ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <div
        onClick={(e) => {
          // Clicks on the Play button itself are left to the
          // trigger toggle; any other click in the cell opens
          // the player — same as the Recordings table.
          if ((e.target as HTMLElement).closest('button')) return;
          onPlayIntent();
          onOpenChange(true);
        }}
        className="hover:bg-muted/60 inline-flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 transition-colors"
      >
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={playLabel}
              onClick={onPlayIntent}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700"
            />
          }
        >
          {open ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="ml-0.5 h-4 w-4" />
          )}
        </PopoverTrigger>
        <span className="text-muted-foreground text-[13px] tabular-nums">
          {durationText}
        </span>
      </div>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        collisionPadding={12}
        collisionAvoidance={{ side: 'flip', align: 'shift' }}
        className="w-80 max-w-[calc(100vw-2rem)] p-4"
        aria-label="Recording audio player"
      >
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close player"
            onClick={onClose}
            className="h-8 w-8 shrink-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {/* Keyed by recording: switching recordings mounts a
            fresh player and unmounts the old one, whose cleanup
            pauses its audio. */}
        <RecordingPlayer
          key={recordingId}
          recordingId={recordingId}
          autoplay={autoplay}
        />
        {footer}
      </PopoverContent>
    </Popover>
  );
}
