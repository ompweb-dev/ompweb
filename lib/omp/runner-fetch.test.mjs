import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const { fetchOmpRunner, findRunnerRelease, installOmpRunner, OMP_RUNNER_CHECKSUMS, OMP_RUNNER_INFO, RELEASE_PAGE_CAP, sweepOmpRunners } = await import("./runner-fetch.ts");
const { OMP_RUNNER_ASSET, OMP_RUNNER_PIN, ompRunnerPath, ompRunnerRoot, readOmpPointer, RUNNER_PROTOCOL } = await import("./omp-cli.ts");
const dir = mkdtempSync(join(tmpdir(), "ompweb-runner-fetch-"));
// Kept partial downloads live in the agent directory's runner root: never the real one.
process.env.PI_CODING_AGENT_DIR = join(dir, "agent-default");
const original = globalThis.fetch;
after(() => { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); });

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const base = (repo, tag) => `https://github.com/${repo}/releases/download/${tag}`;
const TAG = "v18.23.0-int.202611201200.gabc1234";
const OLD_TAG = "v18.22.0-int.202611171027.gec3956c";
const FORK = { repo: "fork/oh-my-pi", tag: TAG };
const runner = Buffer.from("#!/bin/sh\necho runner\n");

/** Serves one fork release's checksum listing and runner asset; `served` records each URL asked for. */
function serveRelease({ repo, tag }, sums, binary = runner, served = []) {
  globalThis.fetch = async (url) => {
    served.push(String(url));
    if (String(url) === `${base(repo, tag)}/${OMP_RUNNER_CHECKSUMS}`) return new Response(sums);
    if (String(url) === `${base(repo, tag)}/${OMP_RUNNER_ASSET}`) return new Response(binary);
    return new Response("missing", { status: 404 });
  };
  return served;
}

test("the runner comes from the pinned fork release, checked against its checksum listing, and lands executable", async () => {
  const served = serveRelease(FORK, `${"0".repeat(64)}  ompweb-omp-other\n${digest(runner)}  ${OMP_RUNNER_ASSET}\n`);
  const target = join(dir, "ok", "ompweb-omp");
  assert.equal(await fetchOmpRunner(target, FORK), target);
  assert.deepEqual(readFileSync(target), runner);
  if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(served, [`${base(FORK.repo, TAG)}/${OMP_RUNNER_CHECKSUMS}`, `${base(FORK.repo, TAG)}/${OMP_RUNNER_ASSET}`]);
  assert.deepEqual(readdirSync(join(dir, "ok")), ["ompweb-omp"], "no partial file is left");
});

test("a failed attempt keeps its partial download in the runner root and the next attempt continues it (#531)", async () => {
  const sums = `${digest(runner)}  ${OMP_RUNNER_ASSET}\n`;
  const target = join(dir, "resume", "ompweb-omp");
  const partial = join(ompRunnerRoot(), `.partial-${digest(runner).slice(0, 16)}-${OMP_RUNNER_ASSET}`);
  const ranges = [];
  // The first asset response sends 10 bytes and then fails with no byte more, every retry included.
  let broken = true;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith(OMP_RUNNER_CHECKSUMS)) return new Response(sums);
    const range = init.headers.Range ?? null;
    ranges.push(range);
    if (broken) {
      if (range) throw new TypeError("fetch failed");
      let pulls = 0;
      return new Response(new ReadableStream({ pull(controller) { if (pulls++ === 0) controller.enqueue(runner.subarray(0, 10)); else controller.error(new TypeError("terminated")); } }));
    }
    const from = Number(/^bytes=(\d+)-$/.exec(range)[1]);
    return new Response(runner.subarray(from), { status: 206, headers: { "content-range": `bytes ${from}-${runner.length - 1}/${runner.length}` } });
  };
  await assert.rejects(fetchOmpRunner(target, FORK), (error) => {
    assert.ok(error.message.includes(`place ${OMP_RUNNER_ASSET} (SHA-256 ${digest(runner)}) at ${partial}`), error.message);
    return true;
  });
  assert.deepEqual(readFileSync(partial), runner.subarray(0, 10));
  assert.equal(existsSync(`${partial}.lock`), false, "the lock is released");
  // As after an updater killed the attempt: its lock names a process that is gone. The next attempt takes it over.
  writeFileSync(`${partial}.lock`, "2147483646");
  broken = false;
  ranges.length = 0;
  await fetchOmpRunner(target, FORK);
  assert.deepEqual(ranges, ["bytes=10-"]);
  assert.deepEqual(readFileSync(target), runner);
  assert.deepEqual(readdirSync(join(dir, "resume")), ["ompweb-omp"]);
  assert.equal(existsSync(partial), false);
  assert.equal(existsSync(`${partial}.lock`), false);
});

