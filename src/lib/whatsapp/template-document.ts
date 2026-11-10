/**
 * Shared WhatsApp template document (PDF) validation — single source
 * of truth for the client dialog and the server upload route. The
 * browser MIME is untrusted, so the server MUST re-validate the
 * extension, size, and actual file content (magic bytes).
 *
 * Limits follow Meta's document cap for template header samples
 * (PDF, 100 MB). Samples are stored in the dedicated `template-media`
 * bucket (migration 164), not `chat-media` (16 MB cap).
 */

export const TEMPLATE_DOCUMENT_BUCKET = 'template-media';

/** Meta's document header sample cap. */
export const TEMPLATE_DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;

export const TEMPLATE_DOCUMENT_MIME = 'application/pdf';

/**
 * True when the file name ends in `.pdf` (case-insensitive). Pure.
 */
export function isPdfFileName(fileName: string): boolean {
  return /\.pdf$/i.test((fileName ?? '').trim());
}

/**
 * True when the bytes start with the PDF magic number `%PDF-`
 * (25 50 44 46 2D). Pure + unit-tested; catches renamed non-PDFs
 * that pass the extension check.
 */
export function detectPdfFromBytes(
  bytes: Uint8Array | ArrayBuffer,
): boolean {
  const b =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
  if (b.length < 5) return false;
  return (
    b[0] === 0x25 && // %
    b[1] === 0x50 && // P
    b[2] === 0x44 && // D
    b[3] === 0x46 && // F
    b[4] === 0x2d // -
  );
}

export interface TemplateDocumentFileRef {
  name: string;
  size: number;
  type: string;
}

/**
 * Validate an upload candidate's name, MIME, and size. Returns the
 * user-facing error or null when it looks like a PDF. Never inspects
 * content — pair with `validateTemplateDocumentBytes` server-side.
 * Pure + client-safe.
 */
export function validateTemplateDocumentFile(
  file: TemplateDocumentFileRef,
): string | null {
  if (!isPdfFileName(file.name)) {
    return 'Document header must be a PDF file (.pdf).';
  }
  const mime = (file.type ?? '').toLowerCase().split(';')[0].trim();
  if (mime !== '' && mime !== TEMPLATE_DOCUMENT_MIME) {
    return `Document header must be a PDF (got ${mime}).`;
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return 'The selected PDF is empty.';
  }
  if (file.size > TEMPLATE_DOCUMENT_MAX_BYTES) {
    return `PDF is ${(file.size / 1024 / 1024).toFixed(1)} MB — Meta's document limit is 100 MB.`;
  }
  return null;
}

/**
 * Validate actual file content: must start with the PDF magic number.
 * Run server-side on the received bytes (browser MIME/extension are
 * untrusted). Pure.
 */
export function validateTemplateDocumentBytes(
  bytes: Uint8Array | ArrayBuffer,
): string | null {
  const b =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
  if (b.byteLength === 0) {
    return 'The selected PDF is empty.';
  }
  if (b.byteLength > TEMPLATE_DOCUMENT_MAX_BYTES) {
    return `PDF is ${(b.byteLength / 1024 / 1024).toFixed(1)} MB — Meta's document limit is 100 MB.`;
  }
  if (!detectPdfFromBytes(b)) {
    return 'The uploaded file is not a valid PDF (content check failed).';
  }
  return null;
}

/**
 * Format bytes for the upload UI ("2.4 MB", "840.0 KB"). Pure.
 */
export function humanDocumentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
