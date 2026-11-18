import { execFile } from "child_process";
import { promisify } from "util";
import { OMP_NOT_FOUND, resolveOmpBin } from "./omp/omp-cli";
import { RpcCommandError } from "./omp/rpc-process";
import { runUtilityCommand } from "./omp/rpc-utility";
import { readAccountPolicyConfig, writeAccountPolicies } from "./omp/settings-config";
import { createChildProcessEnvironment } from "./project-command-env";
import {
  accountPolicyValue,
  canNameAccount,
  reportMatchesAccount,
  withAccountPolicy,
  type AccountIdentity,
  type StoredUsageAccount,
} from "./provider-accounts";
import { asNumber, isRecord } from "./type-guards";
import { loadWebServerSettings, readWebServerSettingsFromDisk, saveWebServerSettings } from "./web-settings";
import type {
  ProviderUsageAccount,
  ProviderUsageAccountsSnapshot,
  ProviderUsageBucket,
  ProviderUsageReport,
  ProviderUsageSnapshot,
  ProviderUsageWindowId,
} from "./provider-usage-types";

const execFileAsync = promisify(execFile);
const USAGE_TIMEOUT_MS = 30_000;
const USAGE_MAX_BUFFER = 4 * 1024 * 1024;
const USAGE_CACHE_TTL_MS = 5 * 60_000;

type UsageQuery = { provider?: string; modelId?: string };

type UsagePayload = Record<string, unknown>;
type CachedUsage = { expiresAt: number; payload: UsagePayload };

let usageCache: CachedUsage | undefined;
let usageInFlight: Promise<UsagePayload> | undefined;
let usageInFlightForced = false;
let usageGeneration = 0;
let usageAccountState: string | undefined;

export function invalidateUsageCache(): void {
  usageGeneration += 1;
  usageCache = undefined;
  usageInFlight = undefined;
}
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function normalizeWindowId(scope: Record<string, unknown>, window: Record<string, unknown>): ProviderUsageWindowId | undefined {
  const windowId = nonEmptyString(scope.windowId);
  if (windowId === "5h" || windowId === "7d" || windowId === "monthly" || windowId === "30d" || windowId === "daily") {
    if (windowId === "30d") return "monthly";
    if (windowId === "daily") return "5h";
    return windowId;
  }
  const durationMs = asNumber(window.durationMs);
  if (durationMs === undefined) return undefined;
  if (Math.abs(durationMs - 5 * 60 * 60 * 1000) <= 60_000) return "5h";
  if (Math.abs(durationMs - 7 * 24 * 60 * 60 * 1000) <= 60_000) return "7d";
  if (Math.abs(durationMs - 30 * 24 * 60 * 60 * 1000) <= 60 * 60 * 1000) return "monthly";
  if (Math.abs(durationMs - 24 * 60 * 60 * 1000) <= 60_000) return "5h";
  return undefined;
}

function usageWindow(
  windowId: ProviderUsageWindowId,
  fraction: number,
  window: Record<string, unknown>,
  now: number,
): ProviderUsageReport["fiveHour"] {
  const resetAt = asNumber(window.resetsAt);
  if (windowId === "5h") {
    return {
      percent: fraction * 100,
      ...(resetAt !== undefined ? { resetMinutes: Math.max(0, Math.round((resetAt - now) / 60_000)) } : {}),
    };
  }
  return {
    percent: fraction * 100,
    ...(resetAt !== undefined ? { resetHours: Math.max(0, Math.round((resetAt - now) / 3_600_000)) } : {}),
  };
}

type UsageLimit = { id: ProviderUsageWindowId; fraction: number; window: Record<string, unknown> };

type UsageGroup = {
  priority: number;
  modelId?: string;
  tier?: string;
  bucket?: string;
  limits: Map<ProviderUsageWindowId, UsageLimit>;
};