test("a complete runner placed at the kept partial's path is checked and installed (#531)", async () => {
  const sums = `${digest(runner)}  ${OMP_RUNNER_ASSET}\n`;
  const partial = join(ompRunnerRoot(), `.partial-${digest(runner).slice(0, 16)}-${OMP_RUNNER_ASSET}`);
  mkdirSync(ompRunnerRoot(), { recursive: true });
  writeFileSync(partial, runner);
  globalThis.fetch = async (url) => (String(url).endsWith(OMP_RUNNER_CHECKSUMS) ? new Response(sums) : new Response(null, { status: 416 }));
  const target = join(dir, "placed", "ompweb-omp");
  await fetchOmpRunner(target, FORK);
  assert.deepEqual(readFileSync(target), runner);
  assert.equal(existsSync(partial), false);
});

test("a partial another live process is downloading is left to it: this one downloads to a file of its own", async () => {
  serveRelease(FORK, `${digest(runner)}  ${OMP_RUNNER_ASSET}\n`);
  const target = join(dir, "locked", "ompweb-omp");
  const partial = join(ompRunnerRoot(), `.partial-${digest(runner).slice(0, 16)}-${OMP_RUNNER_ASSET}`);
  mkdirSync(ompRunnerRoot(), { recursive: true });
  writeFileSync(partial, "someone else's bytes");
  writeFileSync(`${partial}.lock`, String(process.pid));
  try {
    await fetchOmpRunner(target, FORK);
    assert.deepEqual(readFileSync(target), runner);
    assert.equal(readFileSync(partial, "utf8"), "someone else's bytes");
    assert.deepEqual(readdirSync(join(dir, "locked")), ["ompweb-omp"]);
  } finally { rmSync(partial, { force: true }); rmSync(`${partial}.lock`, { force: true }); }
});

test("a kept partial whose digest is wrong is removed, so the next attempt starts over", async () => {
  serveRelease(FORK, `${"b".repeat(64)}  ${OMP_RUNNER_ASSET}\n`);
  await assert.rejects(fetchOmpRunner(join(dir, "wrong", "ompweb-omp"), FORK), /SHA-256/);
  assert.equal(existsSync(join(ompRunnerRoot(), `.partial-${"b".repeat(16)}-${OMP_RUNNER_ASSET}`)), false);
});

test("the baked-in pin is what an install fetches from by default", async () => {
  const served = serveRelease(OMP_RUNNER_PIN, `${digest(runner)}  ${OMP_RUNNER_ASSET}\n`);
  const target = join(dir, "default", "ompweb-omp");
  await fetchOmpRunner(target);
  assert.deepEqual(served, [`${base(OMP_RUNNER_PIN.repo, OMP_RUNNER_PIN.tag)}/${OMP_RUNNER_CHECKSUMS}`, `${base(OMP_RUNNER_PIN.repo, OMP_RUNNER_PIN.tag)}/${OMP_RUNNER_ASSET}`]);
});

test("a runner whose SHA-256 differs from the listed one is refused and nothing is written", async () => {
  serveRelease(FORK, `${"a".repeat(64)}  ${OMP_RUNNER_ASSET}\n`);
  const target = join(dir, "mismatch", "ompweb-omp");
  await assert.rejects(fetchOmpRunner(target, FORK), /SHA-256/);
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(join(dir, "mismatch")), []);
  serveRelease(FORK, `${digest(runner)}  ompweb-omp-other\n`);
  await assert.rejects(fetchOmpRunner(target, FORK), new RegExp(`lists no ${OMP_RUNNER_ASSET}`));
});

