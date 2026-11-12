import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Structural contract for 166_call_dashboard_filters.sql. There is
// no live-DB harness in this repo, so these tests pin the migration
// text: the extended exact aggregates keep their old signatures
// working (new params all DEFAULT NULL), the new per-salesperson
// aggregate joins recordings and events without duplicating either
// population, and RLS/grant posture is unchanged.
const sql = readFileSync(
  join(
    process.cwd(),
    'supabase',
    'migrations',
    '166_call_dashboard_filters.sql'
  ),
  'utf8'
);

describe('calls dashboard filter RPCs (166)', () => {
  it('extends call_kpis_summary without breaking existing callers', () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.call_kpis_summary\(/
    );
    // New filters default to NULL = no constraint.
    for (const param of [
      'p_call_type TEXT DEFAULT NULL',
      'p_contact_ids UUID[] DEFAULT NULL',
      'p_phone TEXT DEFAULT NULL',
      'p_status TEXT DEFAULT NULL',
    ]) {
      expect(sql).toContain(param);
    }
    // Phone/WhatsApp breakdowns on the same single scan.
    expect(sql).toContain(
      "'phone', COUNT(*) FILTER (WHERE call_type = 'phone')"
    );
    expect(sql).toContain("call_type IN ('whatsapp', 'whatsapp_business')");
    // Membership check + grant preserved for the new signature.
    expect(sql).toContain('is_account_member(p_account_id)');
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.call_kpis_summary\(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TEXT, UUID\[\], TEXT, TEXT\) TO authenticated/
    );
  });

  it('extends the outcomes RPC with answered/unknown without touching rejected semantics', () => {
    expect(sql).toContain(
      "'answered', COUNT(*) FILTER (WHERE outcome = 'answered')"
    );
    expect(sql).toContain(
      "'unknown', COUNT(*) FILTER (WHERE outcome = 'unknown')"
    );
    // Existing outputs stay byte-identical.
    expect(sql).toContain(
      "'missed', COUNT(*) FILTER (WHERE outcome = 'missed')"
    );
    expect(sql).toContain(
      "'rejected', COUNT(*) FILTER (WHERE outcome = 'rejected')"
    );
    // Events are phone-only: a non-phone call-type filter matches nothing.
    expect(sql).toContain("(p_call_type IS NULL OR p_call_type = 'phone')");
  });

  it('adds a per-salesperson aggregate that cannot double-count', () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.call_salesperson_stats\(/
    );
    // Separate per-side GROUP BYs joined on the user id — never a
    // row-multiplying join between recordings and events.
    expect(sql).toContain('FULL OUTER JOIN');
    expect(sql).toContain('GROUP BY r.uploaded_by');
    expect(sql).toContain('GROUP BY e.user_id');
    // Unattributed rows never appear as a salesperson.
    expect(sql).toContain('r.uploaded_by IS NOT NULL');
    expect(sql).toContain('e.user_id IS NOT NULL');
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.call_salesperson_stats\(/
    );
  });

  it('changes no authorization posture', () => {
    expect(sql).toMatch(/SECURITY INVOKER/g);
    expect(sql).not.toMatch(/CREATE POLICY/i);
    expect(sql).not.toMatch(/DROP POLICY/i);
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE/i);
    expect(sql).toMatch(/is_account_member\(p_account_id\)/g);
  });
});
