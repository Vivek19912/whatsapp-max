// Meta Sheets Sheets-API client — pure helpers + error taxonomy +
// request-shape tests for the dynamic layout helpers (fetch is
// injected; no production spreadsheets are touched).

import { describe, expect, it, vi } from "vitest";

import {
  deleteSheetRows,
  deleteWorksheetTab,
  ensureSheetsHeader,
  findSheetsRowsByLeadId,
  isAuthSheetsError,
  isQuotaSheetsError,
  isTransientSheetsError,
  parseSheetsSpreadsheetId,
  quoteTabTitle,
  resolveSpreadsheetOpenUrl,
  rewriteSheetRows,
  setSheetColumnHidden,
  SheetsApiError,
  updateSheetsRow,
  validateWorksheetTabName,
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

describe("resolveSpreadsheetOpenUrl", () => {
  it("prefers the saved URL and trims it", () => {
    expect(
      resolveSpreadsheetOpenUrl({
        spreadsheetUrl: "  https://docs.google.com/spreadsheets/d/abc  ",
        spreadsheetId: "abc",
      }),
    ).toBe("https://docs.google.com/spreadsheets/d/abc");
  });

  it("builds a URL from a bare spreadsheet id", () => {
    expect(
      resolveSpreadsheetOpenUrl({ spreadsheetUrl: null, spreadsheetId: "abc123_XYZ-9" }),
    ).toBe("https://docs.google.com/spreadsheets/d/abc123_XYZ-9");
  });

  it("returns null without a safe URL or id", () => {
    expect(resolveSpreadsheetOpenUrl({ spreadsheetUrl: null })).toBeNull();
    expect(resolveSpreadsheetOpenUrl({ spreadsheetUrl: "" , spreadsheetId: "" })).toBeNull();
    expect(
      resolveSpreadsheetOpenUrl({ spreadsheetUrl: "javascript:alert(1)" }),
    ).toBeNull();
    expect(
      resolveSpreadsheetOpenUrl({ spreadsheetUrl: "not a url", spreadsheetId: "has spaces" }),
    ).toBeNull();
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

  it("classifies quota errors (429, 403 rateLimitExceeded, RESOURCE_EXHAUSTED)", () => {
    expect(isQuotaSheetsError(new SheetsApiError("x", 429))).toBe(true);
    expect(
      isQuotaSheetsError(
        new SheetsApiError("x", 403, { reason: "rateLimitExceeded" })
      )
    ).toBe(true);
    expect(
      isQuotaSheetsError(
        new SheetsApiError("x", 403, { reason: "quotaExceeded" })
      )
    ).toBe(true);
    expect(isQuotaSheetsError(new SheetsApiError("x", 400))).toBe(false);
    expect(isQuotaSheetsError(new SheetsApiError("x", 500))).toBe(false);
    // Quota rejections are never auth errors, even at 403.
    expect(
      isAuthSheetsError(
        new SheetsApiError("x", 403, { reason: "rateLimitExceeded" })
      )
    ).toBe(false);
    expect(isAuthSheetsError(new SheetsApiError("x", 403))).toBe(true);
  });

  it("parses the Google reason and Retry-After off error responses", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "120" }),
        text: async () =>
          JSON.stringify({
            error: {
              message: "Quota exceeded for quota metric 'Write requests'",
              errors: [{ reason: "rateLimitExceeded", message: "see above" }],
            },
          }),
      }) as unknown as Response) as typeof fetch;
    const err = await findSheetsRowsByLeadId(
      "tok",
      "sheet-1",
      "Meta Leads",
      ["lead-1"],
      fetchImpl
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SheetsApiError);
    const apiErr = err as SheetsApiError;
    expect(apiErr.status).toBe(429);
    expect(apiErr.reason).toBe("rateLimitExceeded");
    expect(apiErr.retryAfterMs).toBe(120_000);
    expect(apiErr.message).toContain("rateLimitExceeded");
    expect(isQuotaSheetsError(apiErr)).toBe(true);
    expect(isAuthSheetsError(apiErr)).toBe(false);
  });
});

describe("meta sheets oauth scopes", () => {
  it("requests only spreadsheets + email (least-privileged for paste-URL flow)", () => {
    expect(META_SHEETS_GOOGLE_SCOPES).toContain("auth/spreadsheets");
    expect(META_SHEETS_GOOGLE_SCOPES).toContain("userinfo.email");
    expect(META_SHEETS_GOOGLE_SCOPES).not.toContain("auth/drive");
  });
});

