import { describe, expect, it } from "vitest";
import {
  buildFlowTableColumns,
  classifyFlowRun,
  completedAtFor,
  findFlowNameAnswerKey,
  findWorkspaceRowForContact,
  flowColumnRenderKey,
  flowDisplayName,
  resolveAttachmentUrl,
  toFlowTableRow,
  workspaceContactHref,
  type FlowTableRpcRow,
  type FlowTableRow,
} from "./flow-tables";
import type { FlowNodeLite } from "./sheet-columns";

function nodesFor(keys: Array<{ key: string; header?: string }>): FlowNodeLite[] {
  return [
    { node_key: "start", node_type: "start", config: { next_node_key: keys[0]?.key ?? "" } },
    ...keys.map((k, i) => ({
      node_key: `q${i}`,
      node_type: "collect_input",
      config: {
        prompt_text: `What is your ${k.key}?`,
        var_key: k.key,
        ...(k.header ? { sheet_column_name: k.header } : {}),
        next_node_key: keys[i + 1] ? `q${i + 1}` : "end",
      },
    })),
    { node_key: "end", node_type: "end", config: {} },
  ];
}

function rpcRow(over: Partial<FlowTableRpcRow> = {}): FlowTableRpcRow {
  return {
    run_id: "run-1",
    contact_id: "c-1",
    contact_name: "Rahul",
    contact_phone: "+919999999999",
    conversation_id: "conv-1",
    status: "active",
    started_at: "2026-09-18T10:00:00.000Z",
    last_advanced_at: "2026-09-18T10:05:00.000Z",
    ended_at: null,
    reached_at: null,
    is_completed: false,
    vars: {},
    ...over,
  };
}

describe("classifyFlowRun", () => {
  it("9. reaching the custom completion node → Completed", () => {
    expect(
      classifyFlowRun({
        status: "active",
        reachedAt: "2026-09-18T10:05:00.000Z",
        completionNodeId: "hotel",
      }),
    ).toBe("completed");
  });

  it("10. not reaching the custom completion node → Incomplete", () => {
    expect(
      classifyFlowRun({
        status: "active",
        reachedAt: null,
        completionNodeId: "hotel",
      }),
    ).toBe("incomplete");
    // Even a completed runtime status does not matter once a custom
    // point exists — reach is the only source of truth.
    expect(
      classifyFlowRun({
        status: "completed",
        reachedAt: null,
        completionNodeId: "hotel",
      }),
    ).toBe("incomplete");
  });

  it("11. no custom point → END behavior (runtime completed)", () => {
    expect(
      classifyFlowRun({ status: "completed", reachedAt: null, completionNodeId: null }),
    ).toBe("completed");
    expect(
      classifyFlowRun({ status: "active", reachedAt: null, completionNodeId: null }),
    ).toBe("incomplete");
    expect(
      classifyFlowRun({ status: "timed_out", reachedAt: null, completionNodeId: null }),
    ).toBe("incomplete");
  });

  it("records reach time as completed_at, ended_at as fallback", () => {
    expect(
      completedAtFor({
        status: "completed",
        reachedAt: "2026-09-18T10:05:00.000Z",
        endedAt: "2026-09-18T11:00:00.000Z",
      }),
    ).toBe("2026-09-18T10:05:00.000Z");
    expect(
      completedAtFor({ status: "completed", reachedAt: null, endedAt: "2026-09-18T11:00:00.000Z" }),
    ).toBe("2026-09-18T11:00:00.000Z");
    expect(
      completedAtFor({ status: "incomplete", reachedAt: null, endedAt: null }),
    ).toBeNull();
  });
});

