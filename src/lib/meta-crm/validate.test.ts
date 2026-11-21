// Meta CRM Integration — input validation contracts.

import { describe, expect, it } from "vitest";

import { validateCrmDatasetInput, validateRegisterExistingInput } from "./validate";

describe("validateCrmDatasetInput", () => {
  it("accepts a valid input and trims whitespace", () => {
    const result = validateCrmDatasetInput({
      datasetName: "  Interscale Marketing  ",
      businessPortfolioId: "  1171141236081090  ",
      accessToken: "  valid-token-1234567890  ",
    });
    expect(result.ok).toBe(true);
    expect(result.values).toEqual({
      datasetName: "Interscale Marketing",
      businessPortfolioId: "1171141236081090",
      accessToken: "valid-token-1234567890",
    });
  });

  it("rejects an empty dataset name", () => {
    const result = validateCrmDatasetInput({
      datasetName: "   ",
      businessPortfolioId: "1171141236081090",
      accessToken: "valid-token-1234567890",
    });
    expect(result.ok).toBe(false);
    expect(result.fieldErrors.datasetName).toBeTruthy();
  });

  it("rejects a non-numeric business portfolio id", () => {
    for (const bad of ["", "abc", "12.5", "12ab34", "1234"]) {
      const result = validateCrmDatasetInput({
        datasetName: "Interscale Marketing",
        businessPortfolioId: bad,
        accessToken: "valid-token-1234567890",
      });
      expect(result.ok).toBe(false);
      expect(result.fieldErrors.businessPortfolioId).toBeTruthy();
    }
  });

  it("rejects a missing or short access token", () => {
    const empty = validateCrmDatasetInput({
      datasetName: "Interscale Marketing",
      businessPortfolioId: "1171141236081090",
      accessToken: "   ",
    });
    expect(empty.ok).toBe(false);
    expect(empty.fieldErrors.accessToken).toBeTruthy();

    const short = validateCrmDatasetInput({
      datasetName: "Interscale Marketing",
      businessPortfolioId: "1171141236081090",
      accessToken: "short",
    });
    expect(short.ok).toBe(false);
  });

  it("preserves the business id as a string (no number coercion)", () => {
    const result = validateCrmDatasetInput({
      datasetName: "X",
      businessPortfolioId: "1171141236081090",
      accessToken: "valid-token-1234567890",
    });
    expect(result.values?.businessPortfolioId).toBe("1171141236081090");
    expect(typeof result.values?.businessPortfolioId).toBe("string");
  });
});

describe("validateRegisterExistingInput", () => {
  it("accepts a valid registration input", () => {
    const result = validateRegisterExistingInput({
      datasetId: "1830596054845292",
      businessPortfolioId: "1171141236081090",
      accessToken: "valid-token-1234567890",
    });
    expect(result.ok).toBe(true);
    expect(result.values?.datasetId).toBe("1830596054845292");
  });

  it("rejects non-numeric dataset ids", () => {
    const result = validateRegisterExistingInput({
      datasetId: "abc",
      businessPortfolioId: "1171141236081090",
      accessToken: "valid-token-1234567890",
    });
    expect(result.ok).toBe(false);
    expect(result.fieldErrors.datasetId).toBeTruthy();
  });

  it("keeps ids as strings", () => {
    const result = validateRegisterExistingInput({
      datasetId: "1830596054845292",
      businessPortfolioId: "1171141236081090",
      accessToken: "valid-token-1234567890",
    });
    expect(typeof result.values?.datasetId).toBe("string");
    expect(typeof result.values?.businessPortfolioId).toBe("string");
  });
});
