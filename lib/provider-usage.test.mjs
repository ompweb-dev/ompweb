import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseProviderUsageOutput, getProviderUsage } = await import("./provider-usage.ts");
test("parseProviderUsageOutput selects matching model windows", () => {
  const now = Date.UTC(2026, 7, 27, 12, 0, 0);
  const output = JSON.stringify({
    generatedAt: 123,
    reports: [
      {
        provider: "openai-codex",
        metadata: { email: "account@example.com", planType: "plus" },
        limits: [
          {
            scope: { modelId: "gpt-5.6-luna", windowId: "5h" },
            amount: { usedFraction: 0.09 },
            window: { resetsAt: now + (2 * 60 + 39) * 60_000 },
          },
          {
            scope: { modelId: "gpt-5.6-luna", windowId: "7d" },
            amount: { usedFraction: 0.04 },
            window: { resetsAt: now + (5 * 24 + 20) * 3_600_000 },
          },
          {
            scope: { modelId: "other-model", windowId: "5h" },
            amount: { usedFraction: 0.88 },
            window: { resetsAt: now + 60_000 },
          },
        ],
      },
      {
        provider: "ollama",
        limits: [
          {
            scope: { windowId: "5h" },
            amount: { usedFraction: 0.5 },
            window: { resetsAt: now + 60_000 },
          },
        ],
      },
    ],
  });

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "openai-codex", modelId: "GPT-5.6-LUNA" }, now), {
    generatedAt: 123,
    reports: [{
      provider: "openai-codex",
      accountLabel: "account@example.com",
      plan: "plus",
      modelId: "gpt-5.6-luna",
      fiveHour: { percent: 9, resetMinutes: 159 },
      sevenDay: { percent: 4, resetHours: 140 },
    }],
  });
});

test("parseProviderUsageOutput selects the binding meter for repeated windows", () => {
  const now = 1_000_000;
  const output = JSON.stringify({
    reports: [{
      provider: "provider",
      limits: [
        { scope: { modelId: "model", windowId: "5h" }, amount: { usedFraction: 0.1 }, window: { resetsAt: now + 60_000 } },
        { scope: { modelId: "model", windowId: "5h" }, amount: { usedFraction: 0.7 }, window: { resetsAt: now + 30 * 60_000 } },
      ],
    }],
  });

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "provider" }, now).reports[0]?.fiveHour, {
    percent: 70,
    resetMinutes: 30,
  });
});
test("parseProviderUsageOutput returns every model when no model is selected", () => {
  const output = JSON.stringify({
    reports: [{
      provider: "provider",
      metadata: { accountId: "account-1" },
      limits: [
        { scope: { modelId: "model-a", windowId: "5h" }, amount: { usedFraction: 0.1 }, window: {} },
        { scope: { modelId: "model-a", windowId: "7d" }, amount: { usedFraction: 0.2 }, window: {} },
        { scope: { modelId: "model-b", windowId: "5h" }, amount: { usedFraction: 0.3 }, window: {} },
      ],
    }],
  });

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "provider" }), {
    generatedAt: null,
    reports: [
      {
        provider: "provider",
        accountIndex: 1,
        modelId: "model-a",
        fiveHour: { percent: 10 },
        sevenDay: { percent: 20 },
      },
      {
        provider: "provider",
        accountIndex: 1,
        modelId: "model-b",
        fiveHour: { percent: 30 },
      },
    ],
  });
});

test("parseProviderUsageOutput keeps accounts without reported limits", () => {
  const output = JSON.stringify({
    reports: [{ provider: "ollama", metadata: { email: "ollama@example.com" }, limits: [] }],
  });

  assert.deepEqual(parseProviderUsageOutput(output), {
    generatedAt: null,
    reports: [{
      provider: "ollama",
      accountLabel: "ollama@example.com",
      noLimits: true,
    }],
  });
});

