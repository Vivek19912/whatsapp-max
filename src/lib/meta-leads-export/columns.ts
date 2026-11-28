// ============================================================
// Meta Leads Export — column builders (reuse Workspace logic).
//
// Single table: buildFlowTableColumns + Meta twin suppression +
// Source-to-end + header-label overrides + workspace fields.
// All view: allMetaFlowColumns + union columns + fixed provenance.
// Headers always match Workspace display names.
// ============================================================

import { formatColumnLabel } from '@/lib/flows/column-label';
import type { FlowTableColumn } from '@/lib/flows/flow-tables';
import { buildFlowTableColumns } from '@/lib/flows/flow-tables';
import type { FlowNodeLite } from '@/lib/flows/sheet-columns';
import {
  excludeMetaFullNameColumns,
  metaFullNameAnswerKeys,
} from '@/lib/meta-lead-ads/workspace-name';
import { resolveMetaHeaderDisplayLabel } from '@/lib/meta-lead-ads/header-labels';
import { META_SOURCE_COLUMN_KEY } from '@/lib/meta-lead-ads/virtual-flow';
import {
  allMetaFlowColumns,
  buildAllMetaUnionColumns,
  type AllMetaUnionFieldDef,
} from '@/lib/workspace/all-meta-leads';

import type { ExportColumn } from './workbook';

/** Excel display format for Submission Time: `28-11-2026 05:34 PM`. */
export const SUBMISSION_TIME_NUM_FMT = 'dd-mm-yyyy hh:mm AM/PM';

/** Excel display format for date-only columns (Last Contact Date). */
export const DATE_ONLY_NUM_FMT = 'dd-mm-yyyy';

/**
 * Canonical phone-number identity for header deduping: the system
 * column renders "Phone Number", while an Instant Form question may
 * contribute "Phone number" / "phone_number" / "PhoneNumber" as a
 * dynamic column. All spellings collapse to one key.
 */
function normalizedPhoneHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '');
}

/** True for a dynamic column duplicating the system Phone Number. */
function isDuplicatePhoneColumn(header: string): boolean {
  return normalizedPhoneHeader(header) === 'phonenumber';
}

/** True for the Last Contact Date business column (any casing). */
function isLastContactDateColumn(header: string): boolean {
  return (
    header
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '') === 'lastcontactdate'
  );
}

export interface WorkspaceFieldLite {
  id: string;
  name: string;
  field_type: string;
}

/** Resolve one export header (overrides + formatting). */
export function resolveExportHeader(args: {
  column: Pick<FlowTableColumn, 'key' | 'system' | 'label'>;
  labels: Readonly<Record<string, string>> | null | undefined;
}): string {
  return resolveMetaHeaderDisplayLabel({
    flowKind: 'meta_lead_ads',
    column: args.column,
    labels: args.labels,
    formatOriginal: formatColumnLabel,
  });
}

/**
 * Build export columns for ONE Meta Lead Ads table.
 * Mirrors GET /api/flows/[id]/table column order exactly:
 * system cols + flow Name twin@1 + dynamic + Source-at-end +
 * workspace business fields. Provenance columns (Ad Name,
 * Campaign Name, Lead Source, Meta Created Time, Meta Lead ID)
 * are intentionally not exported.
 */
