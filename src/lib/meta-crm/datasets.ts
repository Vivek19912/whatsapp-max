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
