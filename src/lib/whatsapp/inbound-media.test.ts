import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INBOUND_MEDIA_BUCKET,
  INBOUND_MEDIA_MAX_BYTES,
  archiveInboundMedia,
  fetchArchivedInboundMedia,
  inboundMediaPath,
} from "./inbound-media";

const ACCT = "6dac8b51-cb14-47ca-9c19-468dcae93f07";
const MEDIA = "28906476482352401";
const BYTES = Buffer.from("%PDF-1.7 test-bytes");

function headers(extra: Record<string, string> = {}): Headers {
  return new Headers({
    "content-type": "application/pdf",
    "content-length": String(BYTES.length),
    ...extra,
  });
}

function okDownload() {
  return {
    ok: true,
    status: 200,
    headers: headers(),
    arrayBuffer: async () => BYTES,
  } as unknown as Response;
}

describe("inboundMediaPath", () => {
  it("builds the deterministic account-scoped key", () => {
    expect(inboundMediaPath(ACCT, MEDIA)).toBe(`${ACCT}/${MEDIA}`);
  });

  it("rejects path traversal in either segment", () => {
    expect(() => inboundMediaPath("../evil", MEDIA)).toThrow(/Invalid account id/);
    expect(() => inboundMediaPath(ACCT, "../../x")).toThrow(/Invalid media id/);
    expect(() => inboundMediaPath("", MEDIA)).toThrow(/Invalid account id/);
  });
});

describe("archiveInboundMedia", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.com";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.unstubAllGlobals();
  });

  it("downloads and uploads with account-scoped path and metadata", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.startsWith("https://graph.facebook.com/")) {
          return { ok: true, json: async () => ({ url: "https://cdn.meta/file", mime_type: "application/pdf" }) } as Response;
        }
        if (url.startsWith("https://cdn.meta/")) return okDownload();
        if (url.includes(`/storage/v1/object/${INBOUND_MEDIA_BUCKET}/`)) {
          return { ok: true, status: 200 } as unknown as Response;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const res = await archiveInboundMedia({
      accountId: ACCT,
      mediaId: MEDIA,
      accessToken: "tok",
      mimeType: "application/pdf",
      fileName: "suhyl.pdf",
    });

    expect(res.ok).toBe(true);
    expect(res.path).toBe(`${ACCT}/${MEDIA}`);
    expect(res.size).toBe(BYTES.length);

    const upload = calls.find((c) => c.url.includes("/storage/v1/object/"));
    expect(upload?.url).toBe(
      `https://supabase.example.com/storage/v1/object/${INBOUND_MEDIA_BUCKET}/${ACCT}/${MEDIA}`,
    );
    const uploadHeaders = new Headers(upload?.init?.headers as Record<string, string>);
    expect(uploadHeaders.get("content-type")).toBe("application/pdf");
    expect(uploadHeaders.get("x-upsert")).toBe("false");
    expect(uploadHeaders.get("authorization")).toBe("Bearer service-role-key");
    const meta = JSON.parse(
      Buffer.from(uploadHeaders.get("x-metadata") ?? "", "base64").toString("utf8"),
    );
    expect(meta.account_id).toBe(ACCT);
    expect(meta.media_id).toBe(MEDIA);
    expect(meta.original_filename).toBe("suhyl.pdf");
    expect(meta.size).toBe(BYTES.length);
    // No credentials in metadata.
    expect(JSON.stringify(meta)).not.toMatch(/tok|service-role-key/i);
    // The auth token only goes to Meta, never to storage.
    expect(uploadHeaders.get("authorization")).not.toContain("tok");
  });

  it("treats 409 (duplicate delivery) as success without failing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://graph.facebook.com/")) {
          return { ok: true, json: async () => ({ url: "https://cdn.meta/file" }) } as Response;
        }
        if (url.startsWith("https://cdn.meta/")) return okDownload();
        return { ok: false, status: 409 } as unknown as Response;
      }),
    );
    const res = await archiveInboundMedia({ accountId: ACCT, mediaId: MEDIA, accessToken: "tok" });
    expect(res.ok).toBe(true);
    expect(res.alreadyArchived).toBe(true);
  });

  it("skips files over the bucket limit without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://graph.facebook.com/")) {
          return { ok: true, json: async () => ({ url: "https://cdn.meta/file" }) } as Response;
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-length": String(INBOUND_MEDIA_MAX_BYTES + 1) }),
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response;
      }),
    );
    const res = await archiveInboundMedia({ accountId: ACCT, mediaId: MEDIA, accessToken: "tok" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("too_large");
  });

  it("never throws — returns ok:false after retries on persistent failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response),
    );
    const res = await archiveInboundMedia({ accountId: ACCT, mediaId: MEDIA, accessToken: "tok" });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe("fetchArchivedInboundMedia", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.com";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.unstubAllGlobals();
  });

  it("returns null on 400/404 so the caller falls back to Meta", async () => {
    for (const status of [400, 404]) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status }) as unknown as Response));
      await expect(
        fetchArchivedInboundMedia({ accountId: ACCT, mediaId: MEDIA }),
      ).resolves.toBeNull();
    }
  });

  it("forwards the browser Range header to storage", async () => {
    let seenRange: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seenRange = new Headers(init?.headers as Record<string, string>).get("range");
        return {
          ok: true,
          status: 206,
          headers: new Headers({ "content-range": "bytes 0-15/100" }),
          body: "archived-body",
        } as unknown as Response;
      }),
    );
    const res = await fetchArchivedInboundMedia({
      accountId: ACCT,
      mediaId: MEDIA,
      range: "bytes=0-15",
    });
    expect(seenRange).toBe("bytes=0-15");
    expect(res?.status).toBe(206);
  });

  it("returns null on storage errors instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(
      fetchArchivedInboundMedia({ accountId: ACCT, mediaId: MEDIA }),
    ).resolves.toBeNull();
  });
});