/**
 * Bucket name for an Antigravity limit, if omp distinguishes one.
 *
 * Antigravity quotas split by backend counter, not by model/tier, and omp
 * reports that split only in the limit's label/id — never in scope. The
 * quota-summary path labels a bucket "Gemini" or "Claude & GPT (shared)"
 * (the latter is one shared third-party quota, duplicated by omp into
 * anthropic/openai counter ids, so it must stay one bucket, not two);
 * the model-based path labels it "Usage (Google)" / "Usage (Anthropic)" /
 * "Usage (OpenAI)". A bare id counter is used only as a fallback, and
 * never for a shared limit, so the shared bucket is never invented twice.
 * Other providers return undefined: Anthropic's Fable bucket already
 * arrives as scope.tier, and no other provider's labels are bucket names.
 */
function antigravityBucket(rawLimit: Record<string, unknown>, scope: Record<string, unknown>): string | undefined {
  const label = nonEmptyString(rawLimit.label);
  if (label === "Gemini" || label === "Claude & GPT (shared)") return label;
  const usageMatch = label ? /^Usage \((.+)\)$/.exec(label) : null;
  // The model-based path names the Google counter "Google"; the quota
  // summary path names the same counter "Gemini". Unify on "Gemini" so
  // the two fetch paths never split one counter into two rows.
  if (usageMatch) return usageMatch[1] === "Google" ? "Gemini" : usageMatch[1];
  if (scope.shared === true) return undefined;
  const id = nonEmptyString(rawLimit.id);
  const counter = id ? id.split(":")[1] : undefined;
  if (counter === "google") return "Gemini";
  if (counter === "anthropic") return "Anthropic";
  if (counter === "openai") return "OpenAI";
  return undefined;
}

function normalizeReport(
  rawReport: Record<string, unknown>,
  query: UsageQuery,
  now: number,
  reportIndex: number,
): ProviderUsageReport[] {
  const provider = nonEmptyString(rawReport.provider);
  if (!provider || (query.provider && provider !== query.provider)) return [];
  const limits = Array.isArray(rawReport.limits) ? rawReport.limits : [];
  const activeModelId = query.modelId?.toLowerCase();
  const groups = new Map<string, UsageGroup>();

  for (const rawLimit of limits) {
    if (!isRecord(rawLimit) || !isRecord(rawLimit.scope) || !isRecord(rawLimit.amount)) continue;
    const scope = rawLimit.scope;
    const amount = rawLimit.amount;
    const fraction = asNumber(amount.usedFraction);
    if (fraction === undefined) continue;
    const window = isRecord(rawLimit.window) ? rawLimit.window : {};
    const windowId = normalizeWindowId(scope, window);
    if (!windowId) continue;
    const modelId = nonEmptyString(scope.modelId);
    if (activeModelId && modelId && modelId.toLowerCase() !== activeModelId) continue;
    const tier = nonEmptyString(scope.tier);
    const normalizedModelId = modelId?.toLowerCase();
    const normalizedTier = tier?.toLowerCase();
    // Antigravity buckets must not merge: without a bucket in the key, a
    // Gemini weekly limit and a Claude & GPT weekly limit collapse into
    // one group and only the larger fraction survives (#284).
    const bucket = provider === "google-antigravity" || provider === "antigravity"
      ? antigravityBucket(rawLimit, scope)
      : undefined;
    const groupKey = `${normalizedModelId ?? ""}\0${normalizedTier ?? ""}\0${bucket ?? ""}`;
    const priority = modelId ? (normalizedTier ? 0 : 1) : normalizedTier ? 2 : 3;
    let group = groups.get(groupKey);
    if (!group) {
      group = { priority, modelId, tier, bucket, limits: new Map() };
      groups.set(groupKey, group);
    }
    const candidate = { id: windowId, fraction, window };
    const current = group.limits.get(windowId);
    if (!current || fraction > current.fraction) group.limits.set(windowId, candidate);
  }

  const selectedGroups = [...groups.values()];
  if (activeModelId && selectedGroups.length > 0) {
    // Keep every group tied at the best priority, not just the first:
    // Antigravity's Gemini and shared buckets share priority (no modelId,
    // no tier) and differ only by bucket, so picking one would drop a
    // quota bucket from a model-filtered query (#284, CodeRabbit).
    const bestPriority = Math.min(...selectedGroups.map((group) => group.priority));
    const kept = selectedGroups.filter((group) => group.priority === bestPriority);
    selectedGroups.splice(0, selectedGroups.length, ...kept);
  }
  const metadata = isRecord(rawReport.metadata) ? rawReport.metadata : undefined;
  // Email only: unredacted account ids are opaque UUIDs, so those accounts
  // show as "Account N".
  const label = nonEmptyString(metadata?.email);
  const plan = nonEmptyString(metadata?.planType);
  if (selectedGroups.length === 0) {
    return [{
      provider,
      ...(label ? { accountLabel: label } : {}),
      ...(!label ? { accountIndex: reportIndex + 1 } : {}),
      ...(plan ? { plan } : {}),
      noLimits: true,
    }];
  }
  return selectedGroups.flatMap((group) => {
    const result: ProviderUsageReport = {
      provider,
      ...(label ? { accountLabel: label } : {}),
      ...(!label ? { accountIndex: reportIndex + 1 } : {}),
      ...(plan ? { plan } : {}),
      ...(group.modelId ? { modelId: group.modelId } : {}),
      ...(group.tier ? { tier: group.tier } : {}),
      ...(group.bucket ? { bucket: group.bucket } : {}),
    };
    for (const candidate of group.limits.values()) {
      const normalized = usageWindow(candidate.id, candidate.fraction, candidate.window, now);
      if (candidate.id === "5h" && !result.fiveHour) result.fiveHour = normalized;
      if (candidate.id === "7d" && !result.sevenDay) result.sevenDay = normalized;
      if (candidate.id === "monthly" && !result.monthly) result.monthly = normalized;
    }
    return result.fiveHour || result.sevenDay || result.monthly ? [result] : [];
  });
}

