import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { mockBuiltin } from "../../tests/mock-builtin.mjs";

// Each setup imports omp-cli fresh so it binds the mocked child_process and starts with an empty version cache.
let freshImport = 0;

async function setup(t, execute) {
  const dir = mkdtempSync(join(tmpdir(), "omp-version-"));
  const bin = join(dir, "omp");
  writeFileSync(bin, "omp/18.1.19\n");
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = bin;
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
    rmSync(dir, { recursive: true, force: true });
  });
  await mockBuiltin(t, "node:child_process", { execFile: (path, _args, _options, callback) => {
    if (execute) execute(callback);
    else callback(null, readFileSync(path, "utf8"));
  } });
  const { getOmpVersion } = await import(`./omp-cli.ts?fresh=${freshImport++}`);
  return { dir, bin, getOmpVersion };
}

test("unchanged executables reuse the version without launching another process", async (t) => {
  let launches = 0;
  const { bin, getOmpVersion } = await setup(t, (callback) => {
    launches++;
    callback(null, readFileSync(bin, "utf8"));
  });
  assert.equal(await getOmpVersion(), "omp/18.1.19");
  assert.equal(await getOmpVersion(), "omp/18.1.19");
  assert.equal(launches, 1);
  writeFileSync(bin, "omp/18.1.210\n");
  assert.equal(await getOmpVersion(), "omp/18.1.210");
  assert.equal(launches, 2);
});

test("atomic replacement invalidates even with the same size and modification time", async (t) => {
  const { dir, bin, getOmpVersion } = await setup(t);
  const original = statSync(bin);
  // Normalize both mtimes to the same precision before taking the cache snapshot.
  utimesSync(bin, original.atime, original.mtime);
  assert.equal(await getOmpVersion(), "omp/18.1.19");
  const replacement = join(dir, "replacement");
  writeFileSync(replacement, "omp/18.1.21\n");
  utimesSync(replacement, original.atime, original.mtime);
  assert.equal(statSync(replacement, { bigint: true }).mtimeNs, statSync(bin, { bigint: true }).mtimeNs);
  renameSync(replacement, bin);
  assert.equal(await getOmpVersion(), "omp/18.1.21");
});

test("retargeting the release directory invalidates the cached version", async (t) => {
  const { dir, bin, getOmpVersion } = await setup(t);
  const first = join(dir, "first");
  const second = join(dir, "second");
  mkdirSync(first);
  mkdirSync(second);
  renameSync(bin, join(first, "omp"));
  writeFileSync(join(second, "omp"), "omp/18.1.21\n");
  const current = join(dir, "current");
  symlinkSync(first, current, "junction");
  process.env.OMP_WEB_OMP_BIN = join(current, "omp");
  assert.equal(await getOmpVersion(), "omp/18.1.19");
  rmSync(current);
  symlinkSync(second, current, "junction");
  assert.equal(await getOmpVersion(), "omp/18.1.21");
});

test("unchanged launchers are re-probed after the five-minute safety expiry", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let installedVersion = "omp/18.1.19\n";
  const { getOmpVersion } = await setup(t, (callback) => callback(null, installedVersion));
  assert.equal(await getOmpVersion(), "omp/18.1.19");
  installedVersion = "omp/18.1.21\n";
  now += 5 * 60_000 - 1;
  assert.equal(await getOmpVersion(), "omp/18.1.19");
  now++;
  assert.equal(await getOmpVersion(), "omp/18.1.21");
});

test("overlapping version lookups share a result instead of racing failure backoff", async (t) => {
  const callbacks = [];
  const { bin, getOmpVersion } = await setup(t, (callback) => callbacks.push(callback));
  const first = getOmpVersion();
  const second = getOmpVersion();
  if (callbacks.length > 1) {
    callbacks[1](null, "omp/18.1.19\n");
    await second;
    callbacks[0](new Error("executable replaced during update"), "");
  } else {
    callbacks[0](null, "omp/18.1.19\n");
  }
  assert.deepEqual(await Promise.all([first, second]), ["omp/18.1.19", "omp/18.1.19"]);
  writeFileSync(bin, "omp/18.1.210\n");
  const refreshed = getOmpVersion();
  callbacks.at(-1)(null, "omp/18.1.210\n");
  assert.equal(await refreshed, "omp/18.1.210");
});

