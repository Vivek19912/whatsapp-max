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
 * Critical UI contract (spec §3–4):
 *   - ONE column only; every actual answer visible in full, one per line.
 *   - Answer values directly (never question labels, never a generic
 *     "5 Answers" link, never hidden behind a click).
 *   - No truncation, no ellipsis, no line clamping, no fixed cell height
 *     that cuts off answers. Long text wraps; row height expands.
 *   - Every answer has its OWN hover interaction showing ITS original
 *     question + complete answer (never the whole form).
 *   - Touch devices get an equivalent tap/focus interaction.
 *   - Readable in light and dark modes, stays within the viewport,
 *     supports long Q&A with wrapping.
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
      <span className="flex min-w-0 flex-col items-start gap-1.5 py-0.5">
        {answers.map((a) => (
          <TooltipProvider key={a.key} delay={150}>
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
                    title={`${a.question}: ${a.answer}`}
                    className={cn(
                      "inline-flex max-w-full cursor-help items-start rounded-md border px-2 py-1 text-left text-[12.5px] leading-[18px]",
                      "border-blue-200/70 bg-blue-50 text-blue-900",
                      "dark:border-blue-400/20 dark:bg-blue-500/10 dark:text-blue-100",
                      "hover:border-blue-300 hover:bg-blue-100",
                      "dark:hover:border-blue-400/40 dark:hover:bg-blue-500/20",
                      "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                      // Wrapping, never truncation.
                      "whitespace-normal break-words",
                    )}
                    style={{ overflowWrap: "anywhere" }}
                  />
                }
              >
                <span className="min-w-0 break-words">{a.answer}</span>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                align="start"
                sideOffset={8}
                className="z-[70] w-[min(92vw,22rem)] rounded-xl border border-border bg-popover px-3 py-2.5 text-left text-popover-foreground shadow-xl"
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
        ))}
      </span>
    </span>
  );
}
