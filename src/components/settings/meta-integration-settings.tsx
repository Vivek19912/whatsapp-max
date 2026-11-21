"use client";

import { useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { MetaCrmDatasetSettings } from "./meta-crm-dataset-settings";
import { MetaCrmFeedbackSettings } from "./meta-crm-feedback-settings";
import { MetaLeadAdsSettings } from "./meta-lead-ads-settings";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * One "Meta" section with independently-configured capabilities:
 *   * Lead capture  — Direct Meta Lead Ads (Pages → Instant Forms → Workspace)
 *   * CRM Integration — CRM datasets plus lead-quality feedback to
 *     Meta (workspace "Lead Quality" → Conversions API events).
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
  // Lead Capture stays the default subtab. The retired Conversions API
  // tab is never offered here (see DEAD FEATURE note above).
  const [tab, setTab] = useState("lead-capture");
  return (
    <section className="space-y-5">
      <SettingsPanelHead
        title="Meta"
        description="Connect Meta to WhatsApp Max. Capture leads from Facebook & Instagram Instant Forms, and create CRM datasets for future optimization."
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line">
          <TabsTrigger value="lead-capture">Lead capture</TabsTrigger>
          <TabsTrigger value="crm-integration">CRM Integration</TabsTrigger>
        </TabsList>
        <TabsContent value="lead-capture" className="pt-4">
          <MetaLeadAdsSettings embedded />
        </TabsContent>
        <TabsContent value="crm-integration" className="pt-4">
          <div className="space-y-5">
            <MetaCrmDatasetSettings />
            <MetaCrmFeedbackSettings />
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
