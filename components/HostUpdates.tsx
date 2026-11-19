"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, RefreshCw } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/field";
import type { HostRow } from "@/lib/hosts/hub";
import type { HostUpdateInfo, HostUpdateOperation, HostUpdateTarget } from "@/lib/hosts/update-types";
import { useI18n } from "@/lib/i18n";
import { hostName } from "./host-status";

const buttonStyle = { padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 } as const;
const dangerButtonStyle = { ...buttonStyle, border: "1px solid var(--status-error)", color: "var(--status-error)" } as const;
const POLL_MS = 1000;
// Longer than the host's 15-minute update/recovery lease. Expiry only stops waiting; it never resubmits.
const RECONNECT_MS = 20 * 60 * 1000;

export function HostUpdates({ host }: { host: HostRow }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<HostUpdateInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [monitoring, setMonitoring] = useState(false);
  const [needsStatus, setNeedsStatus] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ target: HostUpdateTarget; force: boolean } | null>(null);
  const [check, setCheck] = useState(0);
  const [operationCheck, setOperationCheck] = useState(0);
  const watching = useRef(false);
  const deadline = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const postController = useRef<AbortController | null>(null);
  const endpoint = `/api/hosts/${encodeURIComponent(host.id)}/updates`;
  const upgradeOnly = host.status === "needs-upgrade" && host.upgradeOnly === true;
  const unavailable = (host.status === "offline" || host.status === "needs-upgrade") && !upgradeOnly && host.apiVersion !== 1;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      postController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (unavailable && !watching.current) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let timer: number | undefined;
    let requestTimer: number | undefined;
    let disposed = false;
    setUnsupported(false);
    setLoading(true);
    const stop = () => {
      watching.current = false;
      deadline.current = 0;
      setMonitoring(false);
    };
    const refresh = async () => {
      if (watching.current && Date.now() >= deadline.current) {
        stop();
        setLoading(false);
        setNeedsStatus(true);
        setError(t("hostUpdates.reconnectTimeout"));
        return;
      }
      const request = new AbortController();
      const abort = () => request.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      requestTimer = window.setTimeout(abort, 30000);
      try {
        const response = await fetch(`${endpoint}${check > 0 && !watching.current ? "?force=1" : ""}`, { cache: "no-store", signal: request.signal });
        const data = await response.json();
        if (disposed) return;
        if (response.status === 501) {
          setUnsupported(true);
          setError(null);
          stop();
          return;
        }
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        // A successful status read, not POST acceptance, establishes the result.
        if (!data.ompweb || !data.omp) throw new Error(t("hostUpdates.invalidResponse"));
        const next = data as HostUpdateInfo;
        setInfo(next);
        setError(null);
        setNeedsStatus(false);
        if ([next.operation, next.omp.operation].some((item) => item?.state === "running" && !item.recoveryRequired)) {
          watching.current = true;
          deadline.current ||= Date.now() + RECONNECT_MS;
          setMonitoring(true);
        } else {
          stop();
        }
      } catch (cause) {
        if (disposed) return;
        setError(t("hostUpdates.checkFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
      } finally {
        window.clearTimeout(requestTimer);
        controller.signal.removeEventListener("abort", abort);
        if (!disposed) {
          setLoading(false);
          if (watching.current) timer = window.setTimeout(() => void refresh(), POLL_MS);
        }
      }
    };
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(timer);
      window.clearTimeout(requestTimer);
    };
  }, [endpoint, host.status, unavailable, check, operationCheck, t]);

  const update = async () => {
    const target = confirm?.target;
    const force = confirm?.force === true;
    const software = target ? info?.[target] : undefined;
    // Force is authorized only by the server's own flag, never inferred from a blocker's wording.
    if (!target || !software || !(force ? software.canForceUpdate : software.canUpdate) || !software.updateAvailable || !software.availableVersion || inFlight.current || watching.current || needsStatus || unavailable || unsupported || loading) return;
    inFlight.current = true;
    setPosting(true);
    setConfirm(null);
    setError(null);
    const controller = new AbortController();
    postController.current = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify(force ? { target, version: software.availableVersion, force: true } : { target, version: software.availableVersion }),
      });
      const data = await response.json();
      if (!mounted.current) return;
      if (!response.ok) {
        if (response.status === 501) setUnsupported(true);
        // A lost or late answer (host offline, timed out, unreadable) may follow an update that started: reconcile.
        else if (response.status >= 500) throw new Error(data.error || `HTTP ${response.status}`);
        setError(t("hostUpdates.updateFailed", { error: data.error || `HTTP ${response.status}` }));
        return;
      }
      if (!data.accepted || !data.operation) throw new Error(t("hostUpdates.invalidResponse"));
      const operation = data.operation as HostUpdateOperation;
      // An omp update has its own record, beside ompweb's: neither replaces the other.
      setInfo((previous) => previous && (target === "omp" ? { ...previous, omp: { ...previous.omp, operation: operation.state === "running" ? operation : null } } : { ...previous, operation: operation.state === "running" ? operation : null }));
      watching.current = true;
      deadline.current = Date.now() + RECONNECT_MS;
      setMonitoring(true);
      setOperationCheck((value) => value + 1);
    } catch {
      if (!mounted.current) return;
      // The request may have reached the host: reconcile with GET, never resend it.
      setNeedsStatus(true);
      setError(t("hostUpdates.answerLost"));
      watching.current = true;
      deadline.current = Date.now() + RECONNECT_MS;
      setMonitoring(true);
      setOperationCheck((value) => value + 1);
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
      postController.current = null;
      if (mounted.current) setPosting(false);
    }
  };

  const busy = loading || posting || monitoring;
  const disabled = busy || unavailable || unsupported;
  const unavailableReason = (host.status === "needs-upgrade" && unavailable) || unsupported ? t("hostUpdates.unsupported") : host.status === "offline" && unavailable ? t("hostUpdates.offline") : null;
  const operation = info?.operation;
  const operations = [info?.operation, info?.omp.operation].filter((item): item is HostUpdateOperation => !!item);
  const running = operations.find((item) => item.state === "running");
  return (
    <div style={{ flexBasis: "100%", minWidth: 0, borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("hostUpdates.software")}</span>
        <button type="button" className="ui-focus-ring" disabled={disabled} style={{ ...buttonStyle, opacity: disabled ? 0.6 : 1, cursor: disabled ? "not-allowed" : "pointer" }} onClick={() => setCheck((value) => value + 1)}>
          <RefreshCw size={13} aria-hidden="true" />{t(loading ? "hostUpdates.checking" : error || needsStatus ? "hostUpdates.retry" : "hostUpdates.check")}
        </button>
      </div>
      {(["ompweb", "omp"] as const).map((target) => {
        const software = info?.[target];
        const label = t(`hostUpdates.${target}`);
        // A daemon without the runner channel updates omp only with ompweb.
        const withOmpweb = target === "omp" && info !== null && info.omp.runnerChannel !== true;
        const updateDisabled = disabled || needsStatus || operation?.recoveryRequired === true || !software?.canUpdate;
        const forceable = operation?.recoveryRequired !== true && software?.updateAvailable === true && !software.canUpdate && software.canForceUpdate === true;
        return (
          <div key={target} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <div style={{ minWidth: 0, flex: "1 1 200px", fontSize: 12, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
              <strong style={{ color: "var(--text)", fontWeight: 600 }}>{label}</strong>
              <div style={{ marginTop: 3, fontFamily: "var(--font-mono)" }}>{t("hostUpdates.current", { version: software?.currentVersion ?? (target === "ompweb" ? host.ompwebVersion : host.ompVersion?.replace(/^omp\//, "")) ?? t("hostUpdates.unknown") })}</div>
              {software?.updateAvailable && software.availableVersion && <div style={{ color: "var(--accent)" }}>{t("hostUpdates.available", { version: software.availableVersion })}</div>}
              {withOmpweb && <div>{t("hostUpdates.ompWithOmpweb")}</div>}
              {!withOmpweb && software?.currentVersion && !software.updateAvailable && !software.blockedReason && !error && !busy && !unavailableReason && <div>{t("hostUpdates.upToDate")}</div>}
              {software?.blockedReason && <div style={{ marginTop: 3, color: "var(--status-warning)" }}>{t("hostUpdates.blocked", { reason: software.blockedReason })}</div>}
              {software?.updateAvailable && !software.canUpdate && !software.blockedReason && !forceable && <div>{t("hostUpdates.manualOnly")}</div>}
              {forceable && <div>{t("hostUpdates.forceAvailable")}</div>}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {software?.updateAvailable && software.availableVersion && <button type="button" className="ui-focus-ring" aria-label={t("hostUpdates.updateAria", { software: label })} disabled={updateDisabled} style={{ ...buttonStyle, opacity: updateDisabled ? 0.6 : 1, cursor: updateDisabled ? "not-allowed" : "pointer" }} onClick={() => setConfirm({ target, force: false })}><Download size={13} aria-hidden="true" />{target === "omp" ? t("hostUpdates.updateOmp", { version: software.availableVersion }) : t("hostUpdates.update")}</button>}
              {forceable && software.availableVersion && <button type="button" className="ui-focus-ring" aria-label={t("hostUpdates.forceUpdateAria", { software: label })} disabled={disabled || needsStatus} style={{ ...dangerButtonStyle, opacity: disabled || needsStatus ? 0.6 : 1, cursor: disabled || needsStatus ? "not-allowed" : "pointer" }} onClick={() => setConfirm({ target, force: true })}><AlertTriangle size={13} aria-hidden="true" />{t("hostUpdates.forceUpdate")}</button>}
            </div>
          </div>
        );
      })}
      <div aria-live="polite" style={{ fontSize: 12, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
        {unavailableReason && <div>{unavailableReason}</div>}
        {monitoring && <div role="status">{running ? t("hostUpdates.updating", { software: t(`hostUpdates.${running.target}`), version: running.version }) : t("hostUpdates.reconnecting")}</div>}
        {operations.map((item) => (
          <Fragment key={`${item.target}:${item.id}`}>
            {!monitoring && !posting && !error && item.state === "succeeded" && <div role="status">{t(item.awaitingServerCutover ? "hostUpdates.awaitingServerCutover" : item.target === "omp" ? "hostUpdates.ompSucceeded" : "hostUpdates.succeeded")}</div>}
            {!monitoring && item.force === true && item.interruptedSessions !== undefined && item.state !== "running" && <div>{t("hostUpdates.interruptedSessions", { count: item.interruptedSessions })}</div>}
            {!monitoring && (item.state === "failed" || item.recoveryRequired) && <div role="alert" style={{ color: "var(--status-error)" }}>{t("hostUpdates.updateFailed", { error: item.error || t("hostUpdates.unknownError") })}</div>}
          </Fragment>
        ))}
        {error && <div role="alert" style={{ color: "var(--status-error)" }}>{error}</div>}
        {needsStatus && <div>{t("hostUpdates.statusRequired")}</div>}
      </div>
      <ConfirmDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }} title={t(confirm?.force ? "hostUpdates.forceConfirmTitle" : "hostUpdates.confirmTitle", { software: confirm ? t(`hostUpdates.${confirm.target}`) : "", host: hostName(t, host) })} description={t(confirm?.force ? "hostUpdates.forceHostWarning" : confirm?.target === "omp" ? "hostUpdates.ompHostWarning" : "hostUpdates.hostWarning", { host: hostName(t, host) })} confirmLabel={t(confirm?.force ? "hostUpdates.forceConfirm" : "hostUpdates.update")} cancelLabel={t("hostsConfig.cancel")} danger={confirm?.force === true} busy={posting} onConfirm={() => void update()} />
    </div>
  );
}
