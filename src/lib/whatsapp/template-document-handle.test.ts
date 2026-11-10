import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Meta resumable upload so the helper is tested in isolation.
vi.mock('./meta-api', () => ({
  uploadResumableMedia: vi.fn(async () => ({ handle: 'DOCHANDLE123' })),
}));

import {
  ensureDocumentHeaderHandle,
  ensureMediaHeaderHandle,
} from './template-header-handle';
import { uploadResumableMedia } from './meta-api';
import type { TemplatePayload } from './template-validators';

function payload(over: Partial<TemplatePayload> = {}): TemplatePayload {
  return {
    name: 't',
    category: 'Utility',
    language: 'en_US',
    body_text: 'hi',
    header_type: 'document',
    header_media_url: 'https://x.test/terms.pdf',
    ...over,
  };
}

function pdfResponse(type = 'application/pdf', size = 2048, ok = true, status = 200): Response {
  const bytes = new ArrayBuffer(size);
  new Uint8Array(bytes).set([0x25, 0x50, 0x44, 0x46, 0x2d]);
  return {
    ok,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => bytes,
  } as unknown as Response;
}

function pngResponse(size = 2048): Response {
  const bytes = new ArrayBuffer(size);
  new Uint8Array(bytes).set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) },
    arrayBuffer: async () => bytes,
  } as unknown as Response;
}

describe('ensureDocumentHeaderHandle', () => {
  beforeEach(() => {
    vi.mocked(uploadResumableMedia).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is a no-op for non-document headers', async () => {
    const p = payload({ header_type: 'text', header_content: 'Hi', header_media_url: undefined });
    await ensureDocumentHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBeUndefined();
  });

  it('is a no-op when a handle already exists', async () => {
    const p = payload({ header_handle: 'existing' });
    await ensureDocumentHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBe('existing');
  });

  it('is a no-op without a media url', async () => {
    const p = payload({ header_media_url: undefined });
    await ensureDocumentHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
  });

  it('throws an actionable error when no Meta App ID is available', async () => {
    const p = payload();
    await expect(ensureDocumentHeaderHandle(p, 'tok')).rejects.toThrow(/Meta App ID/);
  });

  it('prefers the per-account App ID arg over the env var', async () => {
    vi.stubEnv('META_APP_ID', '');
    vi.stubGlobal('fetch', vi.fn(async () => pdfResponse()));
    const p = payload();
    await ensureDocumentHeaderHandle(p, 'tok', 'account-app-id');
    expect(p.header_handle).toBeDefined();
    expect(vi.mocked(uploadResumableMedia)).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'account-app-id', mimeType: 'application/pdf', fileName: 'header.pdf' }),
    );
  });

  it('derives + sets header_handle from a valid pdf url (uploaded or pasted)', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => pdfResponse('application/pdf', 2048)));
    const p = payload();
    await ensureDocumentHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).toHaveBeenCalledOnce();
    expect(p.header_handle).toBe('DOCHANDLE123');
  });

  it('rejects a non-pdf content type', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => pngResponse()));
    await expect(ensureDocumentHeaderHandle(payload(), 'tok')).rejects.toThrow(/must be a PDF/);
  });

  it('rejects renamed non-pdf content even with a pdf content type', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    // Server claims pdf but bytes are PNG magic.
    const bytes = new ArrayBuffer(64);
    new Uint8Array(bytes).set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: { get: () => 'application/pdf' },
            arrayBuffer: async () => bytes,
          }) as unknown as Response,
      ),
    );
    await expect(ensureDocumentHeaderHandle(payload(), 'tok')).rejects.toThrow(/content check/);
  });

  it('rejects an unreachable url', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => pdfResponse('application/pdf', 0, false, 404)));
    await expect(ensureDocumentHeaderHandle(payload(), 'tok')).rejects.toThrow(/publicly reachable/);
  });

  it('rejects a document over 100 MB', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => pdfResponse('application/pdf', 101 * 1024 * 1024)));
    await expect(ensureDocumentHeaderHandle(payload(), 'tok')).rejects.toThrow(/100 MB/);
  });
});

describe('ensureMediaHeaderHandle dispatcher', () => {
  beforeEach(() => {
    vi.mocked(uploadResumableMedia).mockClear();
    vi.stubEnv('META_APP_ID', 'app-1');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('routes document headers to the document flow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pdfResponse()));
    const p = payload();
    await ensureMediaHeaderHandle(p, 'tok');
    expect(p.header_handle).toBe('DOCHANDLE123');
  });

  it('is a no-op for video headers (legacy header_url fallback preserved)', async () => {
    const p = payload({ header_type: 'video', header_media_url: 'https://x.test/c.mp4' });
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBeUndefined();
  });

  it('is a no-op for text/none headers', async () => {
    const p = payload({ header_type: 'text', header_content: 'Hi', header_media_url: undefined });
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
  });
});