test("a release without the runner's assets fails with a message that names the missing asset", async () => {
  globalThis.fetch = async () => new Response("Not Found", { status: 404 });
  await assert.rejects(fetchOmpRunner(join(dir, "none", "ompweb-omp"), FORK), (error) => {
    assert.ok(error.message.includes(`${base(FORK.repo, TAG)}/${OMP_RUNNER_CHECKSUMS}`), error.message);
    assert.ok(error.message.includes(`${FORK.repo} release ${TAG} attaches no ${OMP_RUNNER_CHECKSUMS}`), error.message);
    return true;
  });
  globalThis.fetch = async (url) => (String(url).endsWith(OMP_RUNNER_CHECKSUMS) ? new Response(`${digest(runner)}  ${OMP_RUNNER_ASSET}\n`) : new Response("Not Found", { status: 404 }));
  await assert.rejects(fetchOmpRunner(join(dir, "none", "ompweb-omp"), FORK), new RegExp(`attaches no ${OMP_RUNNER_ASSET}`));
  assert.equal(existsSync(join(dir, "none", "ompweb-omp")), false);
});

test("offline, the error names the runner URL and OMP_WEB_OMP_BIN", async () => {
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  const target = join(dir, "offline", "ompweb-omp");
  await assert.rejects(fetchOmpRunner(target, FORK), (error) => {
    assert.ok(error.message.includes(base(FORK.repo, TAG)), error.message);
    assert.match(error.message, /fetch failed.*OMP_WEB_OMP_BIN/);
    return true;
  });
  assert.equal(existsSync(target), false);
});

/** A GitHub release listing entry attaching the runner assets (`assets` overrides the list). */
const release = (tag_name, extra = {}) => ({ tag_name, draft: false, prerelease: true, assets: [OMP_RUNNER_INFO, OMP_RUNNER_CHECKSUMS, OMP_RUNNER_ASSET].map((name) => ({ name })), ...extra });
/** Serves `pages` of a fork's release listing and each tag's ompweb-omp.json (`protocols[tag]`); `served` records every URL. */
function serveListing(repo, pages, protocols, served = []) {
  globalThis.fetch = async (url) => {
    url = String(url);
    served.push(url);
    const page = new RegExp(`^https://api.github.com/repos/${repo}/releases\\?per_page=100&page=(\\d+)$`).exec(url);
    if (page) return Number(page[1]) <= pages.length ? new Response(JSON.stringify(pages[Number(page[1]) - 1])) : new Response("[]");
    for (const [tag, protocol] of Object.entries(protocols)) if (url === `${base(repo, tag)}/${OMP_RUNNER_INFO}`) return new Response(JSON.stringify({ protocol, omp: tag.slice(1) }));
    return new Response("missing", { status: 404 });
  };
  return served;
}

test("a release whose runner speaks another protocol is skipped, whatever its stamp; so is anything that is not a usable fork build", async () => {
  const repo = "fork/skips";
  const NEWEST = "v18.25.0-int.202611250000.g1111111";
  const NEWER = "v18.24.0-int.202611220000.g2222222";
  const listing = [
    release(NEWEST), // newest, but another protocol
    release("v18.26.0-int.202611260000.g3333333", { draft: true }),
    release("v18.26.0-int.202611260000.g4444444", { assets: [{ name: OMP_RUNNER_INFO }] }), // no runner assets yet
    release("v18.26.0-int.202611260000.g5555555", { assets: [{ name: OMP_RUNNER_INFO }, { name: OMP_RUNNER_CHECKSUMS }, { name: "ompweb-omp-other" }] }), // none for this platform
    release("v18.26.0"), // not an integration build
    release("v18.26.0-int.20261126.g6666666"),
    release("v18.26.0-int.202611260000.g6666666/../x"),
    { tag_name: 7 },
    null,
    release(OLD_TAG),
    release(NEWER),
  ];
  const served = serveListing(repo, [listing], { [NEWEST]: RUNNER_PROTOCOL + 1, [NEWER]: RUNNER_PROTOCOL, [OLD_TAG]: RUNNER_PROTOCOL });
  assert.deepEqual(await findRunnerRelease(repo), { tag: NEWER, stamp: "202611220000" });
  assert.ok(served.includes(`${base(repo, NEWEST)}/${OMP_RUNNER_INFO}`), "the newer build's protocol was read, and refused");
  assert.equal(served.some((url) => url.includes("g3333333") || url.includes("g4444444") || url.includes("g5555555")), false, "a release without the assets is never asked about");
  assert.equal(await findRunnerRelease(repo, ["ompweb-omp-no-such-platform"]), null, "an asset list that no release attaches finds none");
});

