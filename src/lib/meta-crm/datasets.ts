// ============================================================
// Meta CRM Integration — Business Dataset creation client (Feature 1).
//
// Calls Meta's official Business Dataset Creation API:
//   POST https://graph.facebook.com/v27.0/{BUSINESS_ID}/ads_dataset
//   Authorization: Bearer {ACCESS_TOKEN}
//   name={DATASET_NAME} + is_crm=true
//
// Backend-only. Never called from the browser with a user-entered
// token. Single POST with no automatic retry — an uncertain response
// must never be replayed because it may create duplicates.
//
// This is a NEW, independent Instant Form CRM Integration feature.
// It does NOT reuse the retired Conversions API (`meta-capi`)
// implementation, which remains untouched and hidden.
//
// Privacy: tokens never appear in errors, logs, or return values.
// ============================================================

/** Pinned Graph version for CRM dataset creation (independent of the
 *  Lead Capture META_GRAPH_VERSION — that integration is untouched). */
export const META_CRM_GRAPH_VERSION = "v27.0";

/** Numeric Meta Business Portfolio ID shape. */
const BUSINESS_ID_PATTERN = /^\d{5,32}$/;

export function buildCrmDatasetUrl(businessPortfolioId: string): string {
  return `https://graph.facebook.com/${META_CRM_GRAPH_VERSION}/${businessPortfolioId}/ads_dataset`;
}

export type MetaCrmErrorCode =
  | "invalid_input"
  | "auth_failed"
  | "forbidden"
  | "meta_error"
  | "network_error"
  | "missing_dataset_id";

export class MetaCrmError extends Error {
  readonly code: MetaCrmErrorCode;
  readonly status: number;
  readonly metaCode: number | null;
  readonly metaSubcode: number | null;

  constructor(args: {
    code: MetaCrmErrorCode;
    message: string;
    status: number;
    metaCode?: number | null;
    metaSubcode?: number | null;
  }) {
    super(args.message);
    this.name = "MetaCrmError";
    this.code = args.code;
    this.status = args.status;
    this.metaCode = args.metaCode ?? null;
    this.metaSubcode = args.metaSubcode ?? null;
  }
}

interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
}

function safeMetaMessage(body: MetaErrorBody | null, status: number): string {
  const raw = body?.error?.message?.trim();
  if (raw && raw.length > 0) {
    // Truncate; never include tokens (tokens are never in Meta's message).
    return raw.slice(0, 300);
  }
  return `Meta rejected the dataset creation request (${status}).`;
}

export interface CreateCrmDatasetArgs {
  businessPortfolioId: string;
  datasetName: string;
  accessToken: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface CreatedCrmDataset {
  id: string;
  name: string;
}

/**
 * Create a CRM dataset under a Meta Business Portfolio. Exactly one
 * POST is issued; callers must not retry on uncertain responses.
 */
export async function createCrmDataset(
  args: CreateCrmDatasetArgs,
): Promise<CreatedCrmDataset> {
  const businessPortfolioId = args.businessPortfolioId.trim();
  const datasetName = args.datasetName.trim();
  const accessToken = args.accessToken.trim();
  const fetchImpl = args.fetchImpl ?? fetch;

  if (!BUSINESS_ID_PATTERN.test(businessPortfolioId)) {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Business Portfolio ID must be a numeric ID (5–32 digits).",
      status: 400,
    });
  }
  if (datasetName === "") {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Enter a dataset name.",
      status: 400,
    });
  }
  if (accessToken === "") {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Paste your authorized Meta access token.",
      status: 400,
    });
  }

  const url = buildCrmDatasetUrl(businessPortfolioId);
  const body = new URLSearchParams();
  body.set("name", datasetName);
  body.set("is_crm", "true");

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch {
    throw new MetaCrmError({
      code: "network_error",
      message: "Could not reach Meta. Check your connection and try again.",
      status: 502,
    });
  }

  let parsed: unknown = null;
  try {
    const text = await res.text();
    parsed = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    parsed = null;
  }

  const data = (parsed ?? {}) as { id?: unknown; error?: MetaErrorBody["error"] };
  const metaError = data.error ?? (parsed as MetaErrorBody | null)?.error;

  if (!res.ok || metaError) {
    const metaCode = typeof metaError?.code === "number" ? metaError.code : null;
    const metaSubcode =
      typeof metaError?.error_subcode === "number" ? metaError.error_subcode : null;
    const message = safeMetaMessage(
      metaError ? { error: metaError } : null,
      res.status,
    );

    // #200 = permission / capability problem; #190/#102 = bad/expired token.
    if (metaCode === 200) {
      throw new MetaCrmError({
        code: "forbidden",
        message: `Meta refused: insufficient permissions (code 200). Grant dataset creation rights to this token/business. ${message}`.slice(
          0,
          300,
        ),
        status: 403,
        metaCode,
        metaSubcode,
      });
    }
    if (metaCode === 190 || metaCode === 102 || res.status === 401) {
      throw new MetaCrmError({
        code: "auth_failed",
        message: "Meta rejected the access token. It may be expired or invalid.",
        status: 401,
        metaCode,
        metaSubcode,
      });
    }
    // Invalid business / bad request.
    if (res.status === 400 || res.status === 404) {
      throw new MetaCrmError({
        code: "meta_error",
        message,
        status: res.status,
        metaCode,
        metaSubcode,
      });
    }
    throw new MetaCrmError({
      code: "meta_error",
      message,
      status: res.status >= 500 ? 502 : res.status || 502,
      metaCode,
      metaSubcode,
    });
  }

  const id = typeof data.id === "string" ? data.id.trim() : "";
  if (id === "") {
    throw new MetaCrmError({
      code: "missing_dataset_id",
      message: "Meta did not return a Dataset ID. The dataset may not have been created.",
      status: 502,
    });
  }

  return { id, name: datasetName };
}

