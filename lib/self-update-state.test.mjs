import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mockBuiltin } from "../tests/mock-builtin.mjs";

for (const scenario of ["transient", "persistent", "other-error", "posix"]) test(`atomic update state publication: ${scenario}`, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "update-state-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "status.json");
  writeFileSync(file, '{"state":"running"}');
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: scenario === "posix" ? "linux" : "win32" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  let attempts = 0;
  const refusal = Object.assign(new Error("publication refused"), { code: scenario === "other-error" ? "EIO" : "EPERM" });
  const originalRename = renameSync;
  await mockBuiltin(t, "node:fs", { renameSync(from, to) {
    if (to === file) {
      attempts++;
      assert.equal(readFileSync(file, "utf8"), '{"state":"running"}', "failed publication must preserve the prior complete state");
      if (scenario !== "transient" || attempts < 3) throw refusal;
    }
    return originalRename(from, to);
  } });
  const { atomicWrite } = await import(`./self-update-state.ts?fresh=${scenario}`);
  if (scenario === "transient") {
    atomicWrite(file, '{"state":"succeeded"}');
    assert.equal(readFileSync(file, "utf8"), '{"state":"succeeded"}');
  } else {
    assert.throws(() => atomicWrite(file, '{"state":"succeeded"}'), (error) => error === refusal);
    assert.equal(readFileSync(file, "utf8"), '{"state":"running"}');
    if (scenario !== "persistent") assert.equal(attempts, 1);
  }
  assert.deepEqual(readdirSync(root), ["status.json"], "publication never leaves temporary files");
});
