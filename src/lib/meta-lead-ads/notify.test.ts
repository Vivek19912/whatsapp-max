// Meta Lead Ads — new-lead email notifications.
//
// Covers: enable/disable, assigned/unassigned/later-assigned flows,
// missing salesperson email, duplicate + concurrent ingestion,
// existing leads re-encountered by polling, SMTP misconfiguration,
// transient failures with bounded retries, tenant isolation,
// reassignment-after-send, and template rendering safety. SMTP is
// mocked — no real email ever leaves the test process.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildNotifyHtml,
  defaultNotifySettings,
  drainMetaLeadNotifications,
  escapeHtml,
  getMetaSmtpStatus,
  maybeEnqueueForRun,
  maybeEnqueueLeadNotification,
  notifyRetryDelayMs,
  renderNotifyTemplate,
  validateNotifyTemplates,
} from "./notify";
import { sendEmailViaSmtp } from "@/lib/email/send";

vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return { ...actual, sendEmailViaSmtp: vi.fn() };
});

const sendMock = vi.mocked(sendEmailViaSmtp);

// ------------------------------------------------------------
// Fake Supabase client
// ------------------------------------------------------------

interface SubmissionLike {
  id: string;
  account_id: string;
  flow_run_id: string | null;
  contact_id: string | null;
  form_name: string | null;
  campaign_name: string | null;
  ad_name: string | null;
  answers: Record<string, string>;
  field_data: Array<{ name?: string; values?: string[] }>;
  meta_created_time: string | null;
  created_at: string;
}

interface FakeConfig {
  settingsRow?: { enabled: boolean; subject_template: string; body_template: string } | null;
  submission?: SubmissionLike | null;
  submissionByRun?: Record<string, string>;
  profilesByUser?: Record<string, { email: string | null; full_name: string | null }>;
  insertError?: { code: string } | null;
  dueRows?: Record<string, unknown>[];
  claimSucceeds?: boolean;
  runContact?: string | null;
}

interface RecordedUpdate {
  table: string;
  patch: Record<string, unknown>;
  filters: string[];
}

class FakeQuery {
  table: string;
  config: FakeConfig;
  db: { updates: RecordedUpdate[]; inserts: Array<{ table: string; row: Record<string, unknown> }> };
  filters: string[] = [];
  patch: Record<string, unknown> | null = null;
  insertRow: Record<string, unknown> | null = null;

  constructor(
    table: string,
    config: FakeConfig,
    db: { updates: RecordedUpdate[]; inserts: Array<{ table: string; row: Record<string, unknown> }> },
  ) {
    this.table = table;
    this.config = config;
    this.db = db;
  }

  select() { return this; }
  eq(k: string, v: unknown) { this.filters.push(`eq:${k}=${String(v)}`); return this; }
  lte(k: string, v: unknown) { this.filters.push(`lte:${k}=${String(v)}`); return this; }
  in(k: string, v: unknown) { this.filters.push(`in:${k}=${JSON.stringify(v)}`); return this; }
  order() { return this; }
  limit() { return this; }
  update(patch: Record<string, unknown>) { this.patch = patch; return this; }
  insert(row: Record<string, unknown>) { this.insertRow = row; return this; }

  private recordUpdate() {
    if (this.patch) this.db.updates.push({ table: this.table, patch: this.patch, filters: [...this.filters] });
  }