test("an update during a probe does not cache its old result", async (t) => {
  const callbacks = [];
  const { bin, getOmpVersion } = await setup(t, (callback) => callbacks.push(callback));
  const first = getOmpVersion();
  writeFileSync(bin, "omp/18.1.210\n");
  callbacks[0](null, "omp/18.1.19\n");
  assert.equal(await first, "omp/18.1.19");
  const refreshed = getOmpVersion();
  callbacks.at(-1)(null, "omp/18.1.210\n");
  assert.equal(await refreshed, "omp/18.1.210");
});

test("changed executables recover immediately from a failed-probe backoff", async (t) => {
  let fail = true;
  const { bin, getOmpVersion } = await setup(t, (callback) => {
    callback(fail ? new Error("update in progress") : null, "omp/18.1.21\n");
  });
  assert.equal(await getOmpVersion(), null);
  fail = false;
  writeFileSync(bin, "updated executable\n");
  assert.equal(await getOmpVersion(), "omp/18.1.21");
});

test("removing an executable never serves its cached version", async (t) => {
  const { bin, getOmpVersion } = await setup(t);
  assert.equal(await getOmpVersion(), "omp/18.1.19");
  rmSync(bin);
  assert.equal(await getOmpVersion(), null);
});

test("a packaged runner is resolved from its actual module root, not cwd, the package-dir hint or the shared cache", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omp-package-runner-")));
  const packageDir = join(root, "package");
  const elsewhere = join(root, "unrelated-cwd");
  const keys = ["OMP_WEB_OMP_BIN", "OMP_WEB_PACKAGE_DIR", "PI_CODING_AGENT_DIR"];
  const previous = keys.map((key) => process.env[key]);
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    rmSync(root, { recursive: true, force: true });
  });
  delete process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_PACKAGE_DIR = elsewhere;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  mkdirSync(join(packageDir, "lib", "omp"), { recursive: true });
  mkdirSync(elsewhere);
  process.chdir(elsewhere);
  const binName = process.platform === "win32" ? "ompweb-omp.exe" : "ompweb-omp";
  const runner = join(packageDir, binName);
  writeFileSync(runner, "approved per-install runner");
  writeFileSync(join(elsewhere, binName), "unrelated cwd runner");
  const modulePath = join(packageDir, "lib", "omp", "omp-cli.ts");
  const source = readFileSync(new URL("./omp-cli.ts", import.meta.url), "utf8")
    .replace('"../project-command-env"', JSON.stringify(new URL("../project-command-env.ts", import.meta.url).href))
    .replace('"./paths"', JSON.stringify(new URL("./paths.ts", import.meta.url).href));
  writeFileSync(modulePath, source);
  copyFileSync(new URL("../../package.json", import.meta.url), join(packageDir, "package.json"));
  copyFileSync(new URL("../../omp-runner.json", import.meta.url), join(packageDir, "omp-runner.json"));
  const api = await import(`${pathToFileURL(modulePath).href}?fresh=${freshImport++}`);
  const cache = api.fetchedOmpBin();
  mkdirSync(join(cache, ".."), { recursive: true });
  writeFileSync(cache, "unrelated shared runner");
  assert.equal(api.resolveOmpBin(true), runner);
  rmSync(runner);
  assert.equal(api.resolveOmpBin(true), cache, "packages without a local runner keep the existing version-cache behavior");
  const override = join(root, "explicit-user-runner");
  writeFileSync(override, "operator override");
  process.env.OMP_WEB_OMP_BIN = override;
  const overrideModulePath = join(packageDir, "lib", "omp", "omp-cli-override.ts");
  writeFileSync(overrideModulePath, source);
  const overridden = await import(pathToFileURL(overrideModulePath).href);
  assert.equal(overridden.resolveOmpBin(true), override);
});

