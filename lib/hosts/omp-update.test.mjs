import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";

// "Update omp": the daemon-side `omp` target of lib/hosts/updates.ts against fake fork releases. The runners are
// POSIX shell scripts answering --version, --runner-info and --smoke-test, the probe the real install runs.
const posix = process.platform !== "win32";
const root = realpathSync(mkdtempSync(join(tmpdir(), "host-omp-update-")));
const saved = { ...process.env };
const originalFetch = globalThis.fetch;
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const RUNNING = "18.22.0-int.202611171027.gec3956c";
const NEWER = "18.23.0-int.202611201200.gabc1234";
const OLDER = "18.21.0-int.202611100000.g1234567";
const compatibility = { min: 1, max: 10 };
let api, cli, fetched;
let releases = [];
let listing = 200;
/** What each fork release's assets hold: the binary served, the SHA-256 its listing claims for it, and its ompweb-omp.json protocol. */
let assets = {};
/** Runner binaries downloaded so far. */
let downloads = 0;
/** While set, the runner binary's download waits for it: an omp install held in flight. */
let gate = null;

const runner = (version, protocol = cli.RUNNER_PROTOCOL) => `#!/bin/sh\ncase "$1" in\n  --version) echo omp/${version} ;;\n  --runner-info) echo '{"protocol":${protocol},"omp":"${version}"}' ;;\n  --smoke-test) exit 0 ;;\nesac\n`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tag = (version) => `v${version}`;
const state = (name) => join(root, "agent", "omp-web", "host-update", name);
const settle = async () => {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const operation = api.getOmpUpdateOperation();
    if (operation?.state !== "running") return operation;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the omp update did not finish");
};
const publish = (version, { protocol = cli.RUNNER_PROTOCOL, binary = runner(version, protocol), listed = sha(binary) } = {}) => {
  assets[tag(version)] = { binary, listed, protocol };
  releases.unshift({ tag_name: tag(version), draft: false, prerelease: true, assets: [cli.OMP_RUNNER_ASSET, "ompweb-omp.json", "ompweb-omp.sha256"].map((name) => ({ name })) });
};

before(() => {
  if (!posix) return;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  delete process.env.OMP_WEB_OMP_BIN;
  delete process.env.OMP_WEB_PACKAGE_DIR;
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.startsWith("https://registry.npmjs.org/")) return new Response(JSON.stringify({ version: packageJson.version }));
    if (url.startsWith(`https://api.github.com/repos/${cli.OMP_RUNNER_PIN.repo}/releases?per_page=100&page=`)) return listing === 200 ? new Response(JSON.stringify(url.endsWith("page=1") ? releases : [])) : new Response("busy", { status: listing });
    for (const [name, { binary, listed, protocol }] of Object.entries(assets)) {
      if (url.endsWith(`/download/${name}/ompweb-omp.json`)) return new Response(JSON.stringify({ protocol, omp: name.slice(1) }));
      if (url.endsWith(`/download/${name}/ompweb-omp.sha256`)) return new Response(`${listed}  ${cli.OMP_RUNNER_ASSET}\n`);
      if (url.endsWith(`/download/${name}/${cli.OMP_RUNNER_ASSET}`)) { downloads++; await gate; return new Response(binary); }
    }
    return new Response("missing", { status: 404 });
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
});
const run = (name, body) => test(name, { skip: posix ? false : "the fake runners are POSIX shell scripts" }, body);

run("the check offers the newest fork release whose runner speaks this protocol, never an older omp, and says when it cannot look", async () => {
  api = await import("./updates.ts");
  cli = await import("../omp/omp-cli.ts");
  fetched = cli.fetchedOmpBin();
  mkdirSync(dirname(fetched), { recursive: true });
  writeFileSync(fetched, runner(RUNNING), { mode: 0o755 });
  // Not integration builds, so no runner of theirs.
  releases = [{ tag_name: "v18.9.0", draft: false, assets: [] }, { tag_name: `v${packageJson.version}`, draft: false, assets: [] }];
  const check = async () => (await api.checkHostUpdates(compatibility, true)).omp;

  const blockers = [];
  assert.deepEqual(await check(), { currentVersion: RUNNING, availableVersion: null, updateAvailable: false, canUpdate: false, blockedReason: null, blockers, operation: null, runnerChannel: true }, "no fork release carries a runner");
  publish(OLDER);
  const older = await check();
  assert.deepEqual([older.availableVersion, older.updateAvailable], [OLDER, false], "a build older than the running one is no update");
  publish(NEWER);
  publish("18.20.0-int.202611050000.gfffffff");
  publish("18.23.9-int.202611210000.gdeadbee", { protocol: cli.RUNNER_PROTOCOL + 1 });
  assert.deepEqual(await check(), { currentVersion: RUNNING, availableVersion: NEWER, updateAvailable: true, canUpdate: true, blockedReason: null, blockers, operation: null, runnerChannel: true });

  listing = 503;
  const failed = await check();
  assert.deepEqual([failed.updateAvailable, failed.canUpdate, failed.availableVersion], [false, false, null]);
  assert.match(failed.blockedReason, /could not check/i);
  assert.equal(failed.blockers[0].code, "check_failed");
  listing = 200;

  process.env.OMP_WEB_DISABLE_AUTOUPDATE = "1";
  const disabled = await check();
  assert.deepEqual([disabled.updateAvailable, disabled.canUpdate], [true, false]);
  assert.match(disabled.blockedReason, /disabled/i);
  assert.equal(disabled.blockers[0].code, "updates_disabled");
  await assert.rejects(api.startHostUpdate("omp", NEWER, compatibility), (error) => error.code === "updates_disabled");
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
});

