import {
  ArrowLeftRight,
  Bell,
  Coins,
  Megaphone,
  KeyRound,
  LayoutGrid,
  Mic,
  Palette,
  Phone,
  PlugZap,
  Shield,
  Smartphone,
  Store,
  Table2,
  Tags,
  User,
  Webhook,
  type LucideIcon,
} from 'lucide-react';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'business-profile',
  'connected-number',
  'security',
  'appearance',
  'notifications',
  'travel-crm',
  'meta-lead-ads',
  'google-sheets-meta',
  'whatsapp',
  'reminder-number',
  'call-recording',
  'fields',
  'deals',
  'api',
  'webhooks',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/** Rail grouping. `adminOnly` items are hidden for non-admins. */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'integrations' | 'workspace';
  /**
   * When true the section stays reachable (deep-link + panel render)
   * but is omitted from the rail — used for navigation-only sections
   * like Deals.
   */
  hideFromRail?: boolean;
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Overview', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'Your profile', icon: User, group: 'account' },
  'connected-number': {
    id: 'connected-number',
    label: 'Connected number',
    icon: Phone,
    group: 'account',
    hideFromRail: true,
  },
  security: { id: 'security', label: 'Login & security', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'Appearance', icon: Palette, group: 'account' },  notifications: { id: 'notifications', label: 'Notifications', icon: Bell, group: 'account' },
  'travel-crm': { id: 'travel-crm', label: 'Travel Agency CRM', icon: ArrowLeftRight, group: 'integrations' },
  'meta-lead-ads': { id: 'meta-lead-ads', label: 'Meta', icon: Megaphone, group: 'integrations' },
  'google-sheets-meta': { id: 'google-sheets-meta', label: 'Google Sheets — Meta Lead Ads', icon: Table2, group: 'integrations' },
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', icon: PlugZap, group: 'workspace' },
  'reminder-number': { id: 'reminder-number', label: 'Reminder WhatsApp Number', icon: Smartphone, group: 'workspace' },
  'call-recording': { id: 'call-recording', label: 'Call Recording', icon: Mic, group: 'account' },
  'business-profile': { id: 'business-profile', label: 'Business Profile', icon: Store, group: 'account' },
  fields: { id: 'fields', label: 'Fields & tags', icon: Tags, group: 'workspace' },
  // Navigation-only: hidden from the left rail but still reachable
  // via deep-link/panel render — the underlying functionality,
  // routes, APIs, and components are untouched.
  deals: { id: 'deals', label: 'Deals & currency', icon: Coins, group: 'workspace', hideFromRail: true },
  api: { id: 'api', label: 'API keys', icon: KeyRound, group: 'workspace', hideFromRail: true },
   webhooks: { id: 'webhooks', label: 'Webhooks', icon: Webhook, group: 'workspace' }
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Account', group: 'account' },
  { label: 'Integrations', group: 'integrations' },
  { label: 'Workspace', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