function parseUsagePayload(output: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("omp usage returned invalid JSON");
  }
  if (!isRecord(payload)) throw new Error("omp usage returned an invalid response");
  return payload;
}

/**
 * omp's raw reports, then its accounts that reported no usage as report-shaped records. Malformed
 * entries stay as `undefined` so "Account N" keeps counting omp's own positions.
 */
function rawUsageReports(payload: Record<string, unknown>): (Record<string, unknown> | undefined)[] {
  const reports = Array.isArray(payload.reports) ? payload.reports : [];
  const withoutUsage = Array.isArray(payload.accountsWithoutUsage) ? payload.accountsWithoutUsage : [];
  return [
    ...reports.map((report) => (isRecord(report) ? report : undefined)),
    ...withoutUsage.map((account) => (isRecord(account) ? { provider: account.provider, metadata: account } : undefined)),
  ];
}

export function parseProviderUsageOutput(output: string, query: UsageQuery = {}, now = Date.now()): ProviderUsageSnapshot {
  return usageSnapshot(parseUsagePayload(output), query, now);
}

function usageSnapshot(payload: UsagePayload, query: UsageQuery, now = Date.now()): ProviderUsageSnapshot {
  const reports = rawUsageReports(payload).flatMap((report, index) => (report ? normalizeReport(report, query, now, index) : []));
  return { generatedAt: asNumber(payload.generatedAt) ?? null, reports };
}

/** Mirrors omp's `usageReportIdentity`: metadata first, then the first limit scope carrying the id. */
function reportIdentity(rawReport: Record<string, unknown>): AccountIdentity {
  const metadata = isRecord(rawReport.metadata) ? rawReport.metadata : {};
  const limits = Array.isArray(rawReport.limits) ? rawReport.limits : [];
  const scoped = (key: string) => limits
    .map((limit) => (isRecord(limit) && isRecord(limit.scope) ? nonEmptyString(limit.scope[key]) : undefined))
    .find((value) => value !== undefined);
  return {
    email: nonEmptyString(metadata.email),
    accountId: nonEmptyString(metadata.accountId) ?? scoped("accountId"),
    projectId: nonEmptyString(metadata.projectId) ?? scoped("projectId"),
    orgId: nonEmptyString(metadata.orgId) ?? scoped("orgId"),
  };
}