export interface VerifiedCrmDataset {
  id: string;
  name: string;
  businessId: string | null;
  ownershipVerified: boolean;
}

interface DatasetDetailResponse {
  id?: unknown;
  name?: unknown;
  error?: MetaErrorBody["error"];
}

/**
 * Read one dataset via Meta (identity verification for "Add Existing").
 * Never throws the token; surfaces Meta codes safely.
 */
export async function getCrmDatasetDetail(
  datasetId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; name: string }> {
  const trimmedId = datasetId.trim();
  if (!BUSINESS_ID_PATTERN.test(trimmedId)) {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Dataset ID must be a numeric ID (5–32 digits).",
      status: 400,
    });
  }
  const url = `https://graph.facebook.com/${META_CRM_GRAPH_VERSION}/${trimmedId}?fields=id,name`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken.trim()}` },
    });
  } catch {
    throw new MetaCrmError({
      code: "network_error",
      message: "Could not reach Meta. Check your connection and try again.",
      status: 502,
    });
  }
  let parsed: unknown = null;
  try {
    const text = await res.text();
    parsed = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    parsed = null;
  }
  const data = (parsed ?? {}) as DatasetDetailResponse;
  const metaError = data.error;
  if (!res.ok || metaError || typeof data.id !== "string") {
    const metaCode = typeof metaError?.code === "number" ? metaError.code : null;
    const metaSubcode =
      typeof metaError?.error_subcode === "number" ? metaError.error_subcode : null;
    if (metaCode === 200) {
      throw new MetaCrmError({
        code: "forbidden",
        message: "Meta refused: this token cannot access that dataset (code 200).",
        status: 403,
        metaCode,
        metaSubcode,
      });
    }
    if (metaCode === 190 || metaCode === 102 || res.status === 401) {
      throw new MetaCrmError({
        code: "auth_failed",
        message: "Meta rejected the access token. It may be expired or invalid.",
        status: 401,
        metaCode,
        metaSubcode,
      });
    }
    if (res.status === 400 || res.status === 404) {
      throw new MetaCrmError({
        code: "meta_error",
        message: safeMetaMessage(metaError ? { error: metaError } : null, res.status),
        status: res.status,
        metaCode,
        metaSubcode,
      });
    }
    throw new MetaCrmError({
      code: "meta_error",
      message: safeMetaMessage(metaError ? { error: metaError } : null, res.status),
      status: res.status >= 500 ? 502 : res.status || 502,
      metaCode,
      metaSubcode,
    });
  }
  const name = typeof data.name === "string" ? data.name.trim() : "";
  return { id: trimmedId, name };
}

/**
 * Confirm the Business Portfolio is readable with the same token
 * (proves authorized access; NOT proof of dataset ownership).
 */
export async function getBusinessDetail(
  businessPortfolioId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; name: string | null }> {
  const trimmed = businessPortfolioId.trim();
  if (!BUSINESS_ID_PATTERN.test(trimmed)) {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Business Portfolio ID must be a numeric ID (5–32 digits).",
      status: 400,
    });
  }
  const url = `https://graph.facebook.com/${META_CRM_GRAPH_VERSION}/${trimmed}?fields=id,name`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken.trim()}` },
    });
  } catch {
    throw new MetaCrmError({
      code: "network_error",
      message: "Could not reach Meta. Check your connection and try again.",
      status: 502,
    });
  }
  let parsed: unknown = null;
  try {
    const text = await res.text();
    parsed = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    parsed = null;
  }
  const data = (parsed ?? {}) as { id?: unknown; name?: unknown; error?: MetaErrorBody["error"] };
  const metaError = data.error;
  if (!res.ok || metaError || typeof data.id !== "string") {
    const metaCode = typeof metaError?.code === "number" ? metaError.code : null;
    const metaSubcode =
      typeof metaError?.error_subcode === "number" ? metaError.error_subcode : null;
    if (metaCode === 200) {
      throw new MetaCrmError({
        code: "forbidden",
        message:
          "Meta refused: this token cannot access that Business Portfolio (code 200). Check the Business ID and token permissions.",
        status: 403,
        metaCode,
        metaSubcode,
      });
    }
    if (metaCode === 190 || metaCode === 102 || res.status === 401) {
      throw new MetaCrmError({
        code: "auth_failed",
        message: "Meta rejected the access token. It may be expired or invalid.",
        status: 401,
        metaCode,
        metaSubcode,
      });
    }
    throw new MetaCrmError({
      code: "meta_error",
      message: safeMetaMessage(metaError ? { error: metaError } : null, res.status),
      status: res.status >= 500 ? 502 : res.status || 502,
      metaCode,
      metaSubcode,
    });
  }
  return {
    id: trimmed,
    name: typeof data.name === "string" ? data.name : null,
  };
}

