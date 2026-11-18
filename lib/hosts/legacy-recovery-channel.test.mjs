import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { mock } from "bun:test";

const root = mkdtempSync(join(tmpdir(), "legacy-recovery-channel-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const { releaseRepo } = await import("../release-repo.ts");
const realRecoveryRelease = await import("../recovery-release.ts");
mock.module("../recovery-release.ts", () => ({ ...realRecoveryRelease,
  recoveryHelperRelease: async () => ({ version: "0.7.2", repo: releaseRepo(), assets: [{ name: "ompweb-linux-x64.tar.gz", digest: `sha256:${"c".repeat(64)}` }] }),
}));
const hub = await import("./hub.ts");
const { readLegacyUpgrade } = await import("./legacy-upgrades.ts");
const { linkHost, until } = await import("./link-driver.test-helper.mjs");
const { LINK_PROTOCOL_VERSION } = await import("./link-protocol.ts");
const operationId = "12345678-1234-4234-8234-123456789012";
const recoverySession = "01a1eed6-de03-7591-84fb-20c20bb3ecca";
test.after(() => {
  hub.flushLinkSamples();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

// A 0.7.1 daemon lists the recovery omp it opened as a channel with that omp's own session id (creationId = the operation).
// The server must not adopt it as a session: the adoption's get_state is `id: 1` like the bootstrap's bash, and its reply
// was taken for the bootstrap's, which closed the channel seconds in and lost the real result (ai-worker-2, 2026-11-18).
test("a legacy host's recovery channel is never adopted, so the bootstrap's own result is the one that is read", async (t) => {
  const link = await linkHost("Legacy recovery channel", { hello: { v: LINK_PROTOCOL_VERSION, platform: "linux", home: "/tmp" } });
  const opens = [];
  const commands = [];
  let closes = 0;
  const serving = link.serve({
    checkUpdates: () => ({ ompweb: { currentVersion: "0.7.1", availableVersion: "0.7.2", updateAvailable: true, canUpdate: false,
      blockedReason: null, updateCommand: "", installMethod: "binary", protocolVersion: LINK_PROTOCOL_VERSION }, omp: { currentVersion: null }, operation: null }),
    open: (args) => {
      opens.push(args);
      return { ch: "recovery", joined: true, pending: [], streaming: null, cwd: "/tmp", fellBack: false, launchAdvisor: false, advisorSpawned: false, autoApproveExtension: false };
    },
    close: () => { closes++; return {}; },
  }, async (message) => {
    if (message.type !== "stdin") return;
    const command = JSON.parse(message.line);
    commands.push(command);
    // The runner answers any command with its own id, as the daemon maps it back to the sender's.
    if (command.op === "get_state") await link.post({ type: "stdout", ch: message.ch, line: JSON.stringify({ t: "res", id: command.id, ok: true, data: { sessionId: recoverySession, sessionFile: "", isStreaming: false, isCompacting: false } }) });
  });
  t.after(async () => { hub.closeHostLink(link.id); await serving; });

  await hub.updateHostSoftware(link.id, "ompweb", "0.7.2", { force: true, operationId });
  await until(() => commands.length === 2, "both recovery lines");
  await link.post({ type: "channels_changed", channels: [{ ch: "recovery", sessionId: recoverySession, cwd: "/tmp", pending: [], creationId: operationId }] });
  await sleep(100);
  assert.equal(opens.length, 1, "only the recovery's own open: no join of the channel as a session");
  assert.deepEqual(commands.map((command) => command.op ?? command.type), ["bash", "bash"], "nothing but the bootstrap is sent to its channel");
  assert.equal(closes, 0);
  assert.equal(readLegacyUpgrade(link.id)?.operation.state, "running");

  // The bootstrap fails after the channel was listed: that exit code is what reaches the operation.
  await link.post({ type: "stdout", ch: "recovery", line: JSON.stringify({ t: "res", id: 1, ok: true, data: { exitCode: 1 } }) });
  await until(() => closes === 1, "the recovery channel's close after the bootstrap's result");
  const state = readLegacyUpgrade(link.id)?.operation;
  assert.equal(state?.state, "failed");
  assert.match(state?.error ?? "", /exited with code 1/);
});
