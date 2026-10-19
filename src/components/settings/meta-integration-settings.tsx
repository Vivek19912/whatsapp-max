"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { MetaConversionsApiSettings } from "./meta-conversions-api-settings";
import { MetaLeadAdsSettings } from "./meta-lead-ads-settings";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * One "Meta" section with two independently-configured capabilities:
 *   * Lead capture  — Direct Meta Lead Ads (Pages → Instant Forms → Workspace)
 *   * Conversions API — send conversion events to the customer's dataset
 *
 * They share the platform Meta app but nothing else; either can be set
 * up, changed, or disconnected without touching the other.
 */
export function MetaIntegrationSettings() {
  return (
    <section className="space-y-5">
      <SettingsPanelHead
        title="Meta"
        description="Connect Meta to WhatsApp Max. Capture leads from Facebook & Instagram Instant Forms, and/or send conversion events to your own Meta dataset. The two are configured independently."
      />
      <Tabs defaultValue="lead-capture">
        <TabsList variant="line">
          <TabsTrigger value="lead-capture">Lead capture</TabsTrigger>
          <TabsTrigger value="conversions-api">Conversions API</TabsTrigger>
        </TabsList>
        <TabsContent value="lead-capture" className="pt-4">
          <MetaLeadAdsSettings embedded />
        </TabsContent>
        <TabsContent value="conversions-api" className="pt-4">
          <MetaConversionsApiSettings embedded />
        </TabsContent>
      </Tabs>
    </section>
  );
}
