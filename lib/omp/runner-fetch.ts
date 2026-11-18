import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import packageJson from "../../package.json";
import { downloadHostUpdateFile, fetchHostUpdateBytes, HOST_RELEASE_MAX_MEMBER } from "../hosts/update-worker";
import { isProcessAlive } from "../process-identity";
import { createChildProcessEnvironment } from "../project-command-env";
import { isRecord } from "../type-guards";
import { fetchedOmpBin, OMP_RUNNER_ASSET, OMP_RUNNER_PIN, OMP_TAG, ompRunnerPath, ompRunnerRoot, readOmpPointer, resolveOmpBin, RUNNER_PROTOCOL, writeOmpPointer } from "./omp-cli";

// The omp runner (ompweb-omp) is built and released by the oh-my-pi fork. Every install fetches the one its build pins
// (omp-runner.json): the asset OMP_RUNNER_ASSET, checked against that release's OMP_RUNNER_CHECKSUMS. "Update omp" takes
// the same two files from the newest fork release whose OMP_RUNNER_INFO names RUNNER_PROTOCOL.
// Loaded by Node/jiti and the compiled binary: no `@/` imports.

/** The `sha256sum` listing of every runner asset a fork release attaches. */
export const OMP_RUNNER_CHECKSUMS = "ompweb-omp.sha256";
/** `{ "protocol": <RUNNER_PROTOCOL of its runners>, "omp": "<omp version>" }`: a fork release's runner metadata. */
export const OMP_RUNNER_INFO = "ompweb-omp.json";

type Pin = typeof OMP_RUNNER_PIN;
/** Prefix of a runner download a failed attempt left for the next one (downloadRunner). */
const KEPT_PARTIAL = ".partial-";
const downloadBase = ({ repo, tag }: Pin) => `https://github.com/${repo}/releases/download/${tag}`;

/** Holds `lock` for this process while `run` runs, or runs nothing and returns null while a live process holds it. */
async function withPartialLock<T>(lock: string, run: () => Promise<T>): Promise<T | null> {
  try { writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || isProcessAlive(Number(readFileSync(lock, "utf8")))) return null;
    // Its process is gone (killed by an updater's time limit, say). Only the process whose rename moves it away takes
    // the partial over: two that both saw it dead cannot both remove a lock and write one partial.
    const stale = `${lock}.${process.pid}.stale`;
    try { renameSync(lock, stale); } catch { return null; }
    rmSync(stale, { force: true });
    try { writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }); } catch { return null; }
  }
  try { return await run(); } finally { rmSync(lock, { force: true }); }
}

/** Moves a finished download into place; across filesystems (a compiled binary's directory) by copy and rename. */
function moveInto(from: string, to: string): void {
  try { return renameSync(from, to); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error; }
  const copy = `${to}.${process.pid}.${Date.now()}.partial`;
  try { copyFileSync(from, copy); chmodSync(copy, 0o755); renameSync(copy, to); } finally { rmSync(copy, { force: true }); }
  rmSync(from, { force: true });
}

/** Downloads `asset` of the fork release `pin` to `target` (atomically, executable) once its SHA-256 matches the one the
 * release's OMP_RUNNER_CHECKSUMS lists; returns that SHA-256. A failure names the file it was fetching. The download
 * goes to `.partial-<sha256 prefix>-<asset>` in this version's runner directory (a stable place: a compiled release's own
 * directory is an updater's staging directory, removed with a failed attempt), which a failed attempt keeps, so the next
 * one continues it rather than starting over on a slow link (#531); a second process fetching the same file meanwhile
 * uses a partial of its own beside `target`. */
