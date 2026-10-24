"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Pencil,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { RequireRole } from "@/components/auth/require-role";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Label } from "@/components/ui/label";
import { SettingsPanelHead } from "@/components/settings/settings-panel-head";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { eligibleMemberIds } from "@/lib/lead-assignment/members";
import {
  normalizeWeightText,
  parseWeightInput,
  validateMembersStep,
  validateRuleInput,
} from "@/lib/lead-assignment/validation";

/**
 * Lead Assignment dashboard (admin only — enforced again
 * server-side on every API). Separate from Chat Assignment in
 * every respect: own table, own rules, own engine, own APIs.
 *
 * One dashboard, two areas:
 *   1. Assignment Rules table (search, create/edit, pause/resume,
 *      delete with confirmation, per-rule recent activity).
 *   2. Table coverage (which active rule governs each Meta table,
 *      or "No rule" when leads stay unassigned).
 *
 * The rule form is a 4-step drawer: tables → mode → members →
 * review. All writes go through the backend; the UI never stores
 * rules locally.
 */

interface RuleMemberView {
  user_id: string;
  position: number;
  weight: number;
}

interface RuleView {
  id: string;
  name: string;
  scope: "specific" | "all";
  mode: "round_robin" | "swrr";
  status: "active" | "paused";
  tables: string[];
  members: RuleMemberView[];
}

interface TableView {
  form_id: string;
  label: string;
  flow_id: string | null;
  governing_rule: {
    id: string;
    name: string;
    mode: string;
    status: string;
  } | null;
}

interface RosterMember {
  user_id: string;
  full_name: string | null;
  /** Same shape as the Team Members page: /api/account/members returns `role`. */
  role: string;
}

interface DraftMember {
  user_id: string;
  /** Parsed share; null while the field is empty or non-numeric. */
  weight: number | null;
}

interface RuleDraft {
  name: string;
  scope: "specific" | "all";
  tables: string[];
  mode: "round_robin" | "swrr";
  members: DraftMember[];
  active: boolean;
  tableSearch: string;
  memberSearch: string;
}

const EMPTY_DRAFT: RuleDraft = {
  name: "",
  scope: "specific",
  tables: [],
  mode: "round_robin",
  members: [],
  active: true,
  tableSearch: "",
  memberSearch: "",
};

