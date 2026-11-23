import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";

const { act, cleanup, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { ModelsConfig, providerInitials } = await import("./ModelsConfig.tsx");
const { RetryFallbackDetail } = await import("./ModelsConfig-panels.tsx");

afterEach(cleanup);

const runtimeModel = {
  provider: "openai-codex",
  id: "gpt-5.6-sol",
  name: "GPT 5.6 Sol",
  thinkingLevels: ["off", "low", "medium", "high"],
};

async function chooseFallback(user, effort) {
  await user.click(await screen.findByRole("combobox", { name: "Select a fallback model" }));
  await user.click(await screen.findByRole("option", { name: "openai-codex/gpt-5.6-sol" }));
  await user.click(screen.getByRole("combobox", { name: "Thinking levels" }));
  await user.click(await screen.findByRole("option", { name: effort }));
}

test("provider glyphs derive from arbitrary runtime provider ids", () => {
  assert.equal(providerInitials("acme-provider"), "AP");
  assert.equal(providerInitials("my_custom_gateway"), "MC");
  assert.equal(providerInitials("provider"), "P");
  assert.equal(providerInitials(""), "?");
});

test("fallback chains can select a model effort", async (t) => {
  const writes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(init.body));
      return Response.json(JSON.parse(init.body));
    }
    return Response.json({ settings: {} });
  });

  render(createElement(RetryFallbackDetail, { models: [runtimeModel] }));
  const user = userEvent.setup();
  await chooseFallback(user, "high");
  await user.click(screen.getByRole("button", { name: "Add" }));

  await waitFor(() => assert.deepEqual(
    writes.at(-1).settings.retry.fallbackChains.default,
    ["openai-codex/gpt-5.6-sol:high"],
  ));
});

test("fallback chains expose the runtime off effort", async (t) => {
  const writes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(init.body));
      return Response.json(JSON.parse(init.body));
    }
    return Response.json({ settings: {} });
  });

  render(createElement(RetryFallbackDetail, { models: [runtimeModel] }));
  const user = userEvent.setup();
  await chooseFallback(user, "off");
  await user.click(screen.getByRole("button", { name: "Add" }));

  await waitFor(() => assert.deepEqual(
    writes.at(-1).settings.retry.fallbackChains.default,
    ["openai-codex/gpt-5.6-sol:off"],
  ));
});

test("fallback chains allow an effort variant after the model default", async (t) => {
  const writes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(init.body));
      return Response.json(JSON.parse(init.body));
    }
    return Response.json({ settings: { retry: { fallbackChains: { default: ["openai-codex/gpt-5.6-sol"] } } } });
  });

  render(createElement(RetryFallbackDetail, { models: [runtimeModel] }));
  const user = userEvent.setup();
  await chooseFallback(user, "high");
  await user.click(screen.getByRole("button", { name: "Add" }));

  await waitFor(() => assert.deepEqual(
    writes.at(-1).settings.retry.fallbackChains.default,
    ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-sol:high"],
  ));
});

test("fallback chains reject an exact duplicate selector", async (t) => {
  const writes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(init.body));
      return Response.json(JSON.parse(init.body));
    }
    return Response.json({ settings: { retry: { fallbackChains: { default: ["openai-codex/gpt-5.6-sol:high"] } } } });
  });

  render(createElement(RetryFallbackDetail, { models: [runtimeModel] }));
  const user = userEvent.setup();
  await chooseFallback(user, "high");

  assert.equal(screen.getByRole("button", { name: "Add" }).disabled, true);
  assert.deepEqual(writes, []);
});

test("a failed fallback save restores the confirmed chain", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init?.method === "PUT") return Response.json({ error: "save failed" }, { status: 500 });
    return Response.json({ settings: {} });
  });

  render(createElement(RetryFallbackDetail, { models: [runtimeModel] }));
  const user = userEvent.setup();
  await chooseFallback(user, "high");
  await user.click(screen.getByRole("button", { name: "Add" }));

  await screen.findByRole("alert");
  assert.equal(screen.queryByText("openai-codex/gpt-5.6-sol:high"), null);
  assert.ok(screen.getByText("No explicit chain. OMP uses the default chain when available."));
});

test("focusProvider waits for OAuth list to settle before selecting apikey", async (t) => {
  let resolveOauth;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url === "/api/auth/providers") {
      return await new Promise((resolve) => {
        resolveOauth = () => resolve(Response.json({ providers: [{ id: "anthropic", name: "Anthropic", loggedIn: false }] }));
      });
    }
    if (url === "/api/auth/all-providers") {
      return Response.json({ providers: [{ id: "anthropic", name: "Anthropic", configured: true }] });
    }
    if (url === "/api/models-config") return Response.json({ providers: {} });
    if (url === "/api/models") return Response.json({ modelList: [], connectedProviders: [] });
    return Response.json({});
  });

  await act(async () => {
    render(createElement(ModelsConfig, { onClose: () => {}, embedded: true, focusProvider: { id: "anthropic" } }));
    await new Promise((r) => setTimeout(r, 30));
  });
  assert.equal(screen.queryByText("API Key"), null, "must not select apikey before oauth list settles");

  await act(async () => {
    resolveOauth();
  });
  await screen.findByText("Subscription");
});
