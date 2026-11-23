"use client";

// Meta CRM Integration — Dataset creation + registry (Features 1 + 2).
//
// New, independent Instant Form CRM Integration UI. It does NOT reuse
// the retired Conversions API (`meta-capi`) implementation, which
// remains untouched and hidden from Settings.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const DATASET_SUGGESTIONS = ["Interscale Marketing"] as const;

interface SavedDataset {
  id: string;
  datasetId: string;
  datasetName: string;
  businessPortfolioId: string;
  datasetType: string;
  creationStatus: string;
  createdAt: string;
}

interface ApiError {
  error?: string;
  code?: string;
  metaCode?: number;
  metaSubcode?: number;
  saveError?: string;
  fieldErrors?: Record<string, string>;
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

function normalizeDataset(json: unknown): SavedDataset | null {
  const d = (json as { dataset?: Record<string, unknown> } | null)?.dataset;
  if (!d || typeof d !== "object") return null;
  const datasetId =
    typeof d.datasetId === "string"
      ? d.datasetId
      : typeof d.id === "string" && !d.id.startsWith("pending-")
        ? d.id
        : null;
  // Pending-save shape carries the real Meta id separately.
  const pendingId =
    typeof d.datasetId === "string"
      ? d.datasetId
      : typeof (d as { id?: unknown }).id === "string" &&
          ((d as { id: string }).id.startsWith("pending-")
            ? (d as { id: string }).id.slice("pending-".length)
            : null);
  const realId = datasetId ?? pendingId;
  if (!realId) return null;
  return {
    id: typeof d.id === "string" ? d.id : realId,
    datasetId: realId,
    datasetName:
      typeof d.datasetName === "string"
        ? d.datasetName
        : typeof d.name === "string"
          ? d.name
          : "",
    businessPortfolioId:
      typeof d.businessPortfolioId === "string" ? d.businessPortfolioId : "",
    datasetType: typeof d.datasetType === "string" ? d.datasetType : (typeof d.type === "string" ? d.type : "CRM"),
    creationStatus:
      typeof d.creationStatus === "string"
        ? d.creationStatus
        : typeof d.status === "string"
          ? d.status
          : "Created",
    createdAt: typeof d.createdAt === "string" ? d.createdAt : new Date().toISOString(),
  };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MetaCrmDatasetSettings() {
  const { canEditSettings, profileLoading } = useAuth();
  const [datasetName, setDatasetName] = useState("");
  const [businessPortfolioId, setBusinessPortfolioId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [lastCreated, setLastCreated] = useState<SavedDataset | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);

  const [datasets, setDatasets] = useState<SavedDataset[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);

  const [showRegister, setShowRegister] = useState(false);
  const [regDatasetId, setRegDatasetId] = useState("");
  const [regBusinessId, setRegBusinessId] = useState("");
  const [regToken, setRegToken] = useState("");
  const [regShowToken, setRegShowToken] = useState(false);
  const [regBusy, setRegBusy] = useState(false);
  const [regErrors, setRegErrors] = useState<Record<string, string>>({});

  // Local-only removal (never touches Meta): the dialog target plus
  // a live "currently selected by CRM Feedback" check.
  const [removeTarget, setRemoveTarget] = useState<SavedDataset | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeBlocked, setRemoveBlocked] = useState(false);
  const [removeCheckPending, setRemoveCheckPending] = useState(false);

  const disabled = !canEditSettings || profileLoading || busy;

  const loadDatasets = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await fetch("/api/integrations/meta-crm/datasets", { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        datasets?: SavedDataset[];
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(
          typeof json.error === "string" && json.error ? json.error : `Could not load datasets (${res.status}).`,
        );
      }
      setDatasets(Array.isArray(json.datasets) ? json.datasets : []);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Could not load datasets.");
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDatasets();
  }, [loadDatasets]);

