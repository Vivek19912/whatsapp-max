"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Notification } from "@/types";

/**
 * Count of unread notifications for the current user. Used by the
 * sidebar to surface a badge on the Notifications nav entry.
 */
export function useUnreadNotifications(): number {
  const [count, setCount] = useState(0);
  const { user } = useAuth();
  const userId = user?.id;

  // Reset-on-logout plus realtime subscription setup in one effect
  // is intentional here; splitting it risks double-subscribing.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional, see above */
  useEffect(() => {
    if (!userId) {
      setCount(0);
      return;
    }

    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { count: unreadCount, error } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .is("read_at", null);
      if (cancelled || error) return;
      setCount(unreadCount ?? 0);
    })();

    const channel = supabase
      .channel(`notifications-unread-count-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const row = payload.new as Notification;
            if (!row.read_at) setCount((n) => n + 1);
          } else if (payload.eventType === "UPDATE") {
            const newRow = payload.new as Notification;
            if (newRow.read_at) setCount((n) => Math.max(0, n - 1));
          } else if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Notification>;
            if (!oldRow.read_at) setCount((n) => Math.max(0, n - 1));
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return count;
}
