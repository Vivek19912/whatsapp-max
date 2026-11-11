"use client";

import { ArrowLeft, ExternalLink, MessageCircle } from "lucide-react";

import { workspaceContactHref } from "@/lib/flows/flow-tables";
import type { Conversation } from "@/types";
import {
  formatLeadSubmittedAt,
  type AssignedLead,
} from "./assigned-leads";

/**
 * Lead-only detail view for an assigned Meta Lead Ads lead that has
 * no WhatsApp conversation yet. Rendered in the Inbox center pane
 * when a lead (not a conversation) is selected.
 *
 * Deliberately NOT a chat thread: there is no conversation id, so
 * there is no message list, no composer, no unread badge, and no
 * fabricated previews — only real lead, contact, and assignment
 * data. When the first real message creates the thread, the parent
 * passes it as `threadConversation` and this panel offers a direct
 * jump instead of duplicating the entry.
 */
export function LeadDetailPanel({
  lead,
  threadConversation,
  onOpenConversation,
  onBack,
}: {
  lead: AssignedLead;
  threadConversation: Conversation | null;
  onOpenConversation: (conversation: Conversation) => void;
  onBack: () => void;
}) {
  return (
    <div className="bg-background flex h-full w-full min-w-0 flex-col">
      <div className="border-border flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to inbox list"
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded-md"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="bg-primary/10 text-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-medium">
          {(lead.name || "?").charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-sm font-semibold">
            {lead.name}
          </p>
          <p className="text-muted-foreground truncate text-xs">
            {lead.phone ?? "No phone number"} · Assigned lead
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
          New lead · No WhatsApp conversation yet
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {threadConversation ? (
          <div className="border-border bg-card mb-4 flex items-center gap-3 rounded-lg border p-3">
            <MessageCircle className="text-primary h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-foreground text-sm font-medium">
                This lead now has a WhatsApp conversation
              </p>
              <p className="text-muted-foreground text-xs">
                {threadConversation.last_message_text || "Conversation started."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onOpenConversation(threadConversation)}
              className="bg-primary text-primary-foreground shrink-0 rounded-md px-3 py-1.5 text-xs font-medium hover:opacity-90"
            >
              Open conversation
            </button>
          </div>
        ) : null}

        <dl className="flex flex-col gap-4">
          <div>
            <dt className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
              Contact
            </dt>
            <dd className="text-foreground mt-1 text-sm">
              {lead.phone ? (
                <p>{lead.phone}</p>
              ) : (
                <p className="text-muted-foreground">
                  No usable phone number — messaging is unavailable for this lead.
                </p>
              )}
              {lead.email ? <p className="text-muted-foreground text-xs">{lead.email}</p> : null}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
              Assignment
            </dt>
            <dd className="text-foreground mt-1 text-sm">
              {lead.owner_name ?? "Assigned salesperson"}
              <span className="text-muted-foreground block text-xs">
                Workspace Assigned To · linked member
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
              Lead details
            </dt>
            <dd className="text-foreground mt-1 text-sm">
              <p>{lead.form_name ?? lead.flow_name}</p>
              <p className="text-muted-foreground text-xs">
                {lead.flow_name} · Submitted {formatLeadSubmittedAt(lead.submitted_at)}
              </p>
              <p className="text-muted-foreground text-xs">Stage: {lead.status}</p>
            </dd>
          </div>
          {!threadConversation ? (
            <div>
              <dt className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
                Conversation
              </dt>
              <dd className="text-muted-foreground mt-1 text-xs leading-relaxed">
                No WhatsApp messages exist for this lead yet. When the
                customer replies — or an approved customer template is
                sent — the conversation appears here automatically in
                the normal list.
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-6 flex flex-wrap gap-2">
          {lead.contact_id ? (
            <a
              href={workspaceContactHref(lead.contact_id, { highlightOnly: true })}
              target="_blank"
              rel="noreferrer"
              className="border-border bg-card text-foreground inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in Workspace
            </a>
          ) : (
            <p className="text-muted-foreground text-xs">
              This lead has no contact record — view it in Workspace under{" "}
              {lead.flow_name}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
