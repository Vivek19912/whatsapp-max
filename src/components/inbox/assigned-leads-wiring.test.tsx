import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { LeadDetailPanel } from "./lead-detail-panel";
import { fetchAssignedLeads } from "./assigned-leads";
import type { AssignedLead } from "./assigned-leads";

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8");

const lead: AssignedLead = {
  run_id: "run-1",
  flow_id: "flow-1",
  flow_name: "Meta Form A",
  form_name: "Form A",
  contact_id: "ct-1",
  name: "Gajanand Kumar",
  phone: "+911234567890",
  email: null,
  owner_id: "owner-1",
  owner_name: "Gajanand Kumar",
  submitted_at: "2026-11-10T10:00:00Z",
  status: "completed",
};

describe("Assigned Leads inbox wiring", () => {
  it("renders the section below the conversation list with lead selection", () => {
    const page = src("src/app/(dashboard)/inbox/page.tsx");
    expect(page).toContain("AssignedLeadsSection");
    expect(page).toContain("LeadDetailPanel");
    expect(page).toContain("onSelectLead={handleSelectLead}");
    expect(page).toContain("threadContactIds");
    expect(page).toContain("threadForActiveLead");
    // Lead and conversation selections are mutually exclusive.
    expect(page).toContain("setActiveLead(null)");
    expect(page).toContain("setActiveConversation(null)");
  });

  it("shares the list search query with the lead section", () => {
    const page = src("src/app/(dashboard)/inbox/page.tsx");
    expect(page).toContain("onSearchQueryChange={setLeadSearchQuery}");
    const list = src("src/components/inbox/conversation-list.tsx");
    expect(list).toContain("onSearchQueryChange");
  });

  it("never mixes lead-only entries into conversation rows", () => {
    const section = src("src/components/inbox/assigned-leads-section.tsx");
    expect(section).toContain('aria-label="Assigned leads"');
    expect(section).toContain("No WhatsApp conversation yet");
    expect(section).not.toContain("last_message");
    expect(section).not.toContain("unread_count");
  });
});

describe("LeadDetailPanel (rendered output)", () => {
  it("shows real lead data with no fabricated chat content", () => {
    const html = renderToStaticMarkup(
      <LeadDetailPanel
        lead={lead}
        threadConversation={null}
        onOpenConversation={() => {}}
        onBack={() => {}}
      />
    );
    expect(html).toContain("Gajanand Kumar");
    expect(html).toContain("+911234567890");
    expect(html).toContain("New lead · No WhatsApp conversation yet");
    expect(html).toContain("Open in Workspace");
    expect(html).not.toContain("last_message");
    expect(html).not.toContain("unread");
    expect(html).not.toContain("No messages yet");
  });

  it("offers the conversation jump once a thread exists", () => {
    const html = renderToStaticMarkup(
      <LeadDetailPanel
        lead={lead}
        threadConversation={{ id: "conv-1", last_message_text: "Hello" } as never}
        onOpenConversation={() => {}}
        onBack={() => {}}
      />
    );
    expect(html).toContain("Open conversation");
    expect(html).toContain("Hello");
  });

  it("handles leads without a phone number honestly", () => {
    const html = renderToStaticMarkup(
      <LeadDetailPanel
        lead={{ ...lead, phone: null, contact_id: null }}
        threadConversation={null}
        onOpenConversation={() => {}}
        onBack={() => {}}
      />
    );
    expect(html).toContain("No usable phone number");
    expect(html).not.toContain("Open in Workspace");
  });
});

describe("fetchAssignedLeads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the server list and passes the query through", async () => {
    const rows = [lead];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ leads: rows }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchAssignedLeads("gaja");
    expect(out).toEqual(rows);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/inbox/assigned-leads?q=gaja",
      expect.anything()
    );
  });

  it("throws a readable error when the endpoint fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: "Denied." }),
      }))
    );
    await expect(fetchAssignedLeads()).rejects.toThrow("Denied.");
  });
});
