// ============================================================
// Lead Assignment rule input validation (pure, shared by the API
// routes so create/update reject identically).
//
// Percentages are whole numbers 0-100 and MUST sum to exactly 100
// for SWRR rules — never auto-adjusted. Member order is the array
// order (positions are renumbered server-side, never trusted from
// the client).
// ============================================================

export interface RuleMemberInput {
  user_id: unknown;
  weight?: unknown;
}

export interface RuleInput {
  name: unknown;
  scope: unknown;
  mode: unknown;
  status?: unknown;
  tables: unknown;
  members: unknown;
}

export interface ValidRuleInput {
  name: string;
  scope: "specific" | "all";
  mode: "round_robin" | "swrr";
  status: "active" | "paused";
  tables: string[];
  members: Array<{ user_id: string; weight: number }>;
}

export function validateRuleInput(input: RuleInput): ValidRuleInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid rule.");
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 120) {
    throw new Error("Give the rule a name (1–120 characters).");
  }
  if (input.scope !== "specific" && input.scope !== "all") {
    throw new Error("Choose Specific Tables or All Tables.");
  }
  if (input.mode !== "round_robin" && input.mode !== "swrr") {
    throw new Error("Choose Round Robin or Percentage-Based.");
  }
  const status = input.status ?? "active";
  if (status !== "active" && status !== "paused") {
    throw new Error("Invalid rule status.");
  }

  const tables = Array.isArray(input.tables)
    ? [...new Set(input.tables.filter((t): t is string => typeof t === "string" && t !== ""))]
    : [];
  if (input.scope === "specific" && tables.length === 0) {
    throw new Error("Select at least one table for a specific-table rule.");
  }
  if (input.scope === "all" && tables.length > 0) {
    throw new Error("An All Tables rule must not list specific tables.");
  }

  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new Error("Select at least one team member.");
  }
  const seen = new Set<string>();
  const members: Array<{ user_id: string; weight: number }> = [];
  for (const entry of input.members) {
    const row = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    if (typeof row.user_id !== "string" || row.user_id === "") {
      throw new Error("Each member needs a valid team member.");
    }
    if (seen.has(row.user_id)) {
      throw new Error("A team member can appear only once per rule.");
    }
    seen.add(row.user_id);
    members.push({ user_id: row.user_id, weight: 0 });
  }

  if (input.mode === "swrr") {
    if (!Array.isArray(input.members)) throw new Error("Invalid members.");
    const provided = input.members as RuleMemberInput[];
    let total = 0;
    provided.forEach((entry, index) => {
      const raw =
        entry && typeof entry === "object"
          ? (entry as unknown as Record<string, unknown>).weight
          : undefined;
      const weight = typeof raw === "number" ? raw : Number.NaN;
      if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
        throw new Error("Percentages must be whole numbers from 0 to 100.");
      }
      total += weight;
      members[index].weight = weight;
    });
    if (total !== 100) {
      throw new Error(`Percentages must total exactly 100% (currently ${total}%).`);
    }
  }

  return { name, scope: input.scope, mode: input.mode, status, tables, members };
}
