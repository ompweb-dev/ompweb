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
const { linkHost, until } = await import("./link-driver.test-helper.mjs");
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

test("an old native updater ignores the pin and reports latest B, so only explicit force routes approved A through recovery", async (t) => {
  const link = await linkHost("Old native pin consumer", { hello: { v: LINK_PROTOCOL_VERSION, platform: "linux", home: "/tmp" } });
  const commands = [];
  let nativeCalls = 0;
  const serving = link.serve({
    checkUpdates: () => ({ ompweb: { currentVersion: "0.7.1", availableVersion: "0.9.0", updateAvailable: true,
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

test("a proven native pin consumer evaluates approved A instead of moving latest B", async (t) => {
  const link = await linkHost("Native pin consumer");
  let checked, received;
  const serving = link.serve({
    checkUpdates: (args) => {
      checked = args;
      return { ompweb: { currentVersion: "0.7.1", availableVersion: args.releasePin?.version ?? "0.9.0", updateAvailable: true,
        canUpdate: true, supportsReleasePin: true, supportsTwoPhaseUpdate: true, canForceUpdate: true, forceMethod: "native", blockers: [],
        blockedReason: null, updateCommand: "", installMethod: "binary", protocolVersion: LINK_PROTOCOL_VERSION },
        omp: { currentVersion: null }, operation: null };
    },
    updateSoftware: (args) => { received = args; return { accepted: true, operation: { id: args.operationId, target: "ompweb", version: args.version, state: "running" } }; },
    open: () => { throw new Error("A proven native consumer must not open a recovery runner"); },
  });
  t.after(async () => { hub.closeHostLink(link.id); await serving; });
  await hub.updateHostSoftware(link.id, "ompweb", pin.version, { releasePin: pin, requireReleasePin: true, operationId });
  assert.deepEqual(checked.releasePin, pin);
  assert.deepEqual(received.releasePin, pin);
  assert.equal(received.requireReleasePin, true);
});

for (const version of [10, 11]) test(`v${version} phased recovery keeps one protected runner through preparation and commit`, async (t) => {
  const link = await linkHost(`Phased v${version}`, { hello: { v: version, platform: "linux", home: "/tmp" } });
  let operation = null, opens = 0, closes = 0;
  const commands = [];
  const serving = link.serve({
    checkUpdates: () => ({ ompweb: { currentVersion: "0.6.0", availableVersion: pin.version, updateAvailable: true,
      canUpdate: true, blockedReason: null, updateCommand: "", installMethod: "binary", protocolVersion: LINK_PROTOCOL_VERSION },
      omp: { currentVersion: null }, operation }),
    open: (args) => {
      opens++;
      assert.equal(args.preparing, true, "the historical daemon must retain the recovery channel while the worker stages");
      return { ch: "phased-recovery", joined: true, pending: [], streaming: null, cwd: "/tmp", fellBack: false, launchAdvisor: false, advisorSpawned: false, autoApproveExtension: false };
    },
    close: () => { closes++; return {}; },
  }, async (message) => { if (message.type === "stdin") commands.push(JSON.parse(message.line)); });
  t.after(async () => { hub.closeHostLink(link.id); await serving; });
  const options = { force: true, releasePin: pin, requireReleasePin: true, operationId };
  await hub.updateHostSoftware(link.id, "ompweb", pin.version, { ...options, phase: "prepare" });
  await until(() => commands.length === 2, "the preparation bootstrap");
  const reply = async (id) => link.post({ type: "stdout", ch: "phased-recovery",
    line: JSON.stringify(version === 10 ? { type: "response", id: String(id), success: true, data: { exitCode: 0 } } : { t: "res", id, ok: true, data: { exitCode: 0 } }) });
  await reply(1);
  operation = { id: operationId, target: "ompweb", version: pin.version, state: "running", prepared: true };
  await hub.getHostSoftwareUpdates(link.id, true, undefined, pin);
  assert.equal(closes, 0, "a successful prepare response must not release the historical preparation lease");
  await hub.updateHostSoftware(link.id, "ompweb", pin.version, { ...options, phase: "commit" });
  await until(() => commands.length === 4, "the commit bootstrap");
  assert.equal(opens, 1, "commit cannot depend on a new spawn while the old daemon has an update claim");
  assert.deepEqual(commands.map((command) => String(command.id)), ["1", "1", "2", "2"]);
  await reply(1);
  await hub.getHostSoftwareUpdates(link.id, true, undefined, pin);
  assert.equal(closes, 0, "a delayed prepare response cannot close the commit channel");
  await reply(2);
  await until(() => closes === 1, "the commit response to release the preparation lease");
});