test("resolveOmpBin prefers a valid runner pointer and falls back when its file is missing or its SHA-256 differs", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omp-pointer-")));
  const keys = ["OMP_WEB_OMP_BIN", "OMP_WEB_PACKAGE_DIR", "PI_CODING_AGENT_DIR"];
  const previous = keys.map((key) => process.env[key]);
  t.after(() => {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    rmSync(root, { recursive: true, force: true });
  });
  delete process.env.OMP_WEB_OMP_BIN;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const api = await import(`./omp-cli.ts?fresh=${freshImport++}`);
  const tag = "v18.23.0-int.202611201200.gabc1234";
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const point = (pointer) => writeFileSync(join(api.ompRunnerRoot(), "current.json"), JSON.stringify(pointer));

  const bundled = api.fetchedOmpBin();
  mkdirSync(join(bundled, ".."), { recursive: true });
  writeFileSync(bundled, "the release's own runner");
  assert.equal(api.resolveOmpBin(true), bundled, "without a pointer the fetched runner is used");

  const pointed = api.ompRunnerPath(tag);
  mkdirSync(join(pointed, ".."), { recursive: true });
  writeFileSync(pointed, "the newer runner");
  const valid = { tag, path: pointed, sha256: sha("the newer runner") };
  point(valid);
  assert.equal(api.resolveOmpBin(), pointed, "a pointer whose file still has the recorded SHA-256 wins");

  writeFileSync(pointed, "a different runner");
  assert.equal(api.resolveOmpBin(), bundled, "a file with another SHA-256 is not used");
  writeFileSync(pointed, "the newer runner");
  assert.equal(api.resolveOmpBin(), pointed, "restoring the recorded bytes makes it valid again");

  rmSync(pointed);
  assert.equal(api.resolveOmpBin(), bundled, "a missing pointed file falls back");
  writeFileSync(pointed, "the newer runner");

  for (const pointer of [
    { ...valid, path: join(root, "elsewhere") },
    { ...valid, tag: "v18.23.0/../x" },
    { ...valid, sha256: "not a digest" },
    "not an object",
  ]) {
    point(pointer);
    assert.equal(api.resolveOmpBin(), bundled, `${JSON.stringify(pointer)} is not trusted`);
  }

  point(valid);
  assert.equal(api.resolveOmpBin(), pointed);
  const override = join(root, "explicit-user-runner");
  writeFileSync(override, "operator override");
  process.env.OMP_WEB_OMP_BIN = override;
  const overridden = await import(`./omp-cli.ts?fresh=${freshImport++}`);
  assert.equal(overridden.resolveOmpBin(true), override, "the operator's override is never replaced by a pointer");
});

test("omp-runner.json pins a release of the fork by an omp build tag, and the protocol this ompweb speaks is an integer", async () => {
  const { OMP_RUNNER_PIN, OMP_TAG, RUNNER_PROTOCOL, fetchedOmpBin, ompRunnerPath } = await import(`./omp-cli.ts?fresh=${freshImport++}`);
  assert.deepEqual(Object.keys(OMP_RUNNER_PIN).sort(), ["repo", "tag"]);
  assert.match(OMP_RUNNER_PIN.repo, /^[\w.-]+\/[\w.-]+$/);
  assert.match(OMP_RUNNER_PIN.tag, OMP_TAG, "the tag becomes a path segment");
  if (!globalThis.Bun?.isStandaloneExecutable) assert.equal(fetchedOmpBin(), ompRunnerPath(OMP_RUNNER_PIN.tag), "a new pin has a new directory");
  assert.ok(Number.isSafeInteger(RUNNER_PROTOCOL) && RUNNER_PROTOCOL >= 1);
});
