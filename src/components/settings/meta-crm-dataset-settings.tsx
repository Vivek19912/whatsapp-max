"use client";

// Meta CRM Integration — Dataset creation form (Feature 1).
//
// New, independent Instant Form CRM Integration UI. It does NOT reuse
// the retired Conversions API (`meta-capi`) implementation, which
// remains untouched and hidden from Settings.

import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Copy, Eye, EyeOff, Loader2, Plus } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const DATASET_SUGGESTIONS = ["Interscale Marketing"] as const;

interface CreatedDataset {
  id: string;
  name: string;
  businessPortfolioId: string;
  type: string;
  status: string;
}

interface ApiError {
  error?: string;
  code?: string;
  metaCode?: number;
  metaSubcode?: number;
  fieldErrors?: {
    datasetName?: string;
    businessPortfolioId?: string;
    accessToken?: string;
  };
}

function friendlyError(payload: ApiError, status: number): string {
  if (typeof payload.error === "string" && payload.error.trim() !== "") {
    const suffix =
      typeof payload.metaCode === "number"
        ? ` (Meta code ${payload.metaCode}${typeof payload.metaSubcode === "number" ? `, subcode ${payload.metaSubcode}` : ""})`
        : "";
    return `${payload.error}${suffix}`;
  }
  if (status === 401) return "Meta rejected the access token. It may be expired or invalid.";
  if (status === 403) return "Meta refused: insufficient permissions (code 200). Grant dataset creation rights to this token/business.";
  return `Dataset creation failed (${status}). Try again.`;
}

export function MetaCrmDatasetSettings() {
  const { canEditSettings, profileLoading } = useAuth();
  const [datasetName, setDatasetName] = useState("");
  const [businessPortfolioId, setBusinessPortfolioId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{
    datasetName?: string;
    businessPortfolioId?: string;
    accessToken?: string;
  }>({});
  const [created, setCreated] = useState<CreatedDataset | null>(null);

  const disabled = !canEditSettings || profileLoading || busy;

  async function handleCreate() {
    if (busy) return;
    setFieldErrors({});

    const nextErrors: typeof fieldErrors = {};
    if (datasetName.trim() === "") nextErrors.datasetName = "Enter a dataset name.";
    if (businessPortfolioId.trim() === "") {
      nextErrors.businessPortfolioId = "Enter the numeric Business Portfolio ID.";
    } else if (!/^\d{5,32}$/.test(businessPortfolioId.trim())) {
      nextErrors.businessPortfolioId = "Business Portfolio ID must be a numeric ID (5–32 digits).";
    }
    if (accessToken.trim() === "") {
      nextErrors.accessToken = "Paste your authorized Meta access token.";
    }
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/integrations/meta-crm/datasets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          datasetName: datasetName.trim(),
          businessPortfolioId: businessPortfolioId.trim(),
          accessToken: accessToken.trim(),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as ApiError & {
        ok?: boolean;
        dataset?: CreatedDataset;
      };
      if (!res.ok || !json.ok || !json.dataset?.id) {
        if (json.fieldErrors) setFieldErrors(json.fieldErrors);
        throw new Error(friendlyError(json, res.status));
      }
      setCreated(json.dataset);
      // Clear the token from memory after use; it is never persisted.
      setAccessToken("");
      toast.success("CRM Dataset Created Successfully");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Dataset creation failed.");
    } finally {
      setBusy(false);
    }
  }

  function handleCreateAnother() {
    setCreated(null);
    setDatasetName("");
    setBusinessPortfolioId("");
    setAccessToken("");
    setFieldErrors({});
  }

  async function handleCopy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.id);
      toast.success("Dataset ID copied.");
    } catch {
      toast.error("Could not copy the Dataset ID.");
    }
  }

  if (created) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <CheckCircle2 className="size-4 text-emerald-600" />
            CRM Dataset Created Successfully
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Save this Dataset ID — future CRM integration steps will reference it.
            Event transmission is not connected yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <dl className="grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Dataset Name</dt>
              <dd className="font-medium text-foreground">{created.name}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Business Portfolio ID</dt>
              <dd className="font-medium text-foreground">{created.businessPortfolioId}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">New Meta Dataset ID</dt>
              <dd className="font-mono font-medium break-all text-foreground">{created.id}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">CRM Dataset Type</dt>
              <dd className="font-medium text-foreground">CRM</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Status</dt>
              <dd className="font-medium text-foreground">Created</dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="outline" onClick={handleCopy}>
              <Copy className="size-4" /> Copy Dataset ID
            </Button>
            <Button variant="outline" onClick={handleCreateAnother}>
              <Plus className="size-4" /> Create Another Dataset
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">Create Meta CRM Dataset</CardTitle>
        <CardDescription className="text-muted-foreground">
          Create a CRM dataset under your Meta Business Portfolio. The dataset
          ID is used by future CRM integration steps — no events are sent yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="meta-crm-dataset-name">Dataset Name</Label>
          <Input
            id="meta-crm-dataset-name"
            list="meta-crm-dataset-suggestions"
            placeholder="Enter dataset name"
            value={datasetName}
            onChange={(e) => setDatasetName(e.target.value)}
            disabled={disabled}
            autoComplete="off"
          />
          <datalist id="meta-crm-dataset-suggestions">
            {DATASET_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          {fieldErrors.datasetName ? (
            <p className="text-sm text-destructive">{fieldErrors.datasetName}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="meta-crm-business-id">Meta Business Portfolio ID</Label>
          <Input
            id="meta-crm-business-id"
            inputMode="numeric"
            placeholder="Enter Business Portfolio ID"
            value={businessPortfolioId}
            onChange={(e) => setBusinessPortfolioId(e.target.value)}
            disabled={disabled}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Enter the numeric Business Portfolio ID from Meta Business Settings.
          </p>
          {fieldErrors.businessPortfolioId ? (
            <p className="text-sm text-destructive">{fieldErrors.businessPortfolioId}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="meta-crm-access-token">Meta Access Token</Label>
          <div className="relative">
            <Input
              id="meta-crm-access-token"
              type={showToken ? "text" : "password"}
              placeholder="Paste your authorized Meta access token"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              disabled={disabled}
              autoComplete="off"
              className="pr-10"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute top-1/2 right-1 h-7 w-7 -translate-y-1/2 p-0"
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? "Hide access token" : "Show access token"}
              disabled={disabled}
            >
              {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
          </div>
          {fieldErrors.accessToken ? (
            <p className="text-sm text-destructive">{fieldErrors.accessToken}</p>
          ) : null}
        </div>

        <Button onClick={handleCreate} disabled={disabled}>
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Creating CRM Dataset...
            </>
          ) : (
            "Create CRM Dataset"
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
