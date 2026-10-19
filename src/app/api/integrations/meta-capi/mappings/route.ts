// /api/integrations/meta-capi/mappings
//
// GET  — list this account's configured event mappings.
// POST — create one (admin). A duplicate name is a 409.

import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole } from "@/lib/auth/account";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { toPublicMapping } from "@/lib/meta-capi/serialize";
import { insertMapping, listMappings } from "@/lib/meta-capi/store";
import { parseMappingInput } from "@/lib/meta-capi/validate";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const mappings = await listMappings(ctx.supabase, ctx.accountId);
    return NextResponse.json({ mappings: mappings.map(toPublicMapping) });
  } catch (err) {
    return metaErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const parsed = parseMappingInput(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    try {
      const created = await insertMapping(ctx.supabase, {
        account_id: ctx.accountId,
        ...parsed.value,
      });
      return NextResponse.json({ ok: true, mapping: toPublicMapping(created) });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return NextResponse.json(
          { error: "You already have an event with that name." },
          { status: 409 },
        );
      }
      throw err;
    }
  } catch (err) {
    return metaErrorResponse(err);
  }
}
