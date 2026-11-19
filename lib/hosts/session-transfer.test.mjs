import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// The moves run the real `omp session pack|unpack|moved` of ompweb's runner (AGENTS.md: `npm test` needs it installed).
const root = mkdtempSync(join(tmpdir(), "omp-web-session-transfer-"));
const cli = resolve("runner/src/cli.ts");
const omp = join(root, process.platform === "win32" ? "omp.cmd" : "omp");
writeFileSync(omp, process.platform === "win32"
  ? `@"${process.execPath.replaceAll("%", "%%")}" "${cli.replaceAll("%", "%%")}" %*\r\n`
  : `#!/bin/sh\nexec bun ${JSON.stringify(cli)} "$@"\n`);
chmodSync(omp, 0o755);
process.env.OMP_WEB_OMP_BIN = omp;

const { packSessionFile, readSessionPack, retireMovedSession, unpackSessionPack, writeSessionPack } = await import("./session-transfer.ts");

const ID = "11111111-2222-4333-8444-555555555555";

/** An agent dir ("a host") holding the fixture session, recorded in workspace `cwd`. */
function host(name, cwd) {
  const agentDir = join(root, name);
  const dir = join(agentDir, "sessions", "-fixture");
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "session", version: 3, id: ID, cwd, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", provider: "test", model: "m", content: [{ type: "text", text: "hi" }] } },
  ];
  const file = join(dir, `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return { agentDir, file };
}

function workspace(name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function on(agentDir) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
}

function sessionFiles(agentDir) {
  return readdirSync(join(agentDir, "sessions"), { recursive: true }).filter((name) => String(name).endsWith(".jsonl"));
}

function lastEntry(agentDir) {
  const [file] = sessionFiles(agentDir);
  return JSON.parse(readFileSync(join(agentDir, "sessions", file), "utf8").trim().split("\n").at(-1));
}

test.after(() => rmSync(root, { recursive: true, force: true }));

// Each step starts omp, a few seconds each under a parallel run.
test("a move between workspaces of one host replaces the session and says so", { timeout: 60_000 }, async () => {
  const from = workspace("same-from");
  const to = workspace("same-to");
  const { agentDir, file } = host("same", from);
  on(agentDir);

  const packed = await packSessionFile(file);
  assert.equal(packed.ok, true, JSON.stringify(packed));
  const unpacked = await unpackSessionPack(packed.value.transfer, to, { host: "alpha", from: null });
  assert.deepEqual(unpacked, { ok: true, value: { sessionId: ID } });

  assert.equal(existsSync(file), false);
  assert.equal(sessionFiles(agentDir).length, 1);
  const marker = lastEntry(agentDir);
  assert.equal(marker.customType, "session-transfer");
  assert.deepEqual(marker.details, { kind: "arrived", fromCwd: from, cwd: to });
  assert.match(marker.content, /moved on host `alpha` from the workspace `.*same-from` to `.*same-to`/);
  assert.doesNotMatch(marker.content, /another machine/);
  assert.equal(readdirSync(join(agentDir, "omp-web", "transfers")).length, 0);
});

test("a move to another host copies the archive in chunks, names both hosts and retires the source", { timeout: 60_000 }, async () => {
  const from = workspace("cross-from");
  const to = workspace("cross-to");
  const source = host("source", from);
  const target = join(root, "target");

  on(source.agentDir);
  const packed = await packSessionFile(source.file);
  assert.equal(packed.ok, true, JSON.stringify(packed));
  const { transfer, bytes } = packed.value;
  for (let offset = 0; offset < bytes;) {
    on(source.agentDir);
    const chunk = await readSessionPack(transfer, offset);
    assert.equal(chunk.ok, true);
    on(target);
    const written = await writeSessionPack(transfer, offset, Buffer.from(chunk.value).toString("base64"));
    assert.equal(written.ok, true, JSON.stringify(written));
    offset = written.value.bytes;
  }
  const repeated = await writeSessionPack(transfer, 0, "AA==");
  assert.equal(repeated.ok, false);
  assert.equal(repeated.code, "transfer_offset");

  const unpacked = await unpackSessionPack(transfer, to, { host: "beta", from: { host: "alpha", home: "/home/alpha", platform: "plan9" } });
  assert.deepEqual(unpacked, { ok: true, value: { sessionId: ID } });
  const marker = lastEntry(target);
  assert.match(marker.content, /moved from host `alpha` to host `beta`/);
  assert.match(marker.content, /home directory changed from `\/home\/alpha`/);
  assert.match(marker.content, /operating system changed from plan9/);

  on(source.agentDir);
  assert.deepEqual(await retireMovedSession(source.file, transfer, `beta:${to}`), { ok: true, value: null });
  assert.equal(existsSync(source.file), false);
  assert.equal(sessionFiles(source.agentDir).length, 0);
  assert.equal(readdirSync(join(source.agentDir, "omp-web", "transfers")).length, 0);
});

test("retireMovedSession and unpackSessionPack reject cmd.exe metacharacters", { timeout: 60_000 }, async () => {
  const from = workspace("meta-from");
  const source = host("meta-source", from);
  on(source.agentDir);
  const packed = await packSessionFile(source.file);
  assert.equal(packed.ok, true, JSON.stringify(packed));

  const badRetire = await retireMovedSession(source.file, packed.value.transfer, "beta:C:\\work&whoami");
  assert.equal(badRetire.ok, false);
  assert.equal(badRetire.code, "invalid_destination");
  assert.equal(badRetire.status, 400);
  assert.equal(existsSync(source.file), true, "rejected retirement must leave the source untouched");

  const badUnpack = await unpackSessionPack(packed.value.transfer, "C:\\work&whoami", { host: "beta", from: null });
  assert.equal(badUnpack.ok, false);
  assert.equal(badUnpack.code, "invalid_destination");
  assert.equal(badUnpack.status, 400);
  assert.equal(existsSync(source.file), true);
});

test("retireMovedSession refuses retirement when the source session changed after packing", { timeout: 60_000 }, async () => {
  const from = workspace("drift-from");
  const to = workspace("drift-to");
  const source = host("drift-source", from);
  on(source.agentDir);
  const packed = await packSessionFile(source.file);
  assert.equal(packed.ok, true, JSON.stringify(packed));

  appendFileSync(source.file, `${JSON.stringify({ type: "message", id: "u2", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "late turn" } })}\n`);
  const retired = await retireMovedSession(source.file, packed.value.transfer, `beta:${to}`);
  assert.equal(retired.ok, false);
  assert.equal(retired.code, "session_changed");
  assert.equal(retired.status, 409);
  assert.equal(existsSync(source.file), true, "changed source session must stay active");
  assert.equal(sessionFiles(source.agentDir).length, 1);
  assert.equal(readdirSync(join(source.agentDir, "omp-web", "transfers")).length, 0);
});