function okJson(body: unknown) {
  return {
    ok: true,
    json: async () => body,
    text: async () => "",
  } as unknown as Response;
}

function failingFetch(status: number) {
  return vi.fn(async (_input: string | URL | Request): Promise<Response> => ({
    ok: false,
    status,
    text: async () => "boom",
  }) as unknown as Response);
}

type Call = [string | URL | Request, RequestInit?];

function lastCall(mock: { mock: { calls: Call[] } }): Call {
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error("expected a fetch call");
  return call;
}

describe("dynamic layout helpers", () => {
  it("writes the requested header and skips matching headers", async () => {
    const read = vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => okJson({ values: [["Meta Lead ID", "Lead Name"]] }));
    const write = vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => okJson({}));
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === "PUT") return write(String(input), init);
      return read(String(input), init);
    });

    const same = await ensureSheetsHeader("t", "s", "Tab", ["Meta Lead ID", "Lead Name"], fetchImpl);
    expect(same).toEqual({ updated: false });
    expect(write).not.toHaveBeenCalled();

    await ensureSheetsHeader("t", "s", "Tab", ["Meta Lead ID", "Lead Name", "Budget"], fetchImpl);
    expect(write).toHaveBeenCalledTimes(1);
    const [url, init] = lastCall(write);
    expect(url).toContain("!A1:C1");
    expect(JSON.parse((init?.body as string) ?? "")).toEqual({ values: [["Meta Lead ID", "Lead Name", "Budget"]] });
  });

  it("sizes row updates to the value width", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request): Promise<Response> => okJson({}));
    await updateSheetsRow("t", "s", "Tab", 4, ["a", "b", "c"], fetchImpl);
    const [url, init] = lastCall(fetchImpl);
    expect(url).toContain("!A4:C4");
    expect(JSON.parse((init?.body as string) ?? "")).toEqual({ values: [["a", "b", "c"]] });
    await expect(updateSheetsRow("t", "s", "Tab", 1, ["a"], fetchImpl)).rejects.toThrow(
      /header row/,
    );
  });

  it("rewrites rows in one batchUpdate with literal A1 ranges", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request): Promise<Response> => okJson({}));
    const rows = [
      { rowNumber: 2, values: ["lead-a", "Asha"] },
      { rowNumber: 5, values: ["lead-b", "Ravi", "x"] },
    ];
    await rewriteSheetRows("t", "s", "My Tab", rows, fetchImpl);
    const [url, init] = lastCall(fetchImpl);
    expect(url).toContain("/values:batchUpdate");
    const body = JSON.parse((init?.body as string) ?? "") as {
      data: Array<{ range: string; values: string[][] }>;
    };
    expect(body.data).toEqual([
      { range: "'My Tab'!A2:B2", values: [["lead-a", "Asha"]] },
      { range: "'My Tab'!A5:C5", values: [["lead-b", "Ravi", "x"]] },
    ]);
  });

  it("deletes rows bottom-to-top and refuses the header", async () => {
    const tabFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
      okJson({ sheets: [{ properties: { sheetId: 7, title: "Tab" } }] }),
    );
    const batch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => okJson({}));
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input).endsWith(":batchUpdate")) return batch(String(input), init);
      return tabFetch(String(input), init);
    });
    await deleteSheetRows("t", "s", "Tab", [2, 5, 3], fetchImpl);
    const [, init] = lastCall(batch);
    const ranges = (JSON.parse((init?.body as string) ?? "") as {
      requests: Array<{ deleteDimension: { range: { startIndex: number } } }>;
    }).requests.map((r) => r.deleteDimension.range.startIndex);
    // Bottom-to-top: row 5, then 3, then 2.
    expect(ranges).toEqual([4, 2, 1]);
    await expect(deleteSheetRows("t", "s", "Tab", [1], fetchImpl)).rejects.toThrow(/header/);
  });

  it("hides the ID column without touching data", async () => {
    const tabFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
      okJson({ sheets: [{ properties: { sheetId: 9, title: "Tab" } }] }),
    );
    const batch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => okJson({}));
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input).endsWith(":batchUpdate")) return batch(String(input), init);
      return tabFetch(String(input), init);
    });
    await setSheetColumnHidden("t", "s", "Tab", 0, true, fetchImpl);
    const [, init] = lastCall(batch);
    expect(JSON.parse((init?.body as string) ?? "")).toEqual({
      requests: [
        {
          updateDimensionProperties: {
            range: { sheetId: 9, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
            properties: { hiddenByUser: true },
            fields: "hiddenByUser",
          },
        },
      ],
    });
  });

  it("surfaces Google failures with status", async () => {
    await expect(
      rewriteSheetRows("t", "s", "Tab", [{ rowNumber: 2, values: ["a"] }], failingFetch(500)),
    ).rejects.toMatchObject({ status: 500 });
  });
});

