import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// TemplateManager View action — icon-only Eye button first (View,
// Edit, Delete) opening a read-only preview dialog over the
// already-loaded row. The manager is a client component with live
// Supabase calls, so (like the Dial action tests) this pins the
// integration points as source assertions: button order/labels,
// dialog wiring, complete read-only content, and no write paths.
// ---------------------------------------------------------------------------

const root = process.cwd();
const src = readFileSync(
  `${root}/src/components/settings/template-manager.tsx`,
  "utf8",
);

describe("View action placement and labels", () => {
  it("renders View before Edit and Delete with tooltips", () => {
    const viewIdx = src.indexOf('aria-label="View template"');
    expect(viewIdx).toBeGreaterThan(-1);
    expect(src).toContain('title="View template"');
    // View opens the preview; it never touches the edit form.
    // (The onClick sits just above the aria-label; scope to this
    // button's close tag so later card actions don't leak in.)
    const viewBlock = src.slice(
      Math.max(0, viewIdx - 400),
      src.indexOf("</Button>", viewIdx),
    );
    expect(viewBlock).toContain("setPreviewTemplate(template)");
    expect(viewBlock).not.toContain("openEdit");
    // Order: the View button precedes every Edit/Delete control
    // on the card.
    expect(viewIdx).toBeLessThan(src.indexOf('aria-label="Edit template"'));
    expect(viewIdx).toBeLessThan(src.indexOf("setTemplateToDelete(template)"));
  });

  it("uses the Eye icon at the shared icon-button size", () => {
    expect(src).toContain('<Eye className="size-4" />');
  });
});

describe("read-only preview dialog", () => {
  it("opens from View state and closes without side effects", () => {
    expect(src).toContain("previewTemplate !== null");
    expect(src).toContain("TemplatePreviewBody");
    expect(src).toContain("Template Preview");
    expect(src).toContain("Close");
  });

  it("displays the complete stored template verbatim", () => {
    // Name, category, status, language badges.
    expect(src).toContain("{template.name}");
    expect(src).toContain("{template.category}");
    expect(src).toContain("{template.language}");
    expect(src).toContain("status.classes");
    // Header, body, footer rendered as stored text (pre-wrap
    // preserves line breaks; no sample substitution anywhere).
    expect(src).toContain("{template.header_content}");
    expect(src).toContain("{template.body_text}");
    expect(src).toContain("{template.footer_text}");
    expect(src).toContain("whitespace-pre-wrap");
    // Buttons with their stored details.
    expect(src).toContain("{b.text}");
    expect(src).toContain("{b.url}");
    expect(src).toContain("{b.phone_number}");
  });

  it("writes nothing: no submit, edit, delete, or sync paths", () => {
    const openIdx = src.indexOf("TemplatePreviewBody");
    const bodyStart = src.indexOf("function TemplatePreviewBody");
    const bodyEnd = src.indexOf("export function TemplateManager()");
    const body = src.slice(bodyStart, bodyEnd);
    for (const writer of [
      "handleSubmit",
      "openEdit",
      "setTemplateToDelete",
      "confirmDelete",
      "setForm(",
      "handleSyncFromMeta",
      "fetchTemplates",
    ]) {
      expect(body).not.toContain(writer);
    }
    expect(openIdx).toBeGreaterThan(-1);
  });
});
