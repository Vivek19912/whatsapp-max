import { describe, expect, it } from 'vitest';

import {
  detectPdfFromBytes,
  humanDocumentSize,
  isPdfFileName,
  TEMPLATE_DOCUMENT_MAX_BYTES,
  TEMPLATE_DOCUMENT_MIME,
  validateTemplateDocumentBytes,
  validateTemplateDocumentFile,
} from './template-document';

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const NOT_PDF = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('isPdfFileName', () => {
  it('accepts .pdf case-insensitively', () => {
    expect(isPdfFileName('invoice.pdf')).toBe(true);
    expect(isPdfFileName('Invoice.PDF')).toBe(true);
    expect(isPdfFileName(' my doc.Pdf ')).toBe(true);
  });

  it('rejects non-pdf extensions', () => {
    expect(isPdfFileName('photo.png')).toBe(false);
    expect(isPdfFileName('clip.mp4')).toBe(false);
    expect(isPdfFileName('no-extension')).toBe(false);
    expect(isPdfFileName('pdf')).toBe(false);
    expect(isPdfFileName('')).toBe(false);
  });
});

describe('detectPdfFromBytes', () => {
  it('detects the %PDF- magic number', () => {
    expect(detectPdfFromBytes(PDF_MAGIC)).toBe(true);
  });

  it('rejects non-pdf content and short buffers', () => {
    expect(detectPdfFromBytes(NOT_PDF)).toBe(false);
    expect(detectPdfFromBytes(new Uint8Array(0))).toBe(false);
    expect(detectPdfFromBytes(new Uint8Array([0x25, 0x50]))).toBe(false);
  });
});

describe('validateTemplateDocumentFile', () => {
  it('accepts a valid pdf upload candidate', () => {
    expect(
      validateTemplateDocumentFile({ name: 'terms.pdf', size: 1024, type: 'application/pdf' }),
    ).toBeNull();
  });

  it('accepts an empty browser mime when the extension is .pdf', () => {
    expect(
      validateTemplateDocumentFile({ name: 'terms.pdf', size: 1024, type: '' }),
    ).toBeNull();
  });

  it('rejects non-pdf extensions', () => {
    expect(
      validateTemplateDocumentFile({ name: 'photo.png', size: 1024, type: 'image/png' }),
    ).toContain('.pdf');
  });

  it('rejects mismatched mime types', () => {
    expect(
      validateTemplateDocumentFile({ name: 'terms.pdf', size: 1024, type: 'image/png' }),
    ).toContain('must be a PDF');
  });

  it('rejects empty and oversized files', () => {
    expect(
      validateTemplateDocumentFile({ name: 'terms.pdf', size: 0, type: 'application/pdf' }),
    ).toContain('empty');
    expect(
      validateTemplateDocumentFile({
        name: 'terms.pdf',
        size: TEMPLATE_DOCUMENT_MAX_BYTES + 1,
        type: 'application/pdf',
      }),
    ).toContain('100 MB');
  });
});

describe('validateTemplateDocumentBytes', () => {
  it('accepts real pdf bytes', () => {
    expect(validateTemplateDocumentBytes(PDF_MAGIC)).toBeNull();
  });

  it('rejects renamed non-pdf content', () => {
    expect(validateTemplateDocumentBytes(NOT_PDF)).toContain('not a valid PDF');
  });

  it('rejects empty content', () => {
    expect(validateTemplateDocumentBytes(new Uint8Array(0))).toContain('empty');
  });
});

describe('template document constants', () => {
  it('targets Meta pdf mime with a 100 MB cap', () => {
    expect(TEMPLATE_DOCUMENT_MIME).toBe('application/pdf');
    expect(TEMPLATE_DOCUMENT_MAX_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe('humanDocumentSize', () => {
  it('formats bytes for the upload UI', () => {
    expect(humanDocumentSize(500)).toBe('500 B');
    expect(humanDocumentSize(2048)).toBe('2.0 KB');
    expect(humanDocumentSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
});
