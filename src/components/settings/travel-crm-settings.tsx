"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowLeftRight, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  DEFAULT_TRAVEL_CRM_URL,
  getTravelCrmUrl,
  isValidTravelCrmUrl,
} from "@/lib/travel-crm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";
import { CrmUserMappingSection } from "./crm-user-mapping-section";

/**
 * Travel CRM link — the URL opened (new tab) by the "Travel CRM"
 * sidebar card.
 *
 * One URL per account: writes go straight to
 * `accounts.travel_crm_url` (migration 076); the `accounts_update`
 * RLS policy (017) already restricts that to admins+, so non-admins
 * see a disabled, read-only control.
 *
 * The input always shows the EFFECTIVE url: the configured value,
 * or DEFAULT_TRAVEL_CRM_URL when nothing is configured. Clearing
 * the field saves NULL, which resolves back to the default — the
 * sidebar card is therefore always available and never a broken
 * link.
 */
export function TravelCrmSettings() {
  const supabase = createClient();
  const {
    accountId,
    account,
    canEditSettings,
    profileLoading,
    refreshProfile,
  } = useAuth();

  const effective = getTravelCrmUrl(account);
  const [url, setUrl] = useState(effective);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the input in sync once the profile (and its account URL)
  // resolves, and after a save round-trips through refreshProfile.
  useEffect(() => {
    setUrl(getTravelCrmUrl(account));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.travel_crm_url]);

  const dirty = url.trim() !== effective;

  async function handleSave() {
    if (!accountId || !dirty) return;
    const trimmed = url.trim();
    // Empty clears the override → NULL → default. Anything else
    // must be an absolute http(s) URL.
    if (trimmed && !isValidTravelCrmUrl(trimmed)) {
      setError("Enter a valid URL starting with http:// or https://.");
      return;
    }
    setError(null);
    setSaving(true);
    const { error } = await supabase
      .from("accounts")
      .update({ travel_crm_url: trimmed || null })
      .eq("id", accountId);
    if (error) {
      toast.error("Failed to save Travel Agency CRM URL");
      setSaving(false);
      return;
    }
    // Pull the new value back into the auth context so the sidebar
    // card picks it up without a full reload.
    await refreshProfile();
    setSaving(false);
    toast.success("Travel Agency CRM URL updated");
  }

  const isDefault = effective === DEFAULT_TRAVEL_CRM_URL;

  return (
    <section className="max-w-4xl animate-in fade-in-50 duration-200 space-y-6">
      <SettingsPanelHead
        title="Travel Agency CRM"
        description="Cross-app navigation for your team — the sidebar card that opens your Travel Agency CRM in a new tab."
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <ArrowLeftRight className="size-4 text-primary" />
            Travel Agency CRM URL
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            URL opened when clicking &ldquo;Travel Agency CRM&rdquo; from the
            sidebar.
            {isDefault
              ? ` Showing the default (${DEFAULT_TRAVEL_CRM_URL}). Replace it to point at a different workspace.`
              : " Using your custom URL — clear the field to go back to the default."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label className="text-muted-foreground" htmlFor="travel-crm-url">
              Travel Agency CRM URL
            </Label>
            <Input
              id="travel-crm-url"
              type="url"
              inputMode="url"
              placeholder={DEFAULT_TRAVEL_CRM_URL}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (error) setError(null);
              }}
              disabled={!canEditSettings || profileLoading}
              className="disabled:cursor-not-allowed disabled:opacity-60"
            />
            {error ? (
              <p className="text-xs text-destructive">{error}</p>
            ) : (
              !canEditSettings && (
                <p className="text-xs text-muted-foreground">
                  Only account admins can change the Travel Agency CRM URL.
                </p>
              )
            )}
          </div>

          {canEditSettings && (
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Section 2: CRM User Mapping — which workspace member's leads go
          to which CRM salesperson. Managed here with the account's own
          session; no API keys involved. */}
      <CrmUserMappingSection />
    </section>
  );
}