test("parseProviderUsageOutput retains Anthropic accounts without usage beside reported accounts", () => {
  const output = JSON.stringify({
    generatedAt: 1_000_000,
    reports: [{
      provider: "openai-codex",
      metadata: { email: "codex@example.com" },
      limits: [
        { scope: { modelId: "gpt-5", windowId: "5h" }, amount: { usedFraction: 0.2 }, window: {} },
        { scope: { modelId: "gpt-4", windowId: "5h" }, amount: { usedFraction: 0.4 }, window: {} },
      ],
    }],
    accountsWithoutUsage: [
      {
        provider: "anthropic",
        type: "oauth",
        email: "anthropic@example.com",
        accountId: "private-anthropic-id",
        metadata: { email: "private@example.com", planType: "private-plan", token: "private-token" },
      },
      { provider: "zai", type: "api_key", accountId: "private-zai-id" },
    ],
  });
  const anthropic = { provider: "anthropic", accountLabel: "anthropic@example.com", noLimits: true };
  const codex = {
    provider: "openai-codex",
    accountLabel: "codex@example.com",
    modelId: "gpt-5",
    fiveHour: { percent: 20 },
  };

  assert.deepEqual(parseProviderUsageOutput(output), {
    generatedAt: 1_000_000,
    reports: [
      codex,
      { ...codex, modelId: "gpt-4", fiveHour: { percent: 40 } },
      anthropic,
      { provider: "zai", accountIndex: 3, noLimits: true },
    ],
  });
  assert.deepEqual(parseProviderUsageOutput(output, { provider: "anthropic", modelId: "claude-sonnet-4" }).reports, [anthropic]);
  assert.deepEqual(parseProviderUsageOutput(output, { provider: "openai-codex", modelId: "GPT-5" }).reports, [codex]);
  assert.deepEqual(parseProviderUsageOutput(output, { provider: "unknown" }).reports, []);
});

test("parseProviderUsageOutput ignores malformed accounts without usage", () => {
  const output = JSON.stringify({
    accountsWithoutUsage: [
      null,
      [],
      "anthropic",
      {},
      { provider: null },
      { provider: 123 },
      { provider: "" },
      { provider: "   " },
      { provider: "anthropic", email: 123, type: "oauth", accountId: "private-id" },
    ],
  });

  assert.deepEqual(parseProviderUsageOutput(output), {
    generatedAt: null,
    reports: [{ provider: "anthropic", accountIndex: 9, noLimits: true }],
  });
  for (const accountsWithoutUsage of [null, {}, "anthropic"]) {
    assert.deepEqual(parseProviderUsageOutput(JSON.stringify({ accountsWithoutUsage })).reports, []);
  }
});

test("parseProviderUsageOutput retains multiple same-provider accounts without usage", () => {
  const output = JSON.stringify({
    reports: [{
      provider: "anthropic",
      metadata: { email: "shared@example.com" },
      limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.3 }, window: {} }],
    }],
    accountsWithoutUsage: [
      { provider: "anthropic", email: "shared@example.com", accountId: "different-account" },
      { provider: "anthropic", email: "second@example.com" },
      { provider: "anthropic", accountId: "unnamed-account" },
    ],
  });

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "anthropic" }).reports, [
    { provider: "anthropic", accountLabel: "shared@example.com", fiveHour: { percent: 30 } },
    { provider: "anthropic", accountLabel: "shared@example.com", noLimits: true },
    { provider: "anthropic", accountLabel: "second@example.com", noLimits: true },
    { provider: "anthropic", accountIndex: 4, noLimits: true },
  ]);
});

test("parseProviderUsageOutput falls back to duration and ignores malformed limits", () => {
  const now = 1_000_000;
  const output = JSON.stringify({
    generatedAt: "not-a-number",
    reports: [{
      provider: "provider",
      limits: [
        {
          scope: {},
          amount: { usedFraction: 0.12 },
          window: { durationMs: 30 * 24 * 60 * 60 * 1000, resetsAt: now + 48 * 3_600_000 },
        },
        { scope: { windowId: "5h" }, amount: { usedFraction: "bad" }, window: {} },
        { scope: { windowId: "unknown" }, amount: { usedFraction: 0.2 }, window: {} },
      ],
    }],
  });

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "provider" }, now), {
    generatedAt: null,
    reports: [{
      provider: "provider",
      accountIndex: 1,
      monthly: { percent: 12, resetHours: 48 },
    }],
  });
});

