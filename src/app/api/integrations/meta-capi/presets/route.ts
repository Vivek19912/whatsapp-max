// POST /api/integrations/meta-capi/presets
//
// Admin-only. Creates DISABLED status-event presets for this workspace
// from the account's actual stored Stage values — never enabled, never
// Purchase. Creation is idempotent: existing preset names are skipped.
//
// Why presets instead of auto-firing: statuses live in per-workspace
// Stage columns with arbitrary stored values, so there is no safe global
// default. An admin reviews the exact matched value, then enables the
// mapping explicitly.

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { toPublicMapping } from "@/lib/meta-capi/serialize";
import {
  insertMapping,
  listEnabledMappingsForAction,
  listMappings,
} from "@/lib/meta-capi/store";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import { supabaseAdmin } from "@/lib/flows/admin-client";

interface StatusPreset {
  status: string;
  eventName: string;
  note: string;
}

const STATUS_PRESETS: StatusPreset[] = [
  {
    status: "Qualified",
    eventName: "QualifiedLead",
    note: "Custom event. Prefer over Lead when lead ingestion already sends Lead.",
  },
  {
    status: "Contacted",
    eventName: "Contact",
    note: "Standard Meta event for outreach.",
  },
  {
    status: "Converted",
    eventName: "ConvertedLead",
    note: "Custom event with no value. Use Purchase only when a real payment is confirmed.",
  },
];

export async function POST() {
  try {
    const ctx = await requireRole("admin");
    const admin = supabaseAdmin();

    const { data: fields, error: fieldsError } = await admin
      .from("workspace_fields")
      .select("id, name, options")
      .eq("account_id", ctx.accountId);
    if (fieldsError) throw fieldsError;

    const stageFields = ((fields ?? []) as Array<{
      name: string;
      options: unknown;
    }>).filter(
      (field) =>
        typeof field.name === "string" &&
        field.name.trim().toLowerCase() === "stage",
    );
    const distinctFieldNames = [
      ...new Set(
        stageFields.map((field) => field.name.trim()).filter((name) => name !== ""),
      ),
    ];
    const availableByField = new Map<string, string[]>();
    for (const name of distinctFieldNames) {
      const options = stageFields
        .filter((field) => field.name.trim() === name)
        .flatMap((field) =>
          Array.isArray(field.options)
            ? field.options.filter(
                (option): option is string => typeof option === "string",
              )
            : [],
        );
      availableByField.set(name, [...new Set(options)]);
    }

    const existing = await listMappings(admin, ctx.accountId);
    const existingNames = new Set(existing.map((mapping) => mapping.name));
    const ingestionLead = await listEnabledMappingsForAction(
      admin,
      ctx.accountId,
      "meta_lead_received",
    );
    const ingestionSendsLead = ingestionLead.some(
      (mapping) => mapping.meta_event_name === "Lead",
    );

    const created: Array<ReturnType<typeof toPublicMapping>> = [];
    const skippedExisting: string[] = [];
    const missing: Array<{ status: string; availableStageValues: string[] }> = [];
    const warnings: string[] = [];
    if (ingestionSendsLead) {
      warnings.push(
        "Lead ingestion already sends the standard Lead event. If you change a qualification preset to send Lead as well, Meta will count two Leads for the same person — prefer the custom QualifiedLead event.",
      );
    }

    if (distinctFieldNames.length === 0) {
      return NextResponse.json({
        ok: true,
        created,
        skippedExisting,
        missing: STATUS_PRESETS.map((preset) => ({
          status: preset.status,
          availableStageValues: [],
        })),
        warnings: [
          ...warnings,
          "No Stage column was found in this workspace, so no presets were created. Create the Stage values first, then run presets again.",
        ],
      });
    }

    for (const preset of STATUS_PRESETS) {
      let matched = false;
      for (const fieldName of distinctFieldNames) {
        const available = availableByField.get(fieldName) ?? [];
        if (!available.includes(preset.status)) continue;
        matched = true;
        const name = `Status: ${fieldName} = ${preset.status} → ${preset.eventName}`;
        if (existingNames.has(name)) {
          skippedExisting.push(name);
          continue;
        }
        try {
          const row = await insertMapping(admin, {
            account_id: ctx.accountId,
            name,
            source_action: "workspace_field_changed",
            source_field: fieldName,
            source_value: preset.status,
            meta_event_name: preset.eventName,
            action_source: "business_messaging",
            requires_value: false,
            event_value: null,
            currency: null,
            enabled: false,
          });
          existingNames.add(name);
          created.push(toPublicMapping(row));
        } catch (err) {
          if (isUniqueViolation(err)) {
            skippedExisting.push(name);
            continue;
          }
          throw err;
        }
      }
      if (!matched) {
        missing.push({
          status: preset.status,
          availableStageValues: [
            ...new Set(
              distinctFieldNames.flatMap(
                (fieldName) => availableByField.get(fieldName) ?? [],
              ),
            ),
          ],
        });
      }
    }

    return NextResponse.json({ ok: true, created, skippedExisting, missing, warnings });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
