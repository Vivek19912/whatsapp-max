// Meta Sheets Sheets-API client — pure helpers + error taxonomy.

import { describe, expect, it } from "vitest";

import {
  isAuthSheetsError,
  isTransientSheetsError,
  parseSheetsSpreadsheetId,
  quoteTabTitle,
  SheetsApiError,
} from "./sheets-client";
import { META_SHEETS_GOOGLE_SCOPES } from "./oauth";

describe("parseSheetsSpreadsheetId", () => {
  it("accepts full URLs and bare ids, rejects garbage", () => {
    expect(
      parseSheetsSpreadsheetId(
        "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit",
      ),
    ).toBe("1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms");
    expect(parseSheetsSpreadsheetId("1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms")).toBe(
      "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
    );
    expect(parseSheetsSpreadsheetId("not a sheet")).toBeNull();
    expect(parseSheetsSpreadsheetId("")).toBeNull();
  });
});

describe("quoteTabTitle", () => {
  it("quotes titles with spaces and apostrophes", () => {
    expect(quoteTabTitle("Meta Leads")).toBe("'Meta Leads'");
    expect(quoteTabTitle("O'Brien")).toBe("'O''Brien'");
  });
});

describe("sheets error taxonomy", () => {
  it("classifies transient vs auth errors", () => {
    expect(isTransientSheetsError(new SheetsApiError("x", 429))).toBe(true);
    expect(isTransientSheetsError(new SheetsApiError("x", 500))).toBe(true);
    expect(isTransientSheetsError(new SheetsApiError("x", 400))).toBe(false);
    expect(isAuthSheetsError(new SheetsApiError("x", 401))).toBe(true);
    expect(isAuthSheetsError(new SheetsApiError("x", 403))).toBe(true);
    expect(isAuthSheetsError(new SheetsApiError("x", 429))).toBe(false);
    expect(isTransientSheetsError(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("meta sheets oauth scopes", () => {
  it("requests only spreadsheets + email (least-privileged for paste-URL flow)", () => {
    expect(META_SHEETS_GOOGLE_SCOPES).toContain("auth/spreadsheets");
    expect(META_SHEETS_GOOGLE_SCOPES).toContain("userinfo.email");
    expect(META_SHEETS_GOOGLE_SCOPES).not.toContain("auth/drive");
  });
});