/** `count` releases, newest first from `stamp`, each a distinct valid tag. */
const releases = (count, offset) => Array.from({ length: count }, (_, index) => release(`v18.0.0-int.${String(202611200000 - offset - index).padStart(12, "0")}.g${(offset + index).toString(16).padStart(7, "0")}`));

test("a runner release found on the second page is the one chosen; a first page that is not full ends the search", async () => {
  const repo = "fork/pages";
  const first = releases(100, 0);
  const wanted = releases(1, 100)[0];
  const second = [...releases(5, 101), wanted];
  const protocols = Object.fromEntries([...first, ...second].map((entry) => [entry.tag_name, RUNNER_PROTOCOL + 1]));
  protocols[wanted.tag_name] = RUNNER_PROTOCOL;
  const served = serveListing(repo, [first, second], protocols);
  assert.equal((await findRunnerRelease(repo))?.tag, wanted.tag_name);
  assert.ok(served.includes(`https://api.github.com/repos/${repo}/releases?per_page=100&page=2`));

  const short = serveListing("fork/short", [releases(3, 0)], Object.fromEntries(releases(3, 0).map((entry) => [entry.tag_name, RUNNER_PROTOCOL + 1])));
  assert.equal(await findRunnerRelease("fork/short"), null);
  assert.deepEqual(short.filter((url) => url.startsWith("https://api.github.com/")), ["https://api.github.com/repos/fork/short/releases?per_page=100&page=1"], "a short page is the last");
});

test("the search reads at most RELEASE_PAGE_CAP pages and finds none beyond them; a listing that is not a list fails", async () => {
  const repo = "fork/capped";
  const pages = Array.from({ length: RELEASE_PAGE_CAP + 2 }, (_, page) => releases(100, page * 100));
  const protocols = Object.fromEntries(pages.flat().map((entry) => [entry.tag_name, RUNNER_PROTOCOL + 1]));
  protocols[pages[RELEASE_PAGE_CAP][0].tag_name] = RUNNER_PROTOCOL; // a match one page past the cap
  const served = serveListing(repo, pages, protocols);
  assert.equal(await findRunnerRelease(repo), null);
  assert.equal(served.filter((url) => url.startsWith("https://api.github.com/")).length, RELEASE_PAGE_CAP);

  globalThis.fetch = async () => new Response(JSON.stringify({ message: "API rate limit exceeded" }));
  await assert.rejects(findRunnerRelease("fork/limited"), /not a list/);
  globalThis.fetch = async () => new Response("busy", { status: 503 });
  await assert.rejects(findRunnerRelease("fork/busy"), /503/);
});