test("parseProviderUsageOutput rejects invalid JSON", () => {
  assert.throws(() => parseProviderUsageOutput("not-json"), /invalid JSON/);
});

test("manual refresh replaces cached limits while automatic reads keep using the cache", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ompweb-provider-usage-"));
  const bin = join(dir, "omp");
  const data = join(dir, "usage.json");
  const cache = join(dir, "cached-usage.json");
  const failOnce = join(dir, "fail-once");
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  const usage = (fraction) => JSON.stringify({
    reports: [{
      provider: "provider",
      limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: fraction }, window: {} }],
    }],
  });
  try {
    await writeFile(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const cache = ${JSON.stringify(cache)};
const failOnce = ${JSON.stringify(failOnce)};
if (process.argv.includes("--redact")) {
  // Redaction turns account emails into "an*" in the sidebar.
  process.exit(2);
} else if (process.argv[3] === "invalidate") {
  fs.rmSync(cache, { force: true });
} else if (fs.existsSync(failOnce)) {
  fs.rmSync(failOnce);
  setTimeout(() => process.exit(1), 100);
} else {
  if (!fs.existsSync(cache)) fs.copyFileSync(${JSON.stringify(data)}, cache);
  process.stdout.write(fs.readFileSync(cache, "utf8"));
}
`, { mode: 0o755 });
    process.env.OMP_WEB_OMP_BIN = bin;
    await writeFile(data, usage(0.1));
    await writeFile(failOnce, "");
    const automatic = getProviderUsage();
    const manual = getProviderUsage({}, true);
    await Promise.all([
      assert.rejects(automatic),
      manual.then((report) => assert.equal(report.reports[0].fiveHour.percent, 10, "manual refresh must recover after an overlapping automatic fetch fails")),
    ]);
    await writeFile(data, usage(0.8));
    assert.equal((await getProviderUsage()).reports[0].fiveHour.percent, 10);
    assert.equal((await getProviderUsage({}, true)).reports[0].fiveHour.percent, 80);
    await writeFile(data, usage(0.4));
    assert.equal((await getProviderUsage()).reports[0].fiveHour.percent, 80);
  } finally {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseProviderUsageOutput keeps Anthropic's Fable tier separate from the shared row (#284)", () => {
  const now = 1_000_000;
  const output = JSON.stringify({
    reports: [{
      provider: "anthropic",
      metadata: { email: "user@example.com" },
      limits: [
        { scope: { windowId: "5h" }, amount: { usedFraction: 0.5 }, window: { resetsAt: now + 60_000 } },
        { scope: { windowId: "7d" }, amount: { usedFraction: 0.4 }, window: { resetsAt: now + 3_600_000 } },
        { scope: { windowId: "7d", tier: "fable" }, amount: { usedFraction: 0.77 }, window: { resetsAt: now + 3_600_000 } },
      ],
    }],
  });

  const { reports } = parseProviderUsageOutput(output, {}, now);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].tier, undefined);
  assert.equal(reports[0].bucket, undefined);
  assert.equal(reports[0].fiveHour.percent, 50);
  assert.equal(reports[0].sevenDay.percent, 40);
  assert.equal(reports[1].tier, "fable");
  assert.equal(reports[1].sevenDay.percent, 77);
  assert.equal(reports[1].fiveHour, undefined);
});

test("parseProviderUsageOutput keeps Antigravity's Gemini and shared Claude & GPT buckets separate (#284)", () => {
  const now = 1_000_000;
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const output = JSON.stringify({
    reports: [{
      provider: "google-antigravity",
      limits: [
        { id: "google-antigravity:google:default:weekly", label: "Gemini", scope: { windowId: "weekly" }, amount: { usedFraction: 0.8 }, window: { durationMs: weekMs, resetsAt: now + weekMs } },
        // omp duplicates the shared third-party bucket into anthropic/openai
        // counter ids; it is still one bucket, not two.
        { id: "google-antigravity:anthropic:default:weekly", label: "Claude & GPT (shared)", scope: { windowId: "weekly", shared: true }, amount: { usedFraction: 0.35 }, window: { durationMs: weekMs, resetsAt: now + weekMs } },
        { id: "google-antigravity:openai:default:weekly", label: "Claude & GPT (shared)", scope: { windowId: "weekly", shared: true }, amount: { usedFraction: 0.35 }, window: { durationMs: weekMs, resetsAt: now + weekMs } },
      ],
    }],
  });

  const { reports } = parseProviderUsageOutput(output, {}, now);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].bucket, "Gemini");
  assert.equal(reports[0].sevenDay.percent, 80);
  assert.equal(reports[1].bucket, "Claude & GPT (shared)");
  assert.equal(reports[1].sevenDay.percent, 35);
});

test("model-filtered Antigravity queries keep both buckets, not just the first (#284, CodeRabbit)", () => {
  const now = 1_000_000;
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const output = JSON.stringify({
    reports: [{
      provider: "google-antigravity",
      limits: [
        { id: "google-antigravity:google:default:weekly", label: "Gemini", scope: { windowId: "weekly" }, amount: { usedFraction: 0.8 }, window: { durationMs: weekMs, resetsAt: now + weekMs } },
        { id: "google-antigravity:anthropic:default:weekly", label: "Claude & GPT (shared)", scope: { windowId: "weekly", shared: true }, amount: { usedFraction: 0.35 }, window: { durationMs: weekMs, resetsAt: now + weekMs } },
      ],
    }],
  });

  // Neither limit carries a scoped modelId, so both survive the model
  // filter — and both buckets must survive selection, not just Gemini.
  const { reports } = parseProviderUsageOutput(output, { modelId: "some-model" }, now);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].bucket, "Gemini");
  assert.equal(reports[1].bucket, "Claude & GPT (shared)");
});

test("parseProviderUsageOutput reads Antigravity buckets from Usage (...) labels and id counters (#284)", () => {
  const now = 1_000_000;
  const output = JSON.stringify({
    reports: [{
      provider: "google-antigravity",
      limits: [
        { id: "google-antigravity:google:default:7d", label: "Usage (Google)", scope: { windowId: "7d" }, amount: { usedFraction: 0.6 }, window: { resetsAt: now + 3_600_000 } },
        { id: "google-antigravity:anthropic:default:7d", label: "Usage (Anthropic)", scope: { windowId: "7d" }, amount: { usedFraction: 0.2 }, window: { resetsAt: now + 3_600_000 } },
        { id: "google-antigravity:google:default:5h", scope: { windowId: "5h" }, amount: { usedFraction: 0.1 }, window: { resetsAt: now + 60_000 } },
      ],
    }],
  });

  const { reports } = parseProviderUsageOutput(output, {}, now);
  // The unlabelled id-counter limit joins the Gemini bucket's 7d report
  // (same bucket, different window), it does not invent a third bucket.
  // "Usage (Google)" is unified to "Gemini", the quota-summary name for
  // the same counter.
  assert.equal(reports.length, 2);
  assert.equal(reports[0].bucket, "Gemini");
  assert.equal(reports[0].sevenDay.percent, 60);
  assert.equal(reports[0].fiveHour.percent, 10);
  assert.equal(reports[1].bucket, "Anthropic");
  assert.equal(reports[1].sevenDay.percent, 20);
});

const { parseProviderUsageAccounts } = await import("./provider-usage.ts");

const limit = (windowId, usedFraction, scope = {}) => ({ scope: { windowId, ...scope }, amount: { usedFraction }, window: {} });

test("parseProviderUsageAccounts merges an account's buckets and keeps the highest per window", () => {
  const output = JSON.stringify({
    reports: [
      {
        provider: "anthropic",
        metadata: { email: "a@x.test", orgId: "org-a" },
        limits: [limit("7d", 0.8, { shared: true }), limit("7d", 0.92, { tier: "fable" })],
      },
      {
        provider: "antigravity-acp",
        metadata: {},
        limits: [
          limit("7d", 0.54, { tier: "Gemini Models", modelId: "gemini-4-hydrogen" }),
          limit("7d", 0.54, { tier: "Gemini Models", modelId: "gemini-3.8-flash" }),
          limit("5h", 0, { tier: "Claude and GPT models" }),
          limit("7d", 1, { tier: "Gemini 4 Argon", modelId: "gemini-4-argon" }),
        ],
      },
    ],
  });
  const { accounts } = parseProviderUsageAccounts(output, null, []);
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].sevenDay.percent, 92);
  assert.deepEqual(accounts[0].buckets.map((bucket) => bucket.label), [undefined, "Fable"]);
  assert.equal(accounts[0].credentialId, undefined, "nothing is changeable without the runner's account list");
  // The two Gemini models draw on one quota: listed once.
  assert.deepEqual(accounts[1].buckets.map((bucket) => bucket.label), ["Gemini Models", "Claude and GPT models", "Gemini 4 Argon"]);
  assert.equal(accounts[1].fiveHour.percent, 0);
  assert.equal(accounts[1].sevenDay.percent, 100);
});

test("parseProviderUsageAccounts attaches stored accounts, limits and paused accounts", () => {
  const output = JSON.stringify({
    reports: [
      { provider: "anthropic", metadata: { email: "a@x.test", orgId: "org-a" }, limits: [limit("7d", 0.5)] },
      { provider: "anthropic", metadata: { email: "a@x.test", orgId: "org-b" }, limits: [limit("7d", 0.6)] },
      // Fetched before b@x.test was paused.
      { provider: "anthropic", metadata: { email: "b@x.test" }, limits: [limit("7d", 0.1)] },
      { provider: "github-copilot", metadata: { accountId: "gh-login" }, limits: [limit("monthly", 1.01)] },
    ],
  });
  const stored = [
    { credentialId: 8, provider: "anthropic", email: "a@x.test", orgId: "org-b", paused: false },
    { credentialId: 7, provider: "anthropic", email: "a@x.test", orgId: "org-a", paused: false },
    { credentialId: 9, provider: "anthropic", email: "b@x.test", paused: true },
    // Copilot credentials carry no identity.
    { credentialId: 4, provider: "github-copilot", paused: false },
  ];
  const policies = [
    { provider: "anthropic", account: { email: "a@x.test", orgId: "org-b" }, reservePct: 20, priority: 1 },
    { provider: "anthropic", account: { email: "b@x.test" }, reservePct: 40 },
  ];
  const { accounts } = parseProviderUsageAccounts(output, stored, policies);
  assert.deepEqual(
    accounts.map((account) => [account.provider, account.credentialId, account.limitPercent, account.paused ?? false, account.canLimit, account.priority]),
    [
      ["anthropic", 7, undefined, false, true, undefined],
      ["anthropic", 8, 80, false, true, 1],
      ["github-copilot", 4, undefined, false, false, undefined],
      ["anthropic", 9, 60, true, undefined, undefined],
    ],
  );
  assert.equal(accounts[3].accountLabel, "b@x.test");
});

test("parseProviderUsageAccounts keys accounts by credential, else by label or omp's position", () => {
  const output = JSON.stringify({
    reports: [
      { provider: "anthropic", metadata: { email: "a@x.test" }, limits: [limit("7d", 0.5)] },
      { provider: "antigravity-acp", metadata: {}, limits: [limit("7d", 0.5)] },
      { provider: "openai-codex", metadata: { email: "c@x.test" }, limits: [limit("7d", 0.5)] },
    ],
  });
  const stored = [{ credentialId: 7, provider: "anthropic", email: "a@x.test", paused: false }];
  assert.deepEqual(
    parseProviderUsageAccounts(output, stored, []).accounts.map((account) => account.key),
    ["anthropic:7", "antigravity-acp:#2", "openai-codex:c@x.test"],
  );
});

test("parseProviderUsageAccounts does not pair a sole report with a conflicting stored identity", () => {
  const diffEmail = JSON.stringify({
    reports: [{ provider: "anthropic", metadata: { email: "a@x.test", orgId: "org-a" }, limits: [limit("7d", 0.5)] }],
  });
  const storedDiffEmail = [{ credentialId: 7, provider: "anthropic", email: "b@x.test", orgId: "org-a", paused: false }];
  assert.equal(parseProviderUsageAccounts(diffEmail, storedDiffEmail, []).accounts[0].credentialId, undefined);

  const diffOrg = JSON.stringify({
    reports: [{ provider: "anthropic", metadata: { email: "a@x.test", orgId: "org-a" }, limits: [limit("7d", 0.5)] }],
  });
  const storedDiffOrg = [{ credentialId: 8, provider: "anthropic", email: "a@x.test", orgId: "org-b", paused: false }];
  assert.equal(parseProviderUsageAccounts(diffOrg, storedDiffOrg, []).accounts[0].credentialId, undefined);
});

const { invalidateUsageCache } = await import("./provider-usage.ts");

test("invalidateUsageCache fences an in-flight usage fetch from populating the cache later", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ompweb-provider-usage-fence-"));
  const bin = join(dir, "omp");
  const marker = join(dir, "slow-once");
  const started = join(dir, "slow-started");
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  try {
    invalidateUsageCache();
    await writeFile(marker, "");
    await writeFile(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const marker = ${JSON.stringify(marker)};
const started = ${JSON.stringify(started)};
const report = (pct) => JSON.stringify({ reports: [{ provider: "p", limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: pct }, window: {} }] }] });
if (fs.existsSync(marker)) {
  fs.rmSync(marker);
  fs.writeFileSync(started, "");
  setTimeout(() => process.stdout.write(report(0.1)), 150);
} else {
  process.stdout.write(report(0.8));
}
`, { mode: 0o755 });
    process.env.OMP_WEB_OMP_BIN = bin;
    const stale = getProviderUsage();
    const deadline = Date.now() + 2000;
    const { existsSync } = await import("node:fs");
    while (!existsSync(started) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(existsSync(started), true, "slow fetch should have started");
    invalidateUsageCache();
    const fresh = await getProviderUsage();
    assert.equal(fresh.reports[0].fiveHour.percent, 80, "post-invalidation read must not join the pre-invalidation fetch");
    assert.equal((await stale).reports[0].fiveHour.percent, 10);
    assert.equal((await getProviderUsage()).reports[0].fiveHour.percent, 80, "stale fetch completing late must not overwrite the cache");
  } finally {
    invalidateUsageCache();
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
    await rm(dir, { recursive: true, force: true });
  }
});

