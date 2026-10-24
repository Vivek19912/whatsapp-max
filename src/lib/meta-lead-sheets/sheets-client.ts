// ============================================================
// Meta Lead Ads → Google Sheets — thin Sheets API client.
//
// Meta-only. This module intentionally does NOT import from
// lib/google/sheets or lib/google/tabs so Flow Tables / All
// Sheets behavior cannot change with this feature. Same raw-fetch
// style (no googleapis SDK), but separate helpers scoped to the
// single-worksheet Meta layout (row 1 = META_SHEETS_HEADERS).
//
// All functions take an already-valid access token from
// meta-lead-sheets/oauth. Spreadsheet access is always validated
// server-side before enabling sync; tokens never reach the browser.
// ============================================================

import {
  META_SHEETS_HEADERS,
  META_SHEETS_LEAD_ID_COL,
} from "./constants";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

export interface SheetsMeta {
  spreadsheetId: string;
  title: string;
  tabs: string[];
  url: string;
}

export class SheetsApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SheetsApiError";
    this.status = status;
  }
}

async function throwForResponse(res: Response, context: string): Promise<never> {
  const text = await res.text().catch(() => "");
  throw new SheetsApiError(`${context} (${res.status}): ${text.slice(0, 500)}`, res.status);
}

/** True for transient errors worth retrying (429 / 5xx). */
export function isTransientSheetsError(err: unknown): boolean {
  if (err instanceof SheetsApiError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  // Network-level failures (fetch threw) are transient.
  return err instanceof TypeError;
}

/** True when Google rejected the credential (expired/revoked/insufficient). */
export function isAuthSheetsError(err: unknown): boolean {
  if (err instanceof SheetsApiError) {
    return err.status === 401 || err.status === 403;
  }
  return false;
}

/** Extract a spreadsheet id from a full URL or accept a bare id. */
export function parseSheetsSpreadsheetId(input: string): string | null {
  const trimmed = input.trim();
  const m = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Quote a tab title for literal A1 notation. */
export function quoteTabTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** Validate access + read title/tabs/url. Throws SheetsApiError on failure. */
export async function getSheetsSpreadsheet(
  accessToken: string,
  spreadsheetId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SheetsMeta> {
  const res = await fetchImpl(
    `${SHEETS_API}/${spreadsheetId}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) await throwForResponse(res, "Google Sheets read failed");
  const data = (await res.json()) as {
    spreadsheetId: string;
    spreadsheetUrl: string;
    properties: { title: string };
    sheets: Array<{ properties: { title: string } }>;
  };
  return {
    spreadsheetId: data.spreadsheetId,
    title: data.properties?.title ?? "Untitled",
    tabs: (data.sheets ?? []).map((s) => s.properties?.title ?? ""),
    url: data.spreadsheetUrl,
  };
}

/** Create a new spreadsheet with the Meta header pre-written. */
export async function createSheetsSpreadsheet(
  accessToken: string,
  title: string,
  tab: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SheetsMeta> {
  const res = await fetchImpl(SHEETS_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: { title },
      sheets: [
        {
          properties: { title: tab },
          data: [
            {
              rowData: [
                {
                  values: [...META_SHEETS_HEADERS].map((h) => ({
                    userEnteredValue: { stringValue: h },
                  })),
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) await throwForResponse(res, "Google Sheets create failed");
  const data = (await res.json()) as {
    spreadsheetId: string;
    spreadsheetUrl: string;
    properties: { title: string };
    sheets: Array<{ properties: { title: string } }>;
  };
  return {
    spreadsheetId: data.spreadsheetId,
    title: data.properties?.title ?? title,
    tabs: (data.sheets ?? []).map((s) => s.properties?.title ?? ""),
    url: data.spreadsheetUrl,
  };
}

/** Create a tab if missing; returns whether it was created. */
export async function ensureSheetsTab(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ created: boolean }> {
  const meta = await getSheetsSpreadsheet(accessToken, spreadsheetId, fetchImpl);
  if (meta.tabs.includes(tab)) return { created: false };
  const res = await fetchImpl(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
  });
  if (!res.ok) await throwForResponse(res, "Google Sheets tab create failed");
  return { created: true };
}

/** Read row 1 of the tab. Null when the tab is empty. */
export async function readSheetsHeader(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
  const range = `${encodeURIComponent(quoteTabTitle(tab))}!1:1`;
  const res = await fetchImpl(
    `${SHEETS_API}/${spreadsheetId}/values/${range}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) await throwForResponse(res, "Google Sheets header read failed");
  const data = (await res.json()) as { values?: unknown[][] };
  const row = data.values?.[0];
  if (!row || row.length === 0) return null;
  return row.map((c) => String(c ?? ""));
}

/**
 * Ensure row 1 matches the desired managed header exactly. Writes
 * the full header when the tab is empty or mismatched. This is the
 * integration's owned range — user columns to the right of the
 * managed width are untouched.
 */
export async function ensureSheetsHeader(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  desiredHeaders: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ updated: boolean }> {
  const existing = await readSheetsHeader(accessToken, spreadsheetId, tab, fetchImpl);
  const wanted = [...desiredHeaders];
  if (
    existing &&
    existing.length >= wanted.length &&
    wanted.every((h, i) => existing[i] === h)
  ) {
    return { updated: false };
  }
  // Build range without double-encoding: reuse the quoted-title pattern
  // used by other values writes in this codebase.
  const headerRange = `${encodeURIComponent(quoteTabTitle(tab))}!A1:${columnLetter(wanted.length - 1)}1`;
  const res = await fetchImpl(
    `${SHEETS_API}/${spreadsheetId}/values/${headerRange}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [wanted] }),
    },
  );
  if (!res.ok) await throwForResponse(res, "Google Sheets header write failed");
  return { updated: true };
}

/** Append rows (INSERT_ROWS semantics handled by Sheets append). */
export async function appendSheetsRows(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  rows: (string | number)[][],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (rows.length === 0) return;
  const range = `${encodeURIComponent(quoteTabTitle(tab))}!A1`;
  const res = await fetchImpl(
    `${SHEETS_API}/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: rows }),
    },
  );
  if (!res.ok) await throwForResponse(res, "Google Sheets append failed");
}

