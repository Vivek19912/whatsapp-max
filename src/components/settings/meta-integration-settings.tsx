"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { MetaLeadAdsSettings } from "./meta-lead-ads-settings";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * One "Meta" section with two independently-configured capabilities:
 *   * Lead capture  — Direct Meta Lead Ads (Pages → Instant Forms → Workspace)
 *   * Conversions API — send conversion events to the customer's dataset
 *
 * They share the platform Meta app but nothing else; either can be set
 * up, changed, or disconnected without touching the other.
 *
 * DEAD FEATURE — Meta Conversions API UI.
 * Retired and intentionally hidden from the WhatsApp Max Settings interface.
 * Do not expose or re-enable this UI without explicit product approval.
 * Existing implementation is retained for reference in
 * "./meta-conversions-api-settings.tsx" (component, hooks, API routes,
 * backend functions, tables, and tests are all preserved).
 */
export function MetaIntegrationSettings() {
  return (
    <section className="space-y-5">
      <SettingsPanelHead
        title="Meta"
        description="Connect Meta to WhatsApp Max. Capture leads from Facebook & Instagram Instant Forms."
      />
      {/* Lead capture is the only visible tab. The Conversions API tab and
          its content panel were removed here (see DEAD FEATURE note above).
          Tabs stays controlled to "lead-capture" so the page always defaults
          to Lead capture and any legacy "conversions-api" value normalizes
          to it instead of rendering an empty panel. */}
      <Tabs value="lead-capture">
        <TabsList variant="line">
          <TabsTrigger value="lead-capture">Lead capture</TabsTrigger>
        </TabsList>
        <TabsContent value="lead-capture" className="pt-4">
          <MetaLeadAdsSettings embedded />
        </TabsContent>
      </Tabs>
    </section>
  );
}
