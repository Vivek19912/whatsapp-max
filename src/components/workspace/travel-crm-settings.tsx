"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Settings2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  resolveDisplayServiceLabel,
  TRAVEL_CRM_SERVICE_LABELS,
} from "@/lib/integrations/travel-crm/services";
import {
  citiesForDestination,
  cityLabelForValue,
  resolveSelectValue,
  validateNightsInput,
} from "@/lib/integrations/travel-crm/itineraries";
import { ItineraryDestinationSelect, ITINERARY_DROPDOWN_ABOVE } from "./travel-crm-action";

export interface ItineraryEditRow {
  destination: string;
  city: string;
  nights: string;
}

interface LookupOption {
  value: string;
  label: string;
  destinationValue?: string | null;
}

/** Blank editing row (nights kept as text for typing). */
export function createEmptyItineraryRow(): ItineraryEditRow {
  return { destination: "", city: "", nights: "" };
}

/** Pure: append a blank row (Add More). */
export function addItineraryRow(rows: ItineraryEditRow[]): ItineraryEditRow[] {
  return [...rows, createEmptyItineraryRow()];
}

/** Pure: remove one row (Remove). Allows empty overall. */
export function removeItineraryRow(
  rows: ItineraryEditRow[],
  index: number,
): ItineraryEditRow[] {
  return rows.filter((_, i) => i !== index);
}

/**
 * Pure: set a row's destination and clear an incompatible city
 * rather than keeping an invalid pairing.
 */
export function updateItineraryDestination(
  rows: ItineraryEditRow[],
  index: number,
  destination: string,
  cities: ReadonlyArray<{ value: string; destinationValue?: string | null }>,
): ItineraryEditRow[] {
  return rows.map((row, i) => {
    if (i !== index) return row;
    const next = { ...row, destination };
    if (!next.city) return next;
    const linked = cities.filter((c) => (c.destinationValue ?? null) !== null);
    // No linkage in lookup data → free pairing, keep the city.
    if (linked.length === 0) return next;
    const compatible = linked.some(
      (c) => c.value === next.city && (c.destinationValue ?? null) === destination,
    );
    return compatible ? next : { ...next, city: "" };
  });
}

/** True when an editing row is completely empty (dropped on save). */
export function isEmptyItineraryRow(row: ItineraryEditRow): boolean {
  return !row.destination && !row.city && !row.nights.trim();
}

/**
 * Per-flow Travel CRM defaults, opened from the Workspace
 * controls next to Filters/Columns. Loads and saves ONLY the
 * currently selected flow's configuration — switching flows shows
 * that flow's own saved services + itinerary. Saving here never
 * touches any lead; it only changes future creation defaults.
 * Per-lead overrides in the creation dialog never write back here.
 */
