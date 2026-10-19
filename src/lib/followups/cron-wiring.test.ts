import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ============================================================
// EC2 cron wiring guard: the production scheduler trigger for
// WhatsApp Reminders is the EXISTING endpoint
// GET /api/followups/cron, invoked every minute by the EXISTING
// system cron installed via scripts/setup-automation-cron.sh.
//
// These tests pin that contract: the script must call the existing
// endpoint, at the existing per-minute cadence, with the existing
// shared-secret authentication — and must not invent a second
// scheduler (no loops, no timers, no new endpoints).
// ============================================================

const SCRIPT = readFileSync(
  resolve("scripts/setup-automation-cron.sh"),
  "utf8",
);
const CRON_ROUTE = readFileSync(
  resolve("src/app/api/followups/cron/route.ts"),
  "utf8",
);

describe("EC2 reminder scheduler trigger", () => {
  it("invokes the existing /api/followups/cron endpoint", () => {
    expect(SCRIPT).toContain('FOLLOWUPS_CRON_URL="${PUBLIC_URL%/}/api/followups/cron"');
    // Inside the double-quoted CRON_LINE the variable is bash-escaped.
    expect(SCRIPT).toContain(' \\"$FOLLOWUPS_CRON_URL\\" '.trim());
  });

  it("runs at the existing every-minute frequency", () => {
    expect(SCRIPT).toMatch(/CRON_LINE="\* \* \* \* \* /);
  });

  it("reuses the existing shared-secret authentication", () => {
    // Same secret source and same header for every endpoint —
    // reminders get no weaker (or different) auth. (Both the quotes
    // and the `$S` are bash-escaped inside the double-quoted CRON_LINE
    // so the secret resolves at cron runtime, not at install time.)
    expect(SCRIPT).toContain("AUTOMATION_CRON_SECRET");
    const headerUses = SCRIPT.match(/-H \\"x-cron-secret: \\\$S\\"/g) ?? [];
    expect(headerUses.length).toBeGreaterThanOrEqual(5);
    expect(SCRIPT).not.toContain("x-cron-secret: \"\"");
  });

  it("still routes through the existing scheduler endpoint", () => {
    // The endpoint drains via the single existing implementation.
    expect(CRON_ROUTE).toContain("drainDueFollowups");
    expect(CRON_ROUTE).toContain("@/lib/followups/scheduler");
  });

  it("introduces no second scheduler implementation", () => {
    expect(SCRIPT).not.toMatch(/setInterval|setTimeout/);
    expect(SCRIPT).not.toMatch(/while\s+true|for\s+\(\(\s*;\s*;\s*\)\)/);
    // Only the known application cron endpoints are pinged.
    const endpoints = SCRIPT.match(/\/api\/[a-z0-9/-]+\/cron/g) ?? [];
    expect([...new Set(endpoints)].sort()).toEqual([
      "/api/all-sheets/cron",
      "/api/automations/cron",
      "/api/flows/cron",
      "/api/followups/cron",
      "/api/integrations/meta-lead-ads/cron",
    ]);
  });

  it("schedules Meta Lead Ads polling on its own five-minute line", () => {
    expect(SCRIPT).toContain(
      'LEAD_ADS_CRON_URL="${PUBLIC_URL%/}/api/integrations/meta-lead-ads/cron"',
    );
    expect(SCRIPT).toMatch(/LEAD_ADS_CRON_LINE="\*\/5 \* \* \* \*/);
    expect(SCRIPT).toContain("wacrm-meta-lead-ads-cron");
    // It must be a separate crontab entry, not chained after the
    // per-minute drains.
    expect(SCRIPT).not.toMatch(/ALL_SHEETS_CRON_URL.*LEAD_ADS_CRON_URL/);
  });
});