describe("flow table rows", () => {
  it("4. one row represents one flow_run_id", () => {
    const row = toFlowTableRow(rpcRow({ run_id: "run-A" }), null, null, []);
    expect(row.runId).toBe("run-A");
  });

  it("5. the same contact keeps multiple legitimate runs as separate rows", () => {
    const a = toFlowTableRow(
      rpcRow({ run_id: "run-A", contact_phone: "+91111", vars: { Name: "A" } }),
      null,
      "Name",
      ["Name"],
    );
    const b = toFlowTableRow(
      rpcRow({ run_id: "run-B", contact_phone: "+91111", vars: { Name: "A" } }),
      null,
      "Name",
      ["Name"],
    );
    expect(a.runId).not.toBe(b.runId);
    expect(a.phone).toBe(b.phone);
  });

  it("13/14. completion reclassifies the same row — never a duplicate", () => {
    const before = toFlowTableRow(
      rpcRow({ run_id: "run-A", status: "active" }),
      "hotel",
      null,
      [],
    );
    const after = toFlowTableRow(
      rpcRow({
        run_id: "run-A",
        status: "active",
        reached_at: "2026-09-18T10:05:00.000Z",
        is_completed: true,
      }),
      "hotel",
      null,
      [],
    );
    expect(before.status).toBe("incomplete");
    expect(after.status).toBe("completed");
    expect(after.runId).toBe(before.runId);
  });

  it("projects answers onto the flow columns, missing → null", () => {
    const row = toFlowTableRow(
      rpcRow({ vars: { TravelDate: "October" } }),
      null,
      "Name",
      ["Name", "TravelDate"],
    );
    expect(row.answers).toEqual({ Name: null, TravelDate: "October" });
    // The system slot carries the canonical contact name.
    expect(row.name).toBe("Rahul");
  });

  it("keeps the system name as the canonical contact name (never merged)", () => {
    const row = toFlowTableRow(
      rpcRow({ contact_name: "WA User", vars: { Name: "Akash" } }),
      null,
      "Name",
      ["Name"],
    );
    // No inference, no merging: the flow answer stays in `answers`
    // under its own question key; the system slot stays the contact.
    expect(row.name).toBe("WA User");
    expect(row.answers).toEqual({ Name: "Akash" });
  });

  it("uses the supplied identity fallback only when the contact is missing", () => {
    const noContact = toFlowTableRow(
      rpcRow({
        contact_id: null,
        contact_name: null,
        contact_phone: null,
        vars: {
          full_name: "<test lead: dummy data for full_name>",
          phone_number: "<test lead: dummy data for phone_number>",
        },
      }),
      null,
      null,
      ["full_name", "phone_number"],
      {
        name: "<test lead: dummy data for full_name>",
        phone: "<test lead: dummy data for phone_number>",
      },
    );
    expect(noContact.name).toBe("<test lead: dummy data for full_name>");
    expect(noContact.phone).toBe("<test lead: dummy data for phone_number>");
    // The same values stay available as normal answer columns.
    expect(noContact.answers.full_name).toBe(
      "<test lead: dummy data for full_name>",
    );

    // Contact data always wins over the fallback.
    const withContact = toFlowTableRow(
      rpcRow({
        contact_name: "Rahul",
        contact_phone: "+919999999999",
        vars: { full_name: "Rahul Kumar", phone_number: "+91111" },
      }),
      null,
      null,
      ["full_name", "phone_number"],
      { name: "Rahul Kumar", phone: "+91111" },
    );
    expect(withContact.name).toBe("Rahul");
    expect(withContact.phone).toBe("+919999999999");

    // Absent fallback keeps the contact-only behavior (blank when no contact).
    const blank = toFlowTableRow(
      rpcRow({ contact_id: null, contact_name: null, contact_phone: null }),
      null,
      null,
      [],
    );
    expect(blank.name).toBeNull();
    expect(blank.phone).toBeNull();
  });
});