interface ActivityEvent {
  id: string;
  assigned_user_id: string | null;
  previous_user_id: string | null;
  kind: string;
  reason: string | null;
  created_by: string | null;
  created_at: string;
  flow_run_id: string | null;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function LeadAssignmentPanel() {
  const [rules, setRules] = useState<RuleView[]>([]);
  const [tables, setTables] = useState<TableView[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [drawer, setDrawer] = useState<null | { editingId: string | null }>(null);
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RuleView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);

  const nameByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of roster) map.set(m.user_id, m.full_name?.trim() || m.user_id);
    return map;
  }, [roster]);

  const roleByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of roster) map.set(m.user_id, m.role);
    return map;
  }, [roster]);

  // Same eligibility rule as the assignment backend (single
  // source in lib/lead-assignment/members): owner/admin/agent,
  // presence never filters. The owner is always eligible even
  // without an explicit Admin/Agent role.
  const eligibleIds = useMemo(() => new Set(eligibleMemberIds(roster)), [roster]);
  const eligibleRoster = useMemo(
    () => roster.filter((m) => eligibleIds.has(m.user_id)),
    [roster, eligibleIds],
  );

  const tableLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tables) map.set(t.form_id, t.label);
    return map;
  }, [tables]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [rulesRes, tablesRes, membersRes] = await Promise.all([
        fetch("/api/lead-assignment/rules", { cache: "no-store" }),
        fetch("/api/lead-assignment/tables", { cache: "no-store" }),
        fetch("/api/account/members", { cache: "no-store" }),
      ]);
      if (!rulesRes.ok) throw new Error("Could not load assignment rules.");
      if (!tablesRes.ok) throw new Error("Could not load Meta tables.");
      if (!membersRes.ok) throw new Error("Could not load team members.");
      const rulesJson = (await rulesRes.json()) as { rules: RuleView[] };
      const tablesJson = (await tablesRes.json()) as { tables: TableView[] };
      const membersJson = (await membersRes.json()) as { members: RosterMember[] };
      setRules(rulesJson.rules ?? []);
      setTables(tablesJson.tables ?? []);
      setRoster(membersJson.members ?? []);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load Lead Assignment."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  function openCreate() {
    setDraft({ ...EMPTY_DRAFT });
    setWeightText({});
    setStep(1);
    setSaveError(null);
    setActivity([]);
    setDrawer({ editingId: null });
  }

  function openEdit(rule: RuleView) {
    setDraft({
      name: rule.name,
      scope: rule.scope,
      tables: [...rule.tables],
      mode: rule.mode,
      members: [...rule.members]
        .sort((a, b) => a.position - b.position)
        .map((m) => ({ user_id: m.user_id, weight: m.weight })),
      active: rule.status === "active",
      tableSearch: "",
      memberSearch: "",
    });
    setWeightText({});
    setStep(1);
    setSaveError(null);
    setDrawer({ editingId: rule.id });
    void fetch(`/api/lead-assignment/events?rule_id=${rule.id}`, { cache: "no-store" })
      .then((r) => r.json().catch(() => null))
      .then((json) => {
        const events = (json as { events?: ActivityEvent[] } | null)?.events;
        if (Array.isArray(events)) setActivity(events.slice(0, 10));
      })
      .catch(() => setActivity([]));
  }

  const filteredRules = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.members.some((m) =>
          (nameByUserId.get(m.user_id) ?? m.user_id).toLowerCase().includes(q),
        ),
    );
  }, [rules, search, nameByUserId]);

  /** Live conflict preview: selected tables already governed elsewhere. */
  const conflictPreview = useMemo(() => {
    if (draft.scope === "all") {
      const other = rules.find(
        (r) =>
          r.scope === "all" &&
          r.status === "active" &&
          r.id !== drawer?.editingId,
      );
      return other
        ? [`All Tables fallback "${other.name}" is already active.`]
        : [];
    }
    const warnings: string[] = [];
    for (const formId of draft.tables) {
      const table = tables.find((t) => t.form_id === formId);
      const gov = table?.governing_rule;
      if (gov && gov.id !== drawer?.editingId) {
        warnings.push(
          `"${tableLabelById.get(formId) ?? formId}" is covered by "${gov.name}". Saving will move it to this rule.`,
        );
      }
    }
    return warnings;
  }, [draft.scope, draft.tables, rules, tables, drawer, tableLabelById]);

  const draftError = useMemo(() => {
    try {
      validateRuleInput({
        name: draft.name,
        scope: draft.scope,
        mode: draft.mode,
        status: draft.active ? "active" : "paused",
        tables: draft.tables,
        members: draft.members.map((m) => ({ user_id: m.user_id, weight: m.weight })),
      });
      return null;
    } catch (err) {
      return errorMessage(err, "Invalid rule.");
    }
  }, [draft]);

  const swrrTotal = useMemo(
    () =>
      draft.members.reduce(
        (sum, m) =>
          sum + (typeof m.weight === "number" && Number.isFinite(m.weight) ? m.weight : 0),
        0,
      ),
    [draft.members],
  );

  // Step-3 gate (SWRR only): live validation as percentages change.
  // Round Robin needs no allocation and is never blocked here.
  const step3Error = useMemo(
    () =>
      draft.mode === "swrr"
        ? validateMembersStep({ mode: draft.mode, members: draft.members })
        : null,
    [draft.mode, draft.members],
  );
  // Surfaced when a blocked Continue is attempted; cleared on any
  // draft/step change so stale text can never linger.
  const [continueError, setContinueError] = useState<string | null>(null);
  useEffect(() => {
    setContinueError(null);
  }, [draft, step]);

  function handleContinue() {
    if (step === 3 && draft.mode === "swrr") {
      const err = validateMembersStep({ mode: draft.mode, members: draft.members });
      if (err !== null) {
        setContinueError(err);
        return;
      }
    }
    setContinueError(null);
    setStep(step + 1);
  }

  function toggleTable(formId: string) {
    setDraft((prev) => ({
      ...prev,
      tables: prev.tables.includes(formId)
        ? prev.tables.filter((t) => t !== formId)
        : [...prev.tables, formId],
    }));
  }

  function toggleMember(userId: string) {
    if (draft.members.some((m) => m.user_id === userId)) {
      setWeightText((text) => {
        const next = { ...text };
        delete next[userId];
        return next;
      });
      setDraft((prev) => ({
        ...prev,
        members: prev.members.filter((m) => m.user_id !== userId),
      }));
      return;
    }
    setDraft((prev) => ({
      ...prev,
      members: [...prev.members, { user_id: userId, weight: 0 }],
    }));
  }

  function moveMember(userId: string, direction: -1 | 1) {
    setDraft((prev) => {
      const index = prev.members.findIndex((m) => m.user_id === userId);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= prev.members.length) return prev;
      const members = [...prev.members];
      const [moved] = members.splice(index, 1);
      members.splice(next, 0, moved);
      return { ...prev, members };
    });
  }

  // String-based editing state for the percentage inputs: the
  // raw text is kept verbatim per keystroke (so Backspace, Delete,
  // select-all, and paste behave natively), while the parsed
  // number|null drives the live total, validation, and saving.
  // Empty or non-numeric text parses to null — an unfinished edit
  // that can never validate — instead of being coerced to 0.
  const [weightText, setWeightText] = useState<Record<string, string>>({});

  function setWeight(userId: string, weight: number | null) {
    setDraft((prev) => ({
      ...prev,
      members: prev.members.map((m) =>
        m.user_id === userId ? { ...m, weight } : m,
      ),
    }));
  }

  function handleWeightChange(userId: string, raw: string) {
    const normalized = normalizeWeightText(weightText[userId] ?? "", raw);
    setWeightText((prev) => ({ ...prev, [userId]: normalized }));
    setWeight(userId, parseWeightInput(normalized));
  }

  function handleWeightBlur(userId: string) {
    // Canonicalize finished edits ("050" → "50"); leave empty or
    // invalid text alone so the error — not a silent 0 — shows.
    const parsed = parseWeightInput(weightText[userId] ?? "");
    if (parsed !== null) {
      const canonical = String(parsed);
      setWeightText((prev) => ({ ...prev, [userId]: canonical }));
      setWeight(userId, parsed);
    }
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body = {
        name: draft.name.trim(),
        scope: draft.scope,
        mode: draft.mode,
        status: draft.active ? "active" : "paused",
        tables: draft.tables,
        members: draft.members.map((m) => ({ user_id: m.user_id, weight: m.weight })),
      };
      const editingId = drawer?.editingId ?? null;
      const res = await fetch(
        editingId ? `/api/lead-assignment/rules/${editingId}` : "/api/lead-assignment/rules",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = (await res.json().catch(() => null)) as {
        error?: string;
        conflicts?: Array<{ rule_name: string }>;
      } | null;
      if (!res.ok) {
        const detail =
          Array.isArray(json?.conflicts) && json.conflicts.length > 0
            ? ` Conflicting: ${json.conflicts.map((c) => `"${c.rule_name}"`).join(", ")}.`
            : "";
        throw new Error(`${json?.error ?? "Could not save the rule."}${detail}`);
      }
      toast.success(editingId ? "Rule updated." : "Rule created.");
      setDrawer(null);
      await loadAll();
    } catch (err) {
      setSaveError(errorMessage(err, "Could not save the rule."));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(rule: RuleView) {
    if (busyId) return;
    setBusyId(rule.id);
    try {
      const res = await fetch(`/api/lead-assignment/rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: rule.name,
          scope: rule.scope,
          mode: rule.mode,
          status: rule.status === "active" ? "paused" : "active",
          tables: rule.tables,
          members: rule.members.map((m) => ({ user_id: m.user_id, weight: m.weight })),
        }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not update the rule.");
      toast.success(rule.status === "active" ? "Rule paused." : "Rule activated.");
      await loadAll();
    } catch (err) {
      toast.error(errorMessage(err, "Could not update the rule."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete() {
    if (!deleting || busyId) return;
    setBusyId(deleting.id);
    try {
      const res = await fetch(`/api/lead-assignment/rules/${deleting.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error ?? "Could not delete the rule.");
      }
      toast.success("Rule deleted.");
      setDeleting(null);
      await loadAll();
    } catch (err) {
      toast.error(errorMessage(err, "Could not delete the rule."));
    } finally {
      setBusyId(null);
    }
  }

  const visibleTables = useMemo(() => {
    const q = draft.tableSearch.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) => t.label.toLowerCase().includes(q));
  }, [tables, draft.tableSearch]);

  const visibleMembers = useMemo(() => {
    const q = draft.memberSearch.trim().toLowerCase();
    const list = eligibleRoster.filter(
      (m) =>
        !q ||
        (m.full_name ?? "").toLowerCase().includes(q) ||
        m.user_id.toLowerCase().includes(q),
    );
    return list;
  }, [eligibleRoster, draft.memberSearch]);

  return (
    <RequireRole min="admin" fallback={<p className="text-sm text-muted-foreground">Lead Assignment is managed by workspace admins.</p>}>
      <SettingsPanelHead
        title="Lead Assignment"
        description="Automatically assign incoming Meta leads to your team. Each rule targets specific tables or all tables, with its own members, order or percentages, and independent per-table distribution state."
        action={
          <Button type="button" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            New Rule
          </Button>
        }
      />

      <div className="mb-4 flex items-center gap-2">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search rules or members…"
            className="pl-9"
            aria-label="Search rules"
          />
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading assignment rules…</p>
      ) : loadError ? (
        <p className="text-sm text-destructive" role="alert">{loadError}</p>
      ) : filteredRules.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="font-medium text-foreground">No assignment rules yet</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Create a rule to automatically assign new Meta leads to your
              team — by table, with Round Robin or percentage-based
              distribution.
            </p>
            <Button type="button" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Create Assignment Rule
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rule Name</TableHead>
                  <TableHead>Applies To</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Team Members</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell className="font-medium">{rule.name}</TableCell>
                    <TableCell>
                      {rule.scope === "all"
                        ? "All Tables"
                        : rule.tables
                            .map((t) => tableLabelById.get(t) ?? t)
                            .join(", ") || "—"}
                    </TableCell>
                    <TableCell>
                      {rule.mode === "round_robin" ? "Round Robin" : "Percentage-Based"}
                    </TableCell>
                    <TableCell className="max-w-64 truncate">
                      {rule.members
                        .map(
                          (m) =>
                            `${nameByUserId.get(m.user_id) ?? m.user_id}${
                              rule.mode === "swrr" ? ` (${m.weight}%)` : ""
                            }`,
                        )
                        .join(", ")}
                    </TableCell>
                    <TableCell>
                      <Badge variant={rule.status === "active" ? "default" : "secondary"}>
                        {rule.status === "active" ? "Active" : "Paused"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit ${rule.name}`}
                          onClick={() => openEdit(rule)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busyId === rule.id}
                          aria-label={rule.status === "active" ? `Pause ${rule.name}` : `Resume ${rule.name}`}
                          onClick={() => void handleToggle(rule)}
                        >
                          {rule.status === "active" ? (
                            <Pause className="h-4 w-4" />
                          ) : (
                            <Play className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete ${rule.name}`}
                          onClick={() => setDeleting(rule)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <h3 className="mt-8 mb-2 text-sm font-semibold text-foreground">Table coverage</h3>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Meta Table</TableHead>
                <TableHead>Governing Rule</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tables.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={2} className="text-muted-foreground">
                    No Meta tables yet — enable a form to see it here.
                  </TableCell>
                </TableRow>
              ) : (
                tables.map((table) => (
                  <TableRow key={table.form_id}>
                    <TableCell className="font-medium">{table.label}</TableCell>
                    <TableCell>
                      {table.governing_rule ? (
                        <span>
                          {table.governing_rule.name}{" "}
                          <span className="text-muted-foreground">
                            ({table.governing_rule.mode === "round_robin" ? "Round Robin" : "Percentage-Based"})
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          No rule — new leads stay unassigned
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create / edit drawer */}
      <Dialog open={drawer !== null} onOpenChange={(v) => { if (!v) setDrawer(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{drawer?.editingId ? "Edit Assignment Rule" : "New Assignment Rule"}</DialogTitle>
            <DialogDescription>
              Step {step} of 4 — {["Tables", "Mode", "Members", "Review"][step - 1]}
            </DialogDescription>
          </DialogHeader>

          {step === 1 && (
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="la-name">Rule name</Label>
                <Input
                  id="la-name"
                  value={draft.name}
                  onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Video Editor Leads"
                />
              </div>
              <div className="grid gap-2">
                <Label>Table selection</Label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="la-scope"
                      checked={draft.scope === "specific"}
                      onChange={() => setDraft((p) => ({ ...p, scope: "specific" }))}
                    />
                    Specific Tables
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="la-scope"
                      checked={draft.scope === "all"}
                      onChange={() => setDraft((p) => ({ ...p, scope: "all", tables: [] }))}
                    />
                    All Tables
                  </label>
                </div>
                {draft.scope === "specific" && (
                  <>
                    <div className="relative">
                      <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={draft.tableSearch}
                        onChange={(e) => setDraft((p) => ({ ...p, tableSearch: e.target.value }))}
                        placeholder="Search tables…"
                        className="pl-9"
                        aria-label="Search tables"
                      />
                    </div>
                    <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                      {visibleTables.length === 0 && (
                        <p className="px-2 py-1 text-sm text-muted-foreground">No Meta tables found.</p>
                      )}
                      {visibleTables.map((t) => (
                        <label key={t.form_id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
                          <Checkbox
                            checked={draft.tables.includes(t.form_id)}
                            onCheckedChange={() => toggleTable(t.form_id)}
                          />
                          <span className="flex-1">{t.label}</span>
                          {t.governing_rule && t.governing_rule.id !== drawer?.editingId && (
                            <span className="text-xs text-muted-foreground">
                              → {t.governing_rule.name}
                            </span>
                          )}
                        </label>
                      ))}
                    </div>
                    {draft.tables.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {draft.tables.map((formId) => (
                          <Badge key={formId} variant="secondary" className="gap-1">
                            {tableLabelById.get(formId) ?? formId}
                            <button type="button" aria-label={`Remove ${formId}`} onClick={() => toggleTable(formId)}>
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {draft.scope === "all" && (
                  <p className="text-sm text-muted-foreground">
                    Covers all current and future Meta tables not handled by a specific rule.
                  </p>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  {
                    mode: "round_robin" as const,
                    title: "Equal Round Robin",
                    body: "Distribute new leads sequentially among selected team members in a repeating order.",
                  },
                  {
                    mode: "swrr" as const,
                    title: "Percentage-Based Distribution",
                    body: "Assign new leads according to each team member's configured percentage using Smooth Weighted Round Robin.",
                  },
                ]
              ).map((card) => (
                <button
                  key={card.mode}
                  type="button"
                  onClick={() => setDraft((p) => ({ ...p, mode: card.mode }))}
                  aria-pressed={draft.mode === card.mode}
                  className={cn(
                    "rounded-xl border p-4 text-left",
                    draft.mode === card.mode
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-muted-foreground",
                  )}
                >
                  <span className="flex items-center gap-2 font-medium">
                    {draft.mode === card.mode && <Check className="h-4 w-4" />}
                    {card.title}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">{card.body}</span>
                </button>
              ))}
            </div>
          )}

          {step === 3 && (
            <div className="grid gap-4">
              <div className="relative">
                <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={draft.memberSearch}
                  onChange={(e) => setDraft((p) => ({ ...p, memberSearch: e.target.value }))}
                  placeholder="Search team members…"
                  className="pl-9"
                  aria-label="Search team members"
                />
              </div>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                {visibleMembers.map((m) => (
                  <label key={m.user_id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
                    <Checkbox
                      checked={draft.members.some((s) => s.user_id === m.user_id)}
                      onCheckedChange={() => toggleMember(m.user_id)}
                    />
                    <span className="flex-1">{m.full_name?.trim() || m.user_id}</span>
                    {m.role === "owner" ? (
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">Owner</span>
                    ) : (
                      <span className="text-xs text-muted-foreground capitalize">{m.role}</span>
                    )}
                  </label>
                ))}
                {visibleMembers.length === 0 && (
                  <p className="px-2 py-1 text-sm text-muted-foreground">No eligible members found.</p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Only owners, admins and agents can receive leads. Removing someone here never deletes their account.
              </p>

              {draft.mode === "round_robin" ? (
                <div className="grid gap-2">
                  <Label>Assignment sequence</Label>
                  {draft.members.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Select members above to build the rotation.</p>
                  ) : (
                    <ol className="space-y-1">
                      {draft.members.map((m, index) => (
                        <li key={m.user_id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm">
                          <span className="w-6 font-medium tabular-nums">{index + 1}.</span>
                          <span className="flex-1">{nameByUserId.get(m.user_id) ?? m.user_id}{roleByUserId.get(m.user_id) === "owner" ? " (Owner)" : ""}</span>
                          <Button type="button" variant="ghost" size="sm" disabled={index === 0} aria-label={`Move ${m.user_id} up`} onClick={() => moveMember(m.user_id, -1)}>
                            <ArrowUp className="h-4 w-4" />
                          </Button>
                          <Button type="button" variant="ghost" size="sm" disabled={index === draft.members.length - 1} aria-label={`Move ${m.user_id} down`} onClick={() => moveMember(m.user_id, 1)}>
                            <ArrowDown className="h-4 w-4" />
                          </Button>
                          <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${m.user_id}`} onClick={() => toggleMember(m.user_id)}>
                            <X className="h-4 w-4" />
                          </Button>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              ) : (
                <div className="grid gap-2">
                  <div className="flex items-baseline justify-between">
                    <Label>Percentages (must total exactly 100%)</Label>
                    <span className={cn("text-sm font-medium tabular-nums", swrrTotal === 100 ? "text-green-600" : "text-destructive")}>
                      Total: {swrrTotal}%
                    </span>
                  </div>
                  {(continueError ?? step3Error) !== null ? (
                    <p className="text-xs text-destructive" role="alert">
                      {continueError ?? step3Error}
                    </p>
                  ) : (
                    <p className="text-xs text-green-600" role="status">
                      Total is 100% — ready to continue.
                    </p>
                  )}
                  {draft.members.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Select members above, then set each share.</p>
                  ) : (
                    draft.members.map((m) => (
                      <div key={m.user_id} className="flex items-center gap-2">
                        <span className="flex-1 text-sm">{nameByUserId.get(m.user_id) ?? m.user_id}{roleByUserId.get(m.user_id) === "owner" ? " (Owner)" : ""}</span>
                        <Input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={weightText[m.user_id] ?? String(m.weight ?? "")}
                          // String-based editing: the raw text is kept
                          // verbatim per keystroke (Backspace, Delete,
                          // select-all, and paste all behave natively)
                          // and parsed separately for the live total,
                          // validation, and saving.
                          onChange={(e) => handleWeightChange(m.user_id, e.target.value)}
                          onBlur={() => handleWeightBlur(m.user_id)}
                          className="w-24"
                          aria-label={`Percentage for ${nameByUserId.get(m.user_id) ?? m.user_id}`}
                        />
                        <span className="text-sm text-muted-foreground">%</span>
                        <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${m.user_id}`} onClick={() => toggleMember(m.user_id)}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="grid gap-4">
              <dl className="space-y-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Rule</dt>
                  <dd className="font-medium">{draft.name.trim() || "—"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Tables</dt>
                  <dd className="text-right font-medium">
                    {draft.scope === "all"
                      ? "All Tables"
                      : draft.tables.map((t) => tableLabelById.get(t) ?? t).join(", ") || "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Mode</dt>
                  <dd className="font-medium">
                    {draft.mode === "round_robin" ? "Round Robin" : "Percentage-Based"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Members</dt>
                  <dd className="max-w-72 text-right font-medium">
                    {draft.members.length === 0
                      ? "—"
                      : draft.members
                          .map(
                            (m) =>
                              `${nameByUserId.get(m.user_id) ?? m.user_id}${
                                draft.mode === "swrr" ? ` (${m.weight ?? "—"}%)` : ""
                              }`,
                          )
                          .join(draft.mode === "round_robin" ? " → " : ", ")}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Active</dt>
                  <dd>
                    <Switch
                      checked={draft.active}
                      onCheckedChange={(v) => setDraft((p) => ({ ...p, active: v }))}
                      aria-label="Rule active"
                    />
                  </dd>
                </div>
              </dl>
              {conflictPreview.length > 0 && (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300" role="alert">
                  {conflictPreview.join(" ")}
                </p>
              )}
              {activity.length > 0 && (
                <div className="grid gap-1">
                  <p className="text-sm font-medium">Recent activity</p>
                  <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                    {activity.map((e) => (
                      <li key={e.id}>
                        {new Date(e.created_at).toLocaleString()} — {e.kind}
                        {e.assigned_user_id
                          ? ` → ${nameByUserId.get(e.assigned_user_id) ?? e.assigned_user_id}`
                          : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {saveError && (
                <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300" role="alert">
                  {saveError}
                </p>
              )}
            </div>
          )}

          {saveError && step !== 4 && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300" role="alert">
              {saveError}
            </p>
          )}

          <DialogFooter className="gap-2">
            {step > 1 && (
              <Button type="button" variant="outline" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            <div className="flex-1" />
            <Button type="button" variant="outline" onClick={() => setDrawer(null)}>
              Cancel
            </Button>
            {step < 4 ? (
              <Button
                type="button"
                onClick={handleContinue}
                disabled={step === 3 && draft.mode === "swrr" && step3Error !== null}
              >
                Continue
              </Button>
            ) : (
              <Button type="button" onClick={() => void handleSave()} disabled={saving || draftError !== null}>
                {saving ? "Saving…" : drawer?.editingId ? "Save Changes" : "Create Rule"}
              </Button>
            )}
          </DialogFooter>
          {draftError && step === 4 && (
            <p className="text-xs text-destructive" role="alert">{draftError}</p>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleting !== null} onOpenChange={(v) => { if (!v) setDeleting(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this rule?</DialogTitle>
            <DialogDescription>
              “{deleting?.name}” and its member list, table targets, and
              distribution state will be removed. Already-assigned leads
              keep their owners; assignment history is preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busyId !== null}
              onClick={() => void handleDelete()}
            >
              Delete Rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </RequireRole>
  );
}
