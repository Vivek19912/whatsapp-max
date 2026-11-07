import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Signed-in landing redirect (`/` → /meta-lead-ads/dashboard).
//
// Authenticated visitors land on the Meta Lead Ads dashboard;
// everyone else keeps the marketing homepage. Interaction
// (session probe → replace) runs client-side in an effect, so
// SSR covers the null render and source pins the contract.
// ---------------------------------------------------------------------------

const root = process.cwd();
const src = readFileSync(`${root}/src/app/landing-redirect.tsx`, "utf8");
const pageSrc = readFileSync(`${root}/src/app/page.tsx`, "utf8");

describe("SignedInRedirect render", () => {
  it("renders nothing (redirect happens in an effect)", () => {
    // useRouter requires the app router, so SSR can't mount it —
    // pin the null render via source instead.
    expect(src).toContain("return null;");
  });

  it("is mounted on the homepage", () => {
    expect(pageSrc).toContain("<SignedInRedirect />");
  });
});

describe("redirect contract", () => {
  it("probes the session directly (no AuthProvider on `/`)", () => {
    expect(src).toContain("createClient().auth.getUser()");
  });

  it("replaces to the Meta Lead Ads dashboard only when signed in", () => {
    expect(src).toContain("router.replace('/meta-lead-ads/dashboard')");
    expect(src).toContain("data.user");
  });

  it("never touches login, signup, or the old dashboard routes", () => {
    expect(src).not.toContain("router.push");
    expect(src).not.toContain("'/login'");
    expect(src).not.toContain("'/signup'");
    expect(src).not.toContain("'/dashboard'");
  });

  it("drops the probe result on unmount (no setState-after-unmount)", () => {
    expect(src).toContain("cancelled");
  });
});
