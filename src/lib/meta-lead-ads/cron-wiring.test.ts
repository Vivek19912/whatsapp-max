// Meta Lead Ads — deployment scheduler wiring.
//
// The polling endpoint is useless unless something calls it. On a
// self-hosted EC2/VPS deployment the installer script must add a
// five-minute crontab entry; on Vercel the cron manifest must list the
// same path. These tests pin both, so a future refactor cannot silently
// remove the only automatic lead-capture path.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(
  resolve("scripts/setup-automation-cron.sh"),
  "utf8",
);
const VERCEL = JSON.parse(
  readFileSync(resolve("vercel.json"), "utf8"),
) as { crons?: Array<{ path: string; schedule: string }> };

const CRON_PATH = "/api/integrations/meta-lead-ads/cron";

describe("Meta Lead Ads scheduler wiring", () => {
  it("is installed by the self-hosted cron setup script every five minutes", () => {
    expect(SCRIPT).toContain(
      'LEAD_ADS_CRON_URL="${PUBLIC_URL%/}/api/integrations/meta-lead-ads/cron"',
    );
    expect(SCRIPT).toMatch(/LEAD_ADS_CRON_LINE="\*\/5 \* \* \* \*/);
    expect(SCRIPT).toContain("wacrm-meta-lead-ads-cron");
  });

  it("is listed in vercel.json for Vercel deployments", () => {
    expect(VERCEL.crons).toEqual(
      expect.arrayContaining([
        { path: CRON_PATH, schedule: "*/5 * * * *" },
      ]),
    );
  });

  it("uses the shared cron authentication, not a new bypass", () => {
    expect(SCRIPT).toContain("AUTOMATION_CRON_SECRET");
    expect(SCRIPT).toContain('curl -fsS -m 60 -H \\"x-cron-secret: \\$S\\"');
  });
});
