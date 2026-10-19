// /api/integrations/meta-capi/mappings/[id]
//
// PATCH  — update a mapping (admin). Merges with the stored row, then
//          re-validates the whole thing.
// DELETE — remove a mapping (admin).

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { toPublicMapping } from "@/lib/meta-capi/serialize";
import { deleteMapping, getMapping, updateMapping } from "@/lib/meta-capi/store";
import { parseMappingInput, toMappingInput } from "@/lib/meta-capi/validate";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = await requireRole("admin");

    const existing = await getMapping(ctx.supabase, ctx.accountId, id);
    if (!existing) {
      return NextResponse.json({ error: "Event not found." }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const parsed = parseMappingInput(body, toMappingInput(existing));
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    try {
      const updated = await updateMapping(ctx.supabase, ctx.accountId, id, parsed.value);
      if (!updated) {
        return NextResponse.json({ error: "Event not found." }, { status: 404 });
      }
      return NextResponse.json({ ok: true, mapping: toPublicMapping(updated) });
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

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = await requireRole("admin");
    await deleteMapping(ctx.supabase, ctx.accountId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