export function TravelCrmSettings({
  flowId,
  flowName,
}: {
  flowId: string | null;
  flowName: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [rows, setRows] = useState<ItineraryEditRow[]>([]);
  const [destinations, setDestinations] = useState<LookupOption[]>([]);
  const [cities, setCities] = useState<LookupOption[]>([]);
  const [lookupsLoading, setLookupsLoading] = useState(false);
  const [lookupsError, setLookupsError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !flowId) return;
    setLoading(true);
    setLookupsLoading(true);
    setError(null);
    setLookupsError(null);
    fetch(`/api/flows/${flowId}/travel-crm-settings`, { cache: "no-store" })
      .then((r) => r.json().catch(() => null))
      .then((json) => {
        const list = (json as { services?: unknown } | null)?.services;
        setSelected(Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : []);
        const itin = (json as { itinerary?: unknown } | null)?.itinerary;
        if (Array.isArray(itin)) {
          setRows(
            itin
              .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
              .map((r) => ({
                destination:
                  typeof r.destination === "string" ? r.destination : "",
                city: typeof r.city === "string" ? r.city : "",
                nights:
                  typeof r.nights === "number" && Number.isFinite(r.nights)
                    ? String(r.nights)
                    : typeof r.nights === "string"
                      ? r.nights
                      : "",
              }))
              .filter((r) => r.destination || r.city || r.nights.trim()),
          );
        } else {
          setRows([]);
        }
      })
      .catch(() => setError("Could not load settings."))
      .finally(() => setLoading(false));
    fetch("/api/integrations/travel-crm/lookups", { cache: "no-store" })
      .then((r) => r.json().catch(() => null))
      .then((json) => {
        const j = json as {
          success?: boolean;
          destinations?: unknown;
          cities?: unknown;
        } | null;
        if (!j || j.success === false) {
          setLookupsError("Could not load Travel CRM destinations.");
          setDestinations([]);
          setCities([]);
          return;
        }
        const dests = Array.isArray(j.destinations)
          ? (j.destinations as Array<{ value?: unknown; label?: unknown }>)
              .filter(
                (o) =>
                  o && typeof o.value === "string" && o.value.trim(),
              )
              .map((o) => ({
                value: (o.value as string).trim(),
                label:
                  typeof o.label === "string" && o.label.trim()
                    ? o.label.trim()
                    : (o.value as string).trim(),
              }))
          : [];
        const cityList = Array.isArray(j.cities)
          ? (
              j.cities as Array<{
                value?: unknown;
                label?: unknown;
                destinationValue?: unknown;
              }>
            )
              .filter(
                (o) =>
                  o && typeof o.value === "string" && o.value.trim(),
              )
              .map((o) => ({
                value: (o.value as string).trim(),
                label:
                  typeof o.label === "string" && o.label.trim()
                    ? o.label.trim()
                    : (o.value as string).trim(),
                destinationValue:
                  typeof o.destinationValue === "string" &&
                  o.destinationValue.trim()
                    ? o.destinationValue.trim()
                    : null,
              }))
          : [];
        setDestinations(dests);
        setCities(cityList);
      })
      .catch(() => {
        setLookupsError("Could not load Travel CRM destinations.");
        setDestinations([]);
        setCities([]);
      })
      .finally(() => setLookupsLoading(false));
  }, [open, flowId]);

  function toggle(label: string) {
    // Compare through the display resolver so a retired stored
    // label ("Vehicle (disposal)") still matches its successor
    // ("Vehicle"): unchecking clears every spelling, checking
    // stores the current label.
    const matches = (s: string) =>
      resolveDisplayServiceLabel(s).toLowerCase() === label.toLowerCase();
    setSelected((prev) =>
      prev.some(matches)
        ? prev.filter((s) => !matches(s))
        : [...prev, label],
    );
  }

  function setDestination(index: number, value: string) {
    setRows((prev) => updateItineraryDestination(prev, index, value, cities));
  }

  function setCity(index: number, value: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, city: value } : r)));
  }

  function setNights(index: number, value: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, nights: value } : r)));
  }

  async function save() {
    if (!flowId) return;
    // Validate nights for non-empty rows before sending.
    for (const row of rows) {
      if (isEmptyItineraryRow(row)) continue;
      if (!row.destination || !row.city) {
        setError("Each itinerary row needs a destination, city, and nights.");
        return;
      }
      const nightsError = validateNightsInput(row.nights);
      if (nightsError) {
        setError(nightsError);
        return;
      }
    }
    const itinerary = rows
      .filter((r) => !isEmptyItineraryRow(r))
      .filter((r) => r.destination && r.city && r.nights.trim())
      .map((r) => ({
        destination: r.destination,
        city: r.city,
        nights: Number(r.nights.trim()),
      }));
    // The departure key is deliberately omitted: the API
    // preserves stored departure defaults when absent, so saving
    // here never wipes saved values and the creation dialog keeps
    // prefilling them.
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/flows/${flowId}/travel-crm-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ services: selected, itinerary }),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
        services?: unknown;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not save settings.");
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 text-sm"
        disabled={!flowId}
        onClick={() => setOpen(true)}
      >
        <Settings2 className="h-4 w-4" />
        Travel CRM Settings
      </Button>
      <Dialog open={open} onOpenChange={(v) => !v && setOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Travel CRM Settings</DialogTitle>
            <DialogDescription>Flow: {flowName}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
            <div className="space-y-2">
              <p className="text-foreground text-sm font-semibold">Travel CRM Defaults</p>
              <p className="text-muted-foreground text-xs">
                Default Services — preselected when creating a lead in Travel CRM.
              </p>
              {loading ? (
                <p className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading…
                </p>
              ) : (
                <div className="grid gap-1.5" role="group" aria-label="Default services">
                  {TRAVEL_CRM_SERVICE_LABELS.map((label) => {
                    // Retired stored labels resolve to the current
                    // name, so previously saved selections keep
                    // rendering checked after the rename.
                    const checked = selected.some(
                      (s) =>
                        resolveDisplayServiceLabel(s).toLowerCase() ===
                        label.toLowerCase(),
                    );
                    return (
                      <label
                        key={label}
                        className="text-foreground flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggle(label)}
                          aria-label={label}
                        />
                        <span className="truncate">{label}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <p className="text-foreground text-sm font-semibold">Itinerary Defaults</p>
              <p className="text-muted-foreground text-xs">
                Prefilled in the Travel CRM lead dialog. Empty means no itinerary is
                prefilled. Editing a lead never changes these defaults.
              </p>
              {loading ? (
                <p className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading…
                </p>
              ) : lookupsLoading ? (
                <p className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading Travel CRM destinations…
                </p>
              ) : lookupsError ? (
                <p role="alert" className="text-xs text-red-500">
                  {lookupsError} Destinations come from Travel CRM — no options are
                  shown until it loads.
                </p>
              ) : rows.length === 0 ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-dashed p-3">
                  <p className="text-muted-foreground text-xs">
                    No itinerary defaults — leads start with an empty itinerary.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRows(addItineraryRow([]))}
                  >
                    <Plus className="h-4 w-4" />
                    Add itinerary
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {rows.map((row, i) => {
                    const cityOptions = row.destination
                      ? citiesForDestination(cities, row.destination)
                      : [];
                    // Stored values are stable Travel CRM IDs. When a
                    // stored ID has no matching lookup option (stale or
                    // archived master), show the "Select" placeholder
                    // instead of a raw UUID — the stored value stays
                    // intact in state and on save.
                    const destinationValue = resolveSelectValue(destinations, row.destination);
                    const cityValue = resolveSelectValue(cityOptions, row.city);
                    // Explicit label resolution (ID → name) for the
                    // city display: the stored UUID is passed to the
                    // Select only as the value; the human-readable
                    // name renders directly so the trigger never
                    // shows a raw UUID.
                    const cityLabel = cityLabelForValue(cityOptions, row.city);
                    // Destination uses the shared country-grouped
                    // selector (same component as the creation
                    // dialog): groups appear when the lookup feed
                    // carries country metadata, otherwise the flat
                    // list renders exactly as before.
                    return (
                      <div
                        key={i}
                        className="grid grid-cols-[1fr_1fr_72px_auto] items-end gap-2"
                      >
                        <div className="grid gap-1">
                          <label
                            className="text-muted-foreground text-xs"
                            htmlFor={`itin-dest-${i}`}
                          >
                            Destination
                          </label>
                          <ItineraryDestinationSelect
                            value={destinationValue}
                            options={destinations}
                            inputId={`itin-dest-${i}`}
                            onChange={(v) => setDestination(i, v ?? "")}
                          />
                        </div>
                        <div className="grid gap-1">
                          <label
                            className="text-muted-foreground text-xs"
                            htmlFor={`itin-city-${i}`}
                          >
                            City
                          </label>
                          <Select
                            value={cityValue}
                            onValueChange={(v) => setCity(i, v ?? "")}
                            disabled={!row.destination}
                          >
                          <SelectTrigger id={`itin-city-${i}`} aria-label="City" className="min-h-8 w-full *:[data-slot=select-value]:line-clamp-none *:[data-slot=select-value]:whitespace-normal">
                            <SelectValue
                              placeholder={
                                row.destination ? "Select" : "Pick destination first"
                              }
                            >
                              {cityLabel !== null ? cityLabel : undefined}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent {...ITINERARY_DROPDOWN_ABOVE}>
                            {cityOptions.map((o) => (
                              <SelectItem
                                key={`${o.destinationValue ?? ""}:${o.value}`}
                                value={o.value}
                                className="[&>div]:whitespace-normal [&>div]:break-words"
                              >
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                          </Select>
                        </div>
                        <div className="grid gap-1">
                          <label
                            className="text-muted-foreground text-xs"
                            htmlFor={`itin-nights-${i}`}
                          >
                            Nights
                          </label>
                          <Input
                            id={`itin-nights-${i}`}
                            aria-label="Nights"
                            type="number"
                            min={1}
                            className="h-8"
                            value={row.nights}
                            onChange={(e) => setNights(i, e.target.value)}
                            placeholder="4"
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2"
                          onClick={() => setRows((prev) => removeItineraryRow(prev, i))}
                          aria-label="Remove itinerary row"
                        >
                          <Trash2 className="h-4 w-4" />
                          Remove
                        </Button>
                      </div>
                    );
                  })}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRows((prev) => addItineraryRow(prev))}
                  >
                    <Plus className="h-4 w-4" />
                    Add More
                  </Button>
                </div>
              )}
            </div>
          </div>
          {error !== null && (
            <p role="alert" className="text-xs text-red-500">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={busy || loading} onClick={save}>
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