describe("flow table columns", () => {
  it("6. dynamic columns come from the selected flow", () => {
    const { columns, nameKey, answerKeys } = buildFlowTableColumns(
      nodesFor([{ key: "Name" }, { key: "TravelDate" }]),
      "start",
    );
    expect(columns.map((c) => c.key)).toEqual([
      "submission_time",
      "name",
      "phone",
      "Name",
      "TravelDate",
      "latest_recording",
      "status",
    ]);
    expect(nameKey).toBe("Name");
    expect(answerKeys).toEqual(["Name", "TravelDate"]);
    // System columns are flagged so answers can never overwrite them.
    expect(columns.filter((c) => c.system).map((c) => c.key)).toEqual([
      "submission_time",
      "name",
      "phone",
      "latest_recording",
      "status",
    ]);
  });

  it("2. different flows load different table structures", () => {
    const a = buildFlowTableColumns(
      nodesFor([{ key: "Name" }, { key: "TravelDate" }, { key: "Hotel" }]),
      "start",
    );
    const b = buildFlowTableColumns(
      nodesFor([{ key: "Name" }, { key: "Destination" }, { key: "Budget" }]),
      "start",
    );
    expect(a.answerKeys).toEqual(["Name", "TravelDate", "Hotel"]);
    expect(b.answerKeys).toEqual(["Name", "Destination", "Budget"]);
  });

  it("uses the stable variable key, not prompt text, as the identity", () => {
    const { answerKeys } = buildFlowTableColumns(
      nodesFor([{ key: "TravelDate", header: "Travel Date" }]),
      "start",
    );
    expect(answerKeys).toEqual(["TravelDate"]);
  });
});

describe("workspace column order invariant", () => {
  it("submission Time is always index 0, then Name, Phone, answers, Status last", () => {    for (const keys of [[], [{ key: "A" }], [{ key: "A" }, { key: "B" }, { key: "C" }]]) {
      const { columns } = buildFlowTableColumns(nodesFor(keys), "start");
      const order = columns.map((c) => c.key);
      expect(order[0]).toBe("submission_time");
      expect(order[1]).toBe("name");
      expect(order[2]).toBe("phone");
      expect(order[order.length - 1]).toBe("status");
    }
  });

  it("system/answer boundary holds regardless of flow fields", () => {
    const { columns } = buildFlowTableColumns(
      nodesFor([{ key: "Hotel" }, { key: "Travel month" }]),
      "start",
    );
    const answerIdx = columns.findIndex((c) => !c.system);
    const statusIdx = columns.findIndex((c) => c.key === "status");
    expect(answerIdx).toBeGreaterThan(2);
    expect(statusIdx).toBe(columns.length - 1);
  });

  it("Latest Recording is a system column at the end of the flow columns", () => {
    for (const keys of [[], [{ key: "A" }]]) {
      const { columns } = buildFlowTableColumns(nodesFor(keys), "start");
      const order = columns.map((c) => c.key);
      // After every flow-derived header, immediately before Status.
      expect(order[order.length - 2]).toBe("latest_recording");
      expect(order[order.length - 1]).toBe("status");
      if (keys.length > 0) expect(order).toContain("A");
      const col = columns.find((c) => c.key === "latest_recording");
      expect(col?.system).toBe(true);
      expect(col?.label).toBe("Latest Recording");
    }
  });
});