function bucketLabel(report: ProviderUsageReport): string | undefined {
  if (report.bucket) return report.bucket;
  // Anthropic's tier is its model bucket ("fable"); other providers' tiers name quota groups as they are.
  if (report.tier) return report.provider === "anthropic" ? report.tier.charAt(0).toUpperCase() + report.tier.slice(1) : report.tier;
  return report.modelId;
}

const WINDOW_KEYS = ["fiveHour", "sevenDay", "monthly"] as const;

function mergeAccount(splits: ProviderUsageReport[], provider: string, index: number): Omit<ProviderUsageAccount, "key"> {
  const first = splits[0];
  const account: Omit<ProviderUsageAccount, "key"> = {
    provider,
    ...(first?.accountLabel ? { accountLabel: first.accountLabel } : { accountIndex: index + 1 }),
    ...(first?.plan ? { plan: first.plan } : {}),
  };
  // omp repeats one quota per model drawing on it (Antigravity's Gemini models): one bucket per label.
  const buckets = new Map<string | undefined, ProviderUsageBucket>();
  for (const split of splits) {
    const label = bucketLabel(split);
    const bucket = buckets.get(label) ?? { label };
    buckets.set(label, bucket);
    for (const key of WINDOW_KEYS) {
      const window = split[key];
      if (!window) continue;
      if (!bucket[key] || window.percent > bucket[key].percent) bucket[key] = window;
      if (!account[key] || window.percent > account[key].percent) account[key] = window;
    }
  }
  if (buckets.size > 1) account.buckets = [...buckets.values()];
  return account;
}

/** The account's limit (100 - reservePct) and priority from its `auth.accountPolicies` entry. */
function policyFields(policies: readonly unknown[], provider: string, account: AccountIdentity): Pick<ProviderUsageAccount, "limitPercent" | "priority"> {
  const reservePct = accountPolicyValue(policies, provider, account, "reservePct");
  const priority = accountPolicyValue(policies, provider, account, "priority");
  return { ...(reservePct !== undefined ? { limitPercent: 100 - reservePct } : {}), ...(priority !== undefined ? { priority } : {}) };
}

export function parseProviderUsageAccounts(
  output: string | null,
  stored: readonly StoredUsageAccount[] | null,
  policies: readonly unknown[],
  now = Date.now(),
): { generatedAt: number | null; accounts: ProviderUsageAccount[] } {
  return usageAccounts(output === null ? null : parseUsagePayload(output), stored, policies, now);
}