run("an omp update takes only a version: force, phases and release pins are refused, and so is a stale candidate", async () => {
  for (const request of [{ force: true }, { phase: "prepare", operationId: "12345678-1234-4234-8234-123456789012" }, { releasePin: { version: "9.9.9", releaseRepo: "ompweb-dev/ompweb", assets: {} } }, { targetCompatibility: compatibility }]) {
    await assert.rejects(api.startHostUpdate("omp", NEWER, compatibility, request), (error) => error.code === "invalid_request", JSON.stringify(request));
  }
  await assert.rejects(api.startHostUpdate("omp", OLDER, compatibility), (error) => error.code === "candidate_changed");
  await assert.rejects(api.startHostUpdate("omp", "18.23.0; rm -rf /", compatibility), (error) => error.code === "invalid_version");
  assert.equal(api.getHostUpdateOperation(), null, "a refused start records nothing");
  assert.equal(api.getOmpUpdateOperation(), null);
  assert.equal(existsSync(state("lock.json")), false, "and keeps no claim");
});

run("a build whose checksum does not match fails the operation and changes nothing", async () => {
  assets[tag(NEWER)] = { binary: runner(NEWER), listed: sha("not this binary"), protocol: cli.RUNNER_PROTOCOL };
  const started = await api.startHostUpdate("omp", NEWER, compatibility);
  assert.deepEqual([started.accepted, started.operation.target, started.operation.version, started.operation.state], [true, "omp", NEWER, "running"]);
  const finished = await settle();
  assert.deepEqual([finished.id, finished.state], [started.operation.id, "failed"]);
  assert.match(finished.error, /SHA-256/);
  assert.equal(cli.readOmpPointer(), null);
  assert.equal(cli.resolveOmpBin(true), fetched);
  assert.equal(existsSync(join(cli.ompRunnerRoot(), `v${NEWER}`)), false);
  assert.equal(existsSync(state("status.json")), false, "ompweb's operation record is never written by an omp update");
  assert.equal(existsSync(state("lock.json")), false, "the claim is released");
});

run("an omp update installs beside the running runner, interrupts no work, and new spawns use it afterwards", async () => {
  assets[tag(NEWER)] = { binary: runner(NEWER), listed: sha(runner(NEWER)), protocol: cli.RUNNER_PROTOCOL };
  const started = await api.startHostUpdate("omp", NEWER, compatibility);
  assert.equal(started.operation.state, "running");
  assert.equal(api.hostUpdateBlocksNewWork(started.operation), false, "sessions start and prepare as usual while it runs");
  const finished = await settle();
  assert.equal(finished.state, "succeeded", finished.error);

  const pointer = cli.readOmpPointer();
  assert.equal(pointer.tag, `v${NEWER}`);
  assert.equal(cli.resolveOmpBin(), pointer.path);
  assert.notEqual(pointer.path, fetched);
  assert.equal(readFileSync(fetched, "utf8"), runner(RUNNING), "the runner already in use is left alone");
  assert.equal(await cli.getOmpVersion(), `omp/${NEWER}`);
  const after = (await api.checkHostUpdates(compatibility, true)).omp;
  assert.deepEqual([after.currentVersion, after.updateAvailable, after.operation.state], [NEWER, false, "succeeded"], "the check reports the omp update's own record");
  assert.equal(api.getHostUpdateOperation(), null, "ompweb's record stays empty");
  assert.equal(existsSync(state("status.json")), false);
  assert.equal(existsSync(state("lock.json")), false);
});

const NEXT = "18.24.0-int.202611250000.g7654321";
const AFTER_NEXT = "18.25.0-int.202611260000.g1111111";
const ompwebOperation = (extra) => ({ operation: { id: "ompweb-update-1", target: "ompweb", version: "99.0.0", state: "running", ...extra }, startedAt: Date.now(), daemonPid: process.pid });