/**
 * Best-effort ownership check: list the business's CRM datasets and
 * see whether the dataset appears. Returns null when the listing
 * itself is unavailable (callers must not treat that as proof).
 *
 * NOTE: a null return is AMBIGUOUS — it covers expired tokens,
 * missing permissions, bad business IDs, Meta outages, and
 * unsupported edges alike. Code paths that must tell the operator
 * *why* verification failed should use verifyDatasetOwnership()
 * instead, which preserves the underlying diagnostic.
 */
export async function isDatasetUnderBusiness(
  businessPortfolioId: string,
  datasetId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  try {
    const ids = await fetchBusinessDatasets(
      businessPortfolioId,
      accessToken,
      fetchImpl,
    );
    return ids.some((id) => id === datasetId.trim());
  } catch {
    return null;
  }
}

/**
 * List a Business Portfolio's CRM dataset ids. Throws a precise
 * MetaCrmError (never null) so callers can distinguish an expired
 * token, missing permissions, a bad business id, and Meta outages.
 *
 * Uses the DOCUMENTED read edge (Meta "Business Ads Dataset"
 * reference: "To read datasets under a business, make a GET request
 * to the {business-id}/ads_dataset endpoint"). The plural form
 * (/{business-id}/ads_datasets) does NOT exist — Meta answers it
 * with "Unknown path components: /ads_datasets".
 */
export async function fetchBusinessDatasets(
  businessPortfolioId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const businessId = businessPortfolioId.trim();
  if (!BUSINESS_ID_PATTERN.test(businessId)) {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Business Portfolio ID must be a numeric ID (5–32 digits).",
      status: 400,
    });
  }
  const token = accessToken.trim();
  if (token === "") {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Refusing to query Meta without an access token.",
      status: 400,
    });
  }
  // NOTE: singular `ads_dataset` — the documented read edge (see
  // function docblock). The plural form does not exist.
  const url =
    `https://graph.facebook.com/${META_CRM_GRAPH_VERSION}/${businessId}` +
    `/ads_dataset?fields=id&limit=100`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new MetaCrmError({
      code: "network_error",
      message: "Could not reach Meta. Check your connection and try again.",
      status: 502,
    });
  }
  let parsed: unknown = null;
  try {
    const text = await res.text();
    parsed = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    parsed = null;
  }
  const data = (parsed ?? {}) as {
    data?: Array<{ id?: unknown }>;
    error?: MetaErrorBody["error"];
  };
  const metaError = data.error;
  if (!res.ok || metaError) {
    const metaCode = typeof metaError?.code === "number" ? metaError.code : null;
    const metaSubcode =
      typeof metaError?.error_subcode === "number" ? metaError.error_subcode : null;
    const message = safeMetaMessage(
      metaError ? { error: metaError } : null,
      res.status,
    );
    if (metaCode === 1349004) {
      throw new MetaCrmError({
        code: "forbidden",
        message:
          `Meta refused: this app/token cannot read datasets for Business Portfolio ${businessId} ` +
          `(code 1349004). The app needs the business_management permission plus Datasets API ` +
          `allowlisting, and the token needs dataset access. ${message}`.slice(0, 300),
        status: 403,
        metaCode,
        metaSubcode,
      });
    }
    if (metaCode === 2282001) {
      throw new MetaCrmError({
        code: "invalid_input",
        message:
          `Invalid Business Portfolio ID ${businessId} (code 2282001). ` +
          `Check the ID in Meta Business Settings.`,
        status: 400,
        metaCode,
        metaSubcode,
      });
    }
    if (metaCode === 200) {
      throw new MetaCrmError({
        code: "forbidden",
        message:
          `Meta refused: this token cannot list datasets for Business Portfolio ${businessId} (code 200). ` +
          `Grant it dataset access. ${message}`.slice(0, 300),
        status: 403,
        metaCode,
        metaSubcode,
      });
    }
    if (metaCode === 190 || metaCode === 102 || res.status === 401) {
      throw new MetaCrmError({
        code: "auth_failed",
        message: "Meta rejected the access token. It may be expired or invalid.",
        status: 401,
        metaCode,
        metaSubcode,
      });
    }
    throw new MetaCrmError({
      code: "meta_error",
      message,
      status: res.status >= 500 ? 502 : res.status || 502,
      metaCode,
      metaSubcode,
    });
  }
  const rows = Array.isArray(data.data) ? data.data : [];
  return rows
    .map((r) => (typeof r.id === "string" ? r.id.trim() : ""))
    .filter((id) => id !== "");
}