describe("WhatsApp Name vs flow Name distinction (display-only)", () => {
  // A flow-derived "Name" column arises from a question whose header
  // resolves to exactly "Name" (custom sheet_column_name here keeps
  // the fixture deterministic regardless of prompt wording).
  const nameQuestion = [{ key: "full_name", header: "Name" }];

  it("1. flow without a Name question keeps the system column as Name", () => {
    const { columns } = buildFlowTableColumns(
      nodesFor([{ key: "TravelDate" }]),
      "start",
    );
    const systemName = columns.find((c) => c.system && c.key === "name");
    expect(systemName?.label).toBe("Name");
  });

  it("2. flow with a Name question shows WhatsApp Name + Name, never Name twice", () => {
    const { columns } = buildFlowTableColumns(nodesFor(nameQuestion), "start");
    const labels = columns.map((c) => c.label);
    const systemName = columns.find((c) => c.system && c.key === "name");
    const flowName = columns.find((c) => !c.system && c.key === "full_name");
    expect(systemName?.label).toBe("WhatsApp Name");
    expect(flowName?.label).toBe("Name");
    expect(labels.filter((l) => l === "Name")).toHaveLength(1);
  });

  it("2b. matches case-insensitively (stored header casing never leaks a duplicate)", () => {
    const { columns } = buildFlowTableColumns(
      nodesFor([{ key: "full_name", header: "name" }]),
      "start",
    );
    expect(columns.find((c) => c.system && c.key === "name")?.label).toBe(
      "WhatsApp Name",
    );
  });

  it("2c. a Name-like prompt with a different header does not rename", () => {
    const { columns } = buildFlowTableColumns(
      nodesFor([{ key: "Name" }, { key: "TravelDate" }]),
      "start",
    );
    // var_key "Name" with prompt-derived header ("What is your
    // Name?") is not a "Name"-labelled column — no duplicate.
    expect(columns.find((c) => c.system && c.key === "name")?.label).toBe("Name");
  });

  it("3+4+5. WhatsApp Name holds the contact name, flow Name the answer, separately", () => {
    const { nameKey, answerKeys } = buildFlowTableColumns(
      nodesFor(nameQuestion),
      "start",
    );
    const row = toFlowTableRow(
      rpcRow({
        contact_name: "Rahul Sharma",
        vars: { full_name: "Rahul Kumar" },
      }),
      null,
      nameKey,
      answerKeys,
    );
    expect(row.name).toBe("Rahul Sharma");
    expect(row.answers).toMatchObject({ full_name: "Rahul Kumar" });
    expect(row.name).not.toBe(row.answers.full_name);
  });

  it("spec example: Nikita Joshi (flow) vs nikitajoshi464 (WhatsApp) vs phone", () => {
    const { nameKey, answerKeys } = buildFlowTableColumns(
      nodesFor(nameQuestion),
      "start",
    );
    const row = toFlowTableRow(
      rpcRow({
        contact_name: "nikitajoshi464",
        contact_phone: "918917378479",
        vars: { full_name: "Nikita Joshi" },
      }),
      null,
      nameKey,
      answerKeys,
    );
    expect(row.name).toBe("nikitajoshi464");
    expect(row.phone).toBe("918917378479");
    expect(row.answers).toMatchObject({ full_name: "Nikita Joshi" });
  });

  it("6+7. derivation identities are unchanged (Sheets + Travel CRM safe)", () => {
    const { columns, nameKey, answerKeys } = buildFlowTableColumns(
      nodesFor(nameQuestion),
      "start",
    );
    // Keys, flags, and derivation outputs are exactly as before —
    // only the system display label and the flow column position changed.
    expect(nameKey).toBe("full_name");
    expect(answerKeys).toEqual(["full_name"]);
    expect(columns.map((c) => c.key)).toEqual([
      "submission_time",
      "full_name",
      "name",
      "phone",
      "latest_recording",
      "status",
    ]);
    expect(columns.filter((c) => c.system).map((c) => c.key)).toEqual([
      "submission_time",
      "name",
      "phone",
      "latest_recording",
      "status",
    ]);
  });

  it("8. nothing is removed or merged: every column survives the rename", () => {
    const plain = buildFlowTableColumns(nodesFor(nameQuestion), "start");
    expect(plain.columns).toHaveLength(6);
    // The flow question keeps its own identity and stays visible.
    expect(
      plain.columns.find((c) => !c.system && c.key === "full_name"),
    ).toMatchObject({ label: "Name", system: false });
  });

  it("9. render keys and visibility identities are stable", () => {
    const { columns } = buildFlowTableColumns(nodesFor(nameQuestion), "start");
    const renderKeys = columns.map(flowColumnRenderKey);
    expect(new Set(renderKeys).size).toBe(columns.length);
    expect(renderKeys).toContain("sys:name");
    expect(renderKeys).toContain("flow:full_name");
  });

  it("10. column order is unchanged with the rename in place", () => {
    const { columns } = buildFlowTableColumns(nodesFor(nameQuestion), "start");
    const order = columns.map((c) => c.key);
    expect(order[0]).toBe("submission_time");
    expect(order[1]).toBe("full_name");
    expect(order[2]).toBe("name");
    expect(order[3]).toBe("phone");
    expect(order[order.length - 1]).toBe("status");
    expect(columns.map((c) => c.label)).toEqual([
      "Submission Time",
      "Name",
      "WhatsApp Name",
      "Phone Number",
      "Latest Recording",
      "Status",
    ]);
  });

  it("2. without a flow Name field the system order and labels are untouched", () => {
    const { columns, nameKey } = buildFlowTableColumns(
      nodesFor([{ key: "TravelDate" }, { key: "Hotel" }]),
      "start",
    );
    expect(nameKey).toBeNull();
    expect(columns.map((c) => c.label)).toEqual([
      "Submission Time",
      "Name",
      "Phone Number",
      "What is your TravelDate?",
      "What is your Hotel?",
      "Latest Recording",
      "Status",
    ]);
  });
});

