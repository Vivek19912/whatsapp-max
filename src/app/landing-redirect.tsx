'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { createClient } from '@/lib/supabase/client';

/**
 * Signed-in landing redirect for the public homepage (`/`).
 *
 * Authenticated visitors land on the Meta Lead Ads dashboard
 * instead of the marketing page; everyone else (signed out, or
 * a failed probe) stays on the marketing page untouched.
 *
 * Client-side probe on purpose: the middleware deliberately
 * skips auth on `/` (a slow Supabase lookup wedged the
 * homepage past the proxy timeout), and the AuthProvider lives
 * inside the (dashboard) group — the same direct
 * `createClient().auth.getUser()` pattern `/login`, `/signup`,
 * and `/join/[token]` use. `replace` (not `push`) keeps the
 * marketing page out of history, and the destination differs
 * from `/`, so no redirect loop is possible.
 */
export function SignedInRedirect() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await createClient().auth.getUser();
        if (!cancelled && data.user) {
          router.replace('/meta-lead-ads/dashboard');
        }
      } catch {
        // Signed out or transient failure: stay on the
        // marketing page exactly as before.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