export interface VerifyOwnershipArgs {
  businessPortfolioId: string;
  datasetId: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}

export type DatasetOwnershipResult =
  | { verified: true }
  | { verified: false; reason: string };

/**
 * Strict ownership verification for enabling CRM feedback.
 *
 * Unlike the best-effort isDatasetUnderBusiness() probe, every
 * failure here is precise:
 *   - dataset unreadable  -> the dataset read's own error
 *     (expired token / missing dataset permission / bad id)
 *   - business unreadable -> the business read's own error
 *     (wrong portfolio id / no business access)
 *   - listing unavailable -> the listing's own error (outage,
 *     unsupported edge) — never misreported as "not owned"
 *   - listed but absent  -> verified:false with both ids named
 *
 * Throws MetaCrmError for all uncertain/error states (fail closed:
 * callers must keep feedback disabled); returns verified:false
 * ONLY when a successful listing proves the dataset is absent.
 * Never fabricates ownership; never logs tokens.
 */
export async function verifyDatasetOwnership(
  args: VerifyOwnershipArgs,
): Promise<DatasetOwnershipResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const token = args.accessToken.trim();
  if (token === "") {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Refusing to verify ownership without an access token.",
      status: 400,
    });
  }
  const detail = await getCrmDatasetDetail(args.datasetId, token, fetchImpl);
  const business = await getBusinessDetail(
    args.businessPortfolioId,
    token,
    fetchImpl,
  );
  const ids = await fetchBusinessDatasets(
    args.businessPortfolioId,
    token,
    fetchImpl,
  );
  if (ids.includes(detail.id)) {
    return { verified: true };
  }
  return {
    verified: false,
    reason:
      `Dataset ${detail.id} ("${detail.name || "unnamed"}") was not found under ` +
      `Business Portfolio ${business.id}. Check that the dataset belongs to ` +
      `business ${business.id} (checked the first ${ids.length} datasets), or ` +
      `move it under that business in Meta Business Settings.`,
  };
}

export interface VerifyExistingArgs {
  datasetId: string;
  businessPortfolioId: string;
  accessToken: string;
  expectedName?: string | null;
  fetchImpl?: typeof fetch;
}

/**
 * Verify an existing dataset WITHOUT creating anything in Meta:
 * dataset identity (id + name) plus business accessibility. When an
 * expected name is supplied it must match Meta's canonical name.
 * Ownership via the business edge is attempted best-effort and
 * reported — never assumed from mere read access.
 */
export async function verifyExistingCrmDataset(
  args: VerifyExistingArgs,
): Promise<VerifiedCrmDataset> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const token = args.accessToken.trim();
  const detail = await getCrmDatasetDetail(args.datasetId, token, fetchImpl);
  await getBusinessDetail(args.businessPortfolioId, token, fetchImpl);

  const expected = (args.expectedName ?? "").trim();
  if (expected !== "" && expected.toLowerCase() !== detail.name.toLowerCase()) {
    throw new MetaCrmError({
      code: "invalid_input",
      message: `Dataset name mismatch: Meta reports "${detail.name || "unnamed"}" for this ID.`,
      status: 400,
    });
  }
  if (detail.name === "") {
    throw new MetaCrmError({
      code: "missing_dataset_id",
      message: "Meta returned this dataset without a name. Refusing to register it.",
      status: 502,
    });
  }
  const linkage = await isDatasetUnderBusiness(
    args.businessPortfolioId,
    detail.id,
    token,
    fetchImpl,
  );
  return {
    id: detail.id,
    name: detail.name,
    businessId: args.businessPortfolioId.trim(),
    ownershipVerified: linkage === true,
  };
}