  async function handleCreate() {
    if (busy) return;
    setFieldErrors({});
    setSaveWarning(null);

    const nextErrors: Record<string, string> = {};
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
        stored?: boolean;
        dataset?: unknown;
      };
      if (!res.ok || !json.ok) {
        if (json.fieldErrors) setFieldErrors(json.fieldErrors);
        throw new Error(friendlyError(json, res.status));
      }
      const created = normalizeDataset(json);
      if (!created) throw new Error("Meta did not return a Dataset ID.");
      setLastCreated(created);
      setAccessToken("");
      if (json.stored === false) {
        setSaveWarning(
          typeof json.saveError === "string" && json.saveError
            ? json.saveError
            : "Dataset was created in Meta but could not be saved locally. Use “Add Existing” with the ID below to save it.",
        );
        // Prefill the register form so retry needs no new Meta POST.
        setRegDatasetId(created.datasetId);
        setRegBusinessId(created.businessPortfolioId);
        setShowRegister(true);
        toast.success("Created in Meta — save pending");
      } else {
        toast.success("CRM Dataset Created Successfully");
        setDatasetName("");
        setBusinessPortfolioId("");
      }
      await loadDatasets();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Dataset creation failed.");
    } finally {
      setBusy(false);
    }
  }

  function handleCreateAnother() {
    setLastCreated(null);
    setSaveWarning(null);
    setDatasetName("");
    setBusinessPortfolioId("");
    setAccessToken("");
    setFieldErrors({});
  }

  async function handleCopy(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      toast.success("Dataset ID copied.");
    } catch {
      toast.error("Could not copy the Dataset ID.");
    }
  }

  /**
   * Open the remove confirmation for one row. Before showing the
   * action, check live CRM Feedback config: removing the dataset
   * it currently uses would silently break sending, so the dialog
   * warns and the server enforces (409) until feedback is
   * disabled or pointed elsewhere.
   */
  async function openRemove(dataset: SavedDataset) {
    setRemoveTarget(dataset);
    setRemoveBlocked(false);
    setRemoveCheckPending(true);
    try {
      const res = await fetch("/api/integrations/meta-crm/config", { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        config?: { enabled?: boolean; datasetId?: string | null } | null;
      };
      const cfg = json.config ?? null;
      setRemoveBlocked(
        !!cfg &&
          cfg.enabled === true &&
          typeof cfg.datasetId === "string" &&
          cfg.datasetId !== "" &&
          cfg.datasetId === dataset.datasetId,
      );
    } catch {
      // Unknown counts as not-blocked: the server re-checks
      // authoritatively on confirm, so a failed probe can never
      // bypass the guard — it only skips the advance warning.
      setRemoveBlocked(false);
    } finally {
      setRemoveCheckPending(false);
    }
  }

  function closeRemove() {
    if (removing) return;
    setRemoveTarget(null);
    setRemoveBlocked(false);
  }

  async function handleRemove() {
    if (!removeTarget || removing) return;
    setRemoving(true);
    try {
      const res = await fetch(
        `/api/integrations/meta-crm/datasets/${encodeURIComponent(removeTarget.id)}`,
        { method: "DELETE" },
      );
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        code?: string;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(
          typeof json.error === "string" && json.error
            ? json.error
            : `Could not remove the dataset (${res.status}).`,
        );
      }
      toast.success("Dataset removed from WhatsApp Max. It still exists in Meta Events Manager.");
      setRemoveTarget(null);
      setRemoveBlocked(false);
      await loadDatasets();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the dataset.");
    } finally {
      setRemoving(false);
    }
  }

  async function handleRegister() {
    if (regBusy) return;
    setRegErrors({});
    const nextErrors: Record<string, string> = {};
    if (regDatasetId.trim() === "") nextErrors.datasetId = "Enter the existing Meta Dataset ID.";
    else if (!/^\d{5,32}$/.test(regDatasetId.trim())) nextErrors.datasetId = "Dataset ID must be a numeric ID (5–32 digits).";
    if (regBusinessId.trim() === "") nextErrors.businessPortfolioId = "Enter the numeric Business Portfolio ID.";
    else if (!/^\d{5,32}$/.test(regBusinessId.trim()))
      nextErrors.businessPortfolioId = "Business Portfolio ID must be a numeric ID (5–32 digits).";
    if (regToken.trim() === "") nextErrors.accessToken = "Paste your authorized Meta access token.";
    if (Object.keys(nextErrors).length > 0) {
      setRegErrors(nextErrors);
      return;
    }
    setRegBusy(true);
    try {
      const res = await fetch("/api/integrations/meta-crm/datasets/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          datasetId: regDatasetId.trim(),
          businessPortfolioId: regBusinessId.trim(),
          accessToken: regToken.trim(),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as ApiError & {
        ok?: boolean;
        dataset?: SavedDataset;
        ownershipVerified?: boolean;
        verificationNote?: string;
      };
      if (!res.ok || !json.ok || !json.dataset) {
        if (json.fieldErrors) setRegErrors(json.fieldErrors);
        throw new Error(friendlyError(json, res.status));
      }
      setRegToken("");
      setShowRegister(false);
      setSaveWarning(null);
      toast.success(
        json.ownershipVerified
          ? "Existing dataset registered."
          : "Existing dataset saved (access verified).",
      );
      await loadDatasets();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Registration failed.");
    } finally {
      setRegBusy(false);
    }
  }

  return (
    <div className="space-y-5">
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

      {saveWarning && lastCreated ? (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="text-foreground">Created in Meta — save pending</CardTitle>
            <CardDescription className="text-muted-foreground">{saveWarning}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">Meta Dataset ID: </span>
              <span className="font-mono font-medium break-all">{lastCreated.datasetId}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => handleCopy(lastCreated.datasetId)}>
                <Copy className="size-4" /> Copy Dataset ID
              </Button>
              <Button variant="outline" onClick={() => { setShowRegister(true); }}>
                <Plus className="size-4" /> Add Existing to save it
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : lastCreated ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <CheckCircle2 className="size-4 text-emerald-600" />
              CRM Dataset Created Successfully
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Saved to WhatsApp Max — it persists across refreshes and logins.
              Event transmission is not connected yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <dl className="grid gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Dataset Name</dt>
                <dd className="font-medium text-foreground">{lastCreated.datasetName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Business Portfolio ID</dt>
                <dd className="font-medium text-foreground">{lastCreated.businessPortfolioId}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">New Meta Dataset ID</dt>
                <dd className="font-mono font-medium break-all text-foreground">{lastCreated.datasetId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">CRM Dataset Type</dt>
                <dd className="font-medium text-foreground">CRM</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Status</dt>
                <dd className="font-medium text-foreground">{lastCreated.creationStatus}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="outline" onClick={() => handleCopy(lastCreated.datasetId)}>
                <Copy className="size-4" /> Copy Dataset ID
              </Button>
              <Button variant="outline" onClick={handleCreateAnother}>
                <Plus className="size-4" /> Create Another Dataset
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-foreground">Created CRM Datasets</CardTitle>
              <CardDescription className="text-muted-foreground">
                Datasets saved in WhatsApp Max for this account. This list reflects
                saved records — not a live sync of everything in Meta.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void loadDatasets()} disabled={listLoading}>
                <RefreshCw className={`size-4 ${listLoading ? "animate-spin" : ""}`} /> Refresh
              </Button>
              {canEditSettings && !profileLoading ? (
                <Button variant="outline" size="sm" onClick={() => setShowRegister((v) => !v)}>
                  <Plus className="size-4" /> Add Existing CRM Dataset
                </Button>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {showRegister ? (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-sm font-medium text-foreground">Add Existing CRM Dataset</p>
              <p className="text-xs text-muted-foreground">
                Registers a dataset already created in Meta. Nothing new is created
                in Meta — the ID is verified with your token, then saved here.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="meta-crm-reg-id">Existing Meta Dataset ID</Label>
                  <Input
                    id="meta-crm-reg-id"
                    inputMode="numeric"
                    placeholder="e.g. 1830596054845292"
                    value={regDatasetId}
                    onChange={(e) => setRegDatasetId(e.target.value)}
                    disabled={regBusy}
                    autoComplete="off"
                  />
                  {regErrors.datasetId ? (
                    <p className="text-sm text-destructive">{regErrors.datasetId}</p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="meta-crm-reg-business">Business Portfolio ID</Label>
                  <Input
                    id="meta-crm-reg-business"
                    inputMode="numeric"
                    placeholder="Enter Business Portfolio ID"
                    value={regBusinessId}
                    onChange={(e) => setRegBusinessId(e.target.value)}
                    disabled={regBusy}
                    autoComplete="off"
                  />
                  {regErrors.businessPortfolioId ? (
                    <p className="text-sm text-destructive">{regErrors.businessPortfolioId}</p>
                  ) : null}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="meta-crm-reg-token">Meta Access Token</Label>
                <div className="relative">
                  <Input
                    id="meta-crm-reg-token"
                    type={regShowToken ? "text" : "password"}
                    placeholder="Paste your authorized Meta access token"
                    value={regToken}
                    onChange={(e) => setRegToken(e.target.value)}
                    disabled={regBusy}
                    autoComplete="off"
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute top-1/2 right-1 h-7 w-7 -translate-y-1/2 p-0"
                    onClick={() => setRegShowToken((v) => !v)}
                    aria-label={regShowToken ? "Hide access token" : "Show access token"}
                    disabled={regBusy}
                  >
                    {regShowToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </Button>
                </div>
                {regErrors.accessToken ? (
                  <p className="text-sm text-destructive">{regErrors.accessToken}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleRegister} disabled={regBusy || !canEditSettings}>
                  {regBusy ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Verifying...
                    </>
                  ) : (
                    "Verify & Save Existing Dataset"
                  )}
                </Button>
                <Button variant="ghost" onClick={() => setShowRegister(false)} disabled={regBusy}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {listLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading saved datasets…
            </p>
          ) : listError ? (
            <div className="space-y-2">
              <p className="text-sm text-destructive">{listError}</p>
              <Button variant="outline" size="sm" onClick={() => void loadDatasets()}>
                <RefreshCw className="size-4" /> Retry
              </Button>
            </div>
          ) : !datasets || datasets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No CRM datasets saved yet. Create one above — it will appear here and
              persist across refreshes and logins.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dataset Name</TableHead>
                  <TableHead>Meta Dataset ID</TableHead>
                  <TableHead>Business Portfolio ID</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date saved</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {datasets.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.datasetName}</TableCell>
                    <TableCell className="font-mono break-all">{d.datasetId}</TableCell>
                    <TableCell className="font-mono break-all">{d.businessPortfolioId}</TableCell>
                    <TableCell>{d.datasetType}</TableCell>
                    <TableCell>{d.creationStatus}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(d.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => handleCopy(d.datasetId)} aria-label={`Copy dataset ID ${d.datasetId}`}>
                          <Copy className="size-4" />
                        </Button>
                        {canEditSettings && !profileLoading ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void openRemove(d)}
                            aria-label={`Remove dataset ${d.datasetName}`}
                            title={`Remove dataset ${d.datasetName}`}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={removeTarget !== null} onOpenChange={(open) => { if (!open) closeRemove(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-foreground">Remove CRM Dataset</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove this CRM dataset from WhatsApp Max?
            </DialogDescription>
          </DialogHeader>
          {removeTarget ? (
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Dataset Name</dt>
                <dd className="font-medium text-foreground">{removeTarget.datasetName || "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Business Portfolio ID</dt>
                <dd className="font-mono break-all text-foreground">{removeTarget.businessPortfolioId || "—"}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Meta Dataset ID</dt>
                <dd className="font-mono break-all text-foreground">{removeTarget.datasetId}</dd>
              </div>
            </dl>
          ) : null}
          <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            This will only remove the dataset registration from WhatsApp Max.
            Your dataset and its events will remain unchanged in Meta Events Manager.
          </p>
          {removeBlocked ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-foreground" role="alert">
              This dataset is currently used by CRM Feedback. Disable CRM feedback
              (or select a different dataset) before removing it.
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeRemove} disabled={removing}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleRemove()}
              disabled={removing || removeCheckPending || removeBlocked || !canEditSettings}
            >
              {removing ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Removing…
                </>
              ) : (
                "Remove from WhatsApp Max"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
