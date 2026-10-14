import { describe, expect, it } from "vitest";

import { formatColumnLabel } from "./column-label";
import {
  LEAD_RECEIVED_FIELD_NAME,
  WORKSPACE_DEFAULT_FIELDS,
  isLeadReceivedField,
} from "./workspace-defaults";

describe("formatColumnLabel (display-only first-word capitalization)", () => {
  it("capitalizes a lowercase first word", () => {
    expect(formatColumnLabel("name")).toBe("Name");
    expect(formatColumnLabel("capital")).toBe("Capital");
    expect(formatColumnLabel("location")).toBe("Location");
  });

  it("only capitalizes the first character of the first word", () => {
    expect(formatColumnLabel("height and weight")).toBe("Height and weight");
    expect(formatColumnLabel("sales agent")).toBe("Sales agent");
    expect(formatColumnLabel("customer_source")).toBe("Customer_source");
    expect(formatColumnLabel("if_we_solve")).toBe("If_we_solve");
  });

  it("leaves remaining characters exactly unchanged", () => {
    expect(formatColumnLabel("Assigned To")).toBe("Assigned To");
    expect(formatColumnLabel("No. of Calls Tried")).toBe("No. of Calls Tried");
    expect(formatColumnLabel("Follow-Up Status")).toBe("Follow-Up Status");
    expect(formatColumnLabel("Lead Quality")).toBe("Lead Quality");
    expect(formatColumnLabel("Quotation / Package")).toBe(
      "Quotation / Package"
    );
    expect(formatColumnLabel("Phone Number")).toBe("Phone Number");
  });

  it("never mutates the stored value and handles edge input", () => {
    const stored = "sales agent";
    expect(formatColumnLabel(stored)).toBe("Sales agent");
    expect(stored).toBe("sales agent");
    expect(formatColumnLabel("")).toBe("");
    expect(formatColumnLabel("1st visit")).toBe("1st visit");
    expect(formatColumnLabel("_private")).toBe("_private");
  });

  it("renders display-only aliases for the two renamed business columns", () => {
    expect(formatColumnLabel("Lead Type")).toBe("Type");
    expect(formatColumnLabel("Lead Received")).toBe("Lead Source");
  });

  it("matches aliases case-insensitively without touching the stored name", () => {
    const storedType = "Lead Type";
    const storedReceived = "Lead Received";
    expect(formatColumnLabel("lead type")).toBe("Type");
    expect(formatColumnLabel("  Lead Received  ")).toBe("Lead Source");
    // Stored identities are unchanged (display-only).
    expect(storedType).toBe("Lead Type");
    expect(storedReceived).toBe("Lead Received");
  });

  it("leaves similarly named columns on the capitalization path", () => {
    expect(formatColumnLabel("Lead Quality")).toBe("Lead Quality");
    expect(formatColumnLabel("Lead Source")).toBe("Lead Source");
    expect(formatColumnLabel("Type")).toBe("Type");
    expect(formatColumnLabel("Received")).toBe("Received");
  });

  it("keeps underlying field keys and identities exactly unchanged", () => {
    const names = WORKSPACE_DEFAULT_FIELDS.map((f) => f.name);
    expect(names).toContain("Lead Type");
    expect(names).toContain("Lead Received");
    expect(names).not.toContain("Type");
    expect(names).not.toContain("Received");
    expect(LEAD_RECEIVED_FIELD_NAME).toBe("Lead Received");
    expect(isLeadReceivedField({ name: "Lead Received" })).toBe(true);
  });
});