function usageAccounts(
  payload: UsagePayload | null,
  stored: readonly StoredUsageAccount[] | null,
  policies: readonly unknown[],
  now = Date.now(),
): { generatedAt: number | null; accounts: ProviderUsageAccount[] } {
  const rows = stored ?? [];
  const entries = (payload ? rawUsageReports(payload) : []).flatMap((raw, index) => {
    const provider = nonEmptyString(raw?.provider);
    if (!raw || !provider) return [];
    return [{ provider, index, identity: reportIdentity(raw), splits: normalizeReport(raw, {}, now, index) }];
  });
  const claimed = new Set<number>();
  const accounts: Omit<ProviderUsageAccount, "key">[] = [];
  for (const entry of entries) {
    const providerAccounts = rows.filter((account) => account.provider === entry.provider);
    const matches = providerAccounts.filter((account) => reportMatchesAccount(entry.identity, account));
    const active = matches.filter((account) => !account.paused);
    // A report fetched before its account was paused: the paused row below stands for it.
    if (active.length === 0 && matches.length > 0) continue;
    const sole = providerAccounts.length === 1 ? providerAccounts[0] : undefined;
    const hasIdentity = (id: AccountIdentity) => !!(id.email || id.accountId || id.projectId || id.orgId);
    const singleReport = entries.filter((other) => other.provider === entry.provider).length === 1;
    const soleActive = sole?.paused === false ? sole : undefined;
    // Copilot credentials carry no identity: fall back only when at least one side lacks identity, never on conflict.
    const match = active.length === 1
      ? active[0]
      : active.length === 0 && singleReport && soleActive && (!hasIdentity(entry.identity) || !hasIdentity(soleActive))
        ? soleActive
        : undefined;
    const account = mergeAccount(entry.splits, entry.provider, entry.index);
    if (match && !claimed.has(match.credentialId)) {
      claimed.add(match.credentialId);
      account.credentialId = match.credentialId;
      if (match.email) {
        account.accountLabel = match.email;
        delete account.accountIndex;
      }
      Object.assign(account, policyFields(policies, entry.provider, match));
      account.canPrioritize = canNameAccount(match);
      account.canLimit = account.canPrioritize && WINDOW_KEYS.some((key) => account[key]);
    }
    accounts.push(account);
  }
  for (const [index, storedAccount] of rows.entries()) {
    if (claimed.has(storedAccount.credentialId)) continue;
    accounts.push({
      provider: storedAccount.provider,
      ...(storedAccount.email ? { accountLabel: storedAccount.email } : { accountIndex: index + 1 }),
      credentialId: storedAccount.credentialId,
      paused: storedAccount.paused,
      canPrioritize: canNameAccount(storedAccount),
      ...policyFields(policies, storedAccount.provider, storedAccount),
    });
  }
  return {
    generatedAt: asNumber(payload?.generatedAt) ?? null,
    // shortcut: an account without a stored credential is keyed by its label or omp's position, so a
    // name for "Account 5" follows the position if omp reorders its reports; key it by identity when that bites.
    accounts: accounts.map((account) => ({
      ...account,
      key: `${account.provider}:${account.credentialId ?? account.accountLabel ?? `#${account.accountIndex}`}`,
    })),
  };
}

async function listStoredUsageAccounts(): Promise<StoredUsageAccount[]> {
  const { accounts } = await runUtilityCommand<{ accounts?: unknown }>({ type: "get_usage_accounts" }, 30_000);
  if (!Array.isArray(accounts)) throw new Error("get_usage_accounts returned no accounts");
  return accounts.flatMap((row) => {
    if (!isRecord(row) || !Number.isInteger(row.credentialId) || typeof row.provider !== "string" || typeof row.paused !== "boolean") return [];
    return [{
      credentialId: row.credentialId as number,
      provider: row.provider,
      paused: row.paused,
      email: nonEmptyString(row.email),
      accountId: nonEmptyString(row.accountId),
      projectId: nonEmptyString(row.projectId),
      orgId: nonEmptyString(row.orgId),
    }];
  });
}

async function fetchProviderUsage(refresh = false): Promise<UsagePayload> {
  const bin = resolveOmpBin();
  if (!bin) throw new Error(OMP_NOT_FOUND);
  if (refresh) {
    await execFileAsync(bin, ["usage", "invalidate"], {
      timeout: USAGE_TIMEOUT_MS,
      maxBuffer: USAGE_MAX_BUFFER,
      windowsHide: true,
      // No `env` option would inherit the server's full environment,
      // including omp-web's own secrets, into this child.
      env: createChildProcessEnvironment(),
    });
  }
  // Unredacted so accounts show their real email; only the parsed label, plan
  // and windows reach the browser, never the raw metadata.
  const { stdout } = await execFileAsync(bin, ["usage", "--json"], {
    timeout: USAGE_TIMEOUT_MS,
    maxBuffer: USAGE_MAX_BUFFER,
    windowsHide: true,
    env: createChildProcessEnvironment(),
  });
  return parseUsagePayload(stdout);
}

function getUsagePayload(refresh = false): Promise<UsagePayload> {
  if (!refresh && usageCache && usageCache.expiresAt > Date.now()) return Promise.resolve(usageCache.payload);
  if (usageInFlight) {
    return refresh && !usageInFlightForced
      ? usageInFlight.then(() => getUsagePayload(true), () => getUsagePayload(true))
      : usageInFlight;
  }
  const generation = usageGeneration;
  usageInFlightForced = refresh;
  const pending = fetchProviderUsage(refresh)
    .then((payload) => {
      if (generation === usageGeneration) {
        usageCache = { payload, expiresAt: Date.now() + USAGE_CACHE_TTL_MS };
      }
      return payload;
    })
    .finally(() => {
      if (usageInFlight === pending) usageInFlight = undefined;
    });
  usageInFlight = pending;
  return pending;
}

