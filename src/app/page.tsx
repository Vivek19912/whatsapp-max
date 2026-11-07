import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowRight,
  Bot,
  Check,
  Download,
  GitBranch,
  Inbox,
  Megaphone,
  MessageSquareText,
  Infinity as InfinityIcon,
  ShieldCheck,
  Sparkles,
  Table2,
  UserCheck,
  Users,
  Workflow,
  Zap,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SignedInRedirect } from './landing-redirect';
import {
  COMPANY_NAME,
  PRODUCT_NAME,
  SUPPORT_EMAIL,
  WEBSITE_DOMAIN,
} from '@/lib/site';

const TITLE =
  'WhatsApp Max | WhatsApp Conversations, Automation and Google Sheets Sync';
const DESCRIPTION =
  'WhatsApp Max helps businesses manage WhatsApp conversations, contacts, pipelines, broadcasts and automation flows, with optional Google Sheets synchronisation.';

// The homepage must be publicly indexable — the root layout marks the
// whole app `robots: index:false`, so we override that here (the same
// way the legal pages do). `title.absolute` bypasses the root layout's
// `title.absolute` bypasses the root layout's title template so Google
// sees the exact required title.
export const metadata: Metadata = {
  metadataBase: new URL(WEBSITE_DOMAIN),
  title: { absolute: TITLE },
  description: DESCRIPTION,
  applicationName: PRODUCT_NAME,
  alternates: { canonical: '/' },
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    url: `${WEBSITE_DOMAIN}/`,
    siteName: PRODUCT_NAME,
    title: TITLE,
    description: DESCRIPTION,
    images: [
      {
        url: '/logo.png',
        width: 512,
        height: 512,
        alt: PRODUCT_NAME,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: PRODUCT_NAME,
    description: DESCRIPTION,
    images: ['/logo.png'],
  },
};

const primaryCta = cn(
  buttonVariants({ variant: 'default' }),
  'h-11 rounded-lg px-6 text-sm font-semibold hover:bg-primary/90'
);
const secondaryCta = cn(
  buttonVariants({ variant: 'outline' }),
  'h-11 rounded-lg px-6 text-sm font-semibold'
);

const FEATURES = [
  {
    icon: Inbox,
    title: 'Shared WhatsApp inbox',
    body: 'Handle every WhatsApp conversation from one shared team inbox with real-time messaging.',
  },
  {
    icon: Users,
    title: 'Contact management',
    body: 'Organise customers with contact records, tags, notes and custom fields.',
  },
  {
    icon: GitBranch,
    title: 'Sales pipelines and deals',
    body: 'Track deals across custom pipeline stages from first message to close.',
  },
  {
    icon: Megaphone,
    title: 'Broadcasts',
    body: 'Reach segments of your contacts with targeted WhatsApp broadcasts.',
  },
  {
    icon: Workflow,
    title: 'Automation flows',
    body: 'Build no-code flows that qualify, route and respond to customers automatically.',
  },
  {
    icon: Bot,
    title: 'AI agents',
    body: 'Let AI agents help answer common questions and assist your team.',
  },
  {
    icon: UserCheck,
    title: 'Team assignment',
    body: 'Assign chats to teammates so ownership of every conversation stays clear.',
  },
  {
    icon: GitBranch,
    title: 'Webhooks and integrations',
    body: 'Connect WhatsApp events and CRM data to the tools your team already uses.',
  },
  {
    icon: Download,
    title: 'Data export',
    body: 'Export your CRM data whenever you need it for reporting or backup.',
  },
] as const;

const SHEETS_CAPABILITIES = [
  'Connect a Google account',
  'See which Google account is connected',
  'Select an existing spreadsheet',
  'Create a new spreadsheet',
  'Append collected flow responses as new rows',
  'Import previously completed responses when requested',
  'Disconnect the integration at any time',
] as const;

const STEPS = [
  {
    title: 'Connect WhatsApp',
    body: 'Link your WhatsApp Business number to start receiving and sending messages.',
  },
  {
    title: 'Build an automation flow',
    body: 'Design a no-code flow that greets, qualifies and responds to customers.',
  },
  {
    title: 'Collect customer responses',
    body: 'Capture the answers and details customers share as they move through the flow.',
  },
  {
    title: 'Sync selected responses to Google Sheets',
    body: 'Append the responses you choose as new rows in a linked Google Spreadsheet.',
  },
  {
    title: 'Manage follow-up and sales activity',
    body: 'Track deals, assign chats and follow up with everything in one CRM workspace.',
  },
] as const;

const SECURITY_POINTS = [
  {
    title: 'Controlled user access',
    body: 'Workspace members sign in to their own accounts, and chats can be assigned to specific teammates.',
  },
  {
    title: 'Secure account authentication',
    body: 'Access to the CRM is protected by authenticated sign-in for every user.',
  },
  {
    title: 'You choose the spreadsheet',
    body: 'Authorised users decide exactly which Google Spreadsheet the integration connects to.',
  },
  {
    title: 'Disconnect at any time',
    body: 'You can disconnect Google Sheets whenever you like, which removes the stored access.',
  },
] as const;

function Header() {
  return (
    <header className="border-border bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <Image
            src="/logo.png"
            alt={PRODUCT_NAME}
            width={36}
            height={36}
            className="rounded-lg"
            priority
          />
          <span className="text-foreground text-sm font-semibold sm:text-base">
            {PRODUCT_NAME}
          </span>
        </Link>

        <nav className="text-muted-foreground hidden items-center gap-6 text-sm lg:flex">
          <a href="#features" className="hover:text-foreground">
            Features
          </a>
          <a href="#pricing" className="hover:text-foreground">
            Pricing
          </a>
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className={cn(
              buttonVariants({ variant: 'ghost' }),
              'text-foreground h-9 px-3 text-sm font-medium'
            )}
          >
            Login
          </Link>
          <Link
            href="/signup"
            className={cn(
              buttonVariants({ variant: 'default' }),
              'hover:bg-primary/90 h-9 rounded-lg px-4 text-sm font-semibold'
            )}
          >
            Get Started
          </Link>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="bg-primary/20 pointer-events-none absolute inset-x-0 -top-40 -z-10 mx-auto h-80 max-w-4xl rounded-full blur-3xl"
      />
      <div className="mx-auto max-w-6xl px-4 pt-16 pb-12 sm:px-6 sm:pt-24 lg:pb-20">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <span className="border-border bg-card text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium">
              <Sparkles className="text-primary size-3.5" />
              WhatsApp messaging &amp; automation platform
            </span>
            <h1 className="text-foreground mt-5 text-4xl font-bold tracking-tight sm:text-5xl">
              {PRODUCT_NAME}
            </h1>
            <p className="text-muted-foreground mt-5 max-w-xl text-lg leading-relaxed">
              {PRODUCT_NAME} helps businesses manage WhatsApp conversations,
              contacts, sales pipelines, broadcasts and automation flows from
              one workspace.
            </p>
            <p className="text-muted-foreground mt-3 max-w-xl text-base leading-relaxed">
              It is a business CRM and automation platform for teams that sell
              and support customers over WhatsApp &mdash; with optional Google
              Sheets synchronisation for the responses you collect.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/signup" className={primaryCta}>
                Get Started
                <ArrowRight className="size-4" />
              </Link>
              <Link href="/login" className={secondaryCta}>
                Login
              </Link>
            </div>
          </div>

          <DashboardPreview />
        </div>
      </div>
    </section>
  );
}

// A stylised, data-free illustration of the product. Deliberately NOT a
// real screenshot: production screenshots can contain real customer
// conversations, so this mock-up shows only sample, non-identifying UI.
function DashboardPreview() {
  return (
    <div className="relative">
      <div className="border-border bg-card overflow-hidden rounded-2xl border shadow-2xl">
        <div className="border-border bg-muted/40 flex items-center gap-1.5 border-b px-4 py-3">
          <span className="bg-destructive/50 size-3 rounded-full" />
          <span className="size-3 rounded-full bg-amber-500/50" />
          <span className="size-3 rounded-full bg-emerald-500/50" />
          <span className="text-muted-foreground ml-3 text-xs">
            {PRODUCT_NAME}
          </span>
        </div>
        <div className="grid grid-cols-3">
          <div className="border-border col-span-1 space-y-3 border-r p-4">
            <div className="text-foreground flex items-center gap-2 text-xs font-medium">
              <Inbox className="text-primary size-4" />
              Inbox
            </div>
            {['Aisha K.', 'Ravi M.', 'Sofia L.'].map((name, i) => (
              <div
                key={name}
                className={cn(
                  'rounded-lg p-2.5',
                  i === 0 ? 'bg-primary/10' : 'bg-muted/50'
                )}
              >
                <div className="text-foreground text-[11px] font-medium">
                  {name}
                </div>
                <div className="bg-muted-foreground/25 mt-1 h-1.5 w-4/5 rounded-full" />
              </div>
            ))}
          </div>
          <div className="col-span-2 flex flex-col gap-3 p-4">
            <div className="bg-muted text-foreground max-w-[80%] rounded-2xl rounded-tl-sm px-3 py-2 text-[11px]">
              Hi! I would like to book a consultation.
            </div>
            <div className="bg-primary text-primary-foreground ml-auto max-w-[80%] rounded-2xl rounded-tr-sm px-3 py-2 text-[11px]">
              Happy to help. What date works best for you?
            </div>
            <div className="border-border bg-muted/30 mt-1 flex items-center gap-2 rounded-lg border border-dashed p-2.5">
              <Table2 className="size-4 text-emerald-500" />
              <span className="text-muted-foreground text-[11px]">
                Response appended to Google Sheet
              </span>
              <Check className="ml-auto size-3.5 text-emerald-500" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-primary text-sm font-semibold">{eyebrow}</p>
      <h2 className="text-foreground mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
        {title}
      </h2>
      {children ? (
        <p className="text-muted-foreground mt-4 text-base leading-relaxed">
          {children}
        </p>
      ) : null}
    </div>
  );
}

function Features() {
  return (
    <section
      id="features"
      className="border-border scroll-mt-20 border-t py-20"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="Features"
          title="Everything your team needs to sell on WhatsApp"
        >
          A complete CRM built around WhatsApp &mdash; from the first message to
          the closed deal.
        </SectionHeading>
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="border-border bg-card hover:border-primary/40 rounded-2xl border p-6 transition-colors"
            >
              <div className="bg-primary/10 flex size-10 items-center justify-center rounded-xl">
                <Icon className="text-primary size-5" />
              </div>
              <h3 className="text-foreground mt-4 text-base font-semibold">
                {title}
              </h3>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                {body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function GoogleSheets() {
  return (
    <section
      id="google-sheets"
      className="border-border scroll-mt-20 border-t py-20"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <p className="text-primary text-sm font-semibold">
              Google Sheets Integration
            </p>
            <h2 className="text-foreground mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              Sync collected responses to Google Sheets
            </h2>
            <p className="text-muted-foreground mt-4 text-base leading-relaxed">
              Authorised users can connect their Google account, select or
              create a Google Spreadsheet, and automatically append responses
              collected through CRM automation flows as new rows.
            </p>
            <p className="text-muted-foreground mt-3 text-base leading-relaxed">
              The integration is optional and fully under your control. With it,
              you can:
            </p>
            <ul className="mt-6 space-y-3">
              {SHEETS_CAPABILITIES.map((item) => (
                <li
                  key={item}
                  className="text-foreground flex items-start gap-3 text-sm"
                >
                  <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                  {item}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-6 text-sm leading-relaxed">
              {PRODUCT_NAME} does not access Gmail, Google Calendar, Google
              Contacts or other unrelated Google services. See our{' '}
              <Link
                href="/privacy-policy"
                className="text-primary hover:text-primary/80"
              >
                Privacy Policy
              </Link>{' '}
              for full details on how Google data is used.
            </p>
          </div>

          <div className="border-border bg-card rounded-2xl border p-6">
            <div className="border-border flex items-center gap-3 border-b pb-4">
              <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-500/10">
                <Table2 className="size-5 text-emerald-500" />
              </div>
              <div>
                <div className="text-foreground text-sm font-semibold">
                  Linked spreadsheet
                </div>
                <div className="text-muted-foreground text-xs">
                  Connected Google account
                </div>
              </div>
              <span className="ml-auto rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-500">
                Connected
              </span>
            </div>
            <div className="border-border mt-4 overflow-hidden rounded-lg border">
              <div className="bg-muted/50 text-muted-foreground grid grid-cols-3 text-[11px] font-medium">
                <div className="border-border border-r px-3 py-2">Name</div>
                <div className="border-border border-r px-3 py-2">Flow</div>
                <div className="px-3 py-2">Submitted</div>
              </div>
              {[
                ['Aisha K.', 'Booking', '10:24'],
                ['Ravi M.', 'Enquiry', '11:02'],
                ['Sofia L.', 'Booking', '11:47'],
              ].map((row) => (
                <div
                  key={row[0]}
                  className="border-border text-foreground grid grid-cols-3 border-t text-[11px]"
                >
                  <div className="border-border border-r px-3 py-2">
                    {row[0]}
                  </div>
                  <div className="border-border border-r px-3 py-2">
                    {row[1]}
                  </div>
                  <div className="px-3 py-2">{row[2]}</div>
                </div>
              ))}
            </div>
            <p className="text-muted-foreground mt-3 text-[11px]">
              Sample data shown for illustration only.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="border-border scroll-mt-20 border-t py-20"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="How it works"
          title="From first message to synced record"
        >
          A simple flow connects your WhatsApp conversations to your CRM and,
          optionally, to Google Sheets.
        </SectionHeading>
        <ol className="mt-14 grid gap-5 md:grid-cols-5">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              className="border-border bg-card relative rounded-2xl border p-5"
            >
              <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-full text-sm font-semibold">
                {i + 1}
              </div>
              <h3 className="text-foreground mt-4 text-sm font-semibold">
                {step.title}
              </h3>
              <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
                {step.body}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Security() {
  return (
    <section className="border-border border-t py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="Security and control"
          title="You stay in control of your data"
        >
          Practical safeguards and clear controls over how your workspace and
          Google data are used.
        </SectionHeading>
        <div className="mt-14 grid gap-5 sm:grid-cols-2">
          {SECURITY_POINTS.map((point) => (
            <div
              key={point.title}
              className="border-border bg-card flex gap-4 rounded-2xl border p-6"
            >
              <ShieldCheck className="text-primary size-5 shrink-0" />
              <div>
                <h3 className="text-foreground text-base font-semibold">
                  {point.title}
                </h3>
                <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                  {point.body}
                </p>
              </div>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground mx-auto mt-8 max-w-3xl text-center text-sm leading-relaxed">
          Data is handled according to our{' '}
          <Link
            href="/privacy-policy"
            className="text-primary hover:text-primary/80"
          >
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

const INTERSCALE_PERKS = [
  { icon: Zap, text: '₹0 platform fee — no monthly subscription, ever' },
  {
    icon: MessageSquareText,
    text: "Free messaging — we absorb Meta's per-message charges",
  },
  { icon: Check, text: 'Every CRM feature, including webhooks, is included' },
  {
    icon: InfinityIcon,
    text: 'Unlimited contacts, conversations & team members',
  },
] as const;

const COMPETITORS = [
  {
    name: 'Interakt',
    logo: '/logos/interakt.svg',
    price: '₹3,799',
    per: '/ month',
    messaging: 'Meta message fees charged',
    limitation: 'Webhooks not included on lower plans',
  },
  {
    name: 'AiSensy',
    logo: '/logos/aisensy.avif',
    price: '₹3,200',
    per: '/ month',
    messaging: 'Per-message fees charged',
    limitation: 'Meta message fees charged separately',
  },
  {
    name: 'Wati',
    logo: '/logos/wati.svg',
    price: '₹6,499',
    per: '/ month',
    messaging: 'Meta message fees charged',
    limitation: 'Advanced features depend on plan',
  },
] as const;

function Pricing() {
  return (
    <section
      id="pricing"
      className="border-border from-primary/[0.06] via-background to-background relative scroll-mt-20 overflow-hidden border-t bg-gradient-to-b py-24"
    >
      <div
        aria-hidden
        className="bg-primary/15 pointer-events-none absolute top-10 left-1/2 -z-0 h-72 w-72 -translate-x-1/2 rounded-full blur-3xl"
      />
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="relative z-1 mx-auto max-w-3xl text-center">
          <span className="border-primary/20 bg-primary/10 text-primary inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold tracking-wide uppercase">
            <Sparkles className="size-3.5" />
            Included with Interscale Marketing
          </span>
          <h2 className="text-foreground mt-5 text-4xl font-bold tracking-tight sm:text-5xl">
            Powerful WhatsApp Max.
            <span className="text-primary block">Zero software bill.</span>
          </h2>
          <p className="text-muted-foreground mx-auto mt-5 max-w-2xl text-base leading-relaxed">
            Use every CRM feature and send messages without paying a platform
            subscription or additional Meta messaging charges.
          </p>
        </div>

        <div className="relative z-1 mt-14 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="bg-primary text-primary-foreground relative overflow-hidden rounded-3xl p-8 shadow-[0_24px_70px_-24px_hsl(var(--primary)/0.65)] sm:p-10">
            <div
              aria-hidden
              className="absolute -top-20 -right-16 size-56 rounded-full border-[38px] border-white/10"
            />
            <div className="relative">
              <p className="text-primary-foreground/75 text-xs font-semibold tracking-[0.18em] uppercase">
                {PRODUCT_NAME}
              </p>
              <div className="mt-7 flex items-end gap-3">
                <span className="text-8xl leading-none font-bold tracking-[-0.08em]">
                  &#8377;0
                </span>
                <span className="text-primary-foreground/75 mb-3 text-sm font-medium">
                  / month
                </span>
              </div>
              <p className="text-primary-foreground/85 mt-4 max-w-sm text-sm leading-relaxed">
                Free when you take marketing services from {COMPANY_NAME}.
                Messaging is free too—we cover the Meta charges.
              </p>

              <ul className="mt-8 space-y-3">
                {INTERSCALE_PERKS.map(({ icon: Icon, text }) => (
                  <li
                    key={text}
                    className="flex items-start gap-3 text-sm font-medium"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/15">
                      <Icon className="size-3.5" />
                    </span>
                    <span className="pt-0.5">{text}</span>
                  </li>
                ))}
              </ul>

              <Link
                href="/signup"
                className="text-primary mt-9 inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-white px-6 text-sm font-bold shadow-lg transition-transform hover:-translate-y-0.5"
              >
                Get Started for free
                <ArrowRight className="size-4" />
              </Link>
            </div>
          </div>

          <div className="border-border bg-card shadow-foreground/5 rounded-3xl border p-6 shadow-xl sm:p-8">
            <div className="border-border flex items-end justify-between gap-4 border-b pb-5">
              <div>
                <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
                  Compare the real cost
                </p>
                <h3 className="text-foreground mt-2 text-2xl font-bold tracking-tight">
                  What others charge monthly
                </h3>
              </div>
              <span className="hidden rounded-full bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-500 sm:inline-flex">
                Before Meta fees
              </span>
            </div>

            <div className="divide-border divide-y">
              {COMPETITORS.map((c) => (
                <div
                  key={c.name}
                  className="grid gap-4 py-5 sm:grid-cols-[1fr_auto] sm:items-center"
                >
                  <div>
                    <span className="inline-flex min-h-9 items-center rounded-lg bg-white px-3 py-2 shadow-sm ring-1 ring-black/5">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={c.logo}
                        alt={c.name}
                        className="h-5 max-w-24 object-contain"
                      />
                    </span>
                  </div>
                  <div className="sm:text-right">
                    <div className="flex items-baseline gap-1 sm:justify-end">
                      <span className="text-foreground text-2xl font-bold tracking-tight">
                        {c.price}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {c.per}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-red-500 sm:text-right">
                      {c.messaging}
                    </p>
                    <p className="text-muted-foreground mt-1 text-[11px]">
                      {c.limitation}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-5 flex items-center gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
                <Check className="size-5" />
              </span>
              <div>
                <p className="text-foreground text-sm font-semibold">
                  With WhatsApp Max, your CRM cost stays at ₹0.
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  No platform fee and no additional Meta messaging charge.
                </p>
              </div>
            </div>
          </div>
        </div>

      </div>
    </section>
  );
}

function CtaBand() {
  return (
    <section className="border-border border-t py-20">
      <div className="mx-auto max-w-4xl px-4 text-center sm:px-6">
        <h2 className="text-foreground text-3xl font-bold tracking-tight sm:text-4xl">
          Get started with {PRODUCT_NAME}
        </h2>
        <p className="text-muted-foreground mx-auto mt-4 max-w-xl text-base leading-relaxed">
          Bring your WhatsApp conversations, contacts and automation into one
          workspace.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href="/signup" className={primaryCta}>
            Get Started
            <ArrowRight className="size-4" />
          </Link>
          <Link href="/login" className={secondaryCta}>
            Login
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-border bg-background border-t">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <div className="flex items-center gap-2.5">
              <Image
                src="/logo.png"
                alt={PRODUCT_NAME}
                width={32}
                height={32}
                className="rounded-lg"
              />
              <span className="text-foreground text-sm font-semibold">
                {PRODUCT_NAME}
              </span>
            </div>
            <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
              A WhatsApp messaging and automation platform by {COMPANY_NAME}.
            </p>
          </div>

          <nav className="flex flex-col gap-3 text-sm">
            <span className="text-muted-foreground/70 text-xs font-semibold tracking-wide uppercase">
              Product &amp; legal
            </span>
            <a
              href="#features"
              className="text-muted-foreground hover:text-foreground"
            >
              Features
            </a>
            <a
              href="#google-sheets"
              className="text-muted-foreground hover:text-foreground"
            >
              Google Sheets Integration
            </a>
            <Link
              href="/privacy-policy"
              className="text-muted-foreground hover:text-foreground"
            >
              Privacy Policy
            </Link>
            <Link
              href="/terms-and-conditions"
              className="text-muted-foreground hover:text-foreground"
            >
              Terms and Conditions
            </Link>
            <Link
              href="/login"
              className="text-muted-foreground hover:text-foreground"
            >
              Login
            </Link>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-muted-foreground hover:text-foreground"
            >
              {SUPPORT_EMAIL}
            </a>
          </nav>
        </div>

        <div className="border-border mt-10 border-t pt-6">
          <p className="text-muted-foreground text-xs leading-relaxed">
            &copy; 2026 {COMPANY_NAME}. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}

export default function HomePage() {
  return (
    <div className="bg-background min-h-screen">
      <SignedInRedirect />
      <Header />
      <main>
        <Hero />
        <Features />
        <Pricing />
        <GoogleSheets />
        <HowItWorks />
        <Security />
        <CtaBand />
      </main>
      <Footer />
    </div>
  );
}