describe("flow Name column position (immediately after Phone Number)", () => {
  // A "Name"-labelled question arriving via the general flow order
  // (prompt text "Name": not a name-like key/header, so no name
  // promotion) placed AFTER another question — the bad layout this
  // fixes (Name buried among the other fields).
  function restPathNameNodes(): FlowNodeLite[] {
    return [
      { node_key: "start", node_type: "start", config: { next_node_key: "q0" } },
      {
        node_key: "q0",
        node_type: "collect_input",
        config: {
          prompt_text: "Travel date?",
          var_key: "TravelDate",
          next_node_key: "q1",
        },
      },
      {
        node_key: "q1",
        node_type: "collect_input",
        config: {
          prompt_text: "Name",
          var_key: "full_name",
          next_node_key: "end",
        },
      },
      { node_key: "end", node_type: "end", config: {} },
    ];
  }

  it("1. flow Name appears immediately after Submission Time, not among other fields", () => {
    const { columns } = buildFlowTableColumns(restPathNameNodes(), "start");
    expect(columns.map((c) => c.label)).toEqual([
      "Submission Time",
      "Name",
      "WhatsApp Name",
      "Phone Number",
      "Travel date?",
      "Latest Recording",
      "Status",
    ]);
    expect(columns.map((c) => c.key)).toEqual([
      "submission_time",
      "full_name",
      "name",
      "phone",
      "TravelDate",
      "latest_recording",
      "status",
    ]);
    // No duplicate "Name" system header exists.
    expect(columns.filter((c) => c.label === "Name")).toHaveLength(1);
  });

  it("derivation identities are preserved: answerKeys keep flow order", () => {
    const { answerKeys, nameKey } = buildFlowTableColumns(
      restPathNameNodes(),
      "start",
    );
    // Display columns moved; derivation (Sheets-adjacent) did not.
    expect(nameKey).toBeNull();
    expect(answerKeys).toEqual(["TravelDate", "full_name"]);
  });

  it("3. values stay independent after the move", () => {
    const { nameKey, answerKeys } = buildFlowTableColumns(
      restPathNameNodes(),
      "start",
    );
    const row = toFlowTableRow(
      rpcRow({
        contact_name: "Rahul Sharma",
        contact_phone: "919XXXXXXXXX",
        vars: { TravelDate: "October", full_name: "Rahul Kumar" },
      }),
      null,
      nameKey,
      answerKeys,
    );
    expect(row.name).toBe("Rahul Sharma");
    expect(row.answers).toMatchObject({
      TravelDate: "October",
      full_name: "Rahul Kumar",
    });
  });

  it("4. render keys stay unique and key-derived (visibility/widths safe)", () => {
    const { columns } = buildFlowTableColumns(restPathNameNodes(), "start");
    const renderKeys = columns.map(flowColumnRenderKey);
    expect(new Set(renderKeys).size).toBe(columns.length);
    expect(renderKeys).toContain("sys:name");
    expect(renderKeys).toContain("flow:full_name");
  });
});
describe("findFlowNameAnswerKey (Travel CRM Name identity)", () => {
  it("returns the key of the exact flow-derived Name column", () => {
    const { columns } = buildFlowTableColumns(
      nodesFor([{ key: "full_name", header: "Name" }]),
      "start",
    );
    expect(findFlowNameAnswerKey(columns)).toBe("full_name");
  });

  it("returns null without a flow Name column (system/custom never match)", () => {
    const { columns } = buildFlowTableColumns(
      nodesFor([{ key: "TravelDate" }]),
      "start",
    );
    // System "Name" alone is not a flow-derived Name column.
    expect(findFlowNameAnswerKey(columns)).toBeNull();
    expect(findFlowNameAnswerKey([])).toBeNull();
  });

  it("matches case-insensitively on the display label", () => {
    expect(
      findFlowNameAnswerKey([
        { key: "submission_time", label: "Submission Time", system: true },
        { key: "name", label: "Name", system: true },
        { key: "full_name", label: "name", system: false },
      ]),
    ).toBe("full_name");
  });
});
describe("flowDisplayName", () => {
  it("shows the flow name, never the UUID", () => {
    expect(flowDisplayName("Singapore Chat Automation")).toBe(
      "Singapore Chat Automation",
    );
  });

  it("falls back for missing names without exposing an id", () => {
    for (const missing of [null, undefined, "", "   "]) {
      expect(flowDisplayName(missing)).toBe("Untitled Flow");
    }
    expect(flowDisplayName("dab466d7-7263-4e7b-ba40-0717091abc")).toBe(
      "dab466d7-7263-4e7b-ba40-0717091abc",
    );
  });
});

