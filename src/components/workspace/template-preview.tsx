"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Eye } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  formatTemplateCategory,
  type TemplateDetail,
} from "./assignment-template-utils";

/**
 * Fill `{{n}}` body/header placeholders with sample values when
 * available, otherwise show a numbered marker so the required
 * variable stays visible. Pure.
 */
export function renderPreviewText(
  text: string,
  sampleValues: Record<string, string[]> | null | undefined,
  scope: "body" | "header" = "body",
): string {
  if (!text) return "";
  const bucket = sampleValues && typeof sampleValues === "object" && !Array.isArray(sampleValues)
    ? sampleValues[scope]
    : undefined;
  const samples = Array.isArray(bucket) ? bucket.filter((v) => typeof v === "string") : [];
  return text.replace(/\{\{(\d+)\}\}/g, (placeholder, raw: string) => {
    const sample = samples[Number(raw) - 1];
    if (typeof sample === "string" && sample !== "") return sample;
    return placeholder;
  });
}

function ButtonGlyph({ type }: { type: string }) {
  let glyph = "↩ ";
  switch (type) {
    case "PHONE_NUMBER":
      glyph = "📞 ";
      break;
    case "URL":
      glyph = "🔗 ";
      break;
    case "COPY_CODE":
      glyph = "📋 ";
      break;
    default:
      break;
  }
  return <span aria-hidden>{glyph}</span>;
}

/**
 * WhatsApp-style render of one template: header (image preserved at
 * its aspect ratio, or text), full body with newlines, footer, and
 * every button with its label. Long content scrolls inside the
 * popover instead of being cut off. Pure presentation — never
 * mutates the selection.
 */
export function TemplatePreviewCard({ detail }: { detail: TemplateDetail }) {
  const headerType = (detail.headerType ?? "").toLowerCase();
  const body = renderPreviewText(detail.bodyText, detail.sampleValues, "body");
  return (
    <div className="flex flex-col gap-0 overflow-hidden rounded-lg bg-[#e7dfd3] text-left dark:bg-[#0b141a]">
      <div className="px-2 pt-2 text-[11px] font-medium text-muted-foreground">
        <span className="font-semibold text-foreground">{detail.name}</span>
        {" · "}
        {formatTemplateCategory(detail.category)} · {detail.language} · {detail.status || "APPROVED"}
      </div>
      <div className="p-2">
        <div className="overflow-hidden rounded-lg bg-card shadow-sm">
          {headerType === "image" && detail.headerMediaUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={detail.headerMediaUrl}
              alt={`${detail.name} header image`}
              className="h-auto max-h-56 w-full object-contain bg-muted"
              loading="lazy"
            />
          ) : headerType === "image" ? (
            <div className="flex h-24 items-center justify-center bg-muted px-3 text-center text-xs text-muted-foreground">
              Image header unavailable for preview.
            </div>
          ) : detail.headerContent ? (
            <p className="px-2.5 pt-2 text-sm font-semibold text-foreground">
              {renderPreviewText(detail.headerContent, detail.sampleValues, "header")}
            </p>
          ) : null}
          {body ? (
            <p className="whitespace-pre-wrap px-2.5 py-1 text-sm text-foreground">{body}</p>
          ) : (
            <p className="px-2.5 py-1 text-xs italic text-muted-foreground">
              No message body stored for this template.
            </p>
          )}
          {detail.footerText ? (
            <p className="px-2.5 pb-1 text-xs text-muted-foreground">{detail.footerText}</p>
          ) : null}
          {detail.buttons.length > 0 ? (
            <div className="border-t border-border">
              {detail.buttons.map((b, i) => (
                <div
                  key={`${b.type}-${b.text}-${i}`}
                  className="border-b border-border px-2.5 py-1.5 text-center text-sm font-medium text-[#00a884] last:border-b-0 dark:text-[#53bdeb]"
                >
                  <ButtonGlyph type={b.type} />
                  {b.text}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Hover/click/focus preview that never changes the selection.
 * Desktop: hovering the trigger opens after a short delay, leaving
 * closes it. Touch: tapping toggles. Keyboard: focusing opens,
 * blurring closes, Escape dismisses. The popover flips/shifts to
 * stay in the viewport; long templates scroll inside (max height).
 */
export function TemplatePreviewPopover({
  detail,
  unavailableNote = "Full preview is unavailable for this template.",
  children,
  label,
}: {
  /** Null = show the unavailable state instead of fabricating content. */
  detail: TemplateDetail | null;
  unavailableNote?: string;
  children: React.ReactNode;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerId = useId();

  const clearTimers = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  useEffect(() => clearTimers, []);

  const scheduleOpen = useCallback(() => {
    if (pinned) return;
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (open) return;
    openTimer.current = setTimeout(() => setOpen(true), 250);
  }, [open, pinned]);

  const scheduleClose = useCallback(() => {
    if (pinned) return;
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  }, [pinned]);

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        if (!v) setPinned(false);
        setOpen(v);
      }}
    >
      <span
        className="inline-flex min-w-0"
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocus={scheduleOpen}
        onBlur={scheduleClose}
        onClick={(e) => {
          // Preview interaction must never select the template.
          e.stopPropagation();
        }}
      >
        <PopoverTrigger
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            clearTimers();
            setPinned((p) => {
              const next = !p;
              setOpen(next ? true : false);
              return next;
            });
          }}
          className="inline-flex min-w-0 rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span id={triggerId} className="inline-flex min-w-0 items-center gap-1">
            {children}
          </span>
        </PopoverTrigger>
      </span>
      <PopoverContent
        className="max-h-[min(28rem,var(--available-height))] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain p-2"
        side="right"
        align="start"
        sideOffset={8}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        collisionPadding={8}
        onMouseEnter={() => {
          if (closeTimer.current) {
            clearTimeout(closeTimer.current);
            closeTimer.current = null;
          }
        }}
        onMouseLeave={scheduleClose}
        onClick={(e) => e.stopPropagation()}
      >
        {detail ? (
          <TemplatePreviewCard detail={detail} />
        ) : (
          <p className="px-1 py-2 text-xs text-muted-foreground">{unavailableNote}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Small eye affordance used next to template names. */
export function TemplatePreviewEye({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      className="inline-flex shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Eye className="size-3.5" aria-hidden />
    </span>
  );
}
