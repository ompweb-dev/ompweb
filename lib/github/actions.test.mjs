import assert from "node:assert/strict";
import test from "node:test";
import { GhError } from "./gh.ts";

const { cancelRun, dispatchWorkflow, listRuns, listWorkflows, readWorkflow, rerunRun } = await import("./actions.ts");

function fake(responses) {
  const calls = [];
  const run = async (args, input) => {
    calls.push({ args, input });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response ?? "";
  };
  return { run, calls };
}

const workflow = {
  id: 42,
  node_id: "W_kwDOA",
  name: "Build supplied ref",
  path: ".github/workflows/build.yml",
  state: "active",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
  url: "https://api.github.com/repos/acme/widgets/actions/workflows/42",
  html_url: "https://github.com/acme/widgets/actions/workflows/build.yml",
  badge_url: "https://github.com/acme/widgets/actions/workflows/build.yml/badge.svg",
};

test("listWorkflows requests one 100-item page and reports bounded pagination", async () => {
  const { run, calls } = fake([JSON.stringify({ total_count: 201, workflows: [workflow] })]);
  const result = await listWorkflows(run, "acme/widgets", 2);

  assert.deepEqual(calls, [{ args: ["api", "repos/acme/widgets/actions/workflows?per_page=100&page=2"], input: undefined }]);
  assert.deepEqual(result.pagination, { page: 2, perPage: 100, totalCount: 201, totalPages: 3, hasNextPage: true });
  assert.deepEqual(result.workflows, [workflow]);
});

test("listRuns routes workflow filters and escapes every query value", async () => {
  const { run, calls } = fake([JSON.stringify({ total_count: 1, workflow_runs: [{ id: 9, name: "untrusted" }] })]);
  const result = await listRuns(run, "acme/widgets", {
    workflow: "ci.yaml",
    branch: "feature/a b",
    headSha: "abc+123",
    event: "pull_request",
    status: "in_progress",
    page: 3,
  });

  assert.deepEqual(calls[0].args, [
    "api",
    "repos/acme/widgets/actions/workflows/ci.yaml/runs?branch=feature%2Fa+b&head_sha=abc%2B123&event=pull_request&status=in_progress&per_page=100&page=3",
  ]);
  assert.deepEqual(result.pagination, { page: 3, perPage: 100, totalCount: 1, totalPages: 1, hasNextPage: false });
  assert.deepEqual(result.workflow_runs, [{ id: 9, name: "untrusted" }]);
});

test("readWorkflow discovers typed workflow_dispatch inputs from YAML at the requested ref", async () => {
  const source = `name: Build\non:\n  push:\n  workflow_dispatch:\n    inputs:\n      release:\n        type: boolean\n        required: true\n        default: false\n      channel:\n        type: choice\n        default: stable\n        options: [stable, canary]\n`;
  const { run, calls } = fake([
    JSON.stringify(workflow),
    JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(source).toString("base64"), path: workflow.path }),
  ]);

  const result = await readWorkflow(run, "acme/widgets", "build.yml", "feature/x");

  assert.deepEqual(calls.map((call) => call.args), [
    ["api", "repos/acme/widgets/actions/workflows/build.yml"],
    ["api", "repos/acme/widgets/contents/.github/workflows/build.yml?ref=feature%2Fx"],
  ]);
  assert.deepEqual(result.workflow, workflow);
  assert.deepEqual(result.workflowDispatch, {
    supported: true,
    enabled: true,
    inputs: {
      release: { type: "boolean", required: true, default: false },
      channel: { type: "choice", required: false, default: "stable", options: ["stable", "canary"] },
    },
  });
});

test("readWorkflow supports scalar and list event syntax and reports unavailable dispatch", async () => {
  for (const [state, source, expected] of [
    ["active", "on: workflow_dispatch\n", { supported: true, enabled: true, inputs: {} }],
    ["active", "on: [push, workflow_dispatch]\n", { supported: true, enabled: true, inputs: {} }],
    ["active", "on: push\n", { supported: false, enabled: true, reason: "missing_trigger", inputs: {} }],
    ["disabled_manually", "on: workflow_dispatch\n", { supported: true, enabled: false, reason: "workflow_disabled", inputs: {} }],
  ]) {
    const metadata = { ...workflow, state };
    const { run } = fake([
      JSON.stringify(metadata),
      JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(source).toString("base64"), path: workflow.path }),
    ]);
    const result = await readWorkflow(run, "acme/widgets", "42", "main");
    assert.deepEqual(result.workflowDispatch, expected);
  }
});

test("dispatchWorkflow sends bounded inputs only on stdin and returns the exact run", async () => {
  const { run, calls } = fake([JSON.stringify({ workflow_run_id: 9007199254740991 })]);
  const result = await dispatchWorkflow(run, "acme/widgets", "build release.yml", "release/1", { count: 2, dryRun: true });

  assert.deepEqual(calls, [{
    args: [
      "api", "-X", "POST", "repos/acme/widgets/actions/workflows/build%20release.yml/dispatches",
      "-H", "X-GitHub-Api-Version: 2022-11-28", "--input", "-",
    ],
    input: JSON.stringify({ ref: "release/1", inputs: { count: 2, dryRun: true }, return_run_details: true }),
  }]);
  assert.deepEqual(result, {
    runId: 9007199254740991,
    url: "https://github.com/acme/widgets/actions/runs/9007199254740991",
  });
});

