"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Gauge, Pause, Play, RefreshCw, Settings2, Star } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatUsageReset, PROVIDER_ACCOUNTS_CHANGED, usageTone, useProviderUsage } from "./AppShell-provider-usage";
import type { ProviderUsageAccount, ProviderUsageAccountsSnapshot, ProviderUsageBucket, ProviderUsageWindow } from "@/lib/provider-usage-types";
import { SidebarIconButton } from "./SessionSidebar-chrome";
import { ThemedSelect, Tooltip } from "./ui/primitives";
import { toast } from "./ui/toast";

const WINDOWS = [
  { short: "5H", key: "fiveHour" },
  { short: "7D", key: "sevenDay" },
  { short: "30D", key: "monthly" },
] as const;

const LIMIT_CHOICES = [50, 60, 70, 80, 90, 95, 100];

const COLLAPSED_STORAGE_KEY = "omp-web:provider-usage-collapsed";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Usage tone against the account's own limit: red from 80% of it, as from 80% of the provider's cap. */
function limitTone(percent: number, limit: number | undefined): string {
  return usageTone(limit ? (percent / limit) * 100 : percent);
}

function Bar({ percent, limit, tone }: { percent: number; limit?: number; tone: string }) {
  return (
    <span style={{ position: "relative", flex: 1, minWidth: 14, height: 3, borderRadius: 2, background: "var(--border)" }}>
      <span style={{ position: "absolute", inset: 0, width: `${Math.min(100, Math.max(0, percent))}%`, background: tone, borderRadius: 2 }} />
      {limit !== undefined && limit < 100 && (
        <span aria-hidden="true" style={{ position: "absolute", left: `${limit}%`, top: -2, width: 2, height: 7, marginLeft: -1, borderRadius: 1, background: "var(--text)" }} />
      )}
    </span>
  );
}

type WindowKey = (typeof WINDOWS)[number]["key"];

/**
 * One bucket's windows side by side: "5H ▬ 12%  7D ▬ 54%". `slots` are the windows any bucket of the
 * account has, so stacked lines keep their columns when a bucket lacks one.
 */
