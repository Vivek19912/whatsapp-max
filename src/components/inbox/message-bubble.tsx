"use client";

import { useState, useEffect, useCallback, useRef, Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Message, MessageReaction, MessageTemplate } from "@/types";
import {
  Download,
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
  X,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import { LinkifiedText } from "./linkified-text";
import { linkify } from "@/lib/inbox/linkify";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  /**
   * Approved-template header fallback for `content_type === 'template'`
   * rows (see resolveTemplateHeaderMedia). The thread provides it from
   * its client-side approved-templates fetch; absent/null means
   * render from the row's own media_url only.
   */
  template?: TemplateHeaderInfo | null;
}

/**
 * Seen/Unseen product semantics (locked): only Meta `read` renders
 * Seen; `sent` and `delivered` both render Unseen. Forward-only
 * status ordering is enforced upstream (webhook mirror + realtime
 * merge) — this mapping never changes it.
 */
export function displayMessageStatus(status: Message["status"]) {
  if (status === "read") return "Seen";
  if (status === "failed") return "Failed";
  if (status === "sending") return "Sending";
  return "Unseen";
}

function MediaUnavailable({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{label} unavailable</span>
    </div>
  );
}

/**
 * Full-screen lightbox overlay for viewing an expanded image.
 * Closes on backdrop click, close-button click, or Escape key.
 */
function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-black/40 p-2 text-white hover:bg-black/60"
        aria-label="Close image"
      >
        <X className="h-5 w-5" />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

/**
 * Display name for a document bubble. Prefers the persisted original
 * filename (migration 077); falls back to the caption (inbound
 * webhook documents store caption||filename there) and finally a
 * generic label. Never derives from Storage object keys — those are
 * `account-<id>/<ts>-<safe>` paths, not human names.
 */
export function documentDisplayName(message: {
  media_file_name?: string | null;
  content_text?: string | null;
}): string {
  return (
    message.media_file_name?.trim() ||
    message.content_text?.trim() ||
    "Document"
  );
}

