import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";

const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react/pure.js");
const { ProviderUsageBar } = await import("./ProviderUsageBar.tsx");
const { PROVIDER_ACCOUNTS_CHANGED } = await import("./AppShell-provider-usage.ts");

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function makeSnapshot(overrides = {}) {
  return {
    generatedAt: 1_700_000_000_000,
    defaultLimitPercent: 80,
    accounts: [
      {
        key: "anthropic:1",
        provider: "anthropic",
        accountLabel: "main@x.test",
        name: "Main Claude",
        credentialId: 1,
        limitPercent: 60,
        canLimit: true,
        canPrioritize: true,
        sevenDay: { percent: 70 },
      },
      {
        key: "anthropic:2",
        provider: "anthropic",
        accountLabel: "second@x.test",
        name: "Second Claude",
        credentialId: 2,
        priority: 1,
        canLimit: true,
        canPrioritize: true,
        sevenDay: { percent: 70 },
      },
      {
        key: "antigravity-acp:3",
        provider: "antigravity-acp",
        accountLabel: "google@x.test",
        name: "Google Default",
        credentialId: 3,
        canLimit: true,
        canPrioritize: true,
        sevenDay: { percent: 70 },
      },
      {
        key: "github-copilot:4",
        provider: "github-copilot",
        accountLabel: "gh@x.test",
        name: "Paused Copilot",
        credentialId: 4,
        paused: true,
        canPrioritize: true,
      },
    ],
    ...overrides,
  };
}

test("collapsed rows show only non-default icons, turn into buttons when expanded, and apply default limit to meters", async (t) => {
  window.localStorage.setItem("omp-web:provider-usage-collapsed", "false");
  const snapshot = makeSnapshot();
  t.mock.method(globalThis, "fetch", async () => Response.json(snapshot));

  const opened = [];
  render(createElement(ProviderUsageBar, { onOpenProvider: (provider) => opened.push(provider) }));

  const mainRow = (await screen.findByText("Main Claude")).closest("[role='button']");
  const secondRow = screen.getByText("Second Claude").closest("[role='button']");
  const googleRow = screen.getByText("Google Default").closest("[role='button']");
  const copilotRow = screen.getByText("Paused Copilot").closest("[role='button']");

  // Non-default badges appear only on rows with non-default state when collapsed.
  assert.ok(mainRow.textContent.includes("≤60%"));
  assert.ok(secondRow.querySelector("[aria-label='Preferred']"));
  assert.equal(googleRow.querySelector("[aria-label='Preferred']"), null);
  assert.equal(googleRow.querySelector("[aria-label='Paused']"), null);
  assert.ok(!googleRow.textContent.includes("≤80%"));
  assert.ok(copilotRow.querySelector("[aria-label='Paused']"));

  // Default limit (80%) is applied to compact meters for accounts without an explicit override:
  // at 70% usage, 70 / 80 = 87.5% (>= 80% -> error tone) and an 80% marker is rendered.
  const googleCompactMarker = googleRow.querySelector("[aria-hidden='true'][style*='left: 80%']");
  assert.ok(googleCompactMarker, "compact meter should show the effective default limit marker (80%)");
  assert.ok(googleRow.innerHTML.includes("var(--status-error)"), "70% of an 80% default limit should render error tone");

  // Expanding Main Claude hides its header badge (no duplicate) and exposes interactive buttons + settings on the right.
  fireEvent.click(mainRow, { detail: 1 });
  await waitFor(() => assert.equal(mainRow.getAttribute("aria-expanded"), "true"));

  const mainCard = mainRow.parentElement;
  const headerBadges = mainRow.querySelector(".provider-usage-badges");
  assert.equal(headerBadges.getAttribute("aria-hidden"), "true");

  // Detail meter for Second Claude (no override) also uses defaultLimit (80%) while its selector keeps "default".
  fireEvent.click(secondRow, { detail: 1 });
  await waitFor(() => assert.equal(secondRow.getAttribute("aria-expanded"), "true"));
  const secondCard = secondRow.parentElement;
  assert.ok(secondCard.querySelector(".accordion-flow.is-open [style*='left: 80%']"), "detail meter should show effective default limit marker");
  const limitTrigger = within(secondCard).getByRole("combobox", { name: "Usage limit for Second Claude" });
  assert.ok(limitTrigger.textContent.includes("≤80% (default)"), "limit selector stays on default");

  const settingsBtn = [...secondCard.querySelectorAll("button")].find((btn) => btn.getAttribute("aria-label") === "Open in API Keys & Providers");
  assert.ok(settingsBtn, `settings button shows when expanded; found buttons: ${[...secondCard.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")).join(", ")}`);
  fireEvent.click(settingsBtn);
  assert.deepEqual(opened, ["anthropic"]);
  assert.ok(mainCard);
});