test("account route keeps credential identities and actions through quota failures and logout", { skip: process.platform === "win32" }, async (t) => {
  const { GET, PATCH } = await import("../app/api/provider-usage/accounts/route.ts");
  const { DELETE } = await import("../app/api/auth/accounts/[provider]/route.ts");
  const { RpcCommandError } = await import("./omp/rpc-process.ts");
  const dir = await mkdtemp(join(tmpdir(), "ompweb-usage-accounts-"));
  const bin = join(dir, "omp");
  const output = join(dir, "usage.json");
  const url = "http://localhost/api/provider-usage/accounts";
  const oldBin = process.env.OMP_WEB_OMP_BIN;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldUtility = globalThis.__ompUtilityRpcState;
  let accounts = [
    { provider: "anthropic", credentialId: 1, email: "first@x.test", paused: false },
    { provider: "anthropic", credentialId: 2, email: "second@x.test", paused: false },
    { provider: "openai-codex", credentialId: 3, email: "codex@x.test", accountId: "codex-account", paused: false },
    { provider: "antigravity-acp", credentialId: 4, email: "antigravity@x.test", paused: false },
  ];
  let listError;
  const utility = {
    proc: {
      isAlive: true,
      sendCommand: async ({ type, credentialId, paused }) => {
        if (type === "get_usage_accounts") {
          if (listError) throw listError;
          return { accounts };
        }
        if (type === "set_account_paused") {
          accounts = accounts.map((row) => row.credentialId === credentialId ? { ...row, paused } : row);
          return {};
        }
        if (type === "logout") {
          accounts = accounts.filter((row) => row.credentialId !== credentialId);
          return {};
        }
        throw new Error(`Unexpected command: ${type}`);
      },
    },
    idleTimer: null,
    queue: Promise.resolve(),
  };
  t.after(async () => {
    invalidateUsageCache();
    clearTimeout(utility.idleTimer);
    globalThis.__ompUtilityRpcState = oldUtility;
    if (oldBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = oldBin;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(dir, { recursive: true, force: true });
  });
  process.env.OMP_WEB_OMP_BIN = bin;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__ompUtilityRpcState = utility;
  invalidateUsageCache();
  await writeFile(join(dir, "omp-web-settings.json"), JSON.stringify({ accountNames: { "anthropic:1": "First Claude" } }));
  await writeFile(bin, `#!/usr/bin/env node
if (process.argv[3] === "--json") process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(output)}));
`, { mode: 0o755 });
  const first = { provider: "anthropic", metadata: { email: "first@x.test" }, limits: [limit("7d", 0.42)] };
  const codex = { provider: "openai-codex", limits: [limit("7d", 0.17, { accountId: "codex-account" })] };
  await writeFile(output, JSON.stringify({ reports: [first, codex] }));

  const get = async (suffix = "") => {
    const response = await GET(new Request(url + suffix));
    assert.equal(response.status, 200);
    const body = await response.json();
    return { ...body, byKey: new Map(body.accounts.map((row) => [row.key, row])) };
  };
  const pause = async (credentialId, paused) => {
    const response = await PATCH(new Request(url, { method: "PATCH", body: JSON.stringify({ provider: "anthropic", credentialId, paused }) }));
    assert.equal(response.status, 200);
  };
  const initial = (await get()).byKey;
  assert.equal(initial.size, 4);
  assert.equal(initial.get("anthropic:1").name, "First Claude");
  assert.equal(initial.get("anthropic:1").sevenDay.percent, 42);
  assert.equal(initial.get("anthropic:2").credentialId, 2, "a missing report does not remove a stored account");
  assert.equal(initial.get("openai-codex:3").accountLabel, "codex@x.test", "a report without an email uses the stored identity");
  assert.equal(initial.get("antigravity-acp:4").accountLabel, "antigravity@x.test");
  assert.equal(initial.get("antigravity-acp:4").sevenDay, undefined);

  await writeFile(output, "invalid usage output");
  await pause(1, true);
  await pause(2, true);
  const unavailable = await get("?refresh=true");
  assert.equal(unavailable.usageUnavailable, true);
  assert.equal(unavailable.byKey.size, 4);
  for (const id of [1, 2]) assert.equal(unavailable.byKey.get(`anthropic:${id}`).paused, true);
  assert.equal(unavailable.byKey.get("anthropic:1").name, "First Claude");
  assert.equal(unavailable.byKey.get("anthropic:1").sevenDay, undefined);
  await pause(1, false);
  assert.equal((await get()).byKey.get("anthropic:1").paused, false);

  await writeFile(output, JSON.stringify({ reports: [first, codex] }));
  assert.equal((await get()).byKey.get("anthropic:1").sevenDay.percent, 42, "failed payloads are not cached");
  accounts = accounts.filter((row) => row.credentialId !== 3);
  await writeFile(output, JSON.stringify({ reports: [first] }));
  assert.equal((await get()).accounts.some((row) => row.provider === "openai-codex"), false, "an external logout invalidates the cached report");
  const logout = await DELETE(new Request("http://localhost/api/auth/accounts/anthropic?credentialId=1", { method: "DELETE" }), {
    params: Promise.resolve({ provider: "anthropic" }),
  });
  assert.equal(logout.status, 200);
  await writeFile(output, JSON.stringify({ reports: [] }));
  assert.deepEqual((await get()).accounts.map((row) => row.key), ["anthropic:2", "antigravity-acp:4"]);

  listError = new Error("inventory temporarily unavailable");
  assert.equal((await GET(new Request(url))).status, 502, "transport failure is not a legacy runner");
  listError = new RpcCommandError("get_usage_accounts", "unknown command: get_usage_accounts");
  await writeFile(output, JSON.stringify({ reports: [codex] }));
  assert.deepEqual((await get("?refresh=true")).accounts.map((row) => [row.provider, row.credentialId]), [["openai-codex", undefined]]);
});
