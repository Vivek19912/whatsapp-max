"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "./searchable-select";
import {
  encodeTemplateKey,
  formatTemplateCategory,
} from "./assignment-template-utils";

export interface SequenceTemplateSlot {
  key: string;
  component: "body" | "header" | "button";
  position: number;
  buttonIndex?: number;
}

/** One send-eligible template for the sequence editor (with slots). */
export interface SequenceTemplateOption {
  template_name: string;
  template_language: string;
  category: string | null;
  status: string;
  preview: string | null;
  body_text: string;
  variables: SequenceTemplateSlot[];
}

export interface SequenceItem {
  template_name: string;
  template_language: string;
  variable_mappings: Record<string, string>;
}

export interface SequenceFieldDef {
  key: string;
  label: string;
}

function slotLabel(slot: SequenceTemplateSlot): string {
  if (slot.component === "body") return `Body {{${slot.position}}}`;
  if (slot.component === "header") return `Header {{${slot.position}}}`;
  return `Button ${slot.buttonIndex! + 1} {{${slot.position}}}`;
}

/** Display-only preview: sample values substituted, unmapped left as {{N}}. */
function previewBody(
  bodyText: string,
  slots: SequenceTemplateSlot[],
  mappings: Record<string, string>,
  sample: Record<string, string> | null,
): string {
  return bodyText.replace(/\{\{(\d+)\}\}/g, (placeholder, raw: string) => {
    const slot = slots.find(
      (s) => s.component === "body" && s.position === Number(raw),
    );
    if (!slot) return placeholder;
    const fieldKey = mappings[slot.key];
    if (!fieldKey || !sample) return placeholder;
    const value = (sample[fieldKey] ?? "").trim();
    return value === "" ? placeholder : value;
  });
}

/**
 * Controlled, read-only-safe editor for one salesperson's
 * customer-facing WhatsApp sequence. Pure UI over the sequence
 * shape shared with the config API: an ordered list of approved
 * templates with per-template variable mappings, plus the delay
 * between consecutive sends. The parent owns the sequence state,
 * loads/saves it through the existing per-salesperson config
 * endpoint, and simply passes it in here.
 *
 * Template selection reuses the same searchable, approved-template
 * selector as the Assignment notification picker: each option shows
 * name + `CATEGORY · language · status`. Selected steps render the
 * same metadata (name, category, language, status) plus any
 * variable mappings against this table's fields.
 */