describe("validateWorksheetTabName", () => {
  it("accepts ordinary names and trims whitespace", () => {
    expect(validateWorksheetTabName("  Leads  ")).toEqual({ tab: "Leads" });
    expect(validateWorksheetTabName("Q1 — Mumbai")).toEqual({ tab: "Q1 — Mumbai" });
  });

  it("rejects blank, overlong, and non-string input", () => {
    expect(validateWorksheetTabName("")).toHaveProperty("error");
    expect(validateWorksheetTabName("   ")).toHaveProperty("error");
    expect(validateWorksheetTabName("x".repeat(101))).toHaveProperty("error");
    expect(validateWorksheetTabName(null)).toHaveProperty("error");
    expect(validateWorksheetTabName(42)).toHaveProperty("error");
  });

  it("rejects characters Google forbids in sheet titles", () => {
    for (const bad of ["a[b", "a]b", "a:b", "a*b", "a?b", "a/b", "a\\b"]) {
      expect(validateWorksheetTabName(bad)).toHaveProperty("error");
    }
    expect(validateWorksheetTabName("a\u0007b")).toHaveProperty("error");
  });
});

describe("findSheetsRowsByLeadId", () => {
  function columnFetch(cells: unknown[]) {
    return vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
        okJson({ values: [cells] }),
    );
  }

  it("scans column A by default (legacy ID-first layouts)", async () => {
    const fetchImpl = columnFetch(["lead-a", "lead-b"]);
    const found = await findSheetsRowsByLeadId("t", "s", "Tab", ["lead-b"], fetchImpl);
    expect(found.get("lead-b")).toBe(3);
    const [url] = lastCall(fetchImpl);
    expect(String(url)).toContain("!A2:A");
  });

  it("scans the configured ID column when the ID is last", async () => {
    const fetchImpl = columnFetch(["lead-a", "lead-b"]);
    const found = await findSheetsRowsByLeadId("t", "s", "Tab", ["lead-a"], fetchImpl, 3);
    expect(found.get("lead-a")).toBe(2);
    const [url] = lastCall(fetchImpl);
    // 0-based index 3 → column D.
    expect(String(url)).toContain("!D2:D");
  });
});

describe("deleteWorksheetTab", () => {
  function tabLookupFetch() {
    return vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
        okJson({ sheets: [{ properties: { sheetId: 12, title: "Old Tab" } }] }),
    );
  }

  it("deletes exactly the resolved sheetId and nothing else", async () => {
    const lookup = tabLookupFetch();
    const batch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => okJson({}),
    );
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input).endsWith(":batchUpdate")) return batch(String(input), init);
      return lookup(String(input), init);
    });
    await deleteWorksheetTab("t", "spreadsheet-1", "Old Tab", fetchImpl);
    const [url, init] = lastCall(batch);
    expect(url).toContain("spreadsheet-1:batchUpdate");
    expect(JSON.parse((init?.body as string) ?? "")).toEqual({
      requests: [{ deleteSheet: { sheetId: 12 } }],
    });
    // No spreadsheet-level delete: only a single deleteSheet request.
    expect(lookup).toHaveBeenCalled();
  });

  it("throws before deleting when the tab does not exist", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      okJson({ sheets: [{ properties: { sheetId: 1, title: "Other" } }] }),
    );
    await expect(
      deleteWorksheetTab("t", "spreadsheet-1", "Missing", fetchImpl),
    ).rejects.toThrow(/not found/);
    expect(fetchImpl.mock.calls.length).toBe(1);
  });

  it("surfaces Google delete failures with status", async () => {
    const lookup = tabLookupFetch();
    const fail = failingFetch(500);
    const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      if (String(input).endsWith(":batchUpdate")) return fail(input);
      return lookup(input);
    });
    await expect(
      deleteWorksheetTab("t", "spreadsheet-1", "Old Tab", fetchImpl),
    ).rejects.toMatchObject({ status: 500 });
  });
});
