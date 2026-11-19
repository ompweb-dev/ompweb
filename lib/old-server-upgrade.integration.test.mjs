// Published ompweb servers (npm 0.6.0, 0.7.0, 0.7.1) updated to this checkout through their own GUI update path.
//
// Real, and unchanged: each old release is the published npm tarball (`npm pack @kahme247/ompweb@<v>`), installed with
// `npm install -g --prefix <scratch>` and started as a user starts it, `ompweb -p <port>`, with its own bundled Bun (or
// Next.js, for 0.6.0). The GUI is the old server's `POST /api/app-update` prepare/commit and its status poll
// (components/AppShell.tsx sends exactly these); the detached update worker, its candidate preflight, the `npm install -g`,
// the launcher handshake and the old daemon (`ompweb host`, with its own updater) are the published code. The candidate
// is `npm pack` of this checkout (its real prepack build). Real npm installs real dependencies from the npm registry, so
// this needs network, `npm`, node >= 24 and about 400 MB per release of the system temp directory.
// Fake, and only here: (a) a preload (BUN_OPTIONS / NODE_OPTIONS) that answers the registry's `latest` with this checkout's
// version and the target tag's raw link-protocol.ts with this checkout's file, and refuses every other network request;
// (b) a `npm` on PATH that swaps the `@kahme247/ompweb@<this version>` spec for the candidate tarball and runs the real npm;
// (c) the omp runner: one POSIX script (OMP_WEB_OMP_BIN) that says the runner's hello for the candidate's preflight.
// HOME, the agent directory, TMPDIR, the npm prefix and the port are scratch; no user service is touched.
//
// What each published release does (npm-global install, launched as a plain `ompweb`; no systemd/launchd/tray supervisor):
// Its worker installs the candidate and reports "succeeded", but the old server never sends its launcher the arm message,
// so the worker's SIGTERM ends the launcher with the server and nobody answers the worker's restart request: no server runs
// afterwards. Recovery for the user: run `ompweb` again. The candidate server finds the old host daemon and keeps it (no
// duplicate); Settings -> Hosts then replaces it: an old daemon has no force contract, so the plain update is refused
// (host_update_blocked) and the GUI's separately confirmed Force starts the recovery (forceMethod "recovery").
// Releases 0.7.0 and 0.7.1 share the update code. 0.6.0 is the Next.js release: it has no host daemon, so the candidate
// server starts the local host itself.
//
// Run:  OMPWEB_OLD_SERVER_E2E=1 bun test --timeout 900000 lib/old-server-upgrade.integration.test.mjs
// Cleanup: every process that inherited the scenario's OMPWEB_OLD_E2E_SCOPE marker is ended, and the run fails if one
// survives. A crash of the runner itself can leave them: kill by the old-server-upgrade-* path.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { nodeBinary, repo, repoVersion, spawnNodeOutsideService } from "./hosts/update-fixture.test-helper.mjs";

/** The release set: `daemon` is whether the release has a host daemon at all; `link` its link protocol. */
const OLD = [
  { version: "0.6.0", daemon: false },
  { version: "0.7.0", daemon: true, link: 11 },
  { version: "0.7.1", daemon: true, link: 12 },
];
/** The link protocol this checkout speaks. */
const APPLICATION = Number(/LINK_PROTOCOL_VERSION = (\d+);/.exec(readFileSync(join(repo, "lib", "hosts", "link-protocol.ts"), "utf8"))?.[1]);
const MARKER = "OMPWEB_OLD_E2E_SCOPE";

const skip = process.env.OMPWEB_OLD_SERVER_E2E !== "1" ? "set OMPWEB_OLD_SERVER_E2E=1: it installs three published releases from the npm registry and runs their GUI update"
  : process.platform !== "linux" ? "needs /proc and a POSIX process table (Linux)"
  : typeof Bun === "undefined" ? "run it with bun test"
  : false;