export function AssigneeSequenceEditor({
  templates,
  fields,
  sample,
  delay,
  items,
  readOnly,
  onDelayChange,
  onItemsChange,
}: {
  templates: readonly SequenceTemplateOption[];
  fields: readonly SequenceFieldDef[];
  sample: Record<string, string> | null;
  delay: string;
  items: readonly SequenceItem[];
  readOnly: boolean;
  onDelayChange: (delay: string) => void;
  onItemsChange: (items: SequenceItem[]) => void;
}) {
  const [pick, setPick] = useState("");

  const chosen = new Set(
    items.map((i) => `${i.template_name}\u0000${i.template_language}`),
  );
  const available = templates.filter(
    (t) => !chosen.has(`${t.template_name}\u0000${t.template_language}`),
  );
  const availableOptions = available.map((t) => ({
    value: encodeTemplateKey({
      name: t.template_name,
      language: t.template_language,
    }),
    label: t.template_name,
    hint: `${formatTemplateCategory(t.category)} · ${t.template_language} · ${t.status}`,
  }));

  function templateFor(item: SequenceItem): SequenceTemplateOption | undefined {
    return templates.find(
      (t) =>
        t.template_name === item.template_name &&
        t.template_language === item.template_language,
    );
  }

  function addPicked() {
    if (readOnly) return;
    if (!pick) return;
    const found = available.find(
      (t) =>
        encodeTemplateKey({
          name: t.template_name,
          language: t.template_language,
        }) === pick,
    );
    if (!found) return;
    onItemsChange([
      ...items,
      {
        template_name: found.template_name,
        template_language: found.template_language,
        variable_mappings: {},
      },
    ]);
    setPick("");
  }

  function move(index: number, dir: -1 | 1) {
    if (readOnly) return;
    const next = [...items];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    const tmp = next[index];
    next[index] = next[j];
    next[j] = tmp;
    onItemsChange(next);
  }

  function remove(index: number) {
    if (readOnly) return;
    onItemsChange(items.filter((_, i) => i !== index));
  }

  function setMapping(index: number, slotKey: string, fieldKey: string) {
    if (readOnly) return;
    onItemsChange(
      items.map((t, i) =>
        i === index
          ? { ...t, variable_mappings: { ...t.variable_mappings, [slotKey]: fieldKey } }
          : t,
      ),
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="assignee-seq-delay">
          Delay between messages (seconds)
        </Label>
        <Input
          id="assignee-seq-delay"
          inputMode="numeric"
          value={delay}
          onChange={(e) => onDelayChange(e.target.value)}
          disabled={readOnly}
          className="max-w-[160px]"
        />
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center">
          <p className="text-sm font-medium text-foreground">
            No customer templates configured
          </p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            {readOnly
              ? "No customer-facing sequence starts for this salesperson."
              : "Pick an approved template below to add the first message sent to a lead on initial assignment."}
          </p>
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {items.map((item, index) => {
            const tpl = templateFor(item);
            const slots = tpl?.variables ?? [];
            const rendered = previewBody(
              tpl?.body_text ?? "",
              slots,
              item.variable_mappings,
              sample,
            );
            return (
              <li
                key={`${item.template_name}\u0000${item.template_language}`}
                className="rounded-lg border border-border bg-card px-3 py-2.5"
              >
                <div className="flex items-center gap-2.5">
                  <span
                    aria-hidden
                    className="bg-primary text-primary-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {item.template_name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {tpl
                        ? `${formatTemplateCategory(tpl.category)} · ${item.template_language} · ${tpl.status}`
                        : item.template_language}
                    </p>
                  </div>
                  {readOnly ? null : (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => move(index, -1)}
                        disabled={index === 0}
                        aria-label={`Move ${item.template_name} up`}
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => move(index, 1)}
                        disabled={index === items.length - 1}
                        aria-label={`Move ${item.template_name} down`}
                      >
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => remove(index)}
                        aria-label={`Remove ${item.template_name}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  )}
                </div>
                {slots.length > 0 ? (
                  <div className="space-y-1.5 border-t border-border pt-2">
                    {slots.map((slot) => {
                      const mappedKey = item.variable_mappings[slot.key] ?? "";
                      const mappedLabel =
                        fields.find((f) => f.key === mappedKey)?.label ?? mappedKey;
                      return (
                        <div key={slot.key} className="flex items-center gap-2">
                          <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
                            {slotLabel(slot)}
                          </span>
                          {readOnly ? (
                            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                              {mappedLabel === "" ? "Not mapped" : mappedLabel}
                            </span>
                          ) : (
                            <Select
                              value={mappedKey}
                              onValueChange={(v: string | null) =>
                                setMapping(index, slot.key, v ?? "")
                              }
                            >
                              <SelectTrigger className="flex-1">
                                <SelectValue placeholder="Select a field…" />
                              </SelectTrigger>
                              <SelectContent>
                                {fields.map((f) => (
                                  <SelectItem key={f.key} value={f.key}>
                                    {f.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      );
                    })}
                    <p className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                      Preview: {rendered}
                      {sample ? null : " (no lead yet — live values fill in per lead)"}
                    </p>
                  </div>
                ) : (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Static template — sends as approved, no mapping needed.
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {readOnly ? null : (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SearchableSelect
              value={pick}
              options={availableOptions}
              onChange={setPick}
              placeholder="Add an approved template…"
              searchPlaceholder="Search templates…"
              emptyText={
                templates.length === 0
                  ? "No APPROVED templates — sync templates from Meta first."
                  : "All approved templates are already in the sequence."
              }
              ariaLabel="Add a customer template"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addPicked}
            disabled={!pick}
            className="shrink-0"
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
