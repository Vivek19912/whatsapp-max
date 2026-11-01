import { describe, expect, it } from "vitest";
import {
  buildMediaPath,
  detectImageMimeFromBytes,
  MEDIA_MAX_BYTES_BY_KIND,
  resolveUploadContentType,
} from "./upload-media";

const ACCOUNT = "11111111-2222-3333-4444-555555555555";

describe("buildMediaPath", () => {
  it("namespaces under account-<id> so RLS write policies match", () => {
    const path = buildMediaPath(ACCOUNT, "photo.png", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-photo.png`);
    expect(path.split("/")[0]).toBe(`account-${ACCOUNT}`);
  });

  it("lower-cases the extension and sanitizes the basename", () => {
    const path = buildMediaPath(ACCOUNT, "My Invoice (final).PDF", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-My_Invoice_final_.pdf`);
  });

  it("caps the basename at 40 chars", () => {
    const long = "a".repeat(100) + ".png";
    const path = buildMediaPath(ACCOUNT, long, 1700000000000);
    const base = path.split("/")[1].replace("1700000000000-", "").replace(".png", "");
    expect(base.length).toBe(40);
  });

  it("falls back to 'file' / 'bin' for a nameless input", () => {
    const path = buildMediaPath(ACCOUNT, "", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-file.bin`);
  });

  it("defaults the extension to bin when there is none", () => {
    const path = buildMediaPath(ACCOUNT, "README", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-README.bin`);
  });
});

describe("MEDIA_MAX_BYTES_BY_KIND", () => {
  it("caps images at Meta's tighter 5 MB limit", () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.image).toBe(5 * 1024 * 1024);
  });

  it("caps video/audio/document at the 16 MB bucket limit", () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.video).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.audio).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.document).toBe(16 * 1024 * 1024);
  });
});

describe("resolveUploadContentType", () => {
  it("preserves a valid browser-supplied image MIME", () => {
    expect(resolveUploadContentType("photo.png", "image/png")).toBe(
      "image/png",
    );
    expect(resolveUploadContentType("photo.jpg", "image/jpeg")).toBe(
      "image/jpeg",
    );
  });

  it("preserves non-empty non-image types untouched (PDF, OPUS, M4A)", () => {
    expect(resolveUploadContentType("doc.pdf", "application/pdf")).toBe(
      "application/pdf",
    );
    expect(resolveUploadContentType("recording.ogg", "audio/ogg")).toBe(
      "audio/ogg",
    );
    expect(resolveUploadContentType("recording.m4a", "audio/mp4")).toBe(
      "audio/mp4",
    );
  });

  it("infers PNG/JPEG/WebP/GIF from the extension when type is empty", () => {
    expect(resolveUploadContentType("photo.PNG", "")).toBe("image/png");
    expect(resolveUploadContentType("photo.jpg", null)).toBe("image/jpeg");
    expect(resolveUploadContentType("photo.jpeg", undefined)).toBe(
      "image/jpeg",
    );
    expect(resolveUploadContentType("anim.webp", "  ")).toBe("image/webp");
    expect(resolveUploadContentType("anim.gif", "")).toBe("image/gif");
  });

  it("returns null for unknown extensions instead of guessing", () => {
    expect(resolveUploadContentType("README", "")).toBeNull();
    expect(resolveUploadContentType("archive.zip", "")).toBeNull();
    expect(resolveUploadContentType("clip.ogg", "")).toBeNull();
    expect(resolveUploadContentType("note.txt", "")).toBeNull();
  });

  it("prefers bytes over extension on mismatch", () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
    ]);
    expect(resolveUploadContentType("photo.jpg", "", png)).toBeNull();
    expect(resolveUploadContentType("photo.png", "", png)).toBe("image/png");
  });

  it("rejects a mismatched browser type against bytes", () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
    ]);
    expect(resolveUploadContentType("x", "image/jpeg", png)).toBeNull();
    expect(resolveUploadContentType("x", "image/png", png)).toBe("image/png");
  });
});

describe("detectImageMimeFromBytes", () => {
  it("detects PNG/GIF/JPEG/WebP signatures", () => {
    expect(
      detectImageMimeFromBytes(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image/png");
    expect(
      detectImageMimeFromBytes(
        new Uint8Array([
          0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0,
        ]),
      ),
    ).toBe("image/gif");
    expect(
      detectImageMimeFromBytes(
        new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
      ),
    ).toBe("image/jpeg");
    expect(
      detectImageMimeFromBytes(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        ]),
      ),
    ).toBe("image/webp");
  });

  it("returns null for unknown or truncated input", () => {
    expect(
      detectImageMimeFromBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])),
    ).toBeNull();
    expect(detectImageMimeFromBytes(new Uint8Array([1, 2]))).toBeNull();
    expect(detectImageMimeFromBytes(new Uint8Array([]))).toBeNull();
  });
});
