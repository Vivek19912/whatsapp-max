import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Script from "next/script";
import "./globals.css";
import { ThemeProvider } from "@/hooks/use-theme";
import { ThemedToaster } from "@/components/themed-toaster";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";
import {
  DEFAULT_FONT,
  DEFAULT_MODE,
  DEFAULT_THEME,
  FONT_IDS,
  FONT_STORAGE_KEY,
  MODE_STORAGE_KEY,
  MODES,
  STORAGE_KEY,
  THEME_IDS,
} from "@/lib/themes";

// Fonts are vendored as WOFF2 files in ./fonts so the production build
// never fetches from Google. `adjustFontFallback` (on by default) keeps
// the metric-adjusted fallback the previous declarations produced.
//
// Default face — preloaded, since most sessions render with it.
const inter = localFont({
  src: "./fonts/inter-latin-wght-normal.woff2",
  variable: "--font-inter",
  weight: "100 900",
});

// Alternative faces the Appearance → Font family picker can switch to.
// `preload: false` keeps them out of the critical path: each is only
// fetched by the browser once a `html[data-font]` block actually
// references its CSS variable. Helvetica / Arial / SF Pro are system
// stacks and need no loading at all.
const roboto = localFont({
  src: "./fonts/roboto-latin-wght-normal.woff2",
  variable: "--font-roboto",
  weight: "300 700",
  preload: false,
});
const openSans = localFont({
  src: "./fonts/open-sans-latin-wght-normal.woff2",
  variable: "--font-open-sans",
  weight: "300 800",
  preload: false,
});
const poppins = localFont({
  src: [
    { path: "./fonts/poppins-latin-300-normal.woff2", weight: "300" },
    { path: "./fonts/poppins-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/poppins-latin-500-normal.woff2", weight: "500" },
    { path: "./fonts/poppins-latin-600-normal.woff2", weight: "600" },
    { path: "./fonts/poppins-latin-700-normal.woff2", weight: "700" },
  ],
  variable: "--font-poppins",
  preload: false,
});
const montserrat = localFont({
  src: "./fonts/montserrat-latin-wght-normal.woff2",
  variable: "--font-montserrat",
  weight: "100 900",
  preload: false,
});
const lato = localFont({
  src: [
    { path: "./fonts/lato-latin-300-normal.woff2", weight: "300" },
    { path: "./fonts/lato-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/lato-latin-700-normal.woff2", weight: "700" },
  ],
  variable: "--font-lato",
  preload: false,
});
const nunitoSans = localFont({
  src: "./fonts/nunito-sans-latin-wght-normal.woff2",
  variable: "--font-nunito-sans",
  weight: "200 1000",
  preload: false,
});

const FONT_VARIABLE_CLASSES = [
  inter.variable,
  roboto.variable,
  openSans.variable,
  poppins.variable,
  montserrat.variable,
  lato.variable,
  nunitoSans.variable,
].join(" ");



export const metadata: Metadata = {
  title: {
    default: "WhatsApp Max",
    template: "%s — WhatsApp Max"
    
  },
  icons: {
    icon: "/logo.png",
    shortcut: "/logo.png",
    apple: "/logo.png",
  },
  description: "WhatsApp Max by Interscale Marketing",
  // Lets iOS treat the installed shortcut as a standalone app (required
  // for Web Push on iOS 16.4+). Next links the manifest.ts automatically.
  appleWebApp: {
    capable: true,
    title: "WhatsApp Max",
    statusBarStyle: "black-translucent",
  },
  robots: {
    index: false,
    follow: false,
  },
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#020617",
  colorScheme: "dark light",
};

// Inline boot script — runs before React hydrates so the user's
// chosen accent (data-theme) AND mode (data-mode) are on the <html>
// element before first paint. Without this every page load flashes
// the server-rendered defaults for a frame before the React tree
// mounts and applies the picked values.
//
// Kept dependency-free (no imports, no JSX) — must be a string the
// browser can run as a single <script>. Knowledge of valid ids is
// sourced from the THEME_IDS / MODES constants so adding one doesn't
// silently break the boot path.
const THEME_BOOT_SCRIPT = `
(function(){
  var d = document.documentElement;
  try {
    var THEME_KEY = ${JSON.stringify(STORAGE_KEY)};
    var THEME_DEFAULT = ${JSON.stringify(DEFAULT_THEME)};
    var THEMES = ${JSON.stringify(THEME_IDS)};
    var savedTheme = localStorage.getItem(THEME_KEY);
    d.dataset.theme = THEMES.indexOf(savedTheme) !== -1 ? savedTheme : THEME_DEFAULT;

    var MODE_KEY = ${JSON.stringify(MODE_STORAGE_KEY)};
    var MODE_DEFAULT = ${JSON.stringify(DEFAULT_MODE)};
    var MODES = ${JSON.stringify(MODES)};
    var savedMode = localStorage.getItem(MODE_KEY);
    d.dataset.mode = MODES.indexOf(savedMode) !== -1 ? savedMode : MODE_DEFAULT;

    var FONT_KEY = ${JSON.stringify(FONT_STORAGE_KEY)};
    var FONT_DEFAULT = ${JSON.stringify(DEFAULT_FONT)};
    var FONTS = ${JSON.stringify(FONT_IDS)};
    var savedFont = localStorage.getItem(FONT_KEY);
    d.dataset.font = FONTS.indexOf(savedFont) !== -1 ? savedFont : FONT_DEFAULT;
  } catch (_e) {
    d.dataset.theme = ${JSON.stringify(DEFAULT_THEME)};
    d.dataset.mode = ${JSON.stringify(DEFAULT_MODE)};
    d.dataset.font = ${JSON.stringify(DEFAULT_FONT)};
  }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme={DEFAULT_THEME}
      data-mode={DEFAULT_MODE}
      data-font={DEFAULT_FONT}
      className={`${FONT_VARIABLE_CLASSES} h-full antialiased`}
      // The `theme-boot` script below rewrites `data-theme` and
      // `data-mode` on <html> from localStorage before React hydrates,
      // so for any non-default choice the client DOM intentionally
      // differs from the server-rendered defaults. suppressHydration-
      // Warning silences the expected mismatch — it only applies to
      // this element's own attributes, so genuine mismatches in
      // children still surface.
      suppressHydrationWarning
    >
      <head>
        <Script
          id="theme-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
      </head>
      <body className="min-h-full bg-background text-foreground font-sans">
        <ThemeProvider>
          {children}
          <ThemedToaster />
          <ServiceWorkerRegister />
        </ThemeProvider>
      </body>
    </html>
  );
}
