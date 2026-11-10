// Template document upload API — validation, account isolation,
// storage failure handling. No production I/O.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  authed: true,
  accountId: 'acct-1' as string | null,
  uploadError: null as { message: string } | null,
  uploadArgs: null as { bucket: string; path: string; contentType?: string } | null,
  removeArgs: null as { bucket: string; paths: string[] } | null,
  removeError: null as { message: string } | null,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock('@/lib/auth/account', () => ({
  requireAuthenticatedUser: async () => {
    if (!h.authed) return { ok: false, body: { error: 'Unauthorized' }, status: 401 };
    return { ok: true, supabase: fakeSupabase(), userId: 'user-1' };
  },
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && 'status' in err
        ? Number((err as { status?: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status },
    );
  },
}));

function fakeSupabase() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === 'profiles'
              ? {
                  data: h.accountId ? { account_id: h.accountId } : null,
                  error: null,
                }
              : { data: null, error: null },
        }),
      }),
    }),
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, bytes: Uint8Array, opts?: { contentType?: string }) => {
          h.uploadArgs = { bucket, path, contentType: opts?.contentType };
          if (h.uploadError) return { error: h.uploadError };
          return { error: null };
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://cdn.test/${path}` },
        }),
        remove: async (paths: string[]) => {
          h.removeArgs = { bucket, paths };
          if (h.removeError) return { error: h.removeError };
          return { error: null };
        },
      }),
    },
  };
}

const route = await import('./route');

function pdfFile(name = 'terms.pdf', size = 2048, type = 'application/pdf'): File {
  const bytes = new Uint8Array(size);
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  return new File([bytes], name, { type });
}

function postWithFile(file: File | null): Request {
  const form = new FormData();
  if (file) form.append('file', file);
  return new Request('https://x/upload', { method: 'POST', body: form });
}

beforeEach(() => {
  h.authed = true;
  h.accountId = 'acct-1';
  h.uploadError = null;
  h.uploadArgs = null;
  h.removeArgs = null;
  h.removeError = null;
});

describe('POST template document upload', () => {
  it('rejects unauthenticated callers', async () => {
    h.authed = false;
    const res = await route.POST(postWithFile(pdfFile()));
    expect(res.status).toBe(401);
  });

  it('rejects profiles without an account', async () => {
    h.accountId = null;
    const res = await route.POST(postWithFile(pdfFile()));
    expect(res.status).toBe(403);
  });

  it('requires a file', async () => {
    const res = await route.POST(postWithFile(null));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('Attach a PDF');
  });

  it('rejects non-pdf extensions', async () => {
    const res = await route.POST(postWithFile(pdfFile('photo.png', 1024, 'image/png')));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('.pdf');
    expect(h.uploadArgs).toBeNull();
  });

  it('rejects mismatched mime types', async () => {
    const res = await route.POST(postWithFile(pdfFile('terms.pdf', 1024, 'image/png')));
    expect(res.status).toBe(400);
    expect(h.uploadArgs).toBeNull();
  });

  it('rejects oversized files', async () => {
    const res = await route.POST(
      postWithFile(pdfFile('terms.pdf', 101 * 1024 * 1024)),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('100 MB');
    expect(h.uploadArgs).toBeNull();
  });

  it('rejects renamed non-pdf content via the magic-byte check', async () => {
    const bytes = new Uint8Array(64);
    bytes.set([0x89, 0x50, 0x4e, 0x47]); // PNG magic in a .pdf
    const file = new File([bytes], 'fake.pdf', { type: 'application/pdf' });
    const res = await route.POST(postWithFile(file));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('not a valid PDF');
    expect(h.uploadArgs).toBeNull();
  });

  it('stores valid pdfs account-scoped with the pdf content type', async () => {
    const res = await route.POST(postWithFile(pdfFile('My Terms.pdf', 4096)));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { publicUrl: string; path: string };
    expect(json.publicUrl).toContain('https://cdn.test/');
    expect(json.path.startsWith('account-acct-1/')).toBe(true);
    expect(json.path.endsWith('.pdf')).toBe(true);
    expect(h.uploadArgs?.bucket).toBe('template-media');
    expect(h.uploadArgs?.contentType).toBe('application/pdf');
  });

  it('surfaces storage failures without leaking internals', async () => {
    h.uploadError = { message: 'boom' };
    const res = await route.POST(postWithFile(pdfFile()));
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('Upload failed');
  });
});

describe('DELETE staged template document', () => {
  const del = (body: unknown) =>
    new Request('https://x/upload', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('rejects unauthenticated callers', async () => {
    h.authed = false;
    const res = await route.DELETE(del({ path: 'account-acct-1/x.pdf' }));
    expect(res.status).toBe(401);
  });

  it('requires a path', async () => {
    const res = await route.DELETE(del({}));
    expect(res.status).toBe(400);
  });

  it('blocks cross-account deletes', async () => {
    const res = await route.DELETE(del({ path: 'account-acct-2/evil.pdf' }));
    expect(res.status).toBe(403);
    expect(h.removeArgs).toBeNull();
  });

  it('removes own-account files', async () => {
    const res = await route.DELETE(del({ path: 'account-acct-1/old.pdf' }));
    expect(res.status).toBe(200);
    expect(h.removeArgs).toEqual({ bucket: 'template-media', paths: ['account-acct-1/old.pdf'] });
  });

  it('surfaces storage remove failures', async () => {
    h.removeError = { message: 'gone' };
    const res = await route.DELETE(del({ path: 'account-acct-1/old.pdf' }));
    expect(res.status).toBe(502);
  });
});
