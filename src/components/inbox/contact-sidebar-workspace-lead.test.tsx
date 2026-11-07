import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Wiring contract for the Inbox contact-panel Workspace Lead
// section. The sidebar needs browser + Supabase APIs to render,
// so (like the Flow-label tests) this pins the integration points
// as source assertions. Resolution behaviour is unit-tested in
// src/app/api/inbox/workspace-lead/route.test.ts; navigation and
// highlight reuse the tested ?contact= deep link.
const sidebarSrc = readFileSync(
  join(process.cwd(), "src", "components", "inbox", "contact-sidebar.tsx"),
  "utf8"
);

describe("contact sidebar Workspace Lead section", () => {
  it("resolves the verified lead server-side per selected contact", () => {
    expect(sidebarSrc).toContain("/api/inbox/workspace-lead?contact_id=");
    expect(sidebarSrc).toContain("encodeURIComponent(contact.id)");
  });

  it("shows the section only for verified Meta conversations", () => {
    // Gated on the server-reported meta flag after resolution —
    // CTWA/organic/unknown threads (meta:false) render nothing,
    // and nothing renders while resolving.
    expect(sidebarSrc).toContain("workspaceLeadResolved && hasMetaSubmission");
    expect(sidebarSrc).toContain("setHasMetaSubmission(body.meta === true)");
  });

  it("renders the new-tab link from the verified stable id", () => {
    expect(sidebarSrc).toContain("workspaceContactHref(workspaceLead.contact_id, {");
    expect(sidebarSrc).toContain("highlightOnly: true,");
    expect(sidebarSrc).toContain('target="_blank"');
    expect(sidebarSrc).toContain("Open in Workspace");
    expect(sidebarSrc).toContain("<ExternalLink");
  });

  it("renders no heading, names, table text, or not-linked copy", () => {
    // Button-only section: heading, icon-adjacent label, lead and
    // table metadata, and the unlinked notice are all gone. (The
    // flow-name state and resolution logic stay — only this
    // section's display shrank.)
    expect(sidebarSrc).not.toContain("Workspace Lead");
    expect(sidebarSrc).not.toContain("workspaceLead.contact_name");
    expect(sidebarSrc).not.toContain("workspaceLead.flow_name");
    expect(sidebarSrc).not.toContain("Workspace lead not linked");
  });

  it("creates no badge, label, or text marking the Inbox origin", () => {
    expect(sidebarSrc).not.toMatch(/from inbox/i);
    expect(sidebarSrc).not.toMatch(/from call recording(?!s)/i);
  });

  it("leaves the Instant Form section exactly as before", () => {
    expect(sidebarSrc).toContain('{isInstantForm ? "Instant Form" : "Flow"}');
    expect(sidebarSrc).toContain("{flowName}");
  });

  it("resets lead state on contact change (no cross-contact flash)", () => {
    expect(sidebarSrc).toContain("setWorkspaceLead(null)");
  });
});
