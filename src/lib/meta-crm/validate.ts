// ============================================================
// Meta CRM Integration — input validation (Feature 1: Dataset Creation).
//
// Pure and dependency-free so it is unit-testable and shared by the
// client form and the backend route. Secrets are never logged here.
//
// This is a NEW, independent Instant Form CRM Integration feature.
// It does NOT reuse the retired Conversions API (`meta-capi`)
// implementation, which remains untouched and hidden.
// ============================================================

/** Max dataset name length (Meta accepts generous names; we bound for safety). */
export const CRM_DATASET_NAME_MAX_LENGTH = 100;

/** Business Portfolio IDs are numeric Meta IDs (same shape as Page IDs). */
export const BUSINESS_PORTFOLIO_ID_PATTERN = /^\d{5,32}$/;

/** Minimum token length to catch accidental pastes (tokens are long). */
export const ACCESS_TOKEN_MIN_LENGTH = 10;

export interface CrmDatasetFormInput {
  datasetName: string | null | undefined;
  businessPortfolioId: string | null | undefined;
  accessToken: string | null | undefined;
}

export interface ValidatedCrmDatasetInput {
  datasetName: string;
  businessPortfolioId: string;
  accessToken: string;
}

export interface CrmDatasetFieldErrors {
  datasetName?: string;
  businessPortfolioId?: string;
  accessToken?: string;
}

/**
 * Validate raw form input. Trims surrounding whitespace and rejects
 * empty values. Business ID is kept as a string to avoid JS number
 * precision issues. Returns sanitized values on success.
 */
export function validateCrmDatasetInput(input: CrmDatasetFormInput): {
  ok: boolean;
  values: ValidatedCrmDatasetInput | null;
  fieldErrors: CrmDatasetFieldErrors;
} {
  const fieldErrors: CrmDatasetFieldErrors = {};

  const datasetName = (input.datasetName ?? "").trim();
  if (datasetName === "") {
    fieldErrors.datasetName = "Enter a dataset name.";
  } else if (datasetName.length > CRM_DATASET_NAME_MAX_LENGTH) {
    fieldErrors.datasetName = `Dataset name must be ${CRM_DATASET_NAME_MAX_LENGTH} characters or fewer.`;
  }

  const businessPortfolioId = (input.businessPortfolioId ?? "").trim();
  if (businessPortfolioId === "") {
    fieldErrors.businessPortfolioId = "Enter the numeric Business Portfolio ID.";
  } else if (!BUSINESS_PORTFOLIO_ID_PATTERN.test(businessPortfolioId)) {
    fieldErrors.businessPortfolioId =
      "Business Portfolio ID must be a numeric ID (5–32 digits).";
  }

  // Tokens are compared trimmed; internal whitespace is never valid.
  const accessToken = (input.accessToken ?? "").trim();
  if (accessToken === "") {
    fieldErrors.accessToken = "Paste your authorized Meta access token.";
  } else if (accessToken.length < ACCESS_TOKEN_MIN_LENGTH) {
    fieldErrors.accessToken = "That token looks too short. Paste the full access token.";
  } else if (/\s/.test(accessToken)) {
    fieldErrors.accessToken = "The access token must not contain spaces.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, values: null, fieldErrors };
  }

  return {
    ok: true,
    values: {
      datasetName,
      businessPortfolioId,
      accessToken,
    },
    fieldErrors: {},
  };
}

export interface RegisterExistingInput {
  datasetId: string | null | undefined;
  businessPortfolioId: string | null | undefined;
  accessToken: string | null | undefined;
  datasetName?: string | null | undefined;
}

export interface ValidatedRegisterInput {
  datasetId: string;
  businessPortfolioId: string;
  accessToken: string;
  datasetName: string | null;
}

export interface RegisterFieldErrors {
  datasetId?: string;
  businessPortfolioId?: string;
  accessToken?: string;
  datasetName?: string;
}

/**
 * Validate an "Add Existing" registration form. The token proves
 * authorized access; the dataset name (when supplied) must match
 * what Meta returns — the backend re-verifies against Meta and uses
 * Meta's canonical name when none is supplied.
 */
export function validateRegisterExistingInput(input: RegisterExistingInput): {
  ok: boolean;
  values: ValidatedRegisterInput | null;
  fieldErrors: RegisterFieldErrors;
} {
  const fieldErrors: RegisterFieldErrors = {};

  const datasetId = (input.datasetId ?? "").trim();
  if (datasetId === "") {
    fieldErrors.datasetId = "Enter the existing Meta Dataset ID.";
  } else if (!BUSINESS_PORTFOLIO_ID_PATTERN.test(datasetId)) {
    fieldErrors.datasetId = "Dataset ID must be a numeric ID (5–32 digits).";
  }

  const businessPortfolioId = (input.businessPortfolioId ?? "").trim();
  if (businessPortfolioId === "") {
    fieldErrors.businessPortfolioId = "Enter the numeric Business Portfolio ID.";
  } else if (!BUSINESS_PORTFOLIO_ID_PATTERN.test(businessPortfolioId)) {
    fieldErrors.businessPortfolioId =
      "Business Portfolio ID must be a numeric ID (5–32 digits).";
  }

  const accessToken = (input.accessToken ?? "").trim();
  if (accessToken === "") {
    fieldErrors.accessToken = "Paste your authorized Meta access token.";
  } else if (accessToken.length < ACCESS_TOKEN_MIN_LENGTH) {
    fieldErrors.accessToken = "That token looks too short. Paste the full access token.";
  } else if (/\s/.test(accessToken)) {
    fieldErrors.accessToken = "The access token must not contain spaces.";
  }

  const rawName = (input.datasetName ?? "") as string;
  const datasetName = rawName.trim() === "" ? null : rawName.trim();
  if (datasetName !== null && datasetName.length > CRM_DATASET_NAME_MAX_LENGTH) {
    fieldErrors.datasetName = `Dataset name must be ${CRM_DATASET_NAME_MAX_LENGTH} characters or fewer.`;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, values: null, fieldErrors };
  }

  return {
    ok: true,
    values: { datasetId, businessPortfolioId, accessToken, datasetName },
    fieldErrors: {},
  };
}
