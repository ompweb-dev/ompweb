import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react/pure.js");
const { SettingsConfig } = await import("./SettingsConfig");

const noop = () => {};
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
const settingsProps = {
  activeTab: "system",
  toolCallsDefaultCollapsed: false, onToolCallsDefaultCollapsedChange: noop,
  hideToolActivity: false, onHideToolActivityChange: noop,
  expandThinkingByDefault: false, onExpandThinkingByDefaultChange: noop, onHideThinkingBlockChange: noop,
  providerUsageVisible: false, onProviderUsageVisibleChange: noop,
  scopeNativeSelectAll: false, onScopeNativeSelectAllChange: noop,
  openUrlAutomatically: false, onOpenUrlAutomaticallyChange: noop,
  cwd: null, remoteHost: false, sessionId: null,
  onModelsSaved: noop, onPluginsReloaded: noop,
  appUpdate: null, onRefreshAppUpdate: async () => null,
  onRequestAppUpdate: noop, onSelectTab: noop, onClose: noop,
};

async function choose(select, name) {
  fireEvent.click(select);
  const list = await waitFor(() => within(document.body).getByRole("listbox"));
  const option = within(list).getByRole("option", { name, exact: true });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await settle();
}

test("agent message approval loads and saves the trust-cluster policy", async (t) => {
  const puts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "/api/web-settings") {
      if (init?.method === "PUT") {
        puts.push(init.body);
        return Response.json({ agentMessagePermission: "trustCluster" });
      }
      return Response.json({ agentMessagePermission: "alwaysAsk" });
    }
    return Response.json({});
  };
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const select = within(container).getByRole("combobox", { name: "Agent message approval" });
  assert.equal(select.textContent, "Always ask");
  await choose(select, "Trust cluster");
  assert.deepEqual(puts, ['{"agentMessagePermission":"trustCluster"}']);
  assert.equal(select.textContent, "Trust cluster");
});

test("agent message approval shows unavailable instead of inventing a policy while loading fails", async (t) => {
  const pending = Promise.withResolvers();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url) === "/api/web-settings" ? pending.promise : Response.json({});
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  const { container } = render(createElement(SettingsConfig, settingsProps));
  const select = await waitFor(() => within(container).getByRole("combobox", { name: "Agent message approval" }));
  assert.equal(select.disabled, true);
  assert.equal(select.textContent, "Unavailable");
  pending.resolve(new Response(null, { status: 503 }));
  await settle();
  assert.equal(select.disabled, true);
  assert.equal(select.textContent, "Unavailable");
});

test("an uncertain agent message approval save reloads the committed policy", async (t) => {
  let saveAttempted = false;
  let loadsAfterSave = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "/api/web-settings") return Response.json({});
    if (init?.method === "PUT") {
      saveAttempted = true;
      throw new TypeError("Failed to fetch");
    }
    if (saveAttempted) loadsAfterSave++;
    return Response.json({ agentMessagePermission: saveAttempted ? "trustCluster" : "alwaysAsk" });
  };
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const select = within(container).getByRole("combobox", { name: "Agent message approval" });
  await choose(select, "Trust cluster");
  assert.equal(saveAttempted, true);
  assert.ok(loadsAfterSave > 0);
  assert.equal(select.disabled, false);
  assert.equal(select.textContent, "Trust cluster");
});
