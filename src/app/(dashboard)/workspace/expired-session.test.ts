import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Expired-session regression for /workspace.
//
// Bug: an expired/invalid session made the flows fetch reject with
// `Couldn't load flows (401)` while leaving the user on the Workspace.
// The fix routes every 401 through the shared expired-session handler,
// which clears the dead client session and redirects to the existing
// sign-in page (/login) — never showing a raw 401 on the Workspace.
//
// The page is a client component (no DOM under vitest's node
// environment — same constraint as deep-link.test.ts), so wiring is
// pinned via the page source while the handler's runtime semantics
// are covered by src/lib/auth/expired-session.test.ts.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8",
);

function flowsFetchSrc(): string {
  const start = pageSrc.indexOf("const flowsUrl = isAgent");
  expect(start).toBeGreaterThan(-1);
  const end = pageSrc.indexOf("}, [accountId, isAgent]);", start);
  expect(end).toBeGreaterThan(start);
  return pageSrc.slice(start, end);
}

function tableFetchSrc(): string {
  const start = pageSrc.indexOf("fetch(`/api/flows/${flowId}/table?${qs}`");
  expect(start).toBeGreaterThan(-1);
  const end = pageSrc.indexOf("return () => ctrl.abort();", start);
  expect(end).toBeGreaterThan(start);
  return pageSrc.slice(start, end);
}

describe("expired session on Workspace → sign-in redirect (not raw 401)", () => {
  it("wires the flows fetch through the shared expired-session handler", () => {
    expect(pageSrc).toContain(
      "import { handleExpiredSessionResponse } from '@/lib/auth/expired-session';",
    );
    expect(flowsFetchSrc()).toContain("handleExpiredSessionResponse(res)");
  });

  it("suppresses the flows error UI on 401 (returns before throwing)", () => {
    const src = flowsFetchSrc();
    const guardIdx = src.indexOf("handleExpiredSessionResponse(res)");
    expect(guardIdx).toBeGreaterThan(-1);
    const throwIdx = src.indexOf("Couldn't load flows");
    expect(throwIdx).toBeGreaterThan(guardIdx);
    // Early return between the 401 guard and the generic throw —
    // the raw `Couldn't load flows (401)` never reaches setFlowsError.
    const between = src.slice(guardIdx, throwIdx);
    expect(between).toContain("return;");
  });

  it("wires the table fetch through the same 401 handler", () => {
    const src = tableFetchSrc();
    expect(src).toContain("handleExpiredSessionResponse(res)");
    const guardIdx = src.indexOf("handleExpiredSessionResponse(res)");
    const throwIdx = src.indexOf("Couldn't load table");
    expect(throwIdx).toBeGreaterThan(guardIdx);
    expect(src.slice(guardIdx, throwIdx)).toContain("return;");
  });

  it("keeps the existing sign-in route (no new login page)", () => {
    // The shared handler redirects to the pre-existing /login page —
    // the page itself must not invent a new login route.
    expect(pageSrc).not.toContain('href="/signin"');
    expect(pageSrc).not.toContain('"/signin"');
    const handlerSrc = readFileSync(
      `${root}/src/lib/auth/expired-session.ts`,
      "utf8",
    );
    expect(handlerSrc).toContain('"/login"');
  });

  it("does not redirect on 403 — forbidden keeps its existing handling", () => {
    // Neither fetch special-cases 403: it falls through to the generic
    // error path. The shared handler itself only matches 401.
    const handlerSrc = readFileSync(
      `${root}/src/lib/auth/expired-session.ts`,
      "utf8",
    );
    expect(handlerSrc).toContain("status === 401");
    // Only the 401 guard calls the handler — no 403 status branch
    // anywhere (a 403 falls through to the generic error path).
    for (const src of [flowsFetchSrc(), tableFetchSrc()]) {
      expect(src).not.toContain("status === 403");
      expect(src).not.toContain("res.status === 403");
    }
  });
});