function MediaImage({
  url,
  alt,
  compact,
  fill,
}: {
  url: string;
  alt: string;
  /** Stickers render smaller; same lazy fetch + lightbox. */
  compact?: boolean;
  /**
   * Fill the parent width (WhatsApp-style media-template headers):
   * `width:100%`, auto height, aspect preserved, fully visible.
   * Default (non-fill) keeps the intrinsic-size behavior for ordinary
   * messages so small images don't inflate the bubble.
   */
  fill?: boolean;
}) {
  // Proxy URLs need an authenticated fetch at runtime, so they can only
  // resolve client-side. Direct CDN/public URLs are usable immediately —
  // initializing them synchronously also makes server/static renders
  // include the image instead of a permanent spinner.
  const isProxyUrl = url.startsWith("/api/whatsapp/media/");
  const [src, setSrc] = useState<string | null>(() =>
    isProxyUrl ? null : url,
  );
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(() => isProxyUrl);
  const [isExpanded, setIsExpanded] = useState(false);
  // Viewport-gated: proxy URLs are fetched (auth blob) only once the
  // bubble scrolls near the viewport — opening a conversation with 50
  // images must not fire 50 media requests up front. Outside a
  // browser (SSR/static render, no IntersectionObserver) there is no
  // viewport to gate on, so render immediately.
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const loadImage = useCallback(async () => {
    if (!url) return;

    // Proxy URLs need auth fetch to create blob URL
    if (url.startsWith("/api/whatsapp/media/")) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load media");
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        setSrc(blobUrl);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    } else {
      setSrc(url);
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    if (!visible) return;
    loadImage();
    return () => {
      if (src?.startsWith("blob:")) {
        URL.revokeObjectURL(src);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, loadImage]);

  // Loading / error placeholder frames reserve space without
  // stretching the bubble. Fill mode takes the full parent width with
  // a poster-like aspect; the default fixed frame keeps ordinary
  // thumbnails small. `max-w-full` keeps it inside narrow viewports.
  const frameClass = compact
    ? "h-32 w-32 max-w-full"
    : fill
      ? "aspect-[4/3] w-full max-w-full"
      : "h-40 w-[240px] max-w-full";

  if (error) {
    return (
      <div ref={hostRef} className={cn("flex items-center justify-center rounded-lg bg-muted", frameClass)}>
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  if (!visible || loading) {
    return (
      <div ref={hostRef} className={cn("flex items-center justify-center rounded-lg bg-muted", frameClass)}>
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div ref={hostRef} className={cn(fill && "w-full", "min-w-0 max-w-full")}>
      <img
        src={src ?? ""}
        alt={alt}
        loading="lazy"
        className={
          compact
            ? "h-32 w-32 max-w-full cursor-pointer rounded-lg object-contain transition-opacity hover:opacity-90"
            : fill
              ? // Media-template header: full parent width, automatic
                // height from the original aspect ratio, fully visible.
                // `object-contain` (not cover) so promotional text,
                // faces, and contact info are never cropped.
                "block h-auto w-full max-w-full cursor-pointer rounded-lg object-contain transition-opacity hover:opacity-90"
              : // Media determines its own size: natural dimensions up to a
                // bounded box, aspect preserved, never stretched. `w-auto`
                // (not `w-full`) is load-bearing — a small image must stay
                // small instead of inflating the bubble to full width.
                "block h-auto w-auto max-w-full cursor-pointer rounded-xl object-cover transition-opacity hover:opacity-90 sm:max-w-[320px] max-h-[320px]"
        }
        onClick={() => setIsExpanded(true)}
        onError={() => setError(true)}
      />
      {isExpanded && src && (
        <ImageLightbox src={src} alt={alt} onClose={() => setIsExpanded(false)} />
      )}
    </div>
  );
}

/**
 * Which way to render a `content_type === 'interactive'` bubble.
 *
 * - "inbound-reply": the customer tapped a button/list row (webhook
 *   stores the tapped title in content_text + id in
 *   interactive_reply_id) — render the "↩ Button reply" affordance.
 * - "outgoing-prompt": the bot's Send Buttons prompt with the offered
 *   buttons persisted (interactive_buttons, set by the flows engine's
 *   meta-send) — render the body plus read-only option chips.
 * - "plain": anything else (historical outgoing prompts with no
 *   stored buttons, or malformed rows) — just the body text.
 *
 * Pure function so the branching is unit-testable without a DOM.
 */
/**
 * Which media (if any) a `content_type === 'template'` bubble carries.
 * Templates only support image/video/document headers; the row stores
 * the header file as a normal `media_url` (+ mime/filename when known,
 * see migration 077). Pure so it is unit-testable without a DOM.
 */
export function templateMediaKind(message: {
  media_url?: string | null;
  media_mime_type?: string | null;
  media_file_name?: string | null;
}): "image" | "video" | "document" | null {
  const url = message.media_url?.trim() || "";
  if (!url) return null;
  const mime = message.media_mime_type?.trim().toLowerCase() || "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (
    mime.startsWith("application/") ||
    mime.startsWith("text/") ||
    mime.startsWith("audio/")
  )
    return "document";
  const lower = url.toLowerCase().split("?")[0];
  if (/\.(jpg|jpeg|png|webp|gif)(\/|$)/.test(lower) || lower.includes("image"))
    return "image";
  if (/\.(mp4|mov|3gp|avi)(\/|$)/.test(lower)) return "video";
  return "document";
}

/**
 * Minimal approved-template header info the Inbox already has
 * client-side (TemplatePicker / thread-level fetch of
 * `message_templates`). Only the header fields are needed to render
 * a template's image/video/document header.
 */
export interface TemplateHeaderInfo {
  header_type?: MessageTemplate["header_type"];
  header_media_url?: MessageTemplate["header_media_url"];
}

/**
 * Which header media (if any) a `content_type === 'template'` bubble
 * should render.
 *
 * Priority: the row's own `media_url` first (inbound media templates
 * and any future sends that persist it — resolved via
 * `templateMediaKind`), then the approved template's
 * `header_media_url` + `header_type` fallback. The fallback exists
 * because outbound template sends (manual, broadcast, queue,
 * reminders) persist `content_type/template_name/content_text` but no
 * `media_url`, so without it an image-header template renders as
 * text-only even though the template definition has an image.
 *
 * Pure so it is unit-testable without a DOM. Never invents a URL:
 * returns null when neither source provides one.
 */
export function resolveTemplateHeaderMedia(
  message: {
    media_url?: string | null;
    media_mime_type?: string | null;
    media_file_name?: string | null;
  },
  template?: TemplateHeaderInfo | null,
): { kind: "image" | "video" | "document"; url: string } | null {
  const directKind = templateMediaKind(message);
  const directUrl = message.media_url?.trim() || "";
  if (directKind && directUrl) return { kind: directKind, url: directUrl };
  const headerUrl = template?.header_media_url?.trim() || "";
  const headerType = template?.header_type;
  if (!headerUrl) return null;
  if (
    headerType === "image" ||
    headerType === "video" ||
    headerType === "document"
  ) {
    return { kind: headerType, url: headerUrl };
  }
  return null;
}

export function interactiveRenderKind(message: Message): {
  kind: "inbound-reply" | "outgoing-prompt" | "plain";
  buttons: Array<{ id: string; title: string }>;
} {
  if (message.content_type !== "interactive") {
    return { kind: "plain", buttons: [] };
  }
  if (message.sender_type === "customer") {
    return { kind: "inbound-reply", buttons: [] };
  }
  const buttons = Array.isArray(message.interactive_buttons)
    ? message.interactive_buttons.filter(
        (b): b is { id: string; title: string } =>
          b != null && typeof b.id === "string" && typeof b.title === "string",
      )
    : [];
  return {
    kind: buttons.length > 0 ? "outgoing-prompt" : "plain",
    buttons,
  };
}

/**
 * WhatsApp-style `*bold*` runs inside a plain-text segment. Single
 * asterisks (not newlines) delimit the run; unmatched asterisks stay
 * literal so nothing is ever swallowed. Pure (no DOM) apart from the
 * returned nodes, so segment logic stays testable.
 */
function BoldRuns({ text, baseKey }: { text: string; baseKey: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  const re = /\*([^*\n]+)\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(
        <Fragment key={`${baseKey}-t${i++}`}>
          {text.slice(last, m.index)}
        </Fragment>,
      );
    }
    nodes.push(
      <strong key={`${baseKey}-b${i++}`} className="font-semibold">
        {m[1]}
      </strong>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    nodes.push(
      <Fragment key={`${baseKey}-t${i++}`}>{text.slice(last)}</Fragment>,
    );
  }
  if (nodes.length === 0) {
    nodes.push(<Fragment key={`${baseKey}-t0`}>{text}</Fragment>);
  }
  return <>{nodes}</>;
}

/**
 * Template body typography: WhatsApp-style presentation of the actual
 * saved body text. Linkifies URLs (same safe segment approach as
 * LinkifiedText) and renders `*text*` as bold, preserving line breaks,
 * paragraph separation, bullets, emojis, and punctuation. Text stays
 * selectable — never a flattened image. Template bodies only; ordinary
 * messages keep LinkifiedText unchanged.
 */
function TemplateBodyText({
  text,
  onPrimary,
}: {
  text: string;
  onPrimary?: boolean;
}) {
  const segments = linkify(text);

  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-[1.45]">
      {segments.map((segment, i) => {
        if (segment.type === "link") {
          return (
            <a
              key={i}
              href={segment.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "underline underline-offset-2 hover:opacity-80",
                onPrimary ? "text-primary-foreground" : "text-primary",
              )}
            >
              {segment.value}
            </a>
          );
        }
        return <BoldRuns key={i} text={segment.value} baseKey={`s${i}`} />;
      })}
    </div>
  );
}

function MessageContent({
  message,
  onPrimary,
  template,
}: {
  message: Message;
  onPrimary: boolean;
  /** Approved-template header fallback (see resolveTemplateHeaderMedia). */
  template?: TemplateHeaderInfo | null;
}) {
  switch (message.content_type) {
    case "text":
      return (
        <LinkifiedText text={message.content_text ?? ""} onPrimary={onPrimary} />
      );

    case "image":
      return (
        // Attachment layout: image defines the width, caption sits below
        // in normal text typography. Single caption render — never
        // duplicated as separate message text. The `sm:max-w-[320px]` cap
        // mirrors the image's own max width so a LONG caption wraps
        // vertically instead of stretching the bubble to the full
        // conversation width (w-fit sizes to max-content otherwise).
        <div className="min-w-0 max-w-full sm:max-w-[320px]">
          {message.media_url ? (
            <MediaImage url={message.media_url} alt="Shared image" />
          ) : (
            <MediaUnavailable label="Image" />
          )}
          {message.content_text && (
            <LinkifiedText
              text={message.content_text}
              onPrimary={onPrimary}
              className="mt-1.5 px-1 break-words"
            />
          )}
        </div>
      );

    case "sticker":
      // Stickers are small square webp images rendered WITHOUT a colored
      // bubble (see MessageBubble shell). Same lazy MediaImage, compact
      // frame, transparency preserved via object-contain. Caption is
      // unexpected from Meta but rendered if ever present, wrapped in a
      // narrow column so it can't stretch the row.
      return (
        <div className="min-w-0 max-w-[200px]">
          {message.media_url ? (
            <MediaImage url={message.media_url} alt="Sticker" compact />
          ) : (
            <MediaUnavailable label="Sticker" />
          )}
          {message.content_text && (
            <LinkifiedText
              text={message.content_text}
              onPrimary={false}
              className="mt-1.5 break-words text-sm"
            />
          )}
        </div>
      );

    case "video":
      return (
        // Caption capped at the player's max width (mirrors the video
        // element below) so long captions wrap instead of widening the
        // bubble — same mechanism as the image case.
        <div className="min-w-0 max-w-full sm:max-w-[320px]">
          {message.media_url ? (
            // preload="metadata" — the browser fetches only headers +
            // first frames until the user hits play; with the proxy's
            // Range support, playback then streams in chunks.
            // Sizing mirrors images: natural aspect, bounded box, the
            // player — not the bubble — sets the width.
            <video
              src={message.media_url}
              controls
              preload="metadata"
              className="block h-auto w-auto max-w-full rounded-xl sm:max-w-[320px] max-h-[320px] bg-black/60"
            />
          ) : (
            <MediaUnavailable label="Video" />
          )}
          {message.content_text && (
            <LinkifiedText
              text={message.content_text}
              onPrimary={onPrimary}
              className="mt-1.5 px-1 break-words"
            />
          )}
        </div>
      );

    case "audio":
      return (
        // Compact attachment: fixed comfortable width, never a giant
        // bubble. Caption (rare for audio) renders below when present.
        <div className="min-w-0 w-[240px] max-w-full">
          {message.media_url ? (
            // preload="none" — no bytes fetched until play. Seeking
            // streams via Range through the proxy.
            <audio
              src={message.media_url}
              controls
              preload="none"
              className="block w-full max-w-full"
            />
          ) : (
            <MediaUnavailable label="Audio" />
          )}
          {message.content_text && (
            <LinkifiedText
              text={message.content_text}
              onPrimary={onPrimary}
              className="mt-1.5 px-1 break-words"
            />
          )}
        </div>
      );

    case "document": {
      if (!message.media_url) {
        return <MediaUnavailable label={documentDisplayName(message)} />;
      }
      const fileName = documentDisplayName(message);
      // Caption vs filename: outbound docs store `caption || filename` in
      // content_text while the real filename lives in media_file_name.
      // When both exist and differ, content_text is a genuine caption and
      // renders below the card; otherwise it IS the filename (no caption).
      const rawFileName = message.media_file_name?.trim() || "";
      const rawText = message.content_text?.trim() || "";
      const caption =
        rawFileName && rawText && rawText !== rawFileName ? rawText : null;
      // The file itself is fetched only on user action: Open streams
      // it in a new tab (Range-capable via the proxy), Download saves
      // it. Merely opening the conversation downloads nothing.
      const downloadHref = message.media_url.startsWith("/api/whatsapp/media/")
        ? `${message.media_url}?download=1`
        : message.media_url;
      return (
        // Compact attachment card: bounded width, truncation for long
        // names, never a tall empty bubble.
        <div className="min-w-0 w-[260px] max-w-full">
          <div className="flex items-center gap-1 rounded-xl bg-muted/50 px-2 py-1.5">
            <a
              href={message.media_url}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${fileName}`}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-muted"
            >
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="truncate">{fileName}</span>
            </a>
            <a
              href={downloadHref}
              download={fileName}
              title={`Download ${fileName}`}
              aria-label={`Download ${fileName}`}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Download className="h-4 w-4" />
            </a>
          </div>
          {caption && (
            <LinkifiedText
              text={caption}
              onPrimary={onPrimary}
              className="mt-1.5 px-1 break-words"
            />
          )}
        </div>
      );
    }

    case "template": {
      // Header media prefers the row's own media_url (when persisted);
      // otherwise falls back to the approved template's header image
      // so image-header templates don't render as text-only.
      const header = resolveTemplateHeaderMedia(message, template);
      const fileName =
        message.media_file_name?.trim() || "Attachment";
      const downloadHref =
        header && header.url.startsWith("/api/whatsapp/media/")
          ? `${header.url}?download=1`
          : (header?.url ?? "");
      // WhatsApp-style media template: fixed compact content width so
      // the image fills ~95-100% of the inner bubble width instead of
      // collapsing to its intrinsic size. `max-w-full` keeps it inside
      // narrow (mobile) viewports. Video shares the layout; documents
      // and text-only templates keep the existing rendering below.
      if (header?.kind === "image" || header?.kind === "video") {
        return (
          <div className="w-[270px] max-w-full sm:w-[320px]">
            <span className="mx-2 mt-1.5 mb-1 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              <LayoutTemplate className="h-3 w-3" />
              Template
            </span>
            <div className="px-2 pt-1">
              {header.kind === "image" ? (
                <MediaImage url={header.url} alt="Template image" fill />
              ) : (
                <video
                  src={header.url}
                  controls
                  preload="metadata"
                  className="block h-auto w-full max-w-full rounded-lg bg-black/60 object-contain"
                />
              )}
            </div>
            {message.content_text && (
              <div className="px-2.5 pb-0.5 pt-1.5">
                <TemplateBodyText
                  text={message.content_text}
                  onPrimary={onPrimary}
                />
              </div>
            )}
          </div>
        );
      }
      return (
        <div className="min-w-0 max-w-full sm:max-w-[320px]">
          <span className="mb-1 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            <LayoutTemplate className="h-3 w-3" />
            Template
          </span>
          {header?.kind === "document" ? (
            <div className="mt-1 flex items-center gap-1 rounded-xl bg-muted/50 px-2 py-1.5">
              <a
                href={header.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open ${fileName}`}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-muted"
              >
                <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="truncate">{fileName}</span>
              </a>
              <a
                href={downloadHref}
                download={fileName}
                title={`Download ${fileName}`}
                aria-label={`Download ${fileName}`}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Download className="h-4 w-4" />
              </a>
            </div>
          ) : null}
          {message.content_text && (
            <div className="mt-1">
              <TemplateBodyText
                text={message.content_text}
                onPrimary={onPrimary}
              />
            </div>
          )}
        </div>
      );
    }

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || "Location shared"}</span>
        </div>
      );

    case "interactive": {
      const { kind, buttons } = interactiveRenderKind(message);

      // Outgoing Send Buttons prompt from the bot: show the body, then
      // the options that were offered, as READ-ONLY chips — a
      // historical record of what the customer saw, not clickable
      // actions. No "↩ Button reply" affordance here; that label means
      // the customer tapped something.
      if (kind === "outgoing-prompt") {
        return (
          <div className="flex flex-col gap-1.5">
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content_text || "[Interactive message]"}
            </p>
            <div className="flex flex-col gap-1">
              {buttons.map((b) => (
                <div
                  key={b.id}
                  className="rounded-lg border border-primary-foreground/25 bg-primary-foreground/10 px-2.5 py-1 text-center text-xs font-medium text-primary-foreground"
                >
                  {b.title}
                </div>
              ))}
            </div>
          </div>
        );
      }

      // Inbound: the customer tapped a reply button or list row on a
      // message the bot sent. We show the tapped option's title (already
      // in content_text, set by parseMessageContent in the webhook) with
      // a small affordance so agents reading the inbox can tell at a
      // glance that this is a tap rather than the customer typing the
      // same words. Historical outgoing prompts with no stored buttons
      // fall through here to the same plain body rendering as before.
      return (
        <div className="flex flex-col gap-0.5">
          <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <CornerDownLeft className="h-3 w-3" />
            Button reply
          </span>
          <p className="whitespace-pre-wrap break-words text-sm">
            {message.content_text || "[Interactive reply]"}
          </p>
        </div>
      );
    }

    default:
      return (
        <LinkifiedText
          text={message.content_text || "[Unsupported message type]"}
          onPrimary={onPrimary}
        />
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  template,
}: MessageBubbleProps) {
  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "h:mm a");

  // Presentation-only branching: the bubble shell stays shared (alignment,
  // reply, metadata, reactions) while the CONTENT area gets type-specific
  // sizing. `isMediaAttachment` covers bubble-backed media (image/video/
  // audio/document); stickers render chromeless like WhatsApp.
  const isSticker = message.content_type === "sticker";
  const isMediaAttachment =
    message.content_type === "image" ||
    message.content_type === "video" ||
    message.content_type === "audio" ||
    message.content_type === "document";
  // WhatsApp-style media template (image/video header): the fixed-width
  // content column owns all spacing, so the shell drops its text
  // padding and clips to the rounded bubble — the image then sits
  // nearly edge-to-edge instead of floating in a large blue card.
  const templateHeader =
    message.content_type === "template"
      ? resolveTemplateHeaderMedia(message, template)
      : null;
  const isTemplateMedia =
    templateHeader?.kind === "image" || templateHeader?.kind === "video";

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative min-w-0 max-w-full rounded-2xl",
          // Sticker: no colored bubble at all — transparent chromeless
          // container preserves positioning context for hover actions
          // without painting a giant rectangle around the art.
          isSticker
            ? "bg-transparent p-0"
            : isTemplateMedia
              ? // Media template: no shell padding — the fixed-width
                // content column (badge / image / body each with their
                // own small insets) defines the compact bubble.
                // `overflow-hidden` clips the image to the rounded
                // bubble; `w-fit` + `max-w-full` keep it compact on
                // desktop and inside narrow viewports on mobile.
                "w-fit max-w-full overflow-hidden p-0"
              : isMediaAttachment
              ? // Media attachment: tight padding + shrink-to-fit so the
                // MEDIA defines the width, not a text-sized bubble.
                // `w-fit` + `overflow-hidden` + `max-w-full` keep large
                // media bounded and small media small. Colors/rounding
                // stay identical to text bubbles.
                "w-fit overflow-hidden p-1.5"
              : "px-3 py-2",
          !isSticker &&
            (isAgent
              ? "rounded-br-md bg-primary text-primary-foreground"
              : "rounded-bl-md bg-muted text-foreground"),
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent && !isSticker}
          />
        )}
        <MessageContent message={message} onPrimary={isAgent && !isSticker} template={template} />
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isTemplateMedia
              ? "px-2 pb-1.5"
              : isMediaAttachment || isSticker
                ? "px-1"
                : undefined,
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          <span
            className={cn(
              "text-[10px]",
              isSticker
                ? // No bubble behind stickers — always muted, either side.
                  "text-muted-foreground"
                : // Outbound bubbles sit on the primary fill, so the
                  // timestamp must read against that (not the neutral
                  // foreground) — otherwise it goes low-contrast in light
                  // mode. Inbound bubbles use the muted surface.
                  isAgent
                  ? "text-primary-foreground/70"
                  : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && (
            <>
              <span
                className={cn(
                  "text-[10px]",
                  isSticker
                    ? "text-muted-foreground/60"
                    : "text-primary-foreground/50",
                )}
              >
                ·
              </span>
              <span
                className={cn(
                  "text-[10px]",
                  isSticker
                    ? "text-muted-foreground"
                    : "text-primary-foreground/70",
                )}
              >
                {displayMessageStatus(message.status)}
              </span>
            </>
          )}
        </div>
      </div>
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