run("an omp update never overwrites or races an ompweb update: it is refused while one is active or unsettled, and leaves its record alone when it runs", async () => {
  publish(NEXT);
  const check = async () => (await api.checkHostUpdates(compatibility, true)).omp;
  const refused = async (why) => {
    const omp = await check();
    assert.deepEqual([omp.updateAvailable, omp.canUpdate, omp.blockers.map((blocker) => blocker.code)], [true, false, ["ompweb_update_active"]], why);
    await assert.rejects(api.startHostUpdate("omp", NEXT, compatibility), (error) => error.code === "ompweb_update_active", why);
    assert.equal(api.getOmpUpdateOperation().version, NEWER, `${why}: the omp record is as it was`);
  };

  // An ompweb claim with no record yet (between its claim and its first status write).
  writeFileSync(state("lock.json"), JSON.stringify({ id: "ompweb-update-1", pid: process.pid, at: Date.now() }), { mode: 0o600 });
  await refused("a live ompweb claim");
  rmSync(state("lock.json"));

  // A running ompweb operation: the record is ompweb's own and must come out byte for byte.
  writeFileSync(state("status.json"), JSON.stringify(ompwebOperation()), { mode: 0o600 });
  const running = readFileSync(state("status.json"), "utf8");
  await refused("a running ompweb operation");
  assert.equal(readFileSync(state("status.json"), "utf8"), running);

  // A settled one does not hold anything: the omp update runs, and still leaves ompweb's record untouched.
  writeFileSync(state("status.json"), JSON.stringify(ompwebOperation({ state: "succeeded" })), { mode: 0o600 });
  const settled = readFileSync(state("status.json"), "utf8");
  const started = await api.startHostUpdate("omp", NEXT, compatibility);
  assert.deepEqual([started.operation.target, started.operation.id === "ompweb-update-1"], ["omp", false]);
  assert.equal((await settle()).state, "succeeded");
  assert.equal(readFileSync(state("status.json"), "utf8"), settled, "ompweb's record is not overwritten");
  assert.equal(api.getHostUpdateOperation().id, "ompweb-update-1", "and still reads as ompweb's");
  assert.equal(cli.readOmpPointer().tag, `v${NEXT}`);
});

run("an ompweb update is refused while an omp install is in flight, which keeps its own record", async () => {
  publish(AFTER_NEXT);
  const ompwebRecord = readFileSync(state("status.json"), "utf8");
  let release;
  gate = new Promise((resolve) => { release = resolve; });
  try {
    const started = await api.startHostUpdate("omp", AFTER_NEXT, compatibility);
    assert.equal(started.operation.state, "running");

    const info = await api.checkHostUpdates(compatibility, true);
    assert.deepEqual(info.ompweb.blockers.map((blocker) => blocker.code), ["omp_install_active"]);
    assert.equal(info.ompweb.canUpdate, false);
    assert.deepEqual([info.omp.canUpdate, info.omp.blockers.map((blocker) => blocker.code), info.omp.operation.id], [false, ["omp_install_active"], started.operation.id]);
    assert.equal(info.operation.id, "ompweb-update-1", "the status's operation stays ompweb's");
    await assert.rejects(api.startHostUpdate("ompweb", "99.0.0", compatibility), (error) => error.code === "update_in_progress");
    await assert.rejects(api.startHostUpdate("omp", AFTER_NEXT, compatibility), (error) => error.code === "omp_install_active");
    assert.equal(readFileSync(state("status.json"), "utf8"), ompwebRecord, "ompweb's record is untouched while the install runs");
  } finally {
    release();
    gate = null;
  }
  assert.equal((await settle()).state, "succeeded");
  assert.equal(readFileSync(state("status.json"), "utf8"), ompwebRecord);
  assert.equal(existsSync(state("lock.json")), false, "the install released the claim, so ompweb can update again");
});

const REPLAYED = "9d3d3f5e-3c33-4d6e-8c1f-5a5a5a5a5a5a";
const OMPWEB_OPERATION = "0f0f0f0f-1111-4222-8333-444444444444";
const AFTER_REPLAY = "18.26.0-int.202611270000.g2222222";
const AFTER_THAT = "18.27.0-int.202611280000.g3333333";