export async function downloadRunner(pin: Pin, asset: string, target: string): Promise<string> {
  let url = `${downloadBase(pin)}/${OMP_RUNNER_CHECKSUMS}`;
  let expected: string | undefined;
  try {
    const sums = (await fetchHostUpdateBytes(url, 64 * 1024, 30_000)).toString("utf8");
    expected = sums.split("\n").map((line) => line.trim().split(/\s+\*?/)).find(([, name]) => name === asset)?.[0];
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`${OMP_RUNNER_CHECKSUMS} lists no ${asset}`);
    const sha256 = expected;
    mkdirSync(dirname(target), { recursive: true });
    url = `${downloadBase(pin)}/${asset}`;
    const download = async (partial: string, resume: boolean) => {
      try {
        const digest = await downloadHostUpdateFile(url, partial, HOST_RELEASE_MAX_MEMBER, undefined, resume);
        if (digest !== `sha256:${sha256}`) { rmSync(partial, { force: true }); throw new Error(`its SHA-256 is not the one ${OMP_RUNNER_CHECKSUMS} lists`); }
        chmodSync(partial, 0o755);
        moveInto(partial, target);
      } catch (error) {
        if (!resume) rmSync(partial, { force: true });
        throw error;
      }
    };
    const kept = join(ompRunnerRoot(), `${KEPT_PARTIAL}${sha256.slice(0, 16)}-${asset}`);
    mkdirSync(dirname(kept), { recursive: true });
    if (await withPartialLock(`${kept}.lock`, () => download(kept, true)) === null) await download(`${target}.${process.pid}.${Date.now()}.partial`, false);
    return sha256;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const missing = /\(404\)/.test(reason) ? ` (${pin.repo} release ${pin.tag} attaches no ${basename(url)})` : "";
    const seed = expected ? `, or place ${asset} (SHA-256 ${expected}) at ${target}` : "";
    throw new Error(`Could not fetch ompweb's omp from ${url}: ${reason}${missing}. Check this machine's connection to GitHub (a retry continues the download where it stopped)${seed}, or set OMP_WEB_OMP_BIN to an ompweb-omp binary.`);
  }
}

/** Downloads the runner of the release this build pins to `target` (atomically, executable) once its SHA-256 matches the release's. */
export async function fetchOmpRunner(target = fetchedOmpBin(), pin = OMP_RUNNER_PIN, asset = OMP_RUNNER_ASSET): Promise<string> {
  await downloadRunner(pin, asset, target);
  return target;
}

/** A fork release a runner can be taken from: its tag and that tag's build stamp, `YYYYMMDDHHMM`. */
export interface OmpRunnerRelease {
  tag: string;
  stamp: string;
}

type ReadBytes = (url: string, maxBytes: number, timeout: number) => Promise<Buffer>;

const RELEASE_PAGE_SIZE = 100;
/** Pages of releases (newest first) read to find a runner. shortcut: a fork whose newest 500 releases carry no matching
 * runner reads as having none; raise it if that ever happens. */
export const RELEASE_PAGE_CAP = 5;

// A published release's metadata never changes: each tag is asked once per process (a failed read is asked again).
const protocols = new Map<string, number | null>();
async function releaseProtocol(pin: Pin, read: ReadBytes): Promise<number | null> {
  const key = `${pin.repo}@${pin.tag}`;
  const known = protocols.get(key);
  if (known !== undefined) return known;
  const bytes = await read(`${downloadBase(pin)}/${OMP_RUNNER_INFO}`, 4096, 15_000);
  let protocol: number | null = null;
  try {
    const info: unknown = JSON.parse(bytes.toString("utf8"));
    if (isRecord(info) && Number.isSafeInteger(info.protocol)) protocol = info.protocol as number;
  } catch { /* not JSON: this release speaks no protocol this ompweb knows */ }
  protocols.set(key, protocol);
  return protocol;
}

/**
 * The newest published release of the fork (`repo`) whose runner speaks RUNNER_PROTOCOL: the releases are read newest
 * first, RELEASE_PAGE_SIZE a page up to RELEASE_PAGE_CAP pages; those that are drafts, are not integration builds
 * (OMP_TAG) or do not attach OMP_RUNNER_INFO, OMP_RUNNER_CHECKSUMS and every one of `assets` are skipped, and so is one
 * whose OMP_RUNNER_INFO names another protocol. Within a page the newest build stamp wins. `read` is a seam for callers
 * with a token (scripts/fetch-runner.ts) and for tests.
 */
