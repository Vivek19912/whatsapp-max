"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, Fragment, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { getTravelCrmUrl } from "@/lib/travel-crm";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import Image from "next/image";
import {
  Bell,
  Bot,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  FileText,
  LayoutDashboard,
  MessageSquare,
  MessageSquareText,
  Mic,
  Phone,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Radio,
  Route,
  Settings,
  Sheet,
  Table2,
  Users,
  UsersRound,
  Workflow,
  X,
  Zap,
  UserX,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
}

export const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/inbox", label: "Inbox", icon: MessageSquare },
  { href: "/calls", label: "Calls", icon: Phone },
  { href: "/recordings", label: "Recordings", icon: Mic },
  { href: "/flows", label: "Flows", icon: Workflow, beta: false },
  { href: "/followups", label: "Reminders", icon: CalendarClock },
  { href: "/workspace", label: "Workspace", icon: Table2, beta: true },
  { href: "/broadcasts", label: "Bulk Messages", icon: Radio },
  { href: "/quick-replies", label: "Quick Replies", icon: MessageSquareText },
  { href: "/automations", label: "Automations", icon: Zap },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/agents", label: "AI Agents", icon: Bot },
  { href: "/data-export", label: "Flow Sheets", icon: Sheet },
  { href: "/all-sheets", label: "All Sheets", icon: Sheet },
  { href: "/chat-assignment", label: "Chat Assignment", icon: Route },
];

const bottomNavItems = [
  { href: "/settings", label: "Settings", icon: Settings },
];

/** Google Sheets starts collapsed on every sidebar mount (no persistence). */
export const DEFAULT_SHEETS_COLLAPSED = true;

/**
 * Whether the Google Sheets group shows its children. An
 * explicitly expanded group is always open; a collapsed group
 * still opens when the user is on a sheets child route so the
 * active row is never hidden.
 */
export function resolveSheetsOpen(
  sheetsCollapsed: boolean,
  pathname: string
): boolean {
  if (!sheetsCollapsed) return true;
  return (
    pathname.startsWith("/data-export") || pathname.startsWith("/all-sheets")
  );
}

