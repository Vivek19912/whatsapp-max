import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Multi-session safety (application-level contract tests).
//
// The business rule: N people may stay logged into the SAME account across
// different browsers/devices. A new login must never sign out existing
// sessions; a normal logout must affect only that browser; only an explicit
// "Sign out of all devices" (global scope) terminates every session.
//
// The multi-session capability itself lives in GoTrue (one session row per
// login in auth.sessions; a new sign-in does NOT revoke older sessions unless
// "single session per user" is enabled server-side). These tests pin the
// APPLICATION half of that contract: there is no code path that signs a user
// out as a side effect of another login, and the two sign-out scopes used by
// the UI are exactly the intentional ones.
// ---------------------------------------------------------------------------

const SRC = fileURLToPath(new URL("../../", import.meta.url));

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(path)));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\./.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

function relative(file: string): string {
  // Normalize Windows separators so the allowlist below matches on
  // every platform (POSIX paths are unchanged by this replace).
  return "/" + file.replace(SRC, "").replace(/\\/g, "/");
}

describe("multi-session safety — a new login must never sign out existing sessions", () => {
  // These tests walk the whole src tree from disk (thousands of
  // files); under a loaded CI runner that I/O can exceed vitest's
  // default 5s per-test timeout, so the budget is raised explicitly.
  // No behavior under test changes with the extra time.
  it("the ONLY signOut() call sites are the explicit, user-initiated ones plus expired-session cleanup", { timeout: 60000 }, async () => {
    const files = await listTsFiles(SRC);
    const found: Array<{ file: string; line: string }> = [];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      const lines = content.split("\n");
      lines.forEach((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//")) return;
        // A real call to supabase.auth.signOut(...) — not a comment or a
        // doc mention.
        if (/(\.signOut\s*\(|signOut\s*\(\s*\{?\s*scope)/.test(line)) {
          found.push({ file: relative(file), line: trimmed });
        }
      });
    }

    // The only legitimate sign-out triggers in the whole app:
    //  - the dashboard header's normal logout (current session only),
    //  - the explicit "Sign out of all devices" card (global scope),
    //  - the join-flow conflict modal's "sign out & use a different email",
    //  - the shared expired-session handler, which clears a session the
    //    server already rejected with 401 (local scope — it never
    //    touches other devices/sessions).
    const allowed = new Set([
      "/hooks/use-auth.tsx",
      "/components/settings/sessions-card.tsx",
      "/app/join/[token]/page.tsx",
      "/lib/auth/expired-session.ts",
    ]);
    const disallowed = found.filter((site) => !allowed.has(site.file));
    expect(disallowed).toEqual([]);
  });

  it("no module pairs a login (signInWithPassword) with a signOut — a second login never terminates sessions", { timeout: 60000 }, async () => {
    const files = await listTsFiles(SRC);
    const offenders: string[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      // signInWithPassword creates a NEW session; signOut terminates one.
      // Any module that does both in one flow could log the previous
      // session out on login — that would violate the requirement.
      if (/signInWithPassword/.test(content) && /signOut\s*\(/.test(content)) {
        offenders.push(relative(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the normal logout uses the local scope; only the sessions card uses global scope", { timeout: 60000 }, async () => {
    const useAuth = await readFile(join(SRC, "hooks/use-auth.tsx"), "utf8");
    const sessionsCard = await readFile(
      join(SRC, "components/settings/sessions-card.tsx"),
      "utf8",
    );

    // Normal logout: no scope → GoTrue revokes only THIS session.
    expect(/auth\.signOut\(\)/.test(useAuth)).toBe(true);
    expect(/signOut\(\s*\{\s*scope\s*:\s*['"]global['"]/.test(useAuth)).toBe(false);

    // Global logout: explicit scope: 'global' → revokes every session
    // for the user. This is the ONLY place that may do it.
    expect(/signOut\(\s*\{\s*scope\s*:\s*['"]global['"]/.test(sessionsCard)).toBe(
      true,
    );
    const files = await listTsFiles(SRC);
    const globalSites: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (/signOut\(\s*\{\s*scope\s*:\s*['"]global['"]/.test(content)) {
        globalSites.push(relative(file));
      }
    }
    expect(globalSites).toEqual(["/components/settings/sessions-card.tsx"]);
  });
});