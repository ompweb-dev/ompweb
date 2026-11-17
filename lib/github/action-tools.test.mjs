import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "github-action-tools-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
const { executeGithubTool, createGithubToolOps, GITHUB_REPLAY_SAFE_TOOLS } = await import("./tools.ts");
const { saveWebServerSettings } = await import("../web-settings.ts");
const { closeWatchStore } = await import("./watch-store.ts");
test.after(() => { closeWatchStore(); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); });
let request = 0;
function setup(policy = "ask", confirm = async () => true) {
  saveWebServerSettings({ agentToolsEnabled: true, githubWritesUnasked: true, githubActionsPermissions: { dispatch: policy, cancel: policy, rerun: policy } });
  const calls = [];
  const asked = [];
  const run = async (args, input) => {
    calls.push({ args, input });
    if (args.includes("user")) return "octocat";
    if (args.some(a => a.endsWith("/dispatches"))) return JSON.stringify({ workflow_run_id: 12345678901 });
    if (args.some(a => a.includes("actions/workflows"))) return JSON.stringify({ total_count: 1, workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }] });
    throw new Error(`Unexpected request ${args}`);
  };
  const ops = { ...createGithubToolOps(() => []), run };
  const ctx = { sourceSessionId: "session", sourceRequestId: `request-${++request}`, sourceHostId: "local", confirm: async (message) => { asked.push(message); return confirm(); } };
  return { calls, asked, ops, ctx, call: (name, args) => executeGithubTool(name, args, ops, ctx) };
}
const dispatch = { repo: "acme/widgets", workflow: "ci.yml", ref: "main", inputs: { build: true } };
test("dispatch asks independently of comment writes and returns exact run identity", async () => {
  const w = setup();
  const result = await w.call("github_workflow_dispatch", dispatch);
  assert.equal(w.asked.length, 1);
  assert.match(w.asked[0], /ci.yml/);
  assert.match(w.asked[0], /main/);
  assert.equal(result.runId, 12345678901);
  assert.equal(result.url, "https://github.com/acme/widgets/actions/runs/12345678901");
  assert.equal(GITHUB_REPLAY_SAFE_TOOLS.has("github_workflow_dispatch"), false);
});
test("blocked dispatch names local policy and never calls GitHub", async () => {
  const w = setup("deny");
  await assert.rejects(() => w.call("github_workflow_dispatch", dispatch), /dispatch.*blocked.*Settings/i);
  assert.deepEqual(w.calls, []);
});
test("declined dispatch never mutates GitHub", async () => {
  const w = setup("ask", async () => false);
  await assert.rejects(() => w.call("github_workflow_dispatch", dispatch), /declined/i);
  assert.equal(w.calls.some(c => c.args.includes("POST")), false);
});
test("policy revocation during confirmation prevents dispatch", async () => {
  const w = setup("ask", async () => {
    saveWebServerSettings({ githubActionsPermissions: { dispatch: "deny", cancel: "ask", rerun: "ask" } });
    return true;
  });
  await assert.rejects(() => w.call("github_workflow_dispatch", dispatch), /blocked/i);
  assert.equal(w.calls.some(c => c.args.includes("POST")), false);
});
test("read-only workflow discovery is replay-safe and needs no write confirmation", async () => {
  const w = setup("deny");
  const result = await w.call("github_workflow_list", { repo: "acme/widgets" });
  assert.ok(result);
  assert.deepEqual(w.asked, []);
  assert.equal(GITHUB_REPLAY_SAFE_TOOLS.has("github_workflow_list"), true);
});
test("repeated dispatch request returns its receipt without another mutation", async () => {
  const w = setup("allow");
  const first = await w.call("github_workflow_dispatch", dispatch);
  const second = await w.call("github_workflow_dispatch", dispatch);
  assert.deepEqual(second, first);
  assert.equal(w.calls.filter(c => c.args.some(a => a.endsWith("/dispatches"))).length, 1);
});
test("a cancelled confirmation cannot dispatch", async () => {
  const controller = new AbortController();
  const w = setup("ask", async () => { controller.abort(); return true; });
  w.ctx.signal = controller.signal;
  await assert.rejects(() => w.call("github_workflow_dispatch", dispatch), /cancelled/i);
  assert.equal(w.calls.some(c => c.args.includes("POST")), false);
});
test("a remote repository grant is required even when dispatch is allowed", async () => {
  const w = setup("allow", async () => false);
  w.ctx.sourceHostId = "remote-host";
  await assert.rejects(() => w.call("github_workflow_dispatch", dispatch), /declined GitHub access/);
  assert.match(w.asked[0], /acme\/widgets/);
  assert.equal(w.calls.some(c => c.args.includes("POST")), false);
});
test("cancel and rerun enforce their own policies independently of dispatch", async () => {
  for (const operation of ["cancel", "rerun"]) {
    for (const policy of ["deny", "ask", "allow"]) {
      const w = setup("deny");
      saveWebServerSettings({ githubActionsPermissions: { dispatch: "deny", cancel: "deny", rerun: "deny", [operation]: policy } });
      let writes = 0;
      w.ops.run = async (args) => {
        if (args.includes("user")) return "octocat";
        if (args.includes("POST")) { writes++; return ""; }
        throw new Error(`Unexpected request ${args}`);
      };
      const perform = () => w.call(`github_run_${operation}`, { target: "https://github.com/acme/widgets/actions/runs/77", ...(operation === "rerun" ? { mode: "failed" } : {}) });
      if (policy === "deny") await assert.rejects(perform, /blocked/);
      else assert.deepEqual(await perform(), { requested: true });
      assert.equal(writes, policy === "deny" ? 0 : 1);
      assert.equal(w.asked.length, policy === "ask" ? 1 : 0);
    }
  }
});
test("rerun revocation during job ownership lookup prevents its POST", async () => {
  const w = setup("allow");
  let writes = 0;
  w.ops.run = async (args) => {
    if (args.includes("user")) return "octocat";
    if (args.some(arg => arg.endsWith("/actions/jobs/12"))) {
      saveWebServerSettings({ githubActionsPermissions: { dispatch: "allow", cancel: "allow", rerun: "deny" } });
      return JSON.stringify({ id: 12, run_id: 77 });
    }
    if (args.includes("POST")) { writes++; return ""; }
    throw new Error(`Unexpected request ${args}`);
  };
  await assert.rejects(() => w.call("github_run_rerun", { target: "https://github.com/acme/widgets/actions/runs/77", mode: "all", jobId: 12 }));
  assert.equal(writes, 0);
});