const required = process.env.OMPWEB_OLD_SERVER_E2E === "1" && Boolean(process.env.CI);
if (required && skip) throw new Error(`old-server upgrade E2E is required in CI and cannot be skipped: ${skip}`);

const base = skip ? "" : realpathSync(mkdtempSync(join(tmpdir(), "old-server-upgrade-")));
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
after(() => { if (base) rmSync(base, { recursive: true, force: true }); });

// ---------------------------------------------------------------- processes

/** Every process that inherited this scenario's marker (the launcher, Bun/Next, workers, daemons, npm, systemd-run). */
function owned(work) {
  const marker = `${MARKER}=${work}\0`;
  return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).flatMap((name) => {
    try {
      if (!readFileSync(`/proc/${name}/environ`, "utf8").includes(marker)) return [];
      return [{ pid: Number(name), argv: readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean) }];
    } catch { return []; }
  }).filter(({ pid }) => pid !== process.pid);
}
const isNode = (p) => basename(p.argv[0] ?? "") === "node";
/** A host daemon: `node omp-web-host.js` or `ompweb host`. */
const daemons = (work) => owned(work).filter((p) => isNode(p) && (p.argv.some((a) => /[\\/]omp-web-host\.js$/.test(a)) || (p.argv[2] === "host" && /[\\/](ompweb|omp-web\.js)$/.test(p.argv[1] ?? "")))).map((p) => p.pid);
const launchers = (work) => owned(work).filter((p) => isNode(p) && /[\\/](ompweb|omp-web\.js)$/.test(p.argv[1] ?? "") && p.argv.includes("-p")).map((p) => p.pid);
const servers = (work) => owned(work).filter((p) => p.argv.some((a) => /server[\\/]main\.ts$/.test(a)) || /^next-server/.test(p.argv[0] ?? "")).map((p) => p.pid);

async function stopAll(work) {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const { pid } of owned(work)) { try { process.kill(pid, signal); } catch { /* gone */ } }
    for (const deadline = Date.now() + 10_000; owned(work).length > 0 && Date.now() < deadline;) await sleep(100);
  }
  assert.deepEqual(owned(work).map((p) => p.pid), [], "every process this scenario started must exit");
}