/** Overwrite one full data row (1-based row number, managed width). */
export async function updateSheetsRow(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  rowNumber: number,
  values: (string | number)[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (rowNumber < 2) throw new Error("Refusing to update a sheet header row");
  if (values.length === 0) throw new Error("Refusing to write an empty sheet row");
  const lastCol = columnLetter(values.length - 1);
  const range = `${encodeURIComponent(quoteTabTitle(tab))}!A${rowNumber}:${lastCol}${rowNumber}`;
  const res = await fetchImpl(
    `${SHEETS_API}/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [values] }),
    },
  );
  if (!res.ok) await throwForResponse(res, "Google Sheets row update failed");
}

/**
 * Rewrite many full data rows in ONE request (used when rolling a
 * column-layout change out to already-written managed rows).
 * Each entry is `{rowNumber (1-based, >= 2), values}`.
 */
export async function rewriteSheetRows(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  rows: Array<{ rowNumber: number; values: (string | number)[] }>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (rows.length === 0) return;
  for (const row of rows) {
    if (row.rowNumber < 2 || row.values.length === 0) {
      throw new Error("Refusing to rewrite a header row or an empty row");
    }
  }
  const res = await fetchImpl(
    `${SHEETS_API}/${spreadsheetId}/values:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data: rows.map((row) => {
          const lastCol = columnLetter(row.values.length - 1);
          return {
            range: `${quoteTabTitle(tab)}!A${row.rowNumber}:${lastCol}${row.rowNumber}`,
            values: [row.values],
          };
        }),
      }),
    },
  );
  if (!res.ok) await throwForResponse(res, "Google Sheets rows rewrite failed");
}

async function getSheetId(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const res = await fetchImpl(
    `${SHEETS_API}/${spreadsheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    await throwForResponse(res, "Google Sheets tab lookup failed");
  }
  const data = (await res.json()) as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };
  const sheetId = data.sheets?.find((sheet) => sheet.properties?.title === tab)
    ?.properties?.sheetId;
  if (typeof sheetId !== "number") {
    throw new Error(`Google Sheets tab not found: ${tab}`);
  }
  return sheetId;
}

/**
 * Hide or unhide one 0-based sheet column (used for the pinned
 * Meta Lead ID column when it is not a selected visible column).
 * Cosmetic and idempotent; never deletes data.
 */
export async function setSheetColumnHidden(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  colIndex: number,
  hidden: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const sheetId = await getSheetId(accessToken, spreadsheetId, tab, fetchImpl);
  const res = await fetchImpl(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: "COLUMNS",
              startIndex: colIndex,
              endIndex: colIndex + 1,
            },
            properties: { hiddenByUser: hidden },
            fields: "hiddenByUser",
          },
        },
      ],
    }),
  });
  if (!res.ok) {
    await throwForResponse(res, "Google Sheets column visibility update failed");
  }
}

/**
 * Delete multiple 1-based data rows in one request, bottom-to-top
 * (so earlier deletions never shift later row numbers). Never
 * deletes the header row. Used ONLY for the explicit, confirmed
 * cleanup of integration-managed rows — never for user data.
 */
export async function deleteSheetRows(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  rowNumbers: number[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (rowNumbers.length === 0) return;
  if (rowNumbers.some((rowNumber) => rowNumber < 2)) {
    throw new Error("Refusing to delete a sheet header row");
  }
  const sheetId = await getSheetId(accessToken, spreadsheetId, tab, fetchImpl);
  const descendingRows = [...new Set(rowNumbers)].sort((a, b) => b - a);
  const res = await fetchImpl(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: descendingRows.map((rowNumber) => ({
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: rowNumber - 1,
            endIndex: rowNumber,
          },
        },
      })),
    }),
  });
  if (!res.ok) {
    await throwForResponse(res, "Google Sheets row delete failed");
  }
}

/**
 * Find 1-based row numbers for Meta Lead IDs by scanning column A
 * (single read). Returns only IDs that were found.
 */
export async function findSheetsRowsByLeadId(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  leadIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  if (leadIds.length === 0) return found;
  const col = columnLetter(META_SHEETS_LEAD_ID_COL);
  const range = `${encodeURIComponent(quoteTabTitle(tab))}!${col}2:${col}`;
  const res = await fetchImpl(
    `${SHEETS_API}/${spreadsheetId}/values/${range}?majorDimension=COLUMNS`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) await throwForResponse(res, "Google Sheets column read failed");
  const data = (await res.json()) as { values?: unknown[][] };
  const cells = data.values?.[0] ?? [];
  const wanted = new Set(leadIds);
  cells.forEach((cell, index) => {
    const value = String(cell ?? "");
    if (wanted.has(value) && !found.has(value)) found.set(value, index + 2);
  });
  return found;
}