describe("flowColumnRenderKey", () => {
  it("namespaces system vs answer columns sharing a logical key", () => {
    expect(flowColumnRenderKey({ key: "name", system: true })).toBe("sys:name");
    expect(flowColumnRenderKey({ key: "name", system: false })).toBe("flow:name");
  });

  it("is stable and never depends on the display label", () => {
    // Signature accepts key+system only, so a label rename can never
    // shift the key — full FlowTableColumn objects narrow fine too.
    const full: { key: string; label: string; system: boolean } = {
      key: "TravelDate",
      label: "Renamed!",
      system: false,
    };
    expect(flowColumnRenderKey(full)).toBe("flow:TravelDate");
  });

  it("keeps every sibling unique when a var_key collides with a system key", () => {
    // Reported error: "Encountered two children with the same key,
    // `name`". A collect_input with var_key "name" is name-promoted
    // into an answer column beside the system Name column — display
    // names and data stay as-is, but render keys must differ.
    const { columns } = buildFlowTableColumns(nodesFor([{ key: "name" }]), "start");
    const keys = columns.map((c) => c.key);
    expect(keys.filter((k) => k === "name")).toHaveLength(2);
    const renderKeys = columns.map(flowColumnRenderKey);
    expect(new Set(renderKeys).size).toBe(columns.length);
    expect(renderKeys).toContain("sys:name");
    expect(renderKeys).toContain("flow:name");
  });
});

