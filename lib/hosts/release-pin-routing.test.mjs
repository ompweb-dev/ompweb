import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mock } from "bun:test";

const root = mkdtempSync(join(tmpdir(), "release-pin-routing-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const { releaseRepo } = await import("../release-repo.ts");
const realRecoveryRelease = await import("../recovery-release.ts");
mock.module("../recovery-release.ts", () => ({ ...realRecoveryRelease,
  recoveryHelperRelease: async () => ({ version: "0.8.0", repo: releaseRepo(), assets: [{ name: "ompweb-linux-x64.tar.gz", digest: `sha256:${"c".repeat(64)}` }] }),
}));
const hub = await import("./hub.ts");
const { linkHost } = await import("./link-driver.test-helper.mjs");
const { LINK_PROTOCOL_VERSION } = await import("./link-protocol.ts");
const { parseHostRecoveryArgs } = await import("./recovery.ts");
const pin = { version: "0.8.0", releaseRepo: releaseRepo(), assets: { "ompweb-linux-x64.tar.gz": "a".repeat(64) } };
const operationId = "12345678-1234-4234-8234-123456789012";
test.after(() => {
  hub.flushLinkSamples();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("an old native updater without pin support uses the pinned helper only after explicit force", async (t) => {
  const link = await linkHost("Old native pin consumer", { hello: { v: LINK_PROTOCOL_VERSION, platform: "linux", home: "/tmp" } });
  const commands = [];
  let nativeCalls = 0;
  const serving = link.serve({
    checkUpdates: () => ({ ompweb: { currentVersion: "0.7.1", availableVersion: "0.8.0", updateAvailable: true,
      canUpdate: true, canForceUpdate: true, forceMethod: "native", blockers: [], blockedReason: null,
      updateCommand: "npm install -g @kahme247/ompweb", installMethod: "binary", protocolVersion: LINK_PROTOCOL_VERSION },
      omp: { currentVersion: null }, operation: null }),
    updateSoftware: () => { nativeCalls++; throw new Error("Old native APIs cannot enforce a pin"); },
    open: () => ({ ch: "recovery", joined: true, pending: [], streaming: null, cwd: "/tmp", fellBack: false, launchAdvisor: false, advisorSpawned: false, autoApproveExtension: false }),
    close: () => ({}),
  }, async (message) => { if (message.type === "stdin") commands.push(JSON.parse(message.line)); });
  t.after(async () => { hub.closeHostLink(link.id); await serving; });
  const status = await hub.getHostSoftwareUpdates(link.id, true, undefined, pin);
  assert.equal(status.ompweb.canUpdate, false);
  assert.equal(status.ompweb.canForceUpdate, true);
  assert.equal(status.ompweb.forceMethod, "recovery");
  await assert.rejects(hub.updateHostSoftware(link.id, "ompweb", "0.8.0", { releasePin: pin, requireReleasePin: true, operationId }), { code: "host_update_blocked" });
  assert.equal(commands.length, 0);
  const accepted = await hub.updateHostSoftware(link.id, "ompweb", "0.8.0", { force: true, releasePin: pin, requireReleasePin: true, operationId });
  assert.equal(accepted.operation.id, operationId);
  assert.equal(nativeCalls, 0);
  for (let i = 0; i < 100 && commands.length < 2; i++) await new Promise((done) => setTimeout(done, 1));
  const command = commands.find((message) => message.t === "cmd")?.args.command;
  assert.ok(command, "the existing runner envelope must carry the fixed recovery bootstrap");
  const encoded = Buffer.from(JSON.stringify(pin)).toString("base64url");
  assert.ok(command.includes("--release-pin"));
  assert.ok(command.includes(encoded));
  const parsed = parseHostRecoveryArgs(["--operation", operationId, "--version", pin.version, "--min-protocol", "1", "--max-protocol", "100", "--force", "--release-pin", encoded]);
  assert.deepEqual(parsed.releasePin, pin);
  assert.equal(parsed.requireReleasePin, true);
});

test("a proven native pin consumer receives the immutable manifest without a recovery channel", async (t) => {
  const link = await linkHost("Native pin consumer");
  let received;
  const serving = link.serve({
    checkUpdates: () => ({ ompweb: { currentVersion: "0.7.1", availableVersion: pin.version, updateAvailable: true,
      canUpdate: true, supportsReleasePin: true, canForceUpdate: true, forceMethod: "native", blockers: [],
      blockedReason: null, updateCommand: "", installMethod: "binary", protocolVersion: LINK_PROTOCOL_VERSION },
      omp: { currentVersion: null }, operation: null }),
    updateSoftware: (args) => { received = args; return { accepted: true, operation: { id: args.operationId, target: "ompweb", version: args.version, state: "running" } }; },
    open: () => { throw new Error("A proven native consumer must not open a recovery runner"); },
  });
  t.after(async () => { hub.closeHostLink(link.id); await serving; });
  await hub.updateHostSoftware(link.id, "ompweb", pin.version, { releasePin: pin, requireReleasePin: true, operationId });
  assert.deepEqual(received.releasePin, pin);
  assert.equal(received.requireReleasePin, true);
});