  async maybeSingle(): Promise<{ data: unknown; error: null }> {
    this.recordUpdate();
    if (this.table === "meta_lead_notification_settings") {
      return { data: this.config.settingsRow ?? null, error: null };
    }
    if (this.table === "meta_lead_submissions") {
      if (this.filters.some((f) => f.startsWith("eq:flow_run_id="))) {
        const runId = this.filters.find((f) => f.startsWith("eq:flow_run_id="))!.split("=")[1];
        const subId = this.config.submissionByRun?.[runId];
        return { data: subId ? { id: subId } : null, error: null };
      }
      return { data: this.config.submission ?? null, error: null };
    }
    if (this.table === "profiles") {
      const byUser = this.filters.find((f) => f.startsWith("eq:user_id="));
      const userId = byUser ? byUser.slice("eq:user_id=".length) : "";
      return { data: this.config.profilesByUser?.[userId] ?? null, error: null };
    }
    if (this.table === "flow_runs") {
      return { data: { contact_id: this.config.runContact ?? null }, error: null };
    }
    if (this.table === "meta_lead_notifications") {
      const isClaim = this.filters.some((f) => f.startsWith("eq:id="));
      if (isClaim) {
        const id = this.filters.find((f) => f.startsWith("eq:id="))!.split("=")[1];
        return this.config.claimSucceeds === false
          ? { data: null, error: null }
          : { data: { id }, error: null };
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }

  async single(): Promise<{ data: unknown; error: unknown }> {
    if (this.table === "meta_lead_notifications" && this.insertRow) {
      this.db.inserts.push({ table: this.table, row: this.insertRow });
      if (this.config.insertError) return { data: null, error: this.config.insertError };
      return { data: { id: "notif-1" }, error: null };
    }
    return { data: null, error: null };
  }

  then(resolve: (v: { data: unknown; error: null }) => void) {
    this.recordUpdate();
    if (this.table === "meta_lead_notifications" && this.patch === null) {
      return Promise.resolve({ data: this.config.dueRows ?? [], error: null }).then(resolve);
    }
    return Promise.resolve({ data: null, error: null }).then(resolve);
  }
}

function makeDb(config: FakeConfig = {}) {
  const updates: RecordedUpdate[] = [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const db = {
    updates,
    inserts,
    from(table: string) {
      return new FakeQuery(table, config, { updates, inserts });
    },
  };
  return db;
}

const SETTINGS_ROW = {
  enabled: true,
  subject_template: "New Lead Assigned to You — {{lead_name}}",
  body_template: "Hi {{assignee_name}}, lead {{lead_name}} ({{campaign_name}}) {{lead_link}}",
};

function submission(over: Partial<SubmissionLike> = {}): SubmissionLike {
  return {
    id: "sub-1",
    account_id: "acct-1",
    flow_run_id: "run-1",
    contact_id: "contact-1",
    form_name: "Monsoon Offer",
    campaign_name: "Diwali Campaign",
    ad_name: "Video Ad",
    answers: {},
    field_data: [
      { name: "full_name", values: ["Asha Rao"] },
      { name: "phone_number", values: ["+919876543210"] },
    ],
    meta_created_time: "2026-10-20T10:00:00.000Z",
    created_at: "2026-10-20T10:01:00.000Z",
    ...over,
  };
}

const SALES_PROFILE = { email: "sales@example.com", full_name: "Mohan Sales" };

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...SAVED_ENV };
  process.env.SMTP_HOST = "smtp.gmail.com";
  process.env.SMTP_USER = "leadnotificationss@gmail.com";
  process.env.SMTP_PASS = "app-password-here";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.com";
  sendMock.mockResolvedValue({ messageId: "smtp-1" });
});

// ------------------------------------------------------------
// Enqueue
// ------------------------------------------------------------

