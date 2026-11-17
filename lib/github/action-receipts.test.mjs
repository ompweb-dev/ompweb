import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withActionReceipt } from "./action-receipts.ts";
const dir = mkdtempSync(join(tmpdir(), "action-receipts-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
test.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); });
test("a repeated tool request returns the original run without dispatching twice", async () => {
  let writes = 0;
  const perform = async () => ({ runId: ++writes });
  assert.deepEqual(await withActionReceipt("s", "r", "dispatch", { ref: "main" }, perform), { runId: 1 });
  assert.deepEqual(await withActionReceipt("s", "r", "dispatch", { ref: "main" }, perform), { runId: 1 });
  assert.equal(writes, 1);
  await assert.rejects(() => withActionReceipt("s", "r", "dispatch", { ref: "other" }, perform), /different arguments/);
});
test("an in-flight identical request cannot dispatch a second run", async () => {
  let finish;
  const pending = withActionReceipt("s", "pending", "dispatch", {}, () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(() => withActionReceipt("s", "pending", "dispatch", {}, async () => { throw new Error("duplicate"); }), /outcome is unknown/);
  finish({ runId: 2 });
  assert.deepEqual(await pending, { runId: 2 });
});
test("an uncertain failure stays failed instead of being retried", async () => {
  let writes = 0;
  const perform = async () => { writes++; throw new Error("network outcome unknown"); };
  await assert.rejects(() => withActionReceipt("s", "failed", "dispatch", {}, perform), /network outcome unknown/);
  await assert.rejects(() => withActionReceipt("s", "failed", "dispatch", {}, perform), /network outcome unknown/);
  assert.equal(writes, 1);
});