const pointerFile = () => join(ompRunnerRoot("9.9.9"), "current.json");
const asBuild = (tag) => Buffer.from(`#!/bin/sh\necho omp/${tag.slice(1)}\n`);
/** Serves the fork releases' checksum listings and binaries; a binary maps to the SHA-256 its listing claims. */
function serveBuilds(builds, repo = FORK.repo) {
  globalThis.fetch = async (url) => {
    url = String(url);
    for (const [tag, { binary, listed, status }] of Object.entries(builds)) {
      if (status && url.startsWith(base(repo, tag))) return new Response("error", { status });
      if (url === `${base(repo, tag)}/${OMP_RUNNER_CHECKSUMS}`) return new Response(`${listed}  ${OMP_RUNNER_ASSET}\n`);
      if (url === `${base(repo, tag)}/${OMP_RUNNER_ASSET}`) return new Response(binary);
    }
    return new Response("missing", { status: 404 });
  };
}
const good = (tag) => { const binary = asBuild(tag); return { binary, listed: digest(binary) }; };

let agents = 0;
async function inAgentDir(t) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, `agent-${agents++}`);
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
}
const install = (tag, probe = async () => {}) => installOmpRunner(tag, "9.9.9", probe, FORK.repo);

test("a build is staged and probed where it was downloaded, and only then moved into place and pointed at", async (t) => {
  await inAgentDir(t);
  serveBuilds({ [TAG]: good(TAG) });
  const probes = [];
  const path = await install(TAG, async (bin) => { probes.push([bin, existsSync(join(ompRunnerRoot("9.9.9"), TAG)), existsSync(pointerFile())]); });
  assert.equal(path, ompRunnerPath(TAG, "9.9.9"));
  assert.deepEqual(readFileSync(path), asBuild(TAG));
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o755);
  assert.equal(probes.length, 1);
  assert.ok(probes[0][0].startsWith(join(ompRunnerRoot("9.9.9"), ".staging-")), "the probe runs on the staged file");
  assert.deepEqual(probes[0].slice(1), [false, false], "neither the final directory nor the pointer exists while it is probed");
  assert.deepEqual(readOmpPointer("9.9.9"), { tag: TAG, path, sha256: digest(asBuild(TAG)) });
  assert.deepEqual(readdirSync(ompRunnerRoot("9.9.9")).sort(), ["current.json", TAG], "no staging directory is left");
  assert.deepEqual(readdirSync(join(ompRunnerRoot("9.9.9"), TAG)), [process.platform === "win32" ? "ompweb-omp.exe" : "ompweb-omp"]);
});

test("a failed download or probe leaves the pointer and the selected runner exactly as they were, a same-tag reinstall included", async (t) => {
  await inAgentDir(t);
  serveBuilds({ [OLD_TAG]: good(OLD_TAG), [TAG]: good(TAG) });
  const old = await install(OLD_TAG);
  const selected = await install(TAG);
  const pointer = readFileSync(pointerFile(), "utf8");
  const untouched = (why) => {
    assert.equal(readFileSync(pointerFile(), "utf8"), pointer, why);
    assert.deepEqual(readFileSync(selected), asBuild(TAG), why);
    assert.deepEqual(readFileSync(old), asBuild(OLD_TAG), why);
    assert.deepEqual(readdirSync(ompRunnerRoot("9.9.9")).sort(), ["current.json", OLD_TAG, TAG].sort(), `${why}: nothing is left behind`);
  };

  serveBuilds({ [TAG]: { binary: asBuild("v18.99.0-int.202611990000.gfffffff"), listed: digest("something else") } });
  await assert.rejects(install(TAG, async () => assert.fail("a refused download is never run")), /SHA-256/);
  untouched("a checksum mismatch");

  serveBuilds({ [TAG]: { ...good(TAG), status: 503 } });
  await assert.rejects(install(TAG), /503/);
  untouched("a failed download");

  serveBuilds({ [TAG]: good(TAG) });
  await assert.rejects(install(TAG, async () => { throw new Error("smoke test failed"); }), /did not pass its checks: smoke test failed/);
  untouched("a probe that fails");

  await assert.rejects(installOmpRunner("v18.23.0-int.202611201200.g0000000", "9.9.9", async () => {}, FORK.repo), /attaches no/);
  untouched("a release without the runner");
  assert.equal(existsSync(join(ompRunnerRoot("9.9.9"), "v18.23.0-int.202611201200.g0000000")), false);
});