test("write operations preserve GitHub refusals but mark no-response and malformed success uncertain without retries", async () => {
  const refusal = new GhError("gh api failed", "HTTP 403: Resource not accessible by integration", 1);
  const denied = fake([refusal]);
  await assert.rejects(dispatchWorkflow(denied.run, "acme/widgets", "build.yml", "main", {}), (error) => error === refusal);
  assert.equal(denied.calls.length, 1);

  for (const response of [new GhError("socket closed", "", 1), ...[408, 500, 502, 503].map(status => new GhError("HTTP failure", `HTTP ${status}`, 1, { status })), new Error("socket closed"), "", "{}", JSON.stringify({ workflow_run_id: 0 })]) {
    const attempt = fake([response]);
    await assert.rejects(dispatchWorkflow(attempt.run, "acme/widgets", "build.yml", "main", {}), /outcome is unknown/i);
    assert.equal(attempt.calls.length, 1);
  }

  const target = { owner: "acme", repo: "widgets", number: 77, kind: "workflow_run" };
  for (const operation of [(run) => cancelRun(run, target), (run) => rerunRun(run, target, "all")]) {
    const attempt = fake([new Error("connection reset")]);
    await assert.rejects(operation(attempt.run), /outcome is unknown/i);
    assert.equal(attempt.calls.length, 1);
  }
});

test("cancel and rerun use Actions endpoints once, and a job is verified against its run before rerun", async () => {
  const target = { owner: "acme", repo: "widgets", number: 77, kind: "workflow_run" };
  const { run, calls } = fake(["", "", JSON.stringify({ id: 12, run_id: 77 }), ""]);

  assert.deepEqual(await cancelRun(run, target), { requested: true });
  assert.deepEqual(await rerunRun(run, target, "failed"), { requested: true });
  assert.deepEqual(await rerunRun(run, target, "failed", 12), { requested: true });
  assert.deepEqual(calls.map((call) => call.args), [
    ["api", "-X", "POST", "repos/acme/widgets/actions/runs/77/cancel", "-H", "X-GitHub-Api-Version: 2022-11-28"],
    ["api", "-X", "POST", "repos/acme/widgets/actions/runs/77/rerun-failed-jobs", "-H", "X-GitHub-Api-Version: 2022-11-28"],
    ["api", "repos/acme/widgets/actions/jobs/12"],
    ["api", "-X", "POST", "repos/acme/widgets/actions/jobs/12/rerun", "-H", "X-GitHub-Api-Version: 2022-11-28"],
  ]);
});

test("validation rejects malformed repositories, workflow ids, refs, pages, inputs, targets, results and mismatched jobs before mutation", async () => {
  let runnerCalls = 0;
  const never = async () => { runnerCalls++; throw new Error("unexpected runner call"); };
  await assert.rejects(listWorkflows(never, "acme/widgets/extra"), /repo must use strict OWNER\/REPO syntax/);
  await assert.rejects(listWorkflows(never, "acme/widgets", 0), /page must be a positive safe integer/);
  await assert.rejects(readWorkflow(never, "acme/widgets", "dir/build.yml", "main"), /workflow must be a positive id/);
  await assert.rejects(readWorkflow(never, "acme/widgets", "build.txt", "main"), /workflow must be a positive id/);
  await assert.rejects(readWorkflow(never, "acme/widgets", "0", "main"), /workflow must be a positive id/);
  await assert.rejects(readWorkflow(never, "acme/widgets", "build.yml", ""), /ref must be a nonempty string/);
  await assert.rejects(dispatchWorkflow(never, "acme/widgets", "build.yml", "main", Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`k${i}`, true]))), /inputs may contain at most 25 keys/);
  await assert.rejects(cancelRun(never, { owner: "acme", repo: "widgets", number: 1 }), /target must be a GitHub workflow run URL/);
  await assert.rejects(rerunRun(never, { owner: "acme", repo: "widgets", number: Number.MAX_SAFE_INTEGER + 1, kind: "workflow_run" }, "all"), /run id must be a positive safe integer/);
  await assert.rejects(rerunRun(never, { owner: "acme", repo: "widgets", number: 1, kind: "workflow_run" }, "failed", 0), /job id must be a positive safe integer/);
  assert.equal(runnerCalls, 0, "invalid inputs must be rejected before any GitHub request");

  const mismatch = fake([JSON.stringify({ id: 12, run_id: 78 })]);
  await assert.rejects(rerunRun(mismatch.run, { owner: "acme", repo: "widgets", number: 77, kind: "workflow_run" }, "all", 12), /does not belong/i);
  assert.equal(mismatch.calls.length, 1);
});
