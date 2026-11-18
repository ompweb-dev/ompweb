import assert from "node:assert/strict";
import test from "node:test";

const { summarizeProviderAccounts, planForStoredAccount } = await import("./provider-accounts.ts");

test("distinct accounts are listed once even when usage is split per model/tier", () => {
  const reports = [
    { provider: "anthropic", accountLabel: "a@x.test", plan: "max" },
    { provider: "anthropic", accountLabel: "a@x.test", modelId: "opus" },
    { provider: "anthropic", accountLabel: "b@x.test" },
    { provider: "openai", accountLabel: "other@x.test" },
  ];
  assert.deepEqual(
    summarizeProviderAccounts(reports, "anthropic").map((a) => [a.label, a.plan]),
    [["a@x.test", "max"], ["b@x.test", undefined]],
  );
});

test("accounts without a label are told apart by their position", () => {
  const reports = [
    { provider: "p", accountIndex: 1 },
    { provider: "p", accountIndex: 2, noLimits: true },
    { provider: "p", accountIndex: 1, modelId: "m" },
  ];
  assert.deepEqual(summarizeProviderAccounts(reports, "p").map((a) => a.index), [1, 2]);
  assert.deepEqual(summarizeProviderAccounts(reports, "none"), []);
});

test("a usage plan is shown only for the one stored account its email identifies", () => {
  const usage = [{ key: "a@x.test", label: "a@x.test", plan: "max" }, { key: "b@x.test", label: "b@x.test", plan: "pro" }];
  const single = ["a@x.test (Org A)", "b@x.test"];
  assert.equal(planForStoredAccount("a@x.test (Org A)", single, usage), "max");
  assert.equal(planForStoredAccount("b@x.test", single, usage), "pro");
  // One email in two orgs: the bare-email usage row cannot tell them apart.
  const shared = ["a@x.test (Org A)", "a@x.test (Org B)"];
  assert.equal(planForStoredAccount("a@x.test (Org A)", shared, usage), undefined);
  assert.equal(planForStoredAccount("a@x.test.evil", ["a@x.test.evil"], usage), undefined);
});

const { withAccountPolicy } = await import("./provider-accounts.ts");

test("withAccountPolicy adds, updates and clears one field without touching other policies", () => {
  const a = { email: "a@x.test", accountId: "acc-a", orgId: "org-a" };
  const b = { email: "b@x.test", accountId: "acc-b" };
  const other = { provider: "openai-codex", account: { email: "a@x.test" }, priority: 5 };

  const added = withAccountPolicy([other], "anthropic", a, [a, b], "reservePct", 20);
  assert.deepEqual(added, [other, { provider: "anthropic", account: { email: "a@x.test", orgId: "org-a" }, reservePct: 20 }]);

  const both = withAccountPolicy(added, "anthropic", a, [a, b], "priority", 1);
  assert.deepEqual(both[1], { provider: "anthropic", account: { email: "a@x.test", orgId: "org-a" }, reservePct: 20, priority: 1 }, "one policy carries both fields");

  assert.deepEqual(withAccountPolicy(both, "anthropic", a, [a, b], "reservePct", null)[1], { provider: "anthropic", account: { email: "a@x.test", orgId: "org-a" }, priority: 1 });
  assert.deepEqual(withAccountPolicy(added, "anthropic", a, [a, b], "reservePct", null), [other], "a policy left with only its selector goes");
});

test("withAccountPolicy names an account apart from a sibling sharing its email and org", () => {
  const seat1 = { email: "team@x.test", accountId: "seat-1", orgId: "org" };
  const seat2 = { email: "team@x.test", accountId: "seat-2", orgId: "org" };
  assert.deepEqual(withAccountPolicy([], "openai-codex", seat2, [seat1, seat2], "priority", 1)[0].account, { email: "team@x.test", accountId: "seat-2", orgId: "org" });
  assert.throws(() => withAccountPolicy([], "openai-codex", seat1, [seat1, { ...seat1 }], "priority", 1), /same identity/);
});

test("withAccountPolicy refuses a reserve at or above reclaimAbovePct, including on clear", () => {
  const a = { email: "a@x.test" };
  const policies = [{ provider: "anthropic", account: { email: "a@x.test" }, reservePct: 5, reclaimAbovePct: 10 }];
  assert.throws(() => withAccountPolicy(policies, "anthropic", a, [a], "reservePct", 50), /reclaimAbovePct/);
  assert.throws(() => withAccountPolicy(policies, "anthropic", a, [a], "reservePct", null, 10), /reclaimAbovePct/);
  assert.throws(() => withAccountPolicy([{ provider: "anthropic", account: { email: "a@x.test" }, reservePct: 10, reclaimAbovePct: 20 }], "anthropic", a, [a], "reservePct", null, 20), /reclaimAbovePct/);
  assert.deepEqual(
    withAccountPolicy([{ provider: "anthropic", account: { email: "a@x.test" }, reservePct: 20, reclaimAbovePct: 30 }], "anthropic", a, [a], "reservePct", null, 10),
    [{ provider: "anthropic", account: { email: "a@x.test" }, reclaimAbovePct: 30 }],
  );
  assert.equal(withAccountPolicy([{ provider: "anthropic", account: { email: "a@x.test" }, reclaimAbovePct: 40 }], "anthropic", a, [a], "reservePct", 30)[0].reservePct, 30);
});