export async function getProviderUsage(query: UsageQuery = {}, refresh = false): Promise<ProviderUsageSnapshot> {
  return usageSnapshot(await getUsagePayload(refresh), query);
}

export async function getProviderUsageAccounts(refresh = false): Promise<ProviderUsageAccountsSnapshot> {
  const stored = await listStoredUsageAccounts().catch((error: unknown) => {
    if (error instanceof RpcCommandError && error.message === "unknown command: get_usage_accounts") return null;
    throw error;
  });
  if (stored) {
    // A cached report can outlive its credential, including when logout happened in the CLI.
    const state = JSON.stringify([...stored].sort((a, b) => a.credentialId - b.credentialId));
    if (usageAccountState !== undefined && usageAccountState !== state) invalidateUsageCache();
    usageAccountState = state;
  }
  const payload = await getUsagePayload(refresh).catch((error: unknown) => {
    if (!stored) throw error;
    return null;
  });
  const { policies, reservePct } = readAccountPolicyConfig();
  const { accountNames: names, accountOrder } = loadWebServerSettings();
  const { generatedAt, accounts } = usageAccounts(payload, stored, policies);
  // Rows the user placed come first in their order; new ones follow in omp's order.
  const rank = (key: string, index: number) => (accountOrder.includes(key) ? accountOrder.indexOf(key) : accountOrder.length + index);
  const ordered = accounts.map((account, index) => ({ account, rank: rank(account.key, index) })).sort((a, b) => a.rank - b.rank);
  return {
    generatedAt,
    ...(payload === null ? { usageUnavailable: true } : {}),
    accounts: ordered.map(({ account }) => (names[account.key] ? { ...account, name: names[account.key] } : account)),
    defaultLimitPercent: 100 - reservePct,
  };
}

/** Names an account in the overview (`null` or blank: back to its email or "Account N"). */
export function renameProviderUsageAccount(key: string, name: string | null): void {
  const accountNames = { ...readWebServerSettingsFromDisk().accountNames };
  const trimmed = name?.trim();
  if (trimmed) accountNames[key] = trimmed;
  else delete accountNames[key];
  saveWebServerSettings({ accountNames });
}

/** Pause or resume a stored account, or set (`null`: clear) its usage limit or priority. */
export async function updateProviderUsageAccount(
  provider: string,
  credentialId: number,
  change: { paused?: boolean; limitPercent?: number | null; priority?: number | null },
): Promise<void> {
  if (change.limitPercent !== undefined || change.priority !== undefined) {
    const siblings = (await listStoredUsageAccounts()).filter((account) => account.provider === provider);
    const account = siblings.find((candidate) => candidate.credentialId === credentialId);
    if (!account) throw new Error(`No stored ${provider} account ${credentialId}`);
    if (!canNameAccount(account)) throw new Error("omp cannot name this account in a policy: it has no email, account or project id");
    const { policies: initialPolicies, reservePct } = readAccountPolicyConfig();
    let policies = initialPolicies;
    if (change.limitPercent !== undefined) {
      policies = withAccountPolicy(policies, provider, account, siblings, "reservePct", change.limitPercent === null ? null : 100 - change.limitPercent, reservePct);
    }
    if (change.priority !== undefined) policies = withAccountPolicy(policies, provider, account, siblings, "priority", change.priority);
    writeAccountPolicies(policies);
  }
  if (change.paused !== undefined) {
    await runUtilityCommand({ type: "set_account_paused", providerId: provider, credentialId, paused: change.paused }, 120_000);
  }
  // The cached report still lists a paused account as active and lacks a resumed one.
  invalidateUsageCache();
}
