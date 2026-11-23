import { useState, useEffect, useRef, useCallback } from "react";
import type { ProviderUsageReport, ProviderUsageSnapshot } from "@/lib/provider-usage-types";
import { isRecord } from "@/lib/type-guards";

export const PROVIDER_ACCOUNTS_CHANGED = "omp-provider-accounts-change";

export function formatUsageReset(value: number, unit: "minutes" | "hours"): string {
  if (unit === "minutes") {
    if (value < 60) return `${value}m`;
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (value < 24) return `${value}h`;
  const days = Math.floor(value / 24);
  const hours = value % 24;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

export function usageTone(percent: number): string {
  if (percent >= 80) return "var(--status-error)";
  if (percent >= 50) return "var(--status-warning)";
  return "var(--text-muted)";
}

export function formatProviderUsageReport(report: ProviderUsageReport, noLimitsLabel: string): string {
  if (report.noLimits) return noLimitsLabel;
  const parts: string[] = [];
  if (report.tier) parts.push(report.tier);
  if (report.fiveHour) {
    const reset = report.fiveHour.resetMinutes === undefined
      ? ""
      : ` (${formatUsageReset(report.fiveHour.resetMinutes, "minutes")})`;
    parts.push(`5h ${Math.round(report.fiveHour.percent)}%${reset}`);
  }
  if (report.sevenDay) {
    const reset = report.sevenDay.resetHours === undefined
      ? ""
      : ` (${formatUsageReset(report.sevenDay.resetHours, "hours")})`;
    parts.push(`7d ${Math.round(report.sevenDay.percent)}%${reset}`);
  }
  if (report.monthly) {
    const reset = report.monthly.resetHours === undefined
      ? ""
      : ` (${formatUsageReset(report.monthly.resetHours, "hours")})`;
    parts.push(`mo ${Math.floor(report.monthly.percent)}%${reset}`);
  }
  return parts.join(" · ");
}

export type ProviderUsageState<T = ProviderUsageSnapshot> = {
  snapshot: T | null;
  loading: boolean;
  error: boolean;
};

type UsageLoad = "poll" | "reload" | "force" | "invalidate";

/** Polls `path` (`refresh()` asks omp for fresh limits, `reload()` only re-reads omp-web's view). */
export function useProviderUsage<T = ProviderUsageSnapshot>(
  query: string | null,
  refreshMs?: number,
  path = "/api/provider-usage",
): ProviderUsageState<T> & { refresh: () => Promise<boolean>; reload: (options?: { invalidate?: boolean }) => Promise<boolean> } {
  const [state, setState] = useState<ProviderUsageState<T>>({ snapshot: null, loading: false, error: false });
  const refreshRef = useRef<(mode: UsageLoad) => Promise<boolean>>(async () => false);
  const refresh = useCallback(() => refreshRef.current("force"), []);
  const reload = useCallback((options?: { invalidate?: boolean }) => refreshRef.current(options?.invalidate ? "invalidate" : "reload"), []);
  useEffect(() => {
    if (query === null) {
      setState({ snapshot: null, loading: false, error: false });
      return;
    }
    const controller = new AbortController();
    setState({ snapshot: null, loading: true, error: false });
    let inFlight: Promise<boolean> | undefined;
    let inFlightForced = false;
    let generation = 0;
    const load = (mode: UsageLoad = "poll"): Promise<boolean> => {
      if (controller.signal.aborted) return Promise.resolve(false);
      if (mode === "invalidate") {
        generation += 1;
        setState({ snapshot: null, loading: true, error: false });
      }
      if (inFlight) {
        if (mode === "force" && !inFlightForced) return inFlight.then(() => load("force"));
        if (mode === "reload" || mode === "invalidate") return inFlight.then(() => load("poll"));
        return inFlight;
      }
      const force = mode === "force";
      if (force) setState((previous) => ({ ...previous, loading: true, error: false }));
      const params = new URLSearchParams(query);
      if (force) params.set("refresh", "true");
      const queryString = params.toString();
      inFlightForced = force;
      const startedAt = generation;
      inFlight = (async () => {
        try {
          const response = await fetch(`${path}${queryString ? `?${queryString}` : ""}`, { signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const snapshot = await response.json() as T;
          if (controller.signal.aborted || generation !== startedAt) return false;
          setState({ snapshot, loading: false, error: false });
          return !isRecord(snapshot) || snapshot.usageUnavailable !== true;
        } catch {
          if (!controller.signal.aborted && generation === startedAt) {
            setState((previous) => ({ ...previous, loading: false, error: true }));
          }
          return false;
        } finally {
          inFlight = undefined;
        }
      })();
      return inFlight;
    };
    refreshRef.current = load;
    void load();
    const interval = refreshMs ? window.setInterval(() => void load(), refreshMs) : undefined;
    return () => {
      refreshRef.current = async () => false;
      controller.abort();
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [query, refreshMs, path]);
  return { ...state, refresh, reload };
}