describe("maybeEnqueueLeadNotification", () => {
  it("enqueues a new assigned lead when notifications are enabled", async () => {
    const db = makeDb({
      settingsRow: SETTINGS_ROW,
      submission: submission(),
      profilesByUser: { "user-7": SALES_PROFILE },
    });
    const res = await maybeEnqueueLeadNotification(db as never, {
      accountId: "acct-1",
      submissionId: "sub-1",
      assigneeUserId: "user-7",
    });
    expect(res).toMatchObject({ enqueued: true, reason: "enqueued" });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({
      table: "meta_lead_notifications",
      row: expect.objectContaining({
        account_id: "acct-1",
        submission_id: "sub-1",
        recipient_user_id: "user-7",
        recipient_email: "sales@example.com",
        lead_name: "Asha Rao",
        campaign_name: "Diwali Campaign",
      }),
    });
  });

  it("does not enqueue when notifications are disabled", async () => {
    const db = makeDb({
      settingsRow: { ...SETTINGS_ROW, enabled: false },
      submission: submission(),
      profilesByUser: { "user-7": SALES_PROFILE },
    });
    const res = await maybeEnqueueLeadNotification(db as never, {
      accountId: "acct-1",
      submissionId: "sub-1",
      assigneeUserId: "user-7",
    });
    expect(res).toMatchObject({ enqueued: false, reason: "disabled" });
    expect(db.inserts).toHaveLength(0);
  });

  it("treats a missing settings row as disabled (default off)", async () => {
    const db = makeDb({ submission: submission() });
    const res = await maybeEnqueueLeadNotification(db as never, {
      accountId: "acct-1",
      submissionId: "sub-1",
      assigneeUserId: "user-7",
    });
    expect(res).toMatchObject({ enqueued: false, reason: "disabled" });
    expect(db.inserts).toHaveLength(0);
  });

  it("stays pending (no row) when the lead has no assignment yet", async () => {
    const db = makeDb({ settingsRow: SETTINGS_ROW, submission: submission() });
    const res = await maybeEnqueueLeadNotification(db as never, {
      accountId: "acct-1",
      submissionId: "sub-1",
      assigneeUserId: null,
    });
    expect(res).toMatchObject({ enqueued: false, reason: "unassigned" });
    expect(db.inserts).toHaveLength(0);
  });

  it("enqueues when the salesperson is assigned later", async () => {
    const db = makeDb({
      settingsRow: SETTINGS_ROW,
      submissionByRun: { "run-1": "sub-1" },
      submission: submission(),
      profilesByUser: { "user-9": SALES_PROFILE },
    });
    const first = await maybeEnqueueForRun(db as never, {
      accountId: "acct-1",
      runId: "run-1",
      assigneeUserId: null,
    });
    expect(first.reason).toBe("unassigned");
    const later = await maybeEnqueueForRun(db as never, {
      accountId: "acct-1",
      runId: "run-1",
      assigneeUserId: "user-9",
    });
    expect(later).toMatchObject({ enqueued: true, reason: "enqueued" });
    expect(db.inserts).toHaveLength(1);
  });

  it("treats a duplicate insert as already-notified (no second email)", async () => {
    const db = makeDb({
      settingsRow: SETTINGS_ROW,
      submission: submission(),
      profilesByUser: { "user-7": SALES_PROFILE },
      insertError: { code: "23505" },
    });
    const res = await maybeEnqueueLeadNotification(db as never, {
      accountId: "acct-1",
      submissionId: "sub-1",
      assigneeUserId: "user-7",
    });
    expect(res).toMatchObject({ enqueued: false, reason: "duplicate" });
  });

  it("does not enqueue for another account's submission (tenant isolation)", async () => {
    const db = makeDb({
      settingsRow: SETTINGS_ROW,
      submission: null,
      profilesByUser: { "user-7": SALES_PROFILE },
    });
    const res = await maybeEnqueueLeadNotification(db as never, {
      accountId: "acct-2",
      submissionId: "sub-1",
      assigneeUserId: "user-7",
    });
    expect(res).toMatchObject({ enqueued: false, reason: "submission-not-found" });
    expect(db.inserts).toHaveLength(0);
  });

  it("does not send reassignment notifications after a sent row exists", async () => {
    const db = makeDb({
      settingsRow: SETTINGS_ROW,
      submission: submission(),
      profilesByUser: { "user-7": SALES_PROFILE, "user-8": SALES_PROFILE },
      insertError: { code: "23505" },
    });
    const res = await maybeEnqueueLeadNotification(db as never, {
      accountId: "acct-1",
      submissionId: "sub-1",
      assigneeUserId: "user-8",
    });
    expect(res).toMatchObject({ enqueued: false, reason: "duplicate" });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------
// Drain
// ------------------------------------------------------------

function dueRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "notif-1",
    account_id: "acct-1",
    recipient_user_id: "user-7",
    recipient_email: "sales@example.com",
    assignee_name: "Mohan Sales",
    lead_name: "Asha Rao",
    lead_phone: "+919876543210",
    lead_email: null,
    form_name: "Monsoon Offer",
    campaign_name: "Diwali Campaign",
    ad_name: "Video Ad",
    received_at: "2026-10-20T10:00:00.000Z",
    flow_run_id: "run-1",
    status: "queued",
    attempt: 0,
    max_attempts: 3,
    ...over,
  };
}

describe("drainMetaLeadNotifications", () => {
  it("sends to the assigned salesperson's registered address", async () => {
    const db = makeDb({
      settingsRow: SETTINGS_ROW,
      dueRows: [dueRow()],
      profilesByUser: { "user-7": SALES_PROFILE },
      runContact: "contact-1",
    });
    const res = await drainMetaLeadNotifications(db as never);
    expect(res).toMatchObject({ sent: 1, failed: 0 });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const input = sendMock.mock.calls[0]![0];
    expect(input.to).toBe("sales@example.com");
    expect(input.subject).toContain("Asha Rao");
    expect(input.text).toContain("Diwali Campaign");
    expect(input.text).toContain("/workspace?contact=contact-1");
    expect(input.html).toContain("WhatsApp Max");
    const sent = db.updates.find((u) => u.patch.status === "sent");
    expect(sent?.patch.sent_message_id).toBe("smtp-1");
  });

  it("re-resolves the email at send time when the snapshot is empty", async () => {
    const db = makeDb({
      settingsRow: SETTINGS_ROW,
      dueRows: [dueRow({ recipient_email: null })],
      profilesByUser: { "user-7": SALES_PROFILE },
    });
    const res = await drainMetaLeadNotifications(db as never);
    expect(res.sent).toBe(1);
    expect(sendMock.mock.calls[0]![0].to).toBe("sales@example.com");
  });

  it("records a terminal failure when no valid salesperson email exists", async () => {
    const db = makeDb({
      settingsRow: SETTINGS_ROW,
      dueRows: [dueRow({ recipient_email: null, attempt: 2 })],
      profilesByUser: { "user-7": { email: "not-an-email", full_name: null } },
    });
    const res = await drainMetaLeadNotifications(db as never);
    expect(res).toMatchObject({ sent: 0, failed: 1, finalFailures: 1 });
    expect(sendMock).not.toHaveBeenCalled();
    const failed = db.updates.find((u) => u.patch.status === "failed");
    expect(failed?.patch.failed_at).toBeTruthy();
    expect(String(failed?.patch.last_error)).toMatch(/no valid salesperson email/);
  });

  it("skips (without failing) rows whose account disabled notifications", async () => {
    const db = makeDb({
      settingsRow: { ...SETTINGS_ROW, enabled: false },
      dueRows: [dueRow()],
    });
    const res = await drainMetaLeadNotifications(db as never);
    expect(res).toMatchObject({ sent: 0, failed: 0, skippedDisabled: 1 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(db.updates.some((u) => u.patch.status === "failed")).toBe(false);
  });

  it("fails safely when SMTP is not configured", async () => {
    delete process.env.SMTP_HOST;
    const db = makeDb({
      settingsRow: SETTINGS_ROW,
      dueRows: [dueRow()],
      profilesByUser: { "user-7": SALES_PROFILE },
    });
    const res = await drainMetaLeadNotifications(db as never);
    expect(res).toMatchObject({ sent: 0, failed: 1 });
    expect(sendMock).not.toHaveBeenCalled();
    const failed = db.updates.find((u) => u.patch.status === "failed");
    expect(String(failed?.patch.last_error)).toMatch(/SMTP is not configured/);
  });

  it("retries transient SMTP failures with bounded backoff, then sends", async () => {
    const db = makeDb({
      settingsRow: SETTINGS_ROW,
      dueRows: [dueRow()],
      profilesByUser: { "user-7": SALES_PROFILE },
    });
    sendMock.mockRejectedValueOnce(new Error("socket hang up"));
    const first = await drainMetaLeadNotifications(db as never);
    expect(first).toMatchObject({ sent: 0, failed: 1, finalFailures: 0 });
    const retry = db.updates.find((u) => u.patch.status === "failed");
    expect(retry?.patch.next_attempt_at).toBeTruthy();
    expect(retry?.patch.failed_at).toBeFalsy();

    sendMock.mockResolvedValueOnce({ messageId: "smtp-2" });
    const second = await drainMetaLeadNotifications(db as never);
    expect(second.sent).toBe(1);
  });

  it("gives up after max attempts without endless retries", async () => {
    const db = makeDb({
      settingsRow: SETTINGS_ROW,
      dueRows: [dueRow({ attempt: 2, max_attempts: 3 })],
      profilesByUser: { "user-7": SALES_PROFILE },
    });
    sendMock.mockRejectedValue(new Error("535 Authentication failed"));
    const res = await drainMetaLeadNotifications(db as never);
    expect(res).toMatchObject({ sent: 0, failed: 1, finalFailures: 1 });
    const terminal = db.updates.find((u) => u.patch.status === "failed");
    expect(terminal?.patch.next_attempt_at).toBeNull();
    expect(String(terminal?.patch.last_error)).toMatch(/Authentication failed/);
  });

  it("skips rows lost to a concurrent worker (claim lost)", async () => {
    const db = makeDb({
      settingsRow: SETTINGS_ROW,
      dueRows: [dueRow()],
      claimSucceeds: false,
      profilesByUser: { "user-7": SALES_PROFILE },
    });
    const res = await drainMetaLeadNotifications(db as never);
    expect(res).toMatchObject({ sent: 0, failed: 0 });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------
// Rendering + policy
// ------------------------------------------------------------

describe("template rendering", () => {
  it("replaces placeholders and empties unknown keys", () => {
    expect(
      renderNotifyTemplate("Hi {{assignee_name}}, {{lead_name}} {{bogus}}!", {
        lead_name: "Asha",
        lead_phone: "",
        lead_email: "",
        form_name: "",
        campaign_name: "",
        ad_name: "",
        received_at: "",
        lead_link: "https://x/w",
        assignee_name: "Mohan",
      }),
    ).toBe("Hi Mohan, Asha !");
  });

  it("escapes user content in HTML and never injects raw markup", () => {
    const html = buildNotifyHtml("Name: <script>alert(1)</script>", "https://x/w?a=1&b=2");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("https://x/w?a=1&amp;b=2");
    expect(html).toContain("WhatsApp Max");
  });

  it("escapeHtml covers quotes and ampersands", () => {
    expect(escapeHtml(`a"b'c&d<e>`)).toBe("a&quot;b&#39;c&amp;d&lt;e&gt;");
  });

  it("validates templates (empty + oversized rejected)", () => {
    expect(validateNotifyTemplates({ subjectTemplate: "", bodyTemplate: "x" })).toMatchObject({
      error: expect.any(String),
    });
    expect(
      validateNotifyTemplates({ subjectTemplate: "x", bodyTemplate: "x".repeat(4001) }),
    ).toMatchObject({ error: expect.any(String) });
    expect(defaultNotifySettings().enabled).toBe(false);
  });

  it("backoff is bounded", () => {
    expect(notifyRetryDelayMs(1)).toBe(60_000);
    expect(notifyRetryDelayMs(10)).toBe(900_000);
  });
});

describe("getMetaSmtpStatus", () => {
  it("reports missing host and missing credentials distinctly, without secrets", () => {
    delete process.env.SMTP_HOST;
    expect(getMetaSmtpStatus()).toMatchObject({ configured: false });
    process.env.SMTP_HOST = "smtp.gmail.com";
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_PASSWORD;
    const status = getMetaSmtpStatus();
    expect(status.configured).toBe(false);
    expect(JSON.stringify(status)).not.toContain("app-password-here");
  });

  it("is configured when host, user, and pass are present", () => {
    expect(getMetaSmtpStatus().configured).toBe(true);
  });
});