export async function findRunnerRelease(repo = OMP_RUNNER_PIN.repo, assets = [OMP_RUNNER_ASSET], read: ReadBytes = fetchHostUpdateBytes): Promise<OmpRunnerRelease | null> {
  const needed = [OMP_RUNNER_INFO, OMP_RUNNER_CHECKSUMS, ...assets];
  for (let page = 1; page <= RELEASE_PAGE_CAP; page++) {
    const listing: unknown = JSON.parse((await read(`https://api.github.com/repos/${repo}/releases?per_page=${RELEASE_PAGE_SIZE}&page=${page}`, 8 * 1024 * 1024, 15_000)).toString("utf8"));
    if (!Array.isArray(listing)) throw new Error(`GitHub's release listing of ${repo} is not a list`);
    const candidates: OmpRunnerRelease[] = [];
    for (const release of listing) {
      if (!isRecord(release) || release.draft === true || typeof release.tag_name !== "string" || !OMP_TAG.test(release.tag_name) || !Array.isArray(release.assets)) continue;
      const names = new Set(release.assets.map((asset: unknown) => (isRecord(asset) ? asset.name : undefined)));
      if (needed.every((name) => names.has(name))) candidates.push({ tag: release.tag_name, stamp: /-int\.(\d{12})\./.exec(release.tag_name)![1] });
    }
    for (const candidate of candidates.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0))) {
      if (await releaseProtocol({ repo, tag: candidate.tag }, read) === RUNNER_PROTOCOL) return candidate;
    }
    if (listing.length < RELEASE_PAGE_SIZE) return null;
  }
  return null;
}

const RELEASES_TTL_MS = 5 * 60_000;
const RELEASES_FAILURE_TTL_MS = 30_000;
let releasesCheck: { at: number; failed: boolean; result: Promise<OmpRunnerRelease | null> } | undefined;
/** The newest fork release with a runner for this platform and RUNNER_PROTOCOL (findRunnerRelease), null when there is
 * none. The listing is cached (a status poll must not spend GitHub's unauthenticated rate limit); `refresh` bypasses the cache. */
export function latestOmpRunnerRelease(refresh = false): Promise<OmpRunnerRelease | null> {
  if (!refresh && releasesCheck && Date.now() - releasesCheck.at < (releasesCheck.failed ? RELEASES_FAILURE_TTL_MS : RELEASES_TTL_MS)) return releasesCheck.result;
  const check: NonNullable<typeof releasesCheck> = {
    at: Date.now(),
    failed: false,
    result: findRunnerRelease().catch((error: unknown) => { check.failed = true; throw error; }),
  };
  releasesCheck = check;
  return check.result;
}

const execFileAsync = promisify(execFile);
/** The runner speaks this ompweb's RUNNER_PROTOCOL (`--runner-info`) and passes omp's own start-up checks. */
async function probeOmpRunner(bin: string): Promise<void> {
  const env = createChildProcessEnvironment();
  // 60 s: a fresh ~120 MB runner's first start on Windows waits on the antivirus scan.
  const run = (argument: string) => execFileAsync(bin, [argument], { timeout: 60_000, windowsHide: true, env });
  const printed = (await run("--runner-info")).stdout.trim();
  let info: unknown;
  try { info = JSON.parse(printed); } catch { throw new Error(`--runner-info printed ${printed ? JSON.stringify(printed.slice(0, 200)) : "nothing"}, not its JSON`); }
  if (!isRecord(info) || info.protocol !== RUNNER_PROTOCOL) throw new Error(`it speaks runner protocol ${isRecord(info) ? String(info.protocol) : "(none)"}, this ompweb speaks ${RUNNER_PROTOCOL}`);
  await run("--smoke-test");
}