test("a build that fails the --runner-info protocol check is not installed", { skip: process.platform === "win32" && "the fake runners are POSIX shell scripts" }, async (t) => {
  await inAgentDir(t);
  const fake = (protocol, smoke = 0) => Buffer.from(`#!/bin/sh\ncase "$1" in\n  --runner-info) echo '{"protocol":${protocol},"omp":"18.23.0"}' ;;\n  --smoke-test) exit ${smoke} ;;\nesac\n`);
  const serve = (binary) => serveBuilds({ [TAG]: { binary, listed: digest(binary) } });
  const root = ompRunnerRoot("9.9.9");

  serve(fake(RUNNER_PROTOCOL + 1));
  await assert.rejects(installOmpRunner(TAG, "9.9.9", undefined, FORK.repo), new RegExp(`protocol ${RUNNER_PROTOCOL + 1}, this ompweb speaks ${RUNNER_PROTOCOL}`));
  serve(Buffer.from("#!/bin/sh\necho omp/18.23.0\n"));
  await assert.rejects(installOmpRunner(TAG, "9.9.9", undefined, FORK.repo), /--runner-info printed/);
  serve(fake(RUNNER_PROTOCOL, 1));
  await assert.rejects(installOmpRunner(TAG, "9.9.9", undefined, FORK.repo), /did not pass its checks/);
  assert.equal(readOmpPointer("9.9.9"), null);
  assert.deepEqual(readdirSync(root), [], "no refused build stays");

  serve(fake(RUNNER_PROTOCOL));
  assert.equal(await installOmpRunner(TAG, "9.9.9", undefined, FORK.repo), ompRunnerPath(TAG, "9.9.9"));
  assert.equal(readOmpPointer("9.9.9").tag, TAG);
});

test("reinstalling the selected tag swaps its directory and repoints, and puts the old runner back when the swap fails", async (t) => {
  await inAgentDir(t);
  const first = asBuild(TAG);
  const second = Buffer.concat([first, Buffer.from("# rebuilt\n")]);
  serveBuilds({ [TAG]: { binary: first, listed: digest(first) } });
  const path = await install(TAG);
  serveBuilds({ [TAG]: { binary: second, listed: digest(second) } });
  await install(TAG);
  assert.deepEqual(readFileSync(path), second);
  assert.equal(readOmpPointer("9.9.9").sha256, digest(second));
  assert.deepEqual(readdirSync(ompRunnerRoot("9.9.9")).sort(), ["current.json", TAG], "the displaced copy is removed");

  // A pointer that cannot be written (its name is taken by a directory) fails after the swap: the old copy comes back.
  const third = Buffer.concat([first, Buffer.from("# once more\n")]);
  rmSync(pointerFile());
  mkdirSync(pointerFile());
  serveBuilds({ [TAG]: { binary: third, listed: digest(third) } });
  await assert.rejects(install(TAG));
  assert.deepEqual(readFileSync(path), second, "the runner in use was put back");
  assert.deepEqual(readdirSync(ompRunnerRoot("9.9.9")).sort(), ["current.json", TAG]);
});

test("only an omp build tag is installed, and a start-up sweep keeps the pointed and the pinned build, and removes the rest and unfinished installs", async (t) => {
  await inAgentDir(t);
  await assert.rejects(install("v18.23.0/../../x"), /not an omp build tag/);
  const THIRD = "v18.24.0-int.202611250000.g7654321";
  serveBuilds({ [OLD_TAG]: good(OLD_TAG), [TAG]: good(TAG), [THIRD]: good(THIRD) });
  for (const tag of [OLD_TAG, TAG]) await install(tag);
  const root = ompRunnerRoot("9.9.9");
  mkdirSync(join(root, THIRD));
  mkdirSync(join(root, "not-a-build"));
  mkdirSync(join(root, ".staging-abc"));
  writeFileSync(join(root, ".staging-abc.old"), "x");
  sweepOmpRunners("9.9.9", THIRD);
  assert.deepEqual(readdirSync(root).sort(), ["current.json", "not-a-build", THIRD, TAG].sort());
});
