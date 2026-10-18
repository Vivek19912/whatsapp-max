// ============================================================
// Meta Lead Ads — HTTP error mapping for route handlers.
//
// MetaLeadAdsError (and its MetaGraphError subclass) carry the
// intended HTTP status and a machine-readable `code`; every other
// error falls through to the shared account/auth mapper (which
// collapses unknown errors to a generic 500 without leaking server
// internals). Every Meta route uses this so failures surface with a
// consistent status + body instead of a blanket 500.
// ============================================================

import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";

import { MetaLeadAdsError } from "./errors";

export function metaErrorResponse(err: unknown): NextResponse {
  if (err instanceof MetaLeadAdsError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status },
    );
  }
  return toErrorResponse(err);
}
