import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { FollowupKpiCards } from "./workspace-followup-kpis";

const COUNTS = { overdue: 8, today: 12, tomorrow: 5, upcoming: 21 };

describe("FollowupKpiCards", () => {
  it("renders four server-provided counts with labels, no icons", () => {
    const out = renderToStaticMarkup(
      <FollowupKpiCards counts={COUNTS} loading={false} error={null} onRetry={() => {}} />,
    );
    for (const [label, count] of [["Overdue", "8"], ["Due Today", "12"], ["Tomorrow", "5"], ["Upcoming", "21"]]) {
      expect(out).toContain(`>${label}<`);
      expect(out).toContain(`>${count}<`);
    }
    expect(out).not.toContain("<svg");
  });

  it("keeps identical card heights with prominent counts", () => {
    const out = renderToStaticMarkup(
      <FollowupKpiCards counts={COUNTS} loading={false} error={null} onRetry={() => {}} />,
    );
    expect(out.match(/min-h-\[80px\]/g)?.length).toBe(4);
    expect(out).toContain("text-[26px]");
    expect(out).toContain("uppercase");
  });

  it("shows skeleton placeholders while loading instead of stale zeros", () => {
    const out = renderToStaticMarkup(
      <FollowupKpiCards counts={{ overdue: 0, today: 0, tomorrow: 0, upcoming: 0 }} loading error={null} onRetry={() => {}} />,
    );
    expect(out).toContain("animate-pulse");
    expect(out).not.toContain(">0<");
  });

  it("shows a subtle error with retry instead of misleading zeros", () => {
    const onRetry = vi.fn();
    void onRetry;
    const out = renderToStaticMarkup(
      <FollowupKpiCards counts={{ overdue: 0, today: 0, tomorrow: 0, upcoming: 0 }} loading={false} error="boom" onRetry={() => {}} />,
    );
    expect(out).toContain("unavailable");
    expect(out).toContain(">Retry<");
  });

  it("marks the active bucket with aria-pressed and a restrained tint, others unpressed", () => {
    const out = renderToStaticMarkup(
      <FollowupKpiCards counts={COUNTS} loading={false} error={null} onRetry={() => {}} activeBucket="overdue" onSelectBucket={() => {}} />,
    );
    expect(out.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(out.match(/aria-pressed="false"/g)?.length).toBe(3);
    expect(out).toContain("border-primary/60");
    expect(out).toContain('aria-label="Filter by Overdue"');
  });

  it("leaves every bucket unpressed when no KPI filter is active", () => {
    const out = renderToStaticMarkup(
      <FollowupKpiCards counts={COUNTS} loading={false} error={null} onRetry={() => {}} activeBucket={null} onSelectBucket={() => {}} />,
    );
    expect(out).not.toContain('aria-pressed="true"');
    expect(out.match(/aria-pressed="false"/g)?.length).toBe(4);
    expect(out).not.toContain("border-primary/60");
  });

  it("switches the pressed bucket without touching the displayed counts", () => {
    const forToday = renderToStaticMarkup(
      <FollowupKpiCards counts={COUNTS} loading={false} error={null} onRetry={() => {}} activeBucket="today" onSelectBucket={() => {}} />,
    );
    expect(forToday.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(forToday).toContain('aria-label="Filter by Due Today"');
    // Counts always reflect the whole table, never the filtered view.
    for (const count of ["8", "12", "5", "21"]) {
      expect(forToday).toContain(`>${count}<`);
    }
  });

  it("stays non-interactive without a select handler (backward compatible)", () => {
    const out = renderToStaticMarkup(
      <FollowupKpiCards counts={COUNTS} loading={false} error={null} onRetry={() => {}} />,
    );
    expect(out).not.toContain("aria-pressed");
    expect(out).not.toContain("Filter by");
    expect(out).toContain("cursor-default");
  });

  it("keeps the semantic colour per bucket when selected", () => {
    const out = renderToStaticMarkup(
      <FollowupKpiCards counts={COUNTS} loading={false} error={null} onRetry={() => {}} activeBucket="tomorrow" onSelectBucket={() => {}} />,
    );
    expect(out).toContain("text-red-600");
    expect(out).toContain("text-amber-600");
    expect(out).toContain("text-violet-600");
    expect(out).toContain("text-blue-600");
  });
});
