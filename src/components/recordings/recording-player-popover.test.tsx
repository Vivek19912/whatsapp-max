import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { RecordingPlayer } from './recording-player';

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), 'utf8');

// ---------------------------------------------------------------------------
// RecordingPlayerPopover — the single shared play-button + floating player
// shell. The Recordings page defines the reference behavior; the Calls
// Recent Calls column and the Workspace recording header must reuse this
// shell (and the RecordingPlayer inside it) instead of native audio.
// ---------------------------------------------------------------------------

describe('RecordingPlayerPopover shell', () => {
  const shell = () =>
    src('src/components/recordings/recording-player-popover.tsx');

  it('reuses the single shared RecordingPlayer over the secure endpoint', () => {
    expect(shell()).toContain('RecordingPlayer');
    expect(shell()).toContain('key={recordingId}');
    // The player itself streams the signed-URL endpoint — the shell
    // must not introduce any second audio source.
    expect(shell()).not.toContain('<audio');
    const out = renderToStaticMarkup(
      <RecordingPlayer recordingId="rec-9" autoplay={false} />
    );
    expect(out).toContain('src="/api/recordings/rec-9/audio"');
  });

  it('keeps the compact blue play trigger plus duration readout', () => {
    expect(shell()).toContain('rounded-full bg-blue-600');
    expect(shell()).toContain('h-8 w-8');
    expect(shell()).toContain('durationText');
    expect(shell()).toContain('aria-label="Recording audio player"');
    expect(shell()).toContain('aria-label="Close player"');
  });

  it('portals above the row with flip/shift collision handling', () => {
    expect(shell()).toContain('PopoverContent');
    expect(shell()).toContain('side="top"');
    expect(shell()).toContain(
      "collisionAvoidance={{ side: 'flip', align: 'shift' }}"
    );
    expect(shell()).toContain('collisionPadding={12}');
    expect(shell()).toContain('max-w-[calc(100vw-2rem)]');
    const popover = src('src/components/ui/popover.tsx');
    expect(popover).toContain('PopoverPrimitive.Portal');
  });

  it('supports single-open discipline (open state owned by the caller)', () => {
    expect(shell()).toContain('open={open}');
    expect(shell()).toContain('onOpenChange={onOpenChange}');
    expect(shell()).toContain('onClose');
    expect(shell()).toContain('autoplay');
  });
});

describe('Calls Recent Calls integration', () => {
  const page = () => src('src/components/calls/dashboard/recent-calls.tsx');

  it('opens the shared player popover instead of native audio', () => {
    expect(page()).toContain('RecordingPlayerPopover');
    expect(page()).toContain('recording-player-popover');
    expect(page()).not.toContain('<audio');
    expect(page()).not.toContain('controls');
  });

  it('holds a single open player and resets autoplay on close', () => {
    expect(page()).toContain('const [openId, setOpenId]');
    expect(page()).toContain('closePlayer');
    expect(page()).toContain('setAutoplay(false)');
  });

  it('keeps the No recording state for missed calls', () => {
    expect(page()).toContain('No recording');
  });
});

describe('Workspace recording header integration', () => {
  const page = () => src('src/app/(dashboard)/workspace/page.tsx');

  it('uses the shared player popover in the header cell and drawer list', () => {
    expect(page()).toContain('RecordingPlayerPopover');
    expect(page()).toContain('recording-player-popover');
    expect(page()).not.toContain('<audio');
  });

  it('keeps playback clicks from opening the lead drawer', () => {
    expect(page()).toContain('stopPropagation');
  });

  it('keeps the No recording state', () => {
    expect(page()).toContain('No recording');
  });
});
