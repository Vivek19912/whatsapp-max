import { NextResponse } from 'next/server';

/**
 * GET /download/call-recorder — permanent, version-independent
 * Call Recorder (CallVault) APK endpoint.
 *
 * Public: no WhatsApp Max login required (Android users scan the
 * Settings QR with their phone camera). The QR code and the Download
 * APK button both point here, so replacing the APK never changes
 * them — publish a newer approved release behind the same endpoint.
 *
 * Artifact wiring: set CALL_RECORDER_APK_URL to the approved
 * production-signed APK location (object storage / CDN). The
 * redirect is `no-store` so clients always re-resolve this endpoint;
 * keep the artifact itself overwrite-in-place with no-cache headers
 * (or a versioned object) so updates propagate.
 *
 * Until an approved production-signed APK is published (see the
 * panel notes: package `com.baba.callvault`, real release signing —
 * no debug/unsigned builds), this answers 503 instead of serving an
 * invalid file.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = 'no-store, no-cache, must-revalidate';

export async function GET() {
  const target = process.env.CALL_RECORDER_APK_URL?.trim();
  if (target && /^https:\/\//i.test(target)) {
    const res = NextResponse.redirect(target, 302);
    res.headers.set('Cache-Control', NO_STORE);
    return res;
  }
  return NextResponse.json(
    { error: 'Call Recorder APK is not published yet.' },
    { status: 503, headers: { 'Cache-Control': NO_STORE } },
  );
}