async function until(check, what, diag, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let last = "";
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout / 1000} s waiting for ${what}${last ? ` (last error: ${last})` : ""}\n${diag()}`);
    await sleep(250);
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

// ---------------------------------------------------------------- the fixture

let candidate;
/** `npm pack` of this checkout: the tarball a release publishes (the real prepack build runs). */
function candidateTarball() {
  if (candidate) return candidate;
  const dir = join(base, "candidate");
  mkdirSync(dir);
  const out = execFileSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: repo, encoding: "utf8" }).trim().split("\n").at(-1);
  candidate = join(dir, out);
  return candidate;
}

const tarballs = new Map();
function publishedTarball(version) {
  if (tarballs.has(version)) return tarballs.get(version);
  const dir = join(base, "published");
  mkdirSync(dir, { recursive: true });
  const out = execFileSync("npm", ["pack", `@kahme247/ompweb@${version}`, "--silent", "--pack-destination", dir], { encoding: "utf8" }).trim().split("\n").at(-1);
  tarballs.set(version, join(dir, out));
  return tarballs.get(version);
}

const realNpm = skip ? "" : (spawnSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).stdout ?? "").trim();
if (!skip && !realNpm) throw new Error("old-server upgrade e2e: npm is not on PATH");
const preload = join(base, "delivery.mjs");
// The only network an old release sees: the registry's latest version and the target tag's raw link-protocol.ts.
if (base) writeFileSync(preload, `import { appendFileSync, readFileSync } from "node:fs";
let inner = globalThis.fetch;
const dir = process.env.UPGRADE_FIXTURE_DIR;
const wrapper = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (/^http:\\/\\/(127\\.0\\.0\\.1|localhost|\\[::1\\])[:/]/.test(url)) return inner(input, init);
  if (dir) appendFileSync(dir + "/fetch.log", url + "\\n");
  if (url.startsWith("https://registry.npmjs.org/")) return Response.json({ version: process.env.UPGRADE_FIXTURE_VERSION });
  if (/^https:\\/\\/raw\\.githubusercontent\\.com\\/[^/]+\\/[^/]+\\/v[^/]+\\/lib\\/hosts\\/link-protocol\\.ts$/.test(url)) return new Response(readFileSync(process.env.UPGRADE_FIXTURE_PROTOCOL_SOURCE));
  throw new Error("old-server fixture: no network access to " + url);
};
// Next.js (0.6.0) re-patches globalThis.fetch at startup: an accessor keeps this answer in front of whatever it installs.
Object.defineProperty(globalThis, "fetch", { configurable: true, enumerable: true, get: () => wrapper, set: (value) => { inner = value; } });
`);

/** A disposable user: a global npm prefix holding `version`, scratch HOME/agent/TMPDIR, the fake omp and the delivery fakes. */
function newUser(version) {
  const work = join(base, `v${version}`);
  const user = {
    version, work, prefix: join(work, "prefix"), home: join(work, "home"), tmp: join(work, "tmp"), bin: join(work, "bin"),
    agent: join(work, "home", ".omp", "agent"), logs: [],
  };
  user.pkg = join(user.prefix, "lib", "node_modules", "@kahme247", "ompweb");
  for (const dir of [user.agent, user.tmp, user.bin]) mkdirSync(dir, { recursive: true });
  // A session file no update may touch.
  const sessionFile = join(user.agent, "sessions", "--project--", "s.jsonl");
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, '{"type":"session"}\n');
  user.sessions = () => [readdirSync(join(user.agent, "sessions"), { recursive: true }).sort(), readFileSync(sessionFile, "utf8"), statSync(sessionFile).mtimeMs];
  const fakeOmp = join(work, "fake-omp");
  writeFileSync(fakeOmp, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 14.0.0-fake; exit 0; fi
case "$*" in *--check*) echo "Current version: 14.0.0-fake"; exit 0;; esac
case "$*" in *"--headless --cwd "*"--no-session"*) echo '{"t":"hello","proto":1}'; exec cat >/dev/null;; esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(user.bin, "npm"), `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(join(work, "npm.log"))}, JSON.stringify(args) + "\\n");
const spec = ${JSON.stringify(`@kahme247/ompweb@${repoVersion}`)};
if (args.some((arg) => arg.startsWith("@kahme247/ompweb@") && arg !== spec)) process.exit(8);
process.exit(spawnSync(${JSON.stringify(realNpm)}, args.map((arg) => arg === spec ? ${JSON.stringify(candidateTarball())} : arg), { stdio: "inherit" }).status ?? 1);
`, { mode: 0o755 });
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OMP_WEB_|OMPWEB_|PI_|BUN_|NPM_|NODE_OPTIONS$|NODE_ENV$|PORT$)/i.test(name) && !/^npm_/.test(name)));
  user.env = {
    ...clean, HOME: user.home, USERPROFILE: user.home, PI_CODING_AGENT_DIR: user.agent, TMPDIR: user.tmp,
    PATH: [user.bin, dirname(nodeBinary()), clean.PATH].join(delimiter),
    NPM_CONFIG_PREFIX: user.prefix, NPM_CONFIG_CACHE: join(base, "npm-cache"), NPM_CONFIG_UPDATE_NOTIFIER: "false",
    OMP_WEB_OMP_BIN: fakeOmp, BUN_OPTIONS: `--preload ${preload}`, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
    UPGRADE_FIXTURE_DIR: work, UPGRADE_FIXTURE_VERSION: repoVersion, UPGRADE_FIXTURE_PROTOCOL_SOURCE: join(repo, "lib", "hosts", "link-protocol.ts"),
    [MARKER]: work,
  };
  user.npmCalls = () => existsSync(join(work, "npm.log")) ? readFileSync(join(work, "npm.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  user.output = () => user.logs.map(({ name, text }) => `--- ${name}\n${text}`).join("\n");
  return user;
}

/** Starts `node script ...args` as the user's shell would, outside this suite's service. Null when no scope can be made. */
async function spawnLogged(user, name, script, args) {
  const child = await spawnNodeOutsideService(script, user.env, args);
  if (!child) return null;
  const entry = { name, text: "" };
  user.logs.push(entry);
  child.stdout.on("data", (data) => { entry.text += data; });
  child.stderr.on("data", (data) => { entry.text += data; });
  return { child, entry };
}

async function api(port, path, init) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json().catch(() => null) };
}
const post = (port, path, body) => api(port, path, { method: "POST", body: JSON.stringify(body) });
const answering = async (port) => (await api(port, "/api/app-update").catch(() => null))?.body;
const localRow = async (port) => (await api(port, "/api/hosts").catch(() => null))?.body?.hosts?.find((host) => host.id === "local");

/** What a user does: `ompweb -p <port>`. Resolves once the server answers. */
async function startServer(user, port, expectVersion) {
  const spawned = await spawnLogged(user, `ompweb ${expectVersion}`, join(user.prefix, "bin", "ompweb"), ["-p", String(port), "-H", "127.0.0.1"]);
  if (!spawned) return null;
  await until(async () => (await answering(port))?.currentVersion === expectVersion, `the ${expectVersion} server to answer`, user.output, 120_000);
  return spawned;
}

const statusFile = (user) => join(user.tmp, `ompweb-self-update-${process.getuid()}`, "status.json");

/** The old GUI's whole update: prepare, commit, then its status poll, here on the worker's own durable record. */
async function guiUpdate(user, port) {
  const prepared = await post(port, "/api/app-update", { action: "prepare" });
  assert.equal(prepared.status, 202, JSON.stringify(prepared.body));
  assert.equal(prepared.body.targetVersion, repoVersion);
  const committed = await post(port, "/api/app-update", { action: "commit", attemptId: prepared.body.attemptId });
  assert.deepEqual([committed.status, committed.body], [202, { accepted: true, attemptId: prepared.body.attemptId }]);
  const finished = await until(() => {
    if (!existsSync(statusFile(user))) return null;
    const status = read(statusFile(user));
    return status.attemptId === prepared.body.attemptId && ["succeeded", "failed"].includes(status.state) ? status : null;
  }, "the old update worker to finish", () => `${user.output()}\nnpm calls: ${JSON.stringify(user.npmCalls())}`, 360_000);
  return finished;
}

// ---------------------------------------------------------------- the scenario

async function scenario(t, release) {
  const user = newUser(release.version);
  const port = await freePort();
  try {
    execFileSync(realNpm, ["install", "-g", "--prefix", user.prefix, publishedTarball(release.version), "--no-audit", "--no-fund"], { env: user.env, stdio: "pipe", timeout: 300_000 });
    assert.equal(read(join(user.pkg, "package.json")).version, release.version);
    assert.equal(existsSync(join(user.pkg, "lib", "hosts")), release.daemon, `${release.version} ${release.daemon ? "has" : "has no"} host daemon sources`);

    const old = await startServer(user, port, release.version);
    if (!old) return t.skip("systemd-run cannot create the scope that keeps this test outside the service running the suite");
    let daemonPid;
    if (release.daemon) {
      const daemon = await spawnLogged(user, `ompweb host ${release.version}`, join(user.prefix, "bin", "ompweb"), ["host"]);
      await until(async () => (await localRow(port))?.status === "online" && (await localRow(port)).hostVersion === release.link, `the ${release.version} daemon to link as protocol ${release.link}`, user.output, 60_000);
      assert.equal((await localRow(port)).ompwebVersion, release.version);
      [daemonPid] = daemons(user.work);
      assert.equal(daemons(user.work).length, 1);
      assert.equal(daemon.child.exitCode, null);
    }
    const sessionsBefore = user.sessions();

    // 1. The old GUI's own update.
    const update = await guiUpdate(user, port);
    assert.equal(update.state, "succeeded", update.error);
    assert.equal(update.fromVersion, release.version);
    assert.equal(update.targetVersion, repoVersion);
    // The worker's own steps: the candidate's preflight install (0.7.x), then the global install, both from the candidate tarball.
    const installs = user.npmCalls().filter((args) => args.includes(`@kahme247/ompweb@${repoVersion}`));
    assert.deepEqual(installs.map((args) => args.includes("-g")), release.version === "0.6.0" ? [true] : [false, true], JSON.stringify(installs));
    assert.equal(read(join(user.pkg, "package.json")).version, repoVersion, "the global install now holds the candidate");

    // 2. What the GUI cannot show: the old worker killed the launcher it hands the restart to, so nothing serves.
    await sleep(10_000);
    assert.equal(await answering(port), undefined, "no server answers: the worker's restart handshake had no launcher left");
    assert.deepEqual([launchers(user.work), servers(user.work)], [[], []], "no launcher or server survives");
    if (release.daemon) assert.deepEqual(daemons(user.work), [daemonPid], "the old daemon keeps running through the failed restart");

    // 3. Recovery by the user: `ompweb` again, from the same prefix.
    const fresh = await startServer(user, port, repoVersion);
    assert.equal((await answering(port)).updateAvailable, false);
    assert.equal(launchers(user.work).length, 1);
    assert.equal(servers(user.work).length, 1);
    const row = () => localRow(port);
    if (release.daemon) {
      // The candidate server keeps the running daemon: no second one is started.
      await until(async () => (await row())?.status === (release.link === APPLICATION ? "online" : "needs-upgrade") && (await row()).hostVersion === release.link, "the old daemon to relink to the candidate server", user.output, 60_000);
      assert.deepEqual(daemons(user.work), [daemonPid]);
      assert.doesNotMatch(fresh.entry.text, /local daemon started/);
      // 4. Settings -> Hosts. An old daemon has no force contract: the plain update is refused and only the GUI's separately confirmed Force starts the recovery.
      const info = (await api(port, "/api/hosts/local/updates")).body.ompweb;
      assert.deepEqual([info.updateAvailable, info.availableVersion, info.canForceUpdate, info.forceMethod], [true, repoVersion, true, "recovery"], JSON.stringify(info));
      const refused = await post(port, "/api/hosts/local/updates", { target: "ompweb", version: repoVersion });
      assert.deepEqual([refused.status, refused.body.code], [409, "host_update_blocked"]);
      const started = await post(port, "/api/hosts/local/updates", { target: "ompweb", version: repoVersion, force: true });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      await until(async () => (await row())?.status === "online" && (await row()).hostVersion === APPLICATION && (await row()).ompwebVersion === repoVersion, "the old daemon to be replaced by the candidate's", () => `${user.output()}\nnpm calls: ${JSON.stringify(user.npmCalls())}`, 240_000);
      await until(() => daemons(user.work).length === 1 && daemons(user.work)[0] !== daemonPid, "exactly one new daemon", () => user.output(), 60_000);
    } else {
      // No daemon before: the candidate server starts this machine's host itself.
      await until(async () => (await row())?.status === "online" && (await row()).hostVersion === APPLICATION && (await row()).ompwebVersion === repoVersion, "the candidate server's own local host to link", user.output, 90_000);
      await until(() => /local daemon started \(pid \d+\)/.test(fresh.entry.text), "the server to report that it started this machine's host", user.output, 30_000);
      assert.equal(daemons(user.work).length, 1);
    }
    assert.equal((await row()).ompwebVersion, repoVersion);
    assert.deepEqual(user.sessions(), sessionsBefore, "no update touches the sessions directory");
  } finally {
    await stopAll(user.work);
  }
}

for (const release of OLD) {
  test(`published ${release.version}: GUI update to this checkout (${repoVersion})`, { skip, timeout: 900_000 }, (t) => scenario(t, release));
}