describe("resolveAttachmentUrl", () => {
  const MEDIA = {
    "conv-1": [
      {
        contentText: "Itinerary.pdf",
        mediaUrl: "/api/whatsapp/media/m-2",
        contentType: "application/pdf",
      },
      {
        contentText: "Lord Shiva 4K Wallpaper.jpg",
        mediaUrl: "/api/whatsapp/media/m-1",
        contentType: "image/jpeg",
      },
      // A plain-text message never carries a file URL.
      { contentText: "Thanks", mediaUrl: null, contentType: "text" },
    ],
  };

  it("links a captured attachment filename to its stored media URL", () => {
    expect(
      resolveAttachmentUrl(MEDIA, "conv-1", "Itinerary.pdf"),
    ).toBe("/api/whatsapp/media/m-2");
    expect(
      resolveAttachmentUrl(MEDIA, "conv-1", "Lord Shiva 4K Wallpaper.jpg"),
    ).toBe("/api/whatsapp/media/m-1");
  });

  it("returns null for text values that match no media message", () => {
    expect(resolveAttachmentUrl(MEDIA, "conv-1", "Thanks")).toBeNull();
    expect(resolveAttachmentUrl(MEDIA, "conv-1", "Rahul")).toBeNull();
  });

  it("returns null for empty values and missing conversations", () => {
    expect(resolveAttachmentUrl(MEDIA, "conv-1", "")).toBeNull();
    expect(resolveAttachmentUrl(MEDIA, "conv-1", null)).toBeNull();
    expect(resolveAttachmentUrl(MEDIA, null, "Itinerary.pdf")).toBeNull();
    expect(resolveAttachmentUrl({}, "conv-1", "Itinerary.pdf")).toBeNull();
  });

  it("opens a value that is itself a URL directly (no media match)", () => {
    expect(resolveAttachmentUrl({}, "conv-1", "https://x.app/file.pdf")).toBe(
      "https://x.app/file.pdf",
    );
    expect(resolveAttachmentUrl({}, "conv-1", "http://x.app/a.png")).toBe(
      "http://x.app/a.png",
    );
  });

  it("prefers the stored media URL over a URL-shaped value", () => {
    expect(
      resolveAttachmentUrl(
        { "conv-1": [{ contentText: "https://x.app/a", mediaUrl: "/api/whatsapp/media/m-9", contentType: "text" }] },
        "conv-1",
        "https://x.app/a",
      ),
    ).toBe("/api/whatsapp/media/m-9");
  });
});

function workspaceRow(over: Partial<FlowTableRow> = {}): FlowTableRow {
  return {
    runId: "run-1",
    contactId: null,
    conversationId: null,
    name: null,
    phone: null,
    startedAt: "2026-10-01T10:00:00.000Z",
    lastAdvancedAt: null,
    completedAt: null,
    status: "completed",
    runStatus: "completed",
    answers: {},
    ...over,
  };
}

describe("workspace lead deep link (?contact=)", () => {
  it("builds the Workspace URL from the canonical contacts.id", () => {
    expect(workspaceContactHref("c-1")).toBe("/workspace?contact=c-1");
  });

  it("never points at the per-lead recordings page", () => {
    expect(workspaceContactHref("c-1")).not.toContain("/recordings/contact/");
  });

  it("encodes contact ids safely", () => {
    expect(workspaceContactHref("c 1&2")).toBe("/workspace?contact=c%201%262");
  });

  it("selects the first row for the contact, in table order", () => {
    const rows = [
      workspaceRow({ runId: "r-other", contactId: "c-9" }),
      workspaceRow({ runId: "r-first", contactId: "c-1" }),
      workspaceRow({ runId: "r-second", contactId: "c-1" }),
    ];
    expect(findWorkspaceRowForContact(rows, "c-1")?.runId).toBe("r-first");
  });

  it("selects nothing for blank ids, unknown ids, or leads without rows", () => {
    const rows = [workspaceRow({ runId: "r-1", contactId: "c-1" })];
    expect(findWorkspaceRowForContact(rows, null)).toBeNull();
    expect(findWorkspaceRowForContact(rows, "")).toBeNull();
    expect(findWorkspaceRowForContact(rows, "c-evil")).toBeNull();
    expect(findWorkspaceRowForContact([], "c-1")).toBeNull();
    expect(
      findWorkspaceRowForContact([workspaceRow({ runId: "r-1", contactId: null })], "c-1")
    ).toBeNull();
  });
});
