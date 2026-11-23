"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AllMetaFormAnswer } from "@/lib/workspace/all-meta-leads";

/**
 * Form Answers cell for the All Meta Leads combined view.
 *
 * Exactly ONE column. Every actual answer renders as plain cell
 * text — one answer per own line, in the lead's original form
 * order — with no question labels, no pills, no badges, no
 * "N Answers" link, no truncation, no ellipsis, and no fixed
 * height. Long answers wrap fully and rows expand naturally.
 *
 * Each answer is independently hoverable (keyboard-focusable and
 * tappable on touch): hovering one answer shows ONLY that
 * answer's original Meta form question + complete answer in a
 * viewport-safe tooltip. Never the whole form's question list.
 */
export function AllMetaAnswersCell({
  answers,
  tableName,
}: {
  answers: AllMetaFormAnswer[];
  /** Originating table name for the tooltip header context. */
  tableName?: string | null;
}) {
  // Tap-to-pin for touch: tapping an answer toggles its tooltip open.
  // Hover/focus use the default uncontrolled tooltip behavior.
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);

  if (!answers || answers.length === 0) {
    return <span className="text-muted-foreground text-[13px]">—</span>;
  }

  return (
    <span className="block min-w-0">
      {answers.map((a) => (
        <span key={a.key} className="block min-w-0">
          <TooltipProvider delay={150}>
            <Tooltip
              open={pinnedKey === a.key ? true : undefined}
              onOpenChange={(open) => {
                if (!open && pinnedKey === a.key) setPinnedKey(null);
              }}
            >
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={(e) => {
                      // Row clicks open the lead drawer — answer taps
                      // must not bubble there; they pin the tooltip.
                      e.stopPropagation();
                      setPinnedKey((prev) => (prev === a.key ? null : a.key));
                    }}
                    onFocus={() => setPinnedKey(a.key)}
                    onBlur={() =>
                      setPinnedKey((prev) => (prev === a.key ? null : prev))
                    }
                    aria-label={`Answer: ${a.answer}. Question: ${a.question}`}
                    className={cn(
                      "block w-full min-w-0 cursor-help rounded px-1 text-left whitespace-normal break-words",
                      "transition-colors hover:bg-muted hover:underline hover:underline-offset-2 hover:decoration-dotted",
                      "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                    )}
                    style={{ overflowWrap: "anywhere" }}
                  />
                }
              >
                <span className="min-w-0 break-words whitespace-normal">{a.answer}</span>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                align="start"
                sideOffset={8}
                className="z-[70] w-[min(92vw,22rem)] max-w-[22rem] rounded-xl border border-border bg-popover px-3 py-2.5 text-left text-popover-foreground shadow-xl dark:bg-popover dark:text-popover-foreground"
              >
                {tableName ? (
                  <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    {tableName}
                  </p>
                ) : null}
                <p className="mt-1 text-[13px] font-semibold break-words whitespace-normal">
                  Q. {a.question}
                </p>
                <p className="mt-1 text-[13px] break-words whitespace-normal">
                  <span className="text-muted-foreground">Answer: </span>
                  <span className="font-medium">{a.answer}</span>
                </p>
                {a.legacy ? (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Original question unavailable — showing the stored answer.
                  </p>
                ) : null}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </span>
      ))}
    </span>
  );
}
