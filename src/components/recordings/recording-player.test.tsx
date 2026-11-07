import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { RecordingPlayer } from "./recording-player";

// ---------------------------------------------------------------------------
// RecordingPlayer — the single full audio player shared by every
// playback surface (table popover). SSR covers the complete
// control set against the real secure audio endpoint; behavior
// (play/pause, seek, speed, volume) stays owned by the element.
// ---------------------------------------------------------------------------

function html(recordingId = "r-1", autoplay = false) {
  return renderToStaticMarkup(
    <RecordingPlayer recordingId={recordingId} autoplay={autoplay} />,
  );
}

describe("RecordingPlayer controls", () => {
  it("streams the existing secure audio endpoint for the recording", () => {
    const out = html("rec-9");
    expect(out).toContain("<audio");
    expect(out).toContain('src="/api/recordings/rec-9/audio"');
    expect(out).toContain('preload="none"');
  });

  it("keeps Play/Pause, seek bar, and time readout", () => {
    const out = html();
    expect(out).toContain('aria-label="Play"');
    expect(out).toContain('aria-label="Seek"');
    expect(out).toContain("0:00 / 0:00");
  });

  it("keeps all four playback speeds", () => {
    const out = html();
    expect(out).toContain('aria-label="Playback speed"');
    for (const label of ["1x", "1.25x", "1.5x", "2x"]) {
      expect(out).toContain(`>${label}<`);
    }
  });

  it("keeps volume mute toggle and slider", () => {
    const out = html();
    expect(out).toContain('aria-label="Mute"');
    expect(out).toContain('aria-label="Volume"');
  });

  it("autoplays only when requested", () => {
    // React renders the DOM property camelCased (autoPlay="") and
    // omits it when false: autoplay must appear exactly when asked.
    expect(html("r-1", true)).toContain("autoPlay");
    expect(html("r-1", false)).not.toContain("autoPlay");
  });

  it("keeps every control inside the container with flexible sizing", () => {
    const out = html();
    // Sliders flex instead of forcing fixed widths: the seek bar
    // and (previously overflowing) volume slider shrink with the
    // container, and the second row wraps instead of clipping.
    expect(out).toContain("min-w-0 flex-1");
    expect(out).toContain("flex-wrap");
    expect(out).not.toContain("w-24");
  });
});
