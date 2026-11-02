// ============================================================
// Meta Lead Ads — Workspace display-name projection tests.
//
// Covers the Meta-table-only presentation rules:
//   * system Name shows the submission's own Full Name answer,
//     never the shared contact's WhatsApp profile name;
//   * the Full name question column is excluded by stable key
//     identity (FULL_NAME type / canonical `full_name` key);
//   * Flow Tables and all other surfaces are untouched (these
//     helpers are simply never consulted there).
// ============================================================

import { describe, expect, it } from "vitest";

import {
  excludeMetaFullNameColumns,
  isMetaFullNameQuestionType,
  META_FULL_NAME_ANSWER_KEY,
  metaFullNameAnswerKeys,
  metaWorkspaceDisplayName,
} from "./workspace-name";

describe("metaWorkspaceDisplayName", () => {
  it("prefers the submission Full Name over the WhatsApp contact profile name", () => {
    expect(
      metaWorkspaceDisplayName(
        { full_name: "Mahima Dixit Mukesh", phone_number: "916239419297" },
        "Mahi ❤️💕",
      ),
    ).toBe("Mahima Dixit Mukesh");
  });

  it("resolves per submission: two rows for one contact show different names", () => {
    const contactName = "Shared Profile";
    expect(
      metaWorkspaceDisplayName({ full_name: "Yogesh Bigboss" }, contactName),
    ).toBe("Yogesh Bigboss");
    expect(
      metaWorkspaceDisplayName({ full_name: "Yogesh Kumar" }, contactName),
    ).toBe("Yogesh Kumar");
  });

  it("falls back to the normalized standard name when full_name is missing", () => {
    // Alternate full-name key.
    expect(metaWorkspaceDisplayName({ name: "Asha" }, "Profile")).toBe(
      "Asha",
    );
    // First + last synthesis.
    expect(
      metaWorkspaceDisplayName(
        { first_name: "Grace", last_name: "Hopper" },
        "Profile",
      ),
    ).toBe("Grace Hopper");
  });

  it("falls back to the contact name when the submission has no usable name", () => {
    expect(metaWorkspaceDisplayName({}, "Mahi ❤️💕")).toBe("Mahi ❤️💕");
    expect(
      metaWorkspaceDisplayName({ phone_number: "919999999999" }, "Profile"),
    ).toBe("Profile");
  });

  it("ignores empty or whitespace-only Full Name values", () => {
    expect(metaWorkspaceDisplayName({ full_name: "" }, "Profile")).toBe(
      "Profile",
    );
    expect(metaWorkspaceDisplayName({ full_name: "   " }, "Profile")).toBe(
      "Profile",
    );
    // Non-string values are never rendered.
    expect(
      metaWorkspaceDisplayName({ full_name: 42 } as never, "Profile"),
    ).toBe("Profile");
  });

  it("returns null (never undefined or whitespace) when nothing usable exists", () => {
    expect(metaWorkspaceDisplayName({}, null)).toBeNull();
    expect(metaWorkspaceDisplayName(null, null)).toBeNull();
    expect(metaWorkspaceDisplayName({ full_name: "  " }, "   ")).toBeNull();
    expect(metaWorkspaceDisplayName(undefined, undefined)).toBeNull();
  });

  it("preserves Unicode, emoji, and punctuation byte-for-byte", () => {
    expect(metaWorkspaceDisplayName({ full_name: "محمد أحمد" }, "x")).toBe(
      "محمد أحمد",
    );
    expect(
      metaWorkspaceDisplayName({ full_name: "Mahi ❤️💕 (VIP)" }, "x"),
    ).toBe("Mahi ❤️💕 (VIP)");
    expect(
      metaWorkspaceDisplayName({ full_name: "  JAY PUJARA  " }, "x"),
    ).toBe("JAY PUJARA");
  });
});

describe("isMetaFullNameQuestionType", () => {
  it("matches FULL_NAME case-insensitively, nothing else", () => {
    expect(isMetaFullNameQuestionType("FULL_NAME")).toBe(true);
    expect(isMetaFullNameQuestionType("full_name")).toBe(true);
    expect(isMetaFullNameQuestionType("  Full_Name ")).toBe(true);
    expect(isMetaFullNameQuestionType("CUSTOM")).toBe(false);
    expect(isMetaFullNameQuestionType("PHONE_NUMBER")).toBe(false);
    expect(isMetaFullNameQuestionType(null)).toBe(false);
    expect(isMetaFullNameQuestionType(undefined)).toBe(false);
  });
});

describe("metaFullNameAnswerKeys", () => {
  it("maps FULL_NAME questions to their derived answer keys by index", () => {
    const keys = metaFullNameAnswerKeys(
      [
        { key: "full_name", label: "Full name", type: "FULL_NAME" },
        { key: "phone_number", label: "Phone number", type: "PHONE_NUMBER" },
        { key: "city", label: "City", type: "CUSTOM" },
      ],
      ["full_name", "phone_number", "city"],
    );
    expect(keys.has("full_name")).toBe(true);
    expect(keys.has("phone_number")).toBe(false);
    expect(keys.has("city")).toBe(false);
  });

  it("always includes the canonical key for forms without synced metadata", () => {
    expect([...metaFullNameAnswerKeys([], [])]).toEqual([
      META_FULL_NAME_ANSWER_KEY,
    ]);
    expect([...metaFullNameAnswerKeys(null, [])]).toEqual([
      META_FULL_NAME_ANSWER_KEY,
    ]);
  });

  it("never treats phone or email questions as name twins", () => {
    const keys = metaFullNameAnswerKeys(
      [
        { key: "phone_number", label: "Phone number", type: "PHONE_NUMBER" },
        { key: "email", label: "Email", type: "EMAIL" },
      ],
      ["phone_number", "email"],
    );
    expect(keys.has("phone_number")).toBe(false);
    expect(keys.has("email")).toBe(false);
  });
});

describe("excludeMetaFullNameColumns", () => {
  const columns = [
    { key: "submission_time", label: "Submission Time", system: true },
    { key: "name", label: "Name", system: true },
    { key: "phone", label: "Phone Number", system: true },
    { key: "full_name", label: "Full name", system: false },
    { key: "phone_number", label: "Phone number", system: false },
    { key: "city", label: "City", system: false },
    { key: "latest_recording", label: "Latest Recording", system: true },
    { key: "status", label: "Status", system: true },
  ];

  it("removes only the non-system Full name twin and preserves order", () => {
    const out = excludeMetaFullNameColumns(
      columns,
      new Set([META_FULL_NAME_ANSWER_KEY]),
    );
    expect(out.map((c) => c.key)).toEqual([
      "submission_time",
      "name",
      "phone",
      "phone_number",
      "city",
      "latest_recording",
      "status",
    ]);
    // Exactly one visible Name column: the system one.
    expect(out.filter((c) => c.label === "Name")).toHaveLength(1);
    expect(
      out.find((c) => c.label === "Name"),
    ).toMatchObject({ key: "name", system: true });
  });

  it("keeps the system Name column even if its key is in the set", () => {
    const out = excludeMetaFullNameColumns(columns, new Set(["name"]));
    expect(out.some((c) => c.system && c.key === "name")).toBe(true);
  });

  it("does not mutate the input array", () => {
    const input = [...columns];
    excludeMetaFullNameColumns(input, new Set([META_FULL_NAME_ANSWER_KEY]));
    expect(input).toHaveLength(columns.length);
  });

  it("leaves non-Meta column lists untouched when the set is empty", () => {
    expect(excludeMetaFullNameColumns(columns, new Set())).toEqual(columns);
  });
});
