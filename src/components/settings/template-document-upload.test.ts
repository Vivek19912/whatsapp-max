// Template document upload UI — source pins for the New Message
// Template dialog's document header section.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const src = (p: string) => readFileSync(`${root}/${p}`, 'utf8');

describe('template document upload UI', () => {
  const dialog = src('src/components/settings/template-manager.tsx');

  it('offers both upload and url sources for document headers', () => {
    expect(dialog).toContain('aria-label="Document source"');
    expect(dialog).toContain('Upload PDF');
    expect(dialog).toContain('Paste URL');
    // Existing URL functionality is preserved (input + validation).
    expect(dialog).toContain('paste a public document link');
    expect(dialog).toContain('switchDocSource');
  });

  it('accepts pdf files with browse and drag-and-drop', () => {
    expect(dialog).toContain('accept=".pdf,application/pdf"');
    expect(dialog).toContain('Click to browse or drag and drop a PDF');
    expect(dialog).toContain('onDrop');
    expect(dialog).toContain('onDragOver');
    expect(dialog).toContain('aria-label="Upload a PDF document"');
  });

  it('shows filename, size, progress, and replace/remove actions', () => {
    expect(dialog).toContain('humanDocumentSize');
    expect(dialog).toContain('role="progressbar"');
    expect(dialog).toContain('Uploading…');
    expect(dialog).toContain('Replace');
    expect(dialog).toContain('Remove staged PDF');
    expect(dialog).toContain('removeStagedDoc');
  });

  it('uploads through the authenticated api with pre-validation', () => {
    expect(dialog).toContain('/api/whatsapp/templates/header-document/upload');
    expect(dialog).toContain('validateTemplateDocumentFile');
    expect(dialog).toContain('new XMLHttpRequest');
    expect(dialog).toContain('xhr.upload.onprogress');
  });

  it('surfaces upload errors inline and preserves other inputs', () => {
    // Inline alert (not a form reset) — the shared form state is only
    // ever patched, never cleared, on upload failure.
    expect(dialog).toContain('role="alert"');
    expect(dialog).toContain('setDocError');
    expect(dialog).toContain('setForm((f) => ({ ...f, header_media_url: publicUrl }))');
  });

  it('prevents duplicate uploads and submissions', () => {
    expect(dialog).toContain('disabled={uploadingDoc}');
    expect(dialog).toContain('uploadingDoc ||');
    expect(dialog).toContain('Wait for the PDF upload to finish');
  });

  it('keeps only one source active at a time', () => {
    // Switching clears the shared url field so a stale reference can
    // never be submitted; leaving Upload deletes the orphaned file.
    expect(dialog).toContain("setForm((f) => ({ ...f, header_media_url: '' }))");
    expect(dialog).toContain('deleteStagedDoc');
  });

  it('leaves image/video header behavior untouched', () => {
    expect(dialog).toContain('Upload image');
    expect(dialog).toContain('accept="image/jpeg,image/png"');
    expect(dialog).toContain("or paste a public ${form.header_format} link");
  });
});
