// Per-assignee customer-facing WhatsApp sequence editor — source
// pins + pure behavior. The editor is a controlled, read-only-safe
// UI over the per-salesperson sequence shape: it renders an ordered
// list of approved templates with variable mappings and a delay,
// and delegates all loading/saving to the Assignment dialog (which
// reuses the existing per-salesperson config endpoint).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AssigneeSequenceEditor,
  type SequenceItem,
  type SequenceTemplateOption,
} from "./assignee-sequence-editor";

const root = process.cwd();
const src = () =>
  readFileSync(
    `${root}/src/components/workspace/assignee-sequence-editor.tsx`,
    "utf8",
  );

const templates: SequenceTemplateOption[] = [
  {
    template_name: "hello_world",
    template_language: "en_US",
    category: "Utility",
    status: "APPROVED",
    preview: "Hello {{1}}",
    body_text: "Hello {{1}}",
    variables: [{ key: "body:1", component: "body", position: 1 }],
  },
  {
    template_name: "lead_reminder",
    template_language: "en_US",
    category: "Marketing",
    status: "APPROVED",
    preview: "Reminder",
    body_text: "Reminder",
    variables: [],
  },
];

const fields = [{ key: "name", label: "Name" }];

describe("assignee sequence editor — read-only gate", () => {
  it("derives every control from readOnly", () => {
    expect(src()).toContain("readOnly");
    expect(src()).toContain("if (readOnly) return;");
    // Reorder/remove/add are edit-only; mappings render read-only.
    expect(src()).toContain("disabled={readOnly}");
    expect(src()).toContain('aria-label={`Move ${item.template_name} up`}');
    expect(src()).toContain('aria-label={`Remove ${item.template_name}`}');
    expect(src()).toContain("Not mapped");
    expect(src()).toContain("{readOnly ? null : (");
  });

  it("renders a clear empty state when no templates are configured", () => {
    const html = renderToStaticMarkup(
      <AssigneeSequenceEditor
        templates={templates}
        fields={fields}
        sample={null}
        delay="0"
        items={[]}
        readOnly={false}
        onDelayChange={() => {}}
        onItemsChange={() => {}}
      />,
    );
    expect(html).toContain("No customer templates configured");
  });

  it("is controlled — never fetches its own data", () => {
    // The editor is a pure UI; the Assignment dialog owns loading
    // and saving through the existing per-salesperson config API.
    expect(src()).not.toContain("fetch(");
  });
});

describe("assignee sequence editor — template presentation", () => {
  it("reuses the shared category formatter for option hints", () => {
    expect(src()).toContain("formatTemplateCategory");
    expect(src()).toContain("encodeTemplateKey");
    expect(src()).toContain("SearchableSelect");
    expect(src()).toContain("searchPlaceholder=");
  });

  it("shows each selected template's category, language, and status", () => {
    const items: SequenceItem[] = [
      { template_name: "hello_world", template_language: "en_US", variable_mappings: {} },
    ];
    const html = renderToStaticMarkup(
      <AssigneeSequenceEditor
        templates={templates}
        fields={fields}
        sample={null}
        delay="0"
        items={items}
        readOnly
        onDelayChange={() => {}}
        onItemsChange={() => {}}
      />,
    );
    expect(html).toContain("hello_world");
    expect(html).toContain("UTILITY");
    expect(html).toContain("en_US");
    expect(html).toContain("APPROVED");
  });

  it("renders variable mappings against the table's fields", () => {
    const items: SequenceItem[] = [
      {
        template_name: "hello_world",
        template_language: "en_US",
        variable_mappings: { "body:1": "name" },
      },
    ];
    const html = renderToStaticMarkup(
      <AssigneeSequenceEditor
        templates={templates}
        fields={fields}
        sample={null}
        delay="0"
        items={items}
        readOnly
        onDelayChange={() => {}}
        onItemsChange={() => {}}
      />,
    );
    expect(html).toContain("Body {{1}}");
    expect(html).toContain("Name");
  });

  it("shows the table's actual column headers in the mapping dropdown", () => {
    const tableFields = [
      { key: "name", label: "Name" },
      { key: "phone", label: "Phone Number" },
      { key: "submitted_at", label: "Submission Time" },
      { key: "answer:full_name", label: "Customer" },
    ];
    const items: SequenceItem[] = [
      {
        template_name: "hello_world",
        template_language: "en_US",
        variable_mappings: { "body:1": "phone" },
      },
    ];
    const html = renderToStaticMarkup(
      <AssigneeSequenceEditor
        templates={templates}
        fields={tableFields}
        sample={null}
        delay="0"
        items={items}
        readOnly
        onDelayChange={() => {}}
        onItemsChange={() => {}}
      />,
    );
    // Real headers — never generic "Phone" / "Submitted At" labels.
    expect(html).toContain("Phone Number");
    expect(html).not.toContain(">Phone<");
  });
});
