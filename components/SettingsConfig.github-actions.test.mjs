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

function installFetch(t, get) {
  const puts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "/api/web-settings") return Response.json({});
    if (init?.method === "PUT") {
      const pending = Promise.withResolvers();
      puts.push({ body: init.body, ...pending });
      return pending.promise;
    }
    return get();
  };
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });
  return puts;
}

test("GitHub Actions permission controls stay disabled until their settings load", async (t) => {
  const pending = Promise.withResolvers();
  installFetch(t, () => pending.promise.then(() => Response.json({ githubActionsPermissions: { dispatch: "ask", cancel: "ask", rerun: "ask" } })));
  const { container } = render(createElement(SettingsConfig, settingsProps));
  const page = within(container);
  const selects = [
    page.getByRole("combobox", { name: "Dispatch workflows" }),
    page.getByRole("combobox", { name: "Cancel workflow runs" }),
    page.getByRole("combobox", { name: "Rerun workflow runs" }),
  ];
  assert.ok(selects.every((select) => select.disabled));
  pending.resolve();
  await settle();
  assert.ok(selects.every((select) => !select.disabled));
});

test("GitHub Actions permissions load as three selects and save only the changed operation", async (t) => {
  const puts = installFetch(t, () => Response.json({
    githubActionsPermissions: { dispatch: "ask", cancel: "deny", rerun: "allow" },
  }));
  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const page = within(container);
  const dispatch = page.getByRole("combobox", { name: "Dispatch workflows" });
  assert.equal(dispatch.textContent, "Ask each time");
  assert.equal(page.getByRole("combobox", { name: "Cancel workflow runs" }).textContent, "Blocked");
  assert.equal(page.getByRole("combobox", { name: "Rerun workflow runs" }).textContent, "Allow without asking");

  await choose(dispatch, "Allow without asking");
  assert.deepEqual(puts.map(({ body }) => body), ['{"githubActionsPermissions":{"dispatch":"allow"}}']);
  assert.equal(dispatch.disabled, true, "the control stays disabled while its save is in flight");
  puts[0].resolve(Response.json({ githubActionsPermissions: { dispatch: "allow", cancel: "allow", rerun: "deny" } }));
  await settle();
  assert.equal(dispatch.disabled, false);
  assert.equal(dispatch.textContent, "Allow without asking");
  assert.equal(page.getByRole("combobox", { name: "Cancel workflow runs" }).textContent, "Allow without asking");
  assert.equal(page.getByRole("combobox", { name: "Rerun workflow runs" }).textContent, "Blocked");
});

test("an uncertain GitHub Actions save re-fetches disk state and never presents the unsaved choice as successful", async (t) => {
  let persisted = { dispatch: "ask", cancel: "ask", rerun: "ask" };
  let loads = 0;
  const puts = installFetch(t, () => {
    loads++;
    return Response.json({ githubActionsPermissions: persisted });
  });
  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const dispatch = within(container).getByRole("combobox", { name: "Dispatch workflows" });

  await choose(dispatch, "Allow without asking");
  const previousLoads = loads;
  puts[0].reject(new TypeError("Failed to fetch"));
  await settle();
  assert.ok(loads > previousLoads);
  assert.equal(dispatch.textContent, "Ask each time");

  persisted = null;
  await choose(dispatch, "Blocked");
  puts[1].reject(new TypeError("Failed to fetch"));
  await settle();
  assert.equal(dispatch.disabled, true, "a failed reconciliation leaves the permission unknown");
});
