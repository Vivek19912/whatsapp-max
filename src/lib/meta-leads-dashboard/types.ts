// Shared result shapes for the standalone Meta Lead Ads dashboard.
// Acquisition-only: every count is distinct Meta submissions from
// meta_lead_submissions — never messages, contacts, or flow runs.

export interface MetaLeadFormSplit {
  /** Display name of the Instant Form (form_name, else form_id). */
  formName: string;
  /** Distinct Meta leads for this form in the bucket. */
  leads: number;
}

export interface MetaLeadDay {
  /** Calendar day in the caller's timezone (YYYY-MM-DD). */
  date: string;
  /** Distinct Meta leads that day, across all forms. */
  total: number;
  /** Per-form split; sums to total. */
  forms: MetaLeadFormSplit[];
}

export interface MetaLeadMonth {
  /** 1 = Jan … 12 = Dec. Always 12 entries, zero months included. */
  month: number;
  /** Distinct Meta leads that month, across all forms. */
  total: number;
  /** Per-form split; sums to total. */
  forms: MetaLeadFormSplit[];
}

export interface MetaLeadsAnalytics {
  todayLeads: number;
  yesterdayLeads: number;
  /** Rolling most-recent 7 calendar days (today + previous 6), server-derived. */
  last7Leads: number;
  /** Rolling most-recent 30 calendar days (today + previous 29), server-derived. */
  last30Leads: number;
  /** Trailing 30 days, oldest first, zero days included. */
  daily: MetaLeadDay[];
  /** Selected calendar year. */
  year: number;
  /** Always 12 entries. */
  monthly: MetaLeadMonth[];
}