test("Alt+ArrowUp/Down reorders accounts and serializes concurrent order saves", async (t) => {
  window.localStorage.setItem("omp-web:provider-usage-collapsed", "false");
  let snapshot = makeSnapshot();
  const patchResolvers = [];
  const postedOrders = [];

  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === "/api/provider-usage/accounts" && init?.method === "PATCH") {
      const body = JSON.parse(init.body);
      postedOrders.push(body.order);
      return await new Promise((resolve) => {
        patchResolvers.push(() => {
          const map = new Map(snapshot.accounts.map((a) => [a.key, a]));
          snapshot = { ...snapshot, accounts: body.order.map((k) => map.get(k)) };
          resolve(Response.json({ ok: true }));
        });
      });
    }
    return Response.json(snapshot);
  });

  render(createElement(ProviderUsageBar, {}));
  const googleRow = (await screen.findByText("Google Default")).closest("[role='button']");

  // Two rapid keyboard moves (index 2 -> 1 -> 0) before the first PATCH completes.
  await act(async () => {
    fireEvent.keyDown(googleRow, { key: "ArrowUp", altKey: true });
  });
  // Row moved up in localOrder; move it up again to the top.
  const googleRowAfterFirst = screen.getByText("Google Default").closest("[role='button']");
  await act(async () => {
    fireEvent.keyDown(googleRowAfterFirst, { key: "ArrowUp", altKey: true });
  });

  // Only the first PATCH should be in flight while the second waits in the queue.
  assert.equal(postedOrders.length, 1);
  assert.deepEqual(postedOrders[0], ["anthropic:1", "antigravity-acp:3", "anthropic:2", "github-copilot:4"]);

  await act(async () => {
    patchResolvers.shift()();
    await new Promise((r) => setTimeout(r, 10));
  });
  assert.equal(postedOrders.length, 2);
  assert.deepEqual(postedOrders[1], ["antigravity-acp:3", "anthropic:1", "anthropic:2", "github-copilot:4"]);

  await act(async () => {
    patchResolvers.shift()();
    await new Promise((r) => setTimeout(r, 20));
  });

  const renderedNames = [...document.querySelectorAll(".provider-usage-row")].map((el) => el.textContent);
  assert.ok(renderedNames[0].includes("Google Default"), "final order should reflect the latest move");
});

test("paused accounts can be resumed during a quota outage and logout reloads the list", async (t) => {
  window.localStorage.setItem("omp-web:provider-usage-collapsed", "false");
  const paused = makeSnapshot().accounts.slice(0, 2).map((account) => ({
    ...account, sevenDay: undefined, paused: true, canLimit: false,
  }));
  let accounts = paused;
  let rosterUnavailable = false;
  const changes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init?.method === "PATCH") {
      const change = JSON.parse(init.body);
      changes.push(change);
      accounts = accounts.map((account) => account.credentialId === change.credentialId ? { ...account, paused: change.paused } : account);
      return Response.json({ ok: true });
    }
    if (rosterUnavailable) return new Response(null, { status: 503 });
    return Response.json(makeSnapshot({ accounts, usageUnavailable: true, generatedAt: null }));
  });

  await act(async () => { render(createElement(ProviderUsageBar)); });
  const row = screen.getByText("Main Claude").closest("[role='button']");
  assert.ok(screen.getByText("Provider limits unavailable"));
  assert.ok(screen.getByText("Second Claude"));
  fireEvent.keyDown(row, { key: "Enter" });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resume Main Claude" })); });
  assert.ok(screen.getByRole("button", { name: "Pause Main Claude" }));
  assert.deepEqual(changes, [{ provider: "anthropic", credentialId: 1, paused: false }]);

  rosterUnavailable = true;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh" })); });
  assert.ok(screen.getByText("Main Claude"));
  assert.ok(screen.getByText("Provider limits unavailable"));
  rosterUnavailable = false;

  accounts = accounts.filter((account) => account.credentialId !== 1);
  await act(async () => { window.dispatchEvent(new window.Event(PROVIDER_ACCOUNTS_CHANGED)); });
  assert.equal(screen.queryByText("Main Claude"), null);
  assert.ok(screen.getByText("Second Claude"));
});
