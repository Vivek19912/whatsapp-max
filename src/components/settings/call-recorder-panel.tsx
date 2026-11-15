'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Download } from 'lucide-react';

import { callRecorderDownloadUrl } from '@/lib/call-recorder';
import { SettingsPanelHead } from './settings-panel-head';

/** Rendered QR edge size (px) — matches the reference mockup. */
export const CALL_RECORDER_QR_SIZE = 200;

/**
 * CallVault Android app download page — the standalone Workspace
 * settings entry.
 *
 * Deliberately minimal: one heading, one card, a real scannable QR
 * encoding the permanent download URL, and a single blue button
 * pointing at the exact same URL. No extra prose, numbering, or
 * setup guidance.
 */
export function CallRecorderPanel() {
  const url = callRecorderDownloadUrl();
  const [qrSvg, setQrSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      width: CALL_RECORDER_QR_SIZE,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    }).then(
      (svg) => {
        if (!cancelled) setQrSvg(svg);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <section className="animate-in fade-in-50 duration-200">
      <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
        <SettingsPanelHead title="Call Recorder" className="mb-4" />
        <div className="flex flex-col items-center rounded-xl border border-border bg-background px-6 py-10 text-center">
          <div
            style={{
              width: CALL_RECORDER_QR_SIZE,
              height: CALL_RECORDER_QR_SIZE,
            }}
          >
            {qrSvg ? (
              <div
                role="img"
                aria-label={`QR code linking to ${url}`}
                className="[&>svg]:block [&>svg]:h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
            ) : (
              <div className="h-full w-full animate-pulse rounded-lg bg-muted" />
            )}
          </div>
          <p className="mt-4 text-sm font-medium text-foreground">
            Scan to download
          </p>
          <a
            href={url}
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-10 py-3 text-base font-semibold text-white transition-colors hover:bg-blue-700"
          >
            <Download className="size-5" aria-hidden="true" />
            Download APK
          </a>
        </div>
      </div>
    </section>
  );
}