const STAGING = ".staging-";
const discard = (path: string) => { try { rmSync(path, { recursive: true, force: true }); } catch { /* in use (Windows): the next daemon start's sweep retries */ } };

/**
 * "Update omp": installs the runner of the fork release `tag` as `<tag>/ompweb-omp[.exe]` under this version's runner
 * directory. It is downloaded into a fresh staging directory beside it, checked there (SHA-256 from the release's listing,
 * then `probe`: --runner-info protocol and --smoke-test), and only then renamed to `<tag>` and pointed at by `current.json`.
 * Nothing already installed is touched before that: a failure at any step leaves the pointer and the selected runner as
 * they were (a copy of `tag` already there is set aside for the swap and put back if the swap fails; running sessions keep
 * their file, and Windows, which cannot move a running one, refuses the swap). Returns the installed path.
 * `probe` and `repo` are seams for tests.
 */
export async function installOmpRunner(tag: string, ompweb = packageJson.version, probe = probeOmpRunner, repo = OMP_RUNNER_PIN.repo): Promise<string> {
  if (!OMP_TAG.test(tag)) throw new Error(`${tag} is not an omp build tag`);
  const target = ompRunnerPath(tag, ompweb);
  const final = dirname(target);
  mkdirSync(ompRunnerRoot(ompweb), { recursive: true });
  const staging = mkdtempSync(join(ompRunnerRoot(ompweb), STAGING));
  const old = `${staging}.old`;
  try {
    const staged = join(staging, basename(target));
    const sha256 = await downloadRunner({ repo, tag }, OMP_RUNNER_ASSET, staged);
    try { await probe(staged); }
    catch (error) { throw new Error(`omp ${tag} downloaded but did not pass its checks: ${error instanceof Error ? error.message : String(error)}`); }
    const swapped = existsSync(final);
    if (swapped) renameSync(final, old);
    try {
      renameSync(staging, final);
      writeOmpPointer({ tag, path: target, sha256 }, ompweb);
    } catch (error) {
      if (swapped) { rmSync(final, { recursive: true, force: true }); renameSync(old, final); }
      throw error;
    }
    if (swapped) discard(old);
  } finally {
    discard(staging);
  }
  return target;
}

/** At daemon start, once it owns the host's control endpoint (so no other daemon runs from these directories): removes
 * every fork release's directory but the pointed one and this build's pinned one, and the leftovers of an install that
 * never finished. A runner a process still holds open (Windows) stays until the next start. */
export function sweepOmpRunners(ompweb = packageJson.version, pinned = OMP_RUNNER_PIN.tag): void {
  const keep = new Set([readOmpPointer(ompweb)?.tag, pinned]);
  const root = ompRunnerRoot(ompweb);
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    if (name.startsWith(STAGING) || (OMP_TAG.test(name) && !keep.has(name))) discard(join(root, name));
  }
}

let ensuring: Promise<string | null> | null = null;
/** The runner, fetched first when this install has none. One fetch at a time per process; a web server and a daemon
 * fetching together each write their own partial file. */
export function ensureOmpRunner(): Promise<string | null> {
  ensuring ??= (async () => {
    const found = resolveOmpBin(true);
    if (found || process.env.OMP_WEB_OMP_BIN) return found;
    await fetchOmpRunner();
    return resolveOmpBin(true);
  })().finally(() => { ensuring = null; });
  return ensuring;
}

/** `ompweb fetch-omp`: what updaters run on a candidate release before its preflight; exit 1 names what failed. */
export async function runFetchOmp(): Promise<number> {
  try {
    const bin = await ensureOmpRunner();
    if (!bin) throw new Error(process.env.OMP_WEB_OMP_BIN ? `OMP_WEB_OMP_BIN=${process.env.OMP_WEB_OMP_BIN} does not exist` : "the runner is still missing after the fetch");
    console.log(`omp: ${bin}`);
    return 0;
  } catch (error) {
    console.error(`fetch-omp failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