run("an operationId names one omp update: a replay returns the stored operation, while running or settled, and never installs again; anything else about that id is a conflict", async () => {
  publish(AFTER_REPLAY);
  let release;
  gate = new Promise((resolve) => { release = resolve; });
  let started;
  try {
    started = await api.startHostUpdate("omp", AFTER_REPLAY, compatibility, { operationId: REPLAYED });
    assert.deepEqual([started.operation.id, started.operation.version, started.operation.state], [REPLAYED, AFTER_REPLAY, "running"]);
    assert.deepEqual(await api.startHostUpdate("omp", AFTER_REPLAY, compatibility, { operationId: REPLAYED }), started, "a replay while it runs returns the running operation, not omp_install_active");
  } finally {
    release();
    gate = null;
  }
  assert.equal((await settle()).state, "succeeded");
  const installs = downloads;
  const pointer = readFileSync(join(cli.ompRunnerRoot(), "current.json"), "utf8");

  const settled = await api.startHostUpdate("omp", AFTER_REPLAY, compatibility, { operationId: REPLAYED });
  assert.deepEqual([settled.accepted, settled.operation.id, settled.operation.state], [true, REPLAYED, "succeeded"], "a replay after it settled returns the stored operation, though no update is left to offer");
  assert.equal(downloads, installs, "nothing is downloaded again");
  assert.equal(readFileSync(join(cli.ompRunnerRoot(), "current.json"), "utf8"), pointer);
  assert.equal(existsSync(state("lock.json")), false, "and no claim is taken");

  publish(AFTER_THAT);
  await assert.rejects(api.startHostUpdate("omp", AFTER_THAT, compatibility, { operationId: REPLAYED }), (error) => error.code === "operation_conflict", "the same id for another version");
  assert.equal(downloads, installs);
  await assert.rejects(api.startHostUpdate("omp", AFTER_REPLAY, compatibility, { operationId: REPLAYED, force: true }), (error) => error.code === "invalid_request", "a replay that adds anything but the id is refused too");

  writeFileSync(state("status.json"), JSON.stringify(ompwebOperation({ id: OMPWEB_OPERATION, state: "succeeded" })), { mode: 0o600 });
  await assert.rejects(api.startHostUpdate("omp", AFTER_THAT, compatibility, { operationId: OMPWEB_OPERATION }), (error) => error.code === "operation_conflict", "an ompweb operation's id is not an omp update's");
  await assert.rejects(api.startHostUpdate("ompweb", "99.0.0", compatibility, { operationId: REPLAYED }), (error) => error.code === "operation_conflict", "an omp operation's id is not an ompweb update's");
  assert.equal(api.getOmpUpdateOperation().id, REPLAYED, "the omp record is as it was");
  assert.equal(downloads, installs);

  const fresh = await api.startHostUpdate("omp", AFTER_THAT, compatibility);
  assert.notEqual(fresh.operation.id, REPLAYED, "an update without an id still gets its own");
  assert.equal((await settle()).state, "succeeded");
});

const BROKEN = "18.28.0-int.202611290000.g4444444";
const attemptId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

run("an operationId an earlier attempt used and a later one superseded is refused, never installed again; only the newest attempt's id replays", async () => {
  publish(BROKEN, { listed: sha("not this binary") });
  const [first, second] = [attemptId(1), attemptId(2)];
  for (const operationId of [first, second]) {
    await api.startHostUpdate("omp", BROKEN, compatibility, { operationId });
    assert.equal((await settle()).state, "failed");
  }
  const installs = downloads;
  const record = readFileSync(state("omp-update.json"), "utf8");

  await assert.rejects(api.startHostUpdate("omp", BROKEN, compatibility, { operationId: first }), (error) => error.code === "operation_conflict" && /superseded/.test(error.message), "A failed, B failed: replaying A");
  assert.equal(downloads, installs, "nothing is downloaded again");
  assert.equal(readFileSync(state("omp-update.json"), "utf8"), record, "the record is as it was");
  assert.equal(existsSync(state("lock.json")), false, "no claim is taken");
  const replayed = await api.startHostUpdate("omp", BROKEN, compatibility, { operationId: second });
  assert.deepEqual([replayed.operation.id, replayed.operation.state], [second, "failed"], "the newest attempt still replays");
  assert.equal(downloads, installs);
});

run("the superseded ids are a bounded list: the oldest ages out, the latest 32 are kept", async () => {
  const ids = Array.from({ length: 40 }, (_, n) => attemptId(100 + n));
  for (const operationId of ids) {
    await api.startHostUpdate("omp", BROKEN, compatibility, { operationId });
    assert.equal((await settle()).state, "failed");
  }
  const { earlier, operation } = JSON.parse(readFileSync(state("omp-update.json"), "utf8"));
  assert.equal(operation.id, ids[39]);
  assert.deepEqual(earlier, [...ids.slice(7, 39)], "the 32 attempts before the newest, oldest first");
  await assert.rejects(api.startHostUpdate("omp", BROKEN, compatibility, { operationId: ids[7] }), (error) => error.code === "operation_conflict");
  const aged = await api.startHostUpdate("omp", BROKEN, compatibility, { operationId: attemptId(2) });
  assert.deepEqual([aged.operation.id, aged.operation.state], [attemptId(2), "running"], "an id older than the bound is as unknown as any new one");
  await settle();
});
