import { describe, expect, it } from 'vitest';

import {
  ASSIGNEE_EXPORT_UNKNOWN,
  fetchAssigneeDisplayNames,
  resolveExportAssigneeName,
} from './assignees';

const UUID_A = 'b33ae622-7ec6-460a-8a6e-1644cfe96399';
const UUID_B = 'c44bf733-8fd7-571b-9b7f-2755d0a074aa';

function names(entries: Array<[string, string]>) {
  return new Map<string, string>(entries);
}

describe('resolveExportAssigneeName', () => {
  it('maps empty, null and cleared values to Unassigned', () => {
    for (const stored of [null, undefined, '', '   ']) {
      expect(resolveExportAssigneeName(stored, names([]))).toEqual({
        text: 'Unassigned',
        unresolved: false,
      });
    }
  });

  it('maps the explicit Unassigned marker (even padded) to Unassigned', () => {
    expect(
      resolveExportAssigneeName('  Unassigned  ', names([[UUID_A, 'X']]))
    ).toEqual({ text: 'Unassigned', unresolved: false });
  });

  it('resolves roster user_ids to display names, trimming input', () => {
    expect(
      resolveExportAssigneeName(
        `  ${UUID_A}  `,
        names([[UUID_A, 'Anita Agent']])
      )
    ).toEqual({ text: 'Anita Agent', unresolved: false });
  });

  it('falls back to Unknown for UUID-shaped ids with no roster entry', () => {
    expect(resolveExportAssigneeName(UUID_A, names([]))).toEqual({
      text: ASSIGNEE_EXPORT_UNKNOWN,
      unresolved: true,
    });
    expect(ASSIGNEE_EXPORT_UNKNOWN).not.toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('preserves legacy non-UUID display strings like the UI does', () => {
    expect(resolveExportAssigneeName('Anita (old)', names([]))).toEqual({
      text: 'Anita (old)',
      unresolved: false,
    });
  });

  it('never returns a raw unresolved UUID as cell text', () => {
    // Lowercase known id resolves; anything else UUID-shaped that
    // misses the roster (uppercased, padded, or unknown) is Unknown.
    // Lookup is exact-match, consistent with the write-path validation.
    expect(
      resolveExportAssigneeName(UUID_A, names([[UUID_A, 'Hit']])).text
    ).toBe('Hit');
    for (const stored of [UUID_A.toUpperCase(), ` ${UUID_B} `, UUID_B]) {
      const r = resolveExportAssigneeName(stored, names([[UUID_A, 'Hit']]));
      expect(r.text).toBe('Unknown');
      expect(r.unresolved).toBe(true);
      expect(r.text).not.toMatch(/^[0-9a-f-]{36}$/i);
    }
  });
});

function stubSupabase(
  rows: Array<Record<string, unknown>>,
  opts?: { fail?: boolean; calls?: string[] }
) {
  return {
    from: (table: string) => {
      opts?.calls?.push(table);
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.in = (_col: string, vals: unknown[]) => {
        (chain as { _in?: unknown })._in = vals;
        return chain;
      };
      chain.then = (resolve: (v: unknown) => void) =>
        resolve(
          opts?.fail
            ? { data: null, error: { message: 'db down' } }
            : { data: rows, error: null }
        );
      return chain;
    },
  };
}

describe('fetchAssigneeDisplayNames', () => {
  it('returns an empty map without querying when there is nothing to resolve', async () => {
    const calls: string[] = [];
    const out = await fetchAssigneeDisplayNames(
      stubSupabase([], { calls }) as never,
      'acct-1',
      []
    );
    expect(out.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it('maps user_ids to roster display names with account scoping', async () => {
    const calls: string[] = [];
    const seen: Array<{ col: string; val: unknown }> = [];
    const supabase = {
      from: (table: string) => {
        calls.push(table);
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = (col: string, val: unknown) => {
          seen.push({ col, val });
          return chain;
        };
        chain.in = () => chain;
        chain.then = (resolve: (v: unknown) => void) =>
          resolve({
            data: [
              { user_id: UUID_A, full_name: 'Anita Agent' },
              { user_id: UUID_B, full_name: null },
            ],
            error: null,
          });
        return chain;
      },
    };
    const out = await fetchAssigneeDisplayNames(supabase as never, 'acct-1', [
      UUID_A,
      UUID_B,
      '  ',
      'Unassigned',
    ]);
    expect(calls).toEqual(['profiles']);
    expect(seen).toContainEqual({ col: 'account_id', val: 'acct-1' });
    expect(out.get(UUID_A)).toBe('Anita Agent');
    // Null full_name falls back exactly like the Members tab.
    expect(out.get(UUID_B)).toBe('Unnamed');
  });

  it('never throws: a failed roster read resolves to an empty map', async () => {
    const out = await fetchAssigneeDisplayNames(
      stubSupabase([], { fail: true }) as never,
      'acct-1',
      [UUID_A]
    );
    expect(out.size).toBe(0);
  });

  it('deduplicates ids before querying', async () => {
    let inArg: unknown[] | null = null;
    const supabase = {
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.in = (_c: string, v: unknown[]) => {
          inArg = v;
          return chain;
        };
        chain.then = (resolve: (v: unknown) => void) =>
          resolve({ data: [], error: null });
        return chain;
      },
    };
    await fetchAssigneeDisplayNames(supabase as never, 'acct-1', [
      UUID_A,
      UUID_A,
      ` ${UUID_A} `,
    ]);
    expect(inArg).toEqual([UUID_A]);
  });

  it('does not execute arbitrary logic for unexpected shapes', async () => {
    const out = await fetchAssigneeDisplayNames(
      stubSupabase([{ nope: 1 }]) as never,
      'acct-1',
      [UUID_A]
    );
    expect(out.size).toBe(0);
  });
});
