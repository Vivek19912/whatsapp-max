// POST /api/integrations/meta-lead-ads/notifications/test
//
// Admin-only SMTP verification: sends a clearly-marked SAMPLE new-lead
// notification to the caller's OWN registered profile email. The
// recipient is always resolved server-side — never caller-supplied —
// so this endpoint cannot be used to send mail to arbitrary
// addresses. Proves the Gmail SMTP configuration works before the
// account relies on it.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { sendTestNotificationEmail } from "@/lib/meta-lead-ads/notify";

export async function POST() {
  try {
    const ctx = await requireRole("admin");
    const result = await sendTestNotificationEmail(ctx.supabase, {
      accountId: ctx.accountId,
      userId: ctx.userId,
    });
    return NextResponse.json({
      ok: true,
      to: result.to,
      messageId: result.messageId ?? null,
      note: "Sample notification sent to your own registered email. No real lead was involved.",
    });
  } catch (err) {
    // Preserve auth statuses (401/403); SMTP/config failures are 400.
    const raw = err instanceof Error ? (err as { status?: unknown }).status : undefined;
    const status = typeof raw === "number" && raw !== 500 ? raw : 400;
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status });
    }
    return toErrorResponse(err);
  }
}