function WindowMeters({ windows, slots, limit }: { windows: Partial<Record<WindowKey, ProviderUsageWindow>>; slots: readonly WindowKey[]; limit?: number }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
      {WINDOWS.filter(({ key }) => slots.includes(key)).map(({ short, key }) => {
        const window = windows[key];
        if (!window) return <span key={key} style={{ flex: 1, minWidth: 0 }} />;
        const pct = Math.round(window.percent);
        const tone = limitTone(pct, limit);
        return (
          <span key={key} style={{ display: "flex", alignItems: "center", gap: 5, flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.04em", flexShrink: 0 }}>{short}</span>
            <Bar percent={pct} limit={limit} tone={tone} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums", flexShrink: 0, minWidth: 30, textAlign: "right" }}>{pct}%</span>
          </span>
        );
      })}
    </span>
  );
}

/** One window per line with its reset, for the expanded account. */
function DetailMeters({ windows, limit, t }: { windows: ProviderUsageBucket; limit?: number; t: Translate }) {
  return WINDOWS.map(({ short, key }) => {
    const window = windows[key];
    if (!window) return null;
    const pct = Math.round(window.percent);
    const tone = limitTone(pct, limit);
    const rawReset = window.resetMinutes ?? window.resetHours;
    const reset = rawReset !== undefined ? formatUsageReset(rawReset, window.resetMinutes !== undefined ? "minutes" : "hours") : null;
    return (
      <span key={key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.04em", width: 22, flexShrink: 0 }}>{short}</span>
        <Bar percent={pct} limit={limit} tone={tone} />
        <span style={{ fontSize: 10, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{pct}%</span>
        {reset && (
          <span style={{ fontSize: 9, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>{t("providerUsage.resets", { value: reset })}</span>
        )}
      </span>
    );
  });
}

const chipStyle = { fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 10, border: "1px solid var(--border)", padding: "0 5px", borderRadius: 4, whiteSpace: "nowrap", flexShrink: 0, lineHeight: 1.7 } as const;

const iconButtonStyle = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, flexShrink: 0,
  background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer",
} as const;

type AccountChange = { paused?: boolean; limitPercent?: number | null; priority?: number | null; name?: string | null };

function IconAction({ label, busy, active, onClick, children }: { label: string; busy?: boolean; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip content={label} side="top">
      <button
        type="button"
        className="provider-usage-action-btn"
        disabled={busy}
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        style={{ ...iconButtonStyle, color: active ? "var(--accent)" : iconButtonStyle.color, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function AccountDetail({ account, label, defaultLimit, busy, onChange, onOpenProvider, t }: {
  account: ProviderUsageAccount;
  label: string;
  defaultLimit: number;
  busy: boolean;
  onChange: (change: AccountChange) => void;
  onOpenProvider?: (provider: string) => void;
  t: Translate;
}) {
  const preferred = (account.priority ?? 0) > 0;
  const limit = account.limitPercent;
  const limitOptions = [
    { value: "default", label: t("providerUsage.limitDefault", { percent: defaultLimit }) },
    ...[...new Set([...LIMIT_CHOICES, ...(limit !== undefined ? [limit] : [])])].sort((a, b) => a - b).map((value) => ({ value: String(value), label: `≤${value}%` })),
  ];
  const sections: ProviderUsageBucket[] = account.buckets ?? [account];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, padding: "4px 8px 8px 23px" }}>
      {!account.paused && sections.map((bucket, index) => (
        <div key={index} style={{ display: "flex", flexDirection: "column", gap: 3, fontFamily: "var(--font-mono)" }}>
          {account.buckets && (
            <span style={{ fontSize: 10, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {bucket.label ?? t("appShell.allModels")}
            </span>
          )}
          <DetailMeters windows={bucket} limit={limit ?? defaultLimit} t={t} />
        </div>
      ))}
      {account.paused || !WINDOWS.some(({ key }) => account[key]) ? (
        <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.4 }}>
          {t(account.paused ? "providerUsage.pausedHint" : "appShell.providerUsageNoData")}
        </span>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        {account.credentialId !== undefined && (account.canLimit || limit !== undefined) && (
          <ThemedSelect
            aria-label={t("providerUsage.limitFor", { account: label })}
            title={t("providerUsage.limitFor", { account: label })}
            value={limit === undefined ? "default" : String(limit)}
            disabled={busy || !account.canLimit}
            options={limitOptions}
            onChange={(value) => onChange({ limitPercent: value === "default" ? null : Number(value) })}
            style={{ minHeight: 26, padding: "2px 7px", fontSize: 11, gap: 4 }}
          />
        )}
        {account.credentialId !== undefined && account.canPrioritize && (
          <IconAction
            label={t(preferred ? "providerUsage.unpreferAccount" : "providerUsage.preferAccount", { account: label })}
            busy={busy}
            active={preferred}
            onClick={() => onChange({ priority: preferred ? null : 1 })}
          >
            <Star size={12} fill={preferred ? "currentColor" : "none"} aria-hidden="true" />
          </IconAction>
        )}
        {account.credentialId !== undefined && (
          <IconAction
            label={t(account.paused ? "providerUsage.resumeAccount" : "providerUsage.pauseAccount", { account: label })}
            busy={busy}
            onClick={() => onChange({ paused: !account.paused })}
          >
            {account.paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
          </IconAction>
        )}
        {onOpenProvider && (
          <span style={{ marginLeft: "auto", display: "flex" }}>
            <IconAction label={t("providerUsage.openProvider")} onClick={() => onOpenProvider(account.provider)}>
              <Settings2 size={12} aria-hidden="true" />
            </IconAction>
          </span>
        )}
      </div>
    </div>
  );
}

// Provider rate limits pinned above Settings in the sidebar: one row per stored account with every
// window it reports; click a row for its buckets, limit, pause and a way to its provider settings.
export function ProviderUsageBar({ onOpenProvider }: { onOpenProvider?: (provider: string) => void }) {
  const { t } = useI18n();
  const { snapshot, loading, error, refresh, reload } = useProviderUsage<ProviderUsageAccountsSnapshot>("", 5 * 60_000, "/api/provider-usage/accounts");
  const unavailable = error || snapshot?.usageUnavailable;
  useEffect(() => {
    const onAccountsChanged = () => void reload({ invalidate: true });
    window.addEventListener(PROVIDER_ACCOUNTS_CHANGED, onAccountsChanged);
    return () => window.removeEventListener(PROVIDER_ACCOUNTS_CHANGED, onAccountsChanged);
  }, [reload]);
  const [refreshDone, setRefreshDone] = useState(false);
  useEffect(() => {
    if (!refreshDone) return;
    const timer = window.setTimeout(() => setRefreshDone(false), 2000);
    return () => window.clearTimeout(timer);
  }, [refreshDone]);
  // A dropped order shows at once and stays until the server's next snapshot carries it.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const orderQueueRef = useRef<Promise<void>>(Promise.resolve());
  const orderVersionRef = useRef(0);
  const orderPendingRef = useRef(0);
  useEffect(() => {
    if (orderPendingRef.current === 0) setLocalOrder(null);
  }, [snapshot]);
  const accounts = localOrder
    ? [...(snapshot?.accounts ?? [])].sort((a, b) => localOrder.indexOf(a.key) - localOrder.indexOf(b.key))
    : snapshot?.accounts ?? [];
  const defaultLimit = snapshot?.defaultLimitPercent ?? 90;
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const moveAccount = (from: string, to: string) => {
    const order = accounts.map((account) => account.key).filter((key) => key !== from);
    const targetIndex = accounts.findIndex((account) => account.key === to);
    if (targetIndex === -1) return;
    order.splice(targetIndex, 0, from);
    setLocalOrder(order);
    const version = ++orderVersionRef.current;
    orderPendingRef.current += 1;
    orderQueueRef.current = orderQueueRef.current
      .catch(() => {})
      .then(async () => {
        const response = await fetch("/api/provider-usage/accounts", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ order }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (version === orderVersionRef.current) await reload();
      })
      .catch((cause: unknown) => {
        if (version === orderVersionRef.current) {
          setLocalOrder(null);
          toast.error(t("providerUsage.reorderFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
        }
      })
      .finally(() => {
        orderPendingRef.current = Math.max(0, orderPendingRef.current - 1);
        if (orderPendingRef.current === 0 && version === orderVersionRef.current) setLocalOrder(null);
      });
  };
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const clickTimer = useRef<number | undefined>(undefined);
  // The first render must match the server, where localStorage is unavailable,
  // so start collapsed and apply the stored preference after mounting.
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    try {
      // No stored choice yet → stay hidden; an explicit expand persists.
      if (window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "false") setCollapsed(false);
    } catch {
      // Storage unavailable: keep the collapsed default.
    }
  }, []);

  const update = async (account: ProviderUsageAccount, label: string, change: AccountChange) => {
    setBusyKey(account.key);
    try {
      const response = await fetch("/api/provider-usage/accounts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change.name !== undefined
          ? { key: account.key, name: change.name }
          : { provider: account.provider, credentialId: account.credentialId, ...change }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      await reload();
    } catch (cause) {
      toast.error(t("providerUsage.updateFailed", { account: label, error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section
      aria-label={t("appShell.sectionProviderUsage")}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "8px 8px 6px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-panel)",
        flexShrink: 0,
        minHeight: 0,
        maxHeight: "40vh",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => setCollapsed((v) => {
            const next = !v;
            try {
              window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
            } catch {
              // The preference still applies for this page load.
            }
            return next;
          })}
          aria-expanded={!collapsed}
          title={t("appShell.sectionProviderUsage")}
          style={{ display: "flex", alignItems: "center", gap: 7, flex: 1, boxSizing: "border-box", padding: "0 4px", minWidth: 0, background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
        >
          <ChevronRight
            size={11}
            strokeWidth={2}
            aria-hidden="true"
            style={{ flexShrink: 0, color: "var(--text-dim)", transform: collapsed ? "none" : "rotate(90deg)", transition: "transform var(--dur-med) var(--ease-out-warm)" }}
          />
          <span aria-hidden="true" style={{ display: "flex", color: "var(--accent)", flexShrink: 0 }}>
            <Gauge size={13} strokeWidth={2} aria-hidden="true" />
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("appShell.sectionProviderUsage")}
          </span>
          {(unavailable || accounts.length === 0) && (
            <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-dim)", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
              {loading && accounts.length === 0
                ? t("appShell.providerUsageLoading")
                : unavailable
                  ? t("appShell.providerUsageUnavailable")
                  : t("appShell.providerUsageNoData")}
            </span>
          )}
        </button>
        <Tooltip content={t("sessionSidebar.refresh")} side="top">
          <SidebarIconButton
            label={t("sessionSidebar.refresh")}
            active={refreshDone}
            disabled={loading}
            onClick={() => {
              setRefreshDone(false);
              void refresh().then(setRefreshDone);
            }}
          >
            {refreshDone ? <Check size={14} strokeWidth={2.2} aria-hidden="true" /> : <RefreshCw size={14} strokeWidth={1.9} aria-hidden="true" />}
          </SidebarIconButton>
        </Tooltip>
      </div>
      {accounts.length > 0 && (
        <div className={`accordion-flow${!collapsed ? " is-open" : ""}`} aria-hidden={collapsed} inert={collapsed} style={{ minHeight: 0, flexShrink: 1 }}>
          <div className="accordion-flow-inner" style={{ display: "flex", flexDirection: "column", maxHeight: "calc(40vh - 44px)" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minHeight: 0, overflowY: "auto" }}>
              {accounts.map((account, index) => {
                const defaultLabel = account.accountLabel ?? t("appShell.account", { number: account.accountIndex ?? index + 1 });
                const label = account.name ?? defaultLabel;
                const { key } = account;
                const expanded = expandedKey === key;
                const editing = editingKey === key;
                const preferred = (account.priority ?? 0) > 0;
                const nonDefaultLimit = account.limitPercent !== undefined && account.limitPercent !== defaultLimit ? account.limitPercent : undefined;
                const hasBadges = nonDefaultLimit !== undefined || preferred || !!account.paused;
                const hasWindows = WINDOWS.some(({ key: windowKey }) => account[windowKey]);
                const finishRename = (value: string | null) => {
                  setEditingKey(null);
                  if (value !== null && value.trim() !== (account.name ?? "")) void update(account, label, { name: value.trim() || null });
                };
                const rowStyle = { display: "flex", flexDirection: "column", width: "100%", boxSizing: "border-box", padding: "5px 6px", background: "none", border: "none", cursor: "pointer", textAlign: "left", minWidth: 0 } as const;
                const content = (
                  <>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", minWidth: 0, opacity: account.paused ? 0.55 : 1 }}>
                      <ChevronRight
                        size={11}
                        strokeWidth={2}
                        aria-hidden="true"
                        style={{ flexShrink: 0, color: "var(--text-dim)", transform: expanded ? "rotate(90deg)" : "none", transition: "transform var(--dur-med) var(--ease-out-warm)" }}
                      />
                      <span style={{ ...chipStyle, color: "var(--text)", background: "var(--bg)" }}>{account.provider}</span>
                      {editing ? (
                        <input
                          autoFocus
                          defaultValue={account.name ?? ""}
                          placeholder={defaultLabel}
                          maxLength={80}
                          aria-label={t("providerUsage.nameFor", { account: defaultLabel })}
                          onBlur={(event) => finishRename(event.currentTarget.dataset.cancelled ? null : event.currentTarget.value)}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Escape") event.currentTarget.dataset.cancelled = "true";
                            if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
                          }}
                          style={{ flex: 1, minWidth: 0, height: 20, boxSizing: "border-box", padding: "0 5px", background: "var(--bg)", border: "1px solid var(--accent)", borderRadius: 4, color: "var(--text)", font: "inherit", fontSize: 11 }}
                        />
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                          {label}
                        </span>
                      )}
                      {hasBadges && (
                        <span className={`provider-usage-badges${expanded ? " is-hidden" : ""}`} aria-hidden={expanded}>
                          {nonDefaultLimit !== undefined && (
                            <span style={{ ...chipStyle, color: "var(--text-muted)", background: "var(--bg-subtle)" }}>
                              ≤{nonDefaultLimit}%
                            </span>
                          )}
                          {preferred && (
                            <Star size={11} fill="currentColor" aria-label={t("providerUsage.preferred")} style={{ flexShrink: 0, color: "var(--accent)" }} />
                          )}
                          {account.paused && (
                            <Pause size={11} strokeWidth={2.2} aria-label={t("providerUsage.paused")} style={{ flexShrink: 0, color: "var(--text-muted)" }} />
                          )}
                        </span>
                      )}
                    </span>
                    {/* An open row lists the same quotas with names, resets and interactive buttons below. */}
                    {!account.paused && (
                      <div className={`accordion-flow${!expanded ? " is-open" : ""}`} aria-hidden={expanded} style={{ width: "100%" }}>
                        <div className="accordion-flow-inner">
                          <span style={{ display: "flex", flexDirection: "column", gap: 3, width: "100%", paddingTop: 4, paddingLeft: 17, boxSizing: "border-box" }}>
                            {hasWindows ? (
                              // Each bucket is its own quota (Gemini vs Argon, shared vs Fable): one unlabelled line each.
                              (account.buckets ?? [account]).map((bucket, bucketIndex) => (
                                <WindowMeters key={bucketIndex} windows={bucket} slots={WINDOWS.flatMap(({ key: windowKey }) => (account[windowKey] ? [windowKey] : []))} limit={account.limitPercent ?? defaultLimit} />
                              ))
                            ) : (
                              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("appShell.providerUsageNoData")}</span>
                            )}
                          </span>
                        </div>
                      </div>
                    )}
                  </>
                );
                return (
                  <div
                    key={key}
                    className="provider-usage-card"
                    draggable={!editing}
                    onDragStart={(event) => { event.dataTransfer.setData("text/plain", key); event.dataTransfer.effectAllowed = "move"; setDragKey(key); }}
                    onDragOver={(event) => {
                      if (!dragKey || dragKey === key) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropKey(key);
                    }}
                    onDragLeave={() => setDropKey((current) => (current === key ? null : current))}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (dragKey && dragKey !== key) moveAccount(dragKey, key);
                      setDragKey(null);
                      setDropKey(null);
                    }}
                    onDragEnd={() => { setDragKey(null); setDropKey(null); }}
                    style={{
                      borderRadius: "var(--radius-control)",
                      background: expanded ? "var(--bg-subtle)" : "transparent",
                      opacity: dragKey === key ? 0.5 : 1,
                      ...(dropKey === key ? { outline: "1px solid var(--accent)", outlineOffset: -1 } : {}),
                    }}
                  >
                    {/* A div, not a button: the rename input sits inside the row. */}
                    <div
                      role="button"
                      tabIndex={0}
                      className="provider-usage-row"
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown F2"
                      onClick={(event) => {
                        // Expanding moves the row up (the panel grows from the bottom), so wait out a double-click.
                        window.clearTimeout(clickTimer.current);
                        if (!editing && event.detail <= 1) clickTimer.current = window.setTimeout(() => setExpandedKey((prev) => (prev === key ? null : key)), 220);
                      }}
                      onDoubleClick={() => {
                        window.clearTimeout(clickTimer.current);
                        setEditingKey(key);
                      }}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setExpandedKey((prev) => (prev === key ? null : key));
                        } else if (event.key === "F2") {
                          setEditingKey(key);
                        } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                          event.preventDefault();
                          const target = accounts[index + (event.key === "ArrowUp" ? -1 : 1)];
                          if (target) moveAccount(key, target.key);
                        }
                      }}
                      aria-expanded={expanded}
                      title={[account.name && defaultLabel, account.plan, t("providerUsage.renameHint")].filter(Boolean).join(" · ")}
                      style={{ ...rowStyle, cursor: editing ? "default" : "pointer" }}
                    >
                      {content}
                    </div>
                    <div className={`accordion-flow${expanded ? " is-open" : ""}`} aria-hidden={!expanded} inert={!expanded}>
                      <div className="accordion-flow-inner">
                        <AccountDetail
                          account={account}
                          label={label}
                          defaultLimit={defaultLimit}
                          busy={busyKey === key}
                          onChange={(change) => void update(account, label, change)}
                          onOpenProvider={onOpenProvider}
                          t={t}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
