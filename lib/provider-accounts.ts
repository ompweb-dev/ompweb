import { isRecord } from "./type-guards";
import type { ProviderUsageReport } from "./provider-usage-types";

export interface ProviderAccountSummary {
  /** Stable key: the account label, else its 1-based position in omp's list. */
  key: string;
  label?: string;
  index?: number;
  plan?: string;
}

/**
 * The distinct accounts omp reports usage for under one provider. omp's login
 * RPC only says whether a provider is authenticated, so `omp usage` (one report
 * per credential, split here by model/tier) is the supported place accounts
 * show up. Accounts without usage windows still appear (`noLimits`).
 */
export function summarizeProviderAccounts(reports: readonly ProviderUsageReport[], provider: string): ProviderAccountSummary[] {
  const accounts = new Map<string, ProviderAccountSummary>();
  for (const report of reports) {
    if (report.provider !== provider) continue;
    const key = report.accountLabel ?? `#${report.accountIndex ?? accounts.size + 1}`;
    const existing = accounts.get(key);
    if (existing) {
      if (!existing.plan && report.plan) existing.plan = report.plan;
      continue;
    }
    accounts.set(key, {
      key,
      ...(report.accountLabel ? { label: report.accountLabel } : {}),
      ...(report.accountIndex !== undefined ? { index: report.accountIndex } : {}),
      ...(report.plan ? { plan: report.plan } : {}),
    });
  }
  return [...accounts.values()];
}

/**
 * The usage plan for one of omp's stored-account labels. omp suffixes the org
 * (`email (org)`) while usage reports the bare email, so a plan is returned
 * only when its email identifies exactly one stored account.
 */
export function planForStoredAccount(label: string, storedLabels: readonly string[], usage: readonly ProviderAccountSummary[]): string | undefined {
  const sameEmail = (stored: string, email: string | undefined) => !!email && (stored === email || stored.startsWith(`${email} (`));
  const match = usage.find((u) => sameEmail(label, u.label));
  return match && storedLabels.filter((stored) => sameEmail(stored, match.label)).length === 1 ? match.plan : undefined;
}

export interface AccountIdentity {
  email?: string;
  accountId?: string;
  projectId?: string;
  orgId?: string;
}

/** A stored OAuth account as the runner's `get_usage_accounts` lists it. */
export interface StoredUsageAccount extends AccountIdentity {
  credentialId: number;
  provider: string;
  paused: boolean;
}

const IDENTITY_FIELDS = ["email", "accountId", "projectId", "orgId"] as const;

function sameId(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether a usage report's identity names a stored account, as `omp usage` attributes them: differing orgs
 * never match, an email on both sides decides, else a shared account or project id does.
 */
export function reportMatchesAccount(report: AccountIdentity, account: AccountIdentity): boolean {
  if (report.orgId && account.orgId && !sameId(report.orgId, account.orgId)) return false;
  if (report.email && account.email) return sameId(report.email, account.email);
  return sameId(report.accountId, account.accountId) || sameId(report.projectId, account.projectId);
}

/** omp's conjunctive `auth.accountPolicies[].account` match: every field the selector sets must be equal. */
export function selectorMatches(selector: unknown, account: AccountIdentity): boolean {
  if (!isRecord(selector)) return false;
  return IDENTITY_FIELDS.every((field) => selector[field] === undefined || selector[field] === account[field]);
}

function findPolicy(policies: readonly unknown[], provider: string, account: AccountIdentity): number {
  return policies.findIndex((policy) => isRecord(policy) && policy.provider === provider && selectorMatches(policy.account, account));
}

type PolicyField = "reservePct" | "priority";

/** A numeric field of the account's own policy (`reservePct` = 100 - its limit), if it sets one. */
export function accountPolicyValue(policies: readonly unknown[], provider: string, account: AccountIdentity, field: PolicyField): number | undefined {
  const policy = policies[findPolicy(policies, provider, account)];
  return isRecord(policy) && typeof policy[field] === "number" ? policy[field] : undefined;
}

/** Whether an account policy can name the account at all (omp requires an email, account or project id). */
export function canNameAccount(account: AccountIdentity): boolean {
  return !!(account.email || account.accountId || account.projectId);
}

/**
 * The selector for a new policy: the email (or account, or project id) plus the org, widened to every
 * identity field when that still matches a sibling. omp rejects a selector matching two accounts.
 */
function policySelector(account: AccountIdentity, siblings: readonly AccountIdentity[]): AccountIdentity {
  const pick = (fields: readonly (keyof AccountIdentity)[]) =>
    Object.fromEntries(fields.flatMap((field) => (account[field] ? [[field, account[field]]] : []))) as AccountIdentity;
  const base = account.email ? "email" : account.accountId ? "accountId" : "projectId";
  for (const selector of [pick([base, "orgId"]), pick(IDENTITY_FIELDS)]) {
    if (siblings.filter((sibling) => selectorMatches(selector, sibling)).length === 1) return selector;
  }
  throw new Error("Another stored account has the same identity; omp cannot tell them apart");
}

/**
 * `auth.accountPolicies` with one field of the account's policy set, or cleared (null). Other policies
 * and fields stay as they are; a policy left with nothing but its selector is dropped.
 * `siblings` are the provider's stored accounts, the account included.
 */
export function withAccountPolicy(
  policies: readonly unknown[],
  provider: string,
  account: AccountIdentity,
  siblings: readonly AccountIdentity[],
  field: PolicyField,
  value: number | null,
  defaultReservePct = 10,
): unknown[] {
  const next = [...policies];
  const index = findPolicy(next, provider, account);
  const existing = index === -1 ? undefined : next[index] as Record<string, unknown>;
  if (field === "reservePct" && typeof existing?.reclaimAbovePct === "number") {
    const effectiveReserve = value ?? defaultReservePct;
    if (existing.reclaimAbovePct <= effectiveReserve) {
      throw new Error(`The account's reclaimAbovePct (${existing.reclaimAbovePct}%) must stay above its reserve (${effectiveReserve}%); use a higher limit`);
    }
  }
  if (value === null) {
    if (!existing) return next;
    const rest = { ...existing };
    delete rest[field];
    if (Object.keys(rest).every((key) => key === "provider" || key === "account")) next.splice(index, 1);
    else next[index] = rest;
    return next;
  }
  if (existing) next[index] = { ...existing, [field]: value };
  else next.push({ provider, account: policySelector(account, siblings), [field]: value });
  return next;
}