interface SidebarProps {
  /** Controlled on mobile by the Header's hamburger button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
  /**
   * Desktop icon rail. Affects lg+ presentation classes ONLY — the
   * mobile drawer always renders full-width regardless.
   */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

/**
 * Keyboard-accessible name tooltip for collapsed-rail icons.
 * Rendered only when collapsed (expanded rows already show their
 * labels); the wrapped link/anchor stays natively focusable, so
 * tooltips appear on keyboard focus as well as hover.
 */
function NavTip({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed?: boolean;
  children: ReactElement;
}) {
  if (!collapsed) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({ open = false, onClose, collapsed = false, onToggleCollapse }: SidebarProps) {
  const pathname = usePathname();
  const { profileLoading, account, accountRole, canEditSettings } = useAuth();
  // Team Members is a standalone page at /team-members.
  const isTeamMembersActive = pathname.startsWith("/team-members");
  // Collapsible GOOGLE SHEETS group (Flow Sheets + All Sheets).
  // Default COLLAPSED on every sidebar mount — no persistence, so a
  // refresh/reload always starts closed. Forced open while a sheets
  // child route is active so the highlighted row is never hidden
  // inside a closed group.
  const [sheetsCollapsed, setSheetsCollapsed] = useState(
    DEFAULT_SHEETS_COLLAPSED
  );
  const sheetsOpen = resolveSheetsOpen(sheetsCollapsed, pathname);
  // UI-only gating: Flows, AI Agents, and Settings are shown to the owner
  // only. Non-owners simply don't see these nav entries. This is purely a
  // visibility change — the backend/routes are untouched, so it can be
  // reverted by removing the `isOwner` checks below.
  const isOwner = accountRole === "owner";
  const visibleNavItems = navItems.filter((item) => {
    if (
      !isOwner &&
      (item.href === "/flows" || item.href === "/agents" || item.href === "/data-export" || item.href === "/all-sheets" || item.href === "/workspace" || item.href === "/chat-assignment")
    ) {
      return false;
    }
    return true;
  });
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();
  // Cross-app card target — centralized in getTravelCrmUrl so a
  // missing/invalid value falls back to the default Travel CRM URL
  // instead of hiding the card. Wait for the profile fetch to settle
  // first, otherwise the card flashes in once the row resolves.
  const travelCrmUrl = !profileLoading ? getTravelCrmUrl(account) : null;

  // Close the drawer when route changes — users opened it to navigate,
  // so once they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't positioned there.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      />

      <aside
        className={cn(
          // Mobile: fixed drawer that slides in from the left.
          "fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r border-border bg-card",
          "transition-[transform,width] duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          // Desktop: static in the flex row (content expands
          // automatically); width animates full <-> rail.
          "lg:static lg:relative lg:z-0 lg:translate-x-0",
          collapsed ? "lg:w-16" : "lg:w-60",
        )}
        aria-label="Primary"
      >
        {/* Header row: brand lockup on the left, desktop collapse/
            expand toggle in the top-right corner (beside the logo and
            branding, vertically centered), mobile close button on the
            right. The toggle reuses the shell-owned onToggleCollapse
            handler — never a second collapse implementation. */}
        <div
          className={cn(
            "flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4",
            collapsed && "lg:gap-0 lg:px-1",
          )}
        >
          <Link
            href="/dashboard"
            className="flex items-center gap-2"
            aria-label="Dashboard"
          >
  <Image
    src="/logo.png"
    alt="WhatsApp Max"
    width={32}
    height={32}
    className="h-8 w-8 rounded-lg"
  />
  <span className={cn("text-sm font-semibold text-foreground", collapsed && "lg:hidden")}>
  <p className="text-[15.6px] leading-tight">WhatsApp Max</p>
  <p className="text-[9.8px] leading-tight text-muted-foreground">By Interscale Marketing</p>
</span>
</Link>
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none lg:flex"
            >
              {collapsed ? (
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="flex flex-col gap-1">
            {visibleNavItems.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== "/dashboard" && pathname.startsWith(item.href));

              const showUnreadDot =
                item.href === "/inbox" && totalUnread > 0 && !isActive;

              // Unlike the inbox dot, the notifications count stays visible
              // even while the page is active — it reflects unread state
              // (cleared by marking notifications read), not "currently
              // viewing this section".
              const showNotificationBadge =
                item.href === "/notifications" && unreadNotifications > 0;

              return (
                <Fragment key={item.href}>
                  {/* Collapsible group header for the two sheets
                      entries — a button, never a navigation link.
                      Rendered inline at the first sheets item so
                      owner-gating and ordering stay untouched.
                      Hidden on the collapsed rail (icons remain). */}
                  {item.href === "/data-export" && (
                    <li className={cn(collapsed && "lg:hidden")}>
                      <button
                        type="button"
                        onClick={() => setSheetsCollapsed((v) => !v)}
                        aria-expanded={sheetsOpen}
                        className="flex w-full items-center justify-between px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Google Sheets
                        {sheetsOpen ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </li>
                  )}
                  {((item.href === "/data-export" || item.href === "/all-sheets") && !sheetsOpen && !collapsed) ? null : (
                  <li>
                  <NavTip label={item.label} collapsed={collapsed}>
                  <Link
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      // Taller on mobile so fingers can hit the row reliably (≥44px).
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      // Collapsed rail: centered icon only; labels and
                      // extras hide on lg, the drawer is unaffected.
                      collapsed && "lg:justify-center lg:gap-0 lg:px-0",
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className={cn("flex-1", collapsed && "lg:hidden")}>{item.label}</span>
                    {item.beta && (
                      <span
                        aria-label="Beta feature"
                        className={cn(
                          "rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300",
                          collapsed && "lg:hidden"
                        )}
                      >
                        Beta
                      </span>
                    )}
                    {showUnreadDot && (
                      <span
                        aria-label={`${totalUnread} unread conversation${totalUnread === 1 ? "" : "s"}`}
                        className={cn("relative flex h-2 w-2", collapsed && "lg:hidden")}
                      >
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                      </span>
                    )}
                    {showNotificationBadge && (
                      <span
                        aria-label={`${unreadNotifications} unread notification${unreadNotifications === 1 ? "" : "s"}`}
                        className={cn(
                          "flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground",
                          collapsed && "lg:hidden"
                        )}
                      >
                        {unreadNotifications > 9 ? "9+" : unreadNotifications}
                      </span>
                    )}
                  </Link>
                  </NavTip>
                </li>
                  )}
                </Fragment>
              );
            })}
          </ul>

          {/* Bottom section: Team Members standalone page above Settings.
              Identical row markup to the entries below. */}
          {/* Settings — visible to all roles. */}
          <div className="my-4 border-t border-border" />

              <ul className="flex flex-col gap-1">
                {canEditSettings && (
                  <li key="/team-members">
                    <NavTip label="Team Members" collapsed={collapsed}>
                    <Link
                      href="/team-members"
                      aria-current={isTeamMembersActive ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                        isTeamMembersActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        collapsed && "lg:justify-center lg:gap-0 lg:px-0",
                      )}
                    >
                      <UsersRound className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className={cn(collapsed && "lg:hidden")}>Team Members</span>
                    </Link>
                    </NavTip>
                  </li>
                )}
                {bottomNavItems.map((item) => {
                  const isActive =
                    pathname.startsWith(item.href) && !isTeamMembersActive;
                  return (
                    <li key={item.href}>
                      <NavTip label={item.label} collapsed={collapsed}>
                      <Link
                        href={item.href}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                          isActive
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                          collapsed && "lg:justify-center lg:gap-0 lg:px-0",
                        )}
                      >
                        <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className={cn(collapsed && "lg:hidden")}>{item.label}</span>
                      </Link>
                      </NavTip>
                    </li>
                  );
                })}
              </ul>
        </nav>

        {/* Travel CRM cross-app card. This replaces the old sidebar
            profile block (avatar/name/email) — the top-right header
            menu remains the profile home. Hidden entirely when no URL
            is configured. Opens in a new tab; never a router link. */}
        {travelCrmUrl ? (
          <div className={cn("shrink-0 border-t border-border p-3", collapsed && "lg:flex lg:justify-center lg:p-2")}>
            <NavTip label="Travel Agency CRM" collapsed={collapsed}>
            <a
              href={travelCrmUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open Travel Agency CRM in a new tab"
              title="Open Travel Agency CRM in a new tab"
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-indigo-500 ring-1 ring-inset ring-indigo-500/20 transition-colors duration-150 hover:bg-indigo-500/10",
                collapsed && "lg:gap-0 lg:px-2",
              )}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white">
                <Image
                  src="/icons/travel-agency-crm.png"
                  alt="Travel Agency CRM"
                  width={24}
                  height={24}
                  className="h-6 w-6 object-contain"
                />
              </span>
              <span className={cn("min-w-0 flex-1 truncate leading-tight", collapsed && "lg:hidden")}>
                Travel Agency CRM
              </span>
              <ExternalLink
                className={cn("h-3.5 w-3.5 shrink-0 opacity-70", collapsed && "lg:hidden")}
                aria-hidden="true"
              />
            </a>
            </NavTip>
          </div>
        ) : null}
      </aside>
    </>
  );
}
