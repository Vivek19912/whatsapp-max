"use client";

import { useState } from "react";

import { RecordingPlayerPopover } from "@/components/recordings/recording-player-popover";
import { formatRecordingDuration } from "@/lib/recordings/recordings";
import type { LatestRecordingEntry } from "@/lib/flows/flow-tables";

/**
 * Latest-recording cell: the shared player popover from the
 * Recordings page (one blue Play button + duration; the full
 * player floats in a portaled popover, never a native audio
 * element in the row). Player clicks never bubble to the row
 * (the row opens the lead drawer). No recording → "No
 * recording". Used by individual Workspace tables and the All
 * Meta Leads combined view alike.
 */
export function LatestRecordingCell({ entry }: { entry: LatestRecordingEntry | null }) {
  const [open, setOpen] = useState(false);
  const [autoplay, setAutoplay] = useState(false);
  const closePlayer = () => {
    setOpen(false);
    setAutoplay(false);
  };
  if (!entry) {
    return <span className="text-muted-foreground text-sm">No recording</span>;
  }
  return (
    <span
      className="flex items-center gap-2"
      onClick={(e) => e.stopPropagation()}
    >
      <RecordingPlayerPopover
        recordingId={entry.id}
        open={open}
        autoplay={autoplay}
        onOpenChange={(next) => {
          if (next) setOpen(true);
          else closePlayer();
        }}
        onPlayIntent={() => setAutoplay(true)}
        onClose={closePlayer}
        playLabel="Play latest recording"
        durationText={formatRecordingDuration(entry.duration_seconds)}
      />
      <span className="text-muted-foreground max-w-[120px] truncate text-sm">
        {entry.uploader_name ?? 'Unknown'}
      </span>
    </span>
  );
}