export function buildSingleTableExportColumns(args: {
  nodes: FlowNodeLite[];
  entryNodeKey: string | null;
  fullNameQuestions: Array<{
    key?: string | null;
    label?: string | null;
    type?: string | null;
  }>;
  questionKeys: string[];
  headerLabels: Readonly<Record<string, string>> | null | undefined;
  workspaceFields: WorkspaceFieldLite[];
}): { columns: ExportColumn[]; answerKeys: string[] } {
  const {
    columns: derived,
    nameKey,
    answerKeys,
  } = buildFlowTableColumns(args.nodes, args.entryNodeKey);
  const fullNameKeys = metaFullNameAnswerKeys(
    args.fullNameQuestions,
    args.questionKeys
  );

  // Source to end of dynamic (before Latest Recording), same as UI.
  const ordered = [...derived];
  const sourceIdx = ordered.findIndex((c) => c.key === META_SOURCE_COLUMN_KEY);
  if (sourceIdx > -1) {
    const [sourceCol] = ordered.splice(sourceIdx, 1);
    const recordIdx = ordered.findIndex((c) => c.key === 'latest_recording');
    ordered.splice(recordIdx === -1 ? ordered.length : recordIdx, 0, sourceCol);
  }
  const responseColumns = excludeMetaFullNameColumns(ordered, fullNameKeys);

  const out: ExportColumn[] = [
    { key: '__row', header: 'No.', kind: 'number', width: 6 },
  ];
  for (const c of responseColumns) {
    if (c.key === 'submission_time') {
      out.push({
        key: 'submission_time',
        header: 'Submission Time',
        kind: 'date',
        numFmt: SUBMISSION_TIME_NUM_FMT,
      });
    } else if (c.key === 'name') {
      out.push({ key: 'name', header: 'Name', kind: 'text' });
    } else if (c.key === 'phone') {
      out.push({ key: 'phone', header: 'Phone Number', kind: 'text' });
    } else if (c.key === 'latest_recording' || c.key === 'status') {
      continue; // UI-only badges, not lead data
    } else {
      const header = resolveExportHeader({
        column: c,
        labels: args.headerLabels,
      });
      // The system Phone Number column above is the single source
      // of truth — drop a dynamic Instant Form question column that
      // duplicates it ("Phone number" in any casing/spacing).
      // Other question columns and custom fields are untouched.
      if (isDuplicatePhoneColumn(header)) continue;
      out.push({
        key: `answer:${c.key}`,
        header,
        kind: 'text',
      });
    }
  }

  // Workspace business fields in stored position order.
  for (const f of args.workspaceFields) {
    const label = formatColumnLabel(f.name);
    out.push({
      key: `field:${f.id}`,
      header: label,
      kind: /follow-up|date|time/i.test(f.name) ? 'date' : 'text',
      ...(isLastContactDateColumn(label) ? { numFmt: DATE_ONLY_NUM_FMT } : {}),
    });
  }

  void nameKey;
  return { columns: out, answerKeys };
}

/**
 * Build export columns for the All Meta Leads union.
 * Fixed All-view columns + dynamic union of workspace fields.
 * Order matches defaultAllMetaColumnOrder(). Provenance columns
 * (Ad Name, Campaign Name, Lead Source, Meta Created Time,
 * Meta Lead ID) are intentionally not exported.
 */
export function buildAllMetaExportColumns(args: {
  tables: ReadonlyArray<{ flowId: string }>;
  fieldsByFlow: Record<string, ReadonlyArray<AllMetaUnionFieldDef> | undefined>;
}): ExportColumn[] {
  const fixed = allMetaFlowColumns();
  const out: ExportColumn[] = [
    { key: '__row', header: 'No.', kind: 'number', width: 6 },
  ];
  for (const c of fixed) {
    if (c.key === 'submission_time')
      out.push({
        key: 'submission_time',
        header: 'Submission Time',
        kind: 'date',
        numFmt: SUBMISSION_TIME_NUM_FMT,
      });
    else if (c.key === 'name')
      out.push({ key: 'name', header: 'Name', kind: 'text' });
    else if (c.key === 'phone')
      out.push({ key: 'phone', header: 'Phone Number', kind: 'text' });
    else if (c.key === 'meta_table')
      out.push({
        key: 'meta_table',
        header: 'Meta Lead Ads Table',
        kind: 'text',
      });
    else if (c.key === 'meta_lead_source')
      out.push({ key: 'source', header: 'Source', kind: 'text' });
    else if (c.key === 'form_answers')
      out.push({ key: 'form_answers', header: 'Form Answers', kind: 'text' });
    else if (c.key === 'all_assigned_to')
      out.push({ key: 'assigned_to', header: 'Assigned To', kind: 'text' });
    else if (c.key === 'all_lead_type')
      out.push({ key: 'lead_type', header: 'Type', kind: 'text' });
    else if (c.key === 'all_stage')
      out.push({ key: 'stage', header: 'Stage', kind: 'text' });
    else if (c.key === 'all_call_status')
      out.push({ key: 'call_status', header: 'Call Status', kind: 'text' });
    else if (c.key === 'all_follow_up')
      out.push({
        key: 'follow_up',
        header: 'Follow-up information',
        kind: 'date',
      });
  }
  const unions = buildAllMetaUnionColumns(args.tables, args.fieldsByFlow);
  for (const u of unions) {
    out.push({
      key: `union:${u.key}`,
      header: u.label,
      kind: /date|time/i.test(u.fieldType) ? 'date' : 'text',
      ...(isLastContactDateColumn(u.label)
        ? { numFmt: DATE_ONLY_NUM_FMT }
        : {}),
    });
  }
  return out;
}
