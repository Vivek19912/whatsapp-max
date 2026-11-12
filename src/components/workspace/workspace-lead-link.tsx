'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { workspaceContactHref } from '@/lib/flows/flow-tables';

/**
 * Shared Workspace lead deep link — used by the Recordings table
 * and the Call Analytics Recent Calls table (one implementation,
 * never two navigation flows).
 *
 * Opens the lead's own Workspace table in a NEW tab, located by
 * stable `contacts.id` (never name/phone) through the existing
 * `?contact=` deep-link flow: the Workspace page locates the row,
 * scrolls it into view, applies the ~4s blue-wash highlight, and
 * opens the same lead drawer a row click opens. `rel="noreferrer"`
 * (implies `noopener`) so the new tab cannot touch this page.
 */
export function WorkspaceLeadLink({
  contactId,
  children,
  title,
  className,
}: {
  /** Stable `contacts.id`. Never render for null/blank ids. */
  contactId: string;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <a
      href={workspaceContactHref(contactId)}
      target="_blank"
      rel="noreferrer"
      title={title}
      className={cn(
        'truncate font-medium text-blue-600 hover:underline focus-visible:underline focus-visible:outline-none dark:text-blue-400',
        className
      )}
    >
      {children}
    </a>
  );
}
