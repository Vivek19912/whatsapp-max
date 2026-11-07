import { redirect } from 'next/navigation';

/**
 * `/dashboard` lands on the Meta Lead Ads dashboard.
 *
 * Server-side route redirect (no client JavaScript involved), so
 * direct URL entry and refresh behave identically. Authentication
 * is untouched: middleware still guards `/dashboard` first, so
 * unauthenticated visitors follow the existing login flow and
 * only signed-in users arrive here. No loop is possible — the
 * destination is a different route that never redirects back.
 * The previous dashboard implementation is preserved verbatim in
 * `./dashboard-view`, alongside its APIs, charts, and statistics.
 */
export default function DashboardPage() {
  redirect('/meta-lead-ads/dashboard');
}
