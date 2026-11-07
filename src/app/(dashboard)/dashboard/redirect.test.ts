import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// `/dashboard` redirects to `/meta-lead-ads/dashboard` at the route
// level (server redirect — direct entry and refresh behave the
// same). The previous dashboard implementation is preserved
// alongside, with its APIs, charts, and statistics untouched.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  join(root, "src", "app", "(dashboard)", "dashboard", "page.tsx"),
  "utf8"
);

describe("dashboard route redirect", () => {
  it("redirects server-side to the Meta Lead Ads dashboard", () => {
    expect(pageSrc).toContain("import { redirect } from 'next/navigation';");
    expect(pageSrc).toContain("redirect('/meta-lead-ads/dashboard');");
  });

  it("redirects nowhere else (no loops, no detours)", () => {
    const redirects = pageSrc.match(/redirect\(/g) ?? [];
    expect(redirects).toHaveLength(1);
    expect(pageSrc).not.toContain("router.push");
    expect(pageSrc).not.toContain("router.replace");
    expect(pageSrc).not.toContain("window.location");
  });

  it("leaves authentication to the existing middleware", () => {
    // No auth logic in the route: middleware still guards
    // `/dashboard`, so signed-out visitors reach `/login` first.
    expect(pageSrc).not.toContain("getUser");
    expect(pageSrc).not.toContain("/login");
    const middleware = readFileSync(join(root, "src", "middleware.ts"), "utf8");
    expect(middleware).toContain("'/dashboard'");
  });

  it("preserves the previous dashboard implementation alongside", () => {
    const viewPath = join(
      root,
      "src",
      "app",
      "(dashboard)",
      "dashboard",
      "dashboard-view.tsx"
    );
    expect(existsSync(viewPath)).toBe(true);
    const view = readFileSync(viewPath, "utf8");
    expect(view).toContain("export function DashboardView()");
    // UI, analytics wiring, and charts intact.
    expect(view).toContain("loadDashboardAnalytics");
    expect(view).toContain("DailyChart");
    expect(view).toContain("MonthlyChart");
    expect(view).toContain("KpiCard");
  });
});
