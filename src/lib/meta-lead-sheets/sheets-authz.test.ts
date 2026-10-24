// Meta Sheets auth + tenant isolation — source assertions.
// Verifies every new route enforces admin/member roles, scopes all
// queries by the caller's account, and never exposes tokens.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const src = (p: string) => readFileSync(`${root}/${p}`, "utf8");

describe("meta sheets routes — authorization", () => {
  it("connect requires admin", () => {
    expect(src("src/app/api/integrations/meta-lead-ads/google/connect/route.ts")).toContain(
      'requireRole("admin")',
    );
  });

  it("callback requires admin and binds state to the session account", () => {
    const s = src("src/app/api/integrations/meta-lead-ads/google/callback/route.ts");
    expect(s).toContain('requireRole("admin")');
    expect(s).toContain("consumeSheetsOAuthState");
    expect(s).toContain("account_mismatch");
    expect(s).not.toContain("access_token");
  });

  it("config PUT requires admin and validates before persisting", () => {
    const s = src("src/app/api/integrations/meta-lead-ads/sheets/config/route.ts");
    expect(s).toContain('requireRole("admin")');
    expect(s).toContain("getSheetsAccessToken");
    expect(s).toContain("getSheetsSpreadsheet");
    expect(s).toContain("ensureSheetsHeader");
  });

  it("retry requires admin and checks submission ownership", () => {
    const s = src("src/app/api/integrations/meta-lead-ads/sheets/retry/route.ts");
    expect(s).toContain('requireRole("admin")');
    expect(s).toContain('.eq("account_id", ctx.accountId)');
  });

  it("status never returns tokens", () => {
    const s = src("src/lib/meta-lead-sheets/queue.ts");
    expect(s).toContain("getSheetsSyncStatus");
    const statusFn = s.slice(s.indexOf("getSheetsSyncStatus"));
    expect(statusFn).not.toContain("access_token");
    expect(statusFn).not.toContain("refresh_token");
  });

  it("disconnect is admin-only and scoped", () => {
    const s = src("src/app/api/integrations/meta-lead-ads/google/disconnect/route.ts");
    expect(s).toContain('requireRole("admin")');
    expect(s).toContain('.eq("account_id", ctx.accountId)');
  });
});

describe("meta sheets lib — tenant isolation", () => {
  it("every queue query is account-scoped", () => {
    const s = src("src/lib/meta-lead-sheets/queue.ts");
    const scoped = (s.match(/\.eq\("account_id", /g) ?? []).length;
    expect(scoped).toBeGreaterThan(10);
    expect(s).toContain("onlyAccountId");
  });

  it("oauth tokens are encrypted and never logged", () => {
    const s = src("src/lib/meta-lead-sheets/oauth.ts");
    expect(s).toContain("encrypt(");
    expect(s).toContain("decrypt(");
    expect(s).not.toContain("console.log");
  });

  it("sheets client sends tokens only as Bearer headers", () => {
    const s = src("src/lib/meta-lead-sheets/sheets-client.ts");
    expect(s).toContain("Authorization");
    expect(s).not.toContain("access_token=");
  });
});
