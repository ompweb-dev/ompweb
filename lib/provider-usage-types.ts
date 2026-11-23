export type ProviderUsageWindowId = "5h" | "7d" | "monthly";

export interface ProviderUsageWindow {
  percent: number;
  resetMinutes?: number;
  resetHours?: number;
}

export interface ProviderUsageReport {
  provider: string;
  accountLabel?: string;
  accountIndex?: number;
  plan?: string;
  modelId?: string;
  tier?: string;
  /**
   * Human bucket name for providers whose quotas split by backend counter
   * rather than by model/tier — currently Antigravity ("Gemini",
   * "Claude & GPT (shared)", "Anthropic", "OpenAI"). Anthropic's Fable
   * bucket is carried by `tier` instead and needs no bucket.
   */
  bucket?: string;
  noLimits?: boolean;
  fiveHour?: ProviderUsageWindow;
  sevenDay?: ProviderUsageWindow;
  monthly?: ProviderUsageWindow;
}

export interface ProviderUsageSnapshot {
  generatedAt: number | null;
  reports: ProviderUsageReport[];
}

export interface ProviderUsageBucket {
  /** Tier, quota bucket or model ("Fable", "Gemini"); absent for the account-wide counter. */
  label?: string;
  fiveHour?: ProviderUsageWindow;
  sevenDay?: ProviderUsageWindow;
  monthly?: ProviderUsageWindow;
}

/** One stored account with every usage split merged in; windows hold the highest bucket. */
export interface ProviderUsageAccount {
  /** Stable id of the account in the overview: its credential, else its label or omp's position. */
  key: string;
  /** The user's name for the account, shown instead of its email or "Account N". */
  name?: string;
  provider: string;
  accountLabel?: string;
  accountIndex?: number;
  plan?: string;
  /** omp's credential row; absent when no stored account could be matched, so nothing can be changed. */
  credentialId?: number;
  paused?: boolean;
  /** Usage above which omp routes to the provider's other accounts first (100 - the account's reservePct). */
  limitPercent?: number;
  /** omp's `priority` for the account: higher is picked first while it is below its limit. */
  priority?: number;
  /** Whether an account policy can name this account (limit and priority need one). */
  canPrioritize?: boolean;
  /** Whether a policy can name this account and omp can measure its usage. */
  canLimit?: boolean;
  fiveHour?: ProviderUsageWindow;
  sevenDay?: ProviderUsageWindow;
  monthly?: ProviderUsageWindow;
  /** Present when the account reports more than one bucket. */
  buckets?: ProviderUsageBucket[];
}

export interface ProviderUsageAccountsSnapshot {
  generatedAt: number | null;
  usageUnavailable?: boolean;
  accounts: ProviderUsageAccount[];
  /** Limit omp applies to accounts without their own (100 - `retry.usageReservePct`). */
  defaultLimitPercent: number;
}

export interface ProviderUsageContext {
  provider: string;
  modelId: string;
}
