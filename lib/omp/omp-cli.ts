import { execFile } from "child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "node:url";
import packageJson from "../../package.json";
import runnerPin from "../../omp-runner.json";
import { createChildProcessEnvironment } from "../project-command-env";
import { getAgentDir } from "./paths";

/**
 * Locating and probing ompweb's own omp build (`ompweb-omp`, built and released by the oh-my-pi fork: omp-runner.json
 * names the release this ompweb build fetches). omp-web never embeds the (Bun-only) @oh-my-pi SDK — every live-agent
 * capability goes through that binary, so its absence is a first-class, user-visible state.
 */

let cachedBin: string | null = null;
let binMissAt = 0;
let cachedVersion: { fingerprint: string; value: string; expiresAt: number } | null = null;
let versionMiss: { fingerprint: string | null; retryAt: number } | null = null;
let versionProbe: Promise<string | null> | null = null;

const BIN_NAME = process.platform === "win32" ? "ompweb-omp.exe" : "ompweb-omp";
/** The release asset of `<os>-<arch>`'s runner (`linux-x64`, `windows-x64`...): `ompweb-omp-<os>-<arch>[.exe]`. */
export const runnerAsset = (target: string): string => `ompweb-omp-${target}${target.startsWith("windows-") ? ".exe" : ""}`;
/** This platform's runner asset. */
export const OMP_RUNNER_ASSET = runnerAsset(`${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`);
/** Pinned package updates require this shipped-source capability before executing the candidate. */
export const OMP_PACKAGED_RUNNER_CAPABILITY = "ompweb-packaged-runner-v1";
// .cmd/.bat launchers (e.g. OMP_WEB_OMP_BIN pointing at a wrapper script) cannot
// be spawned directly by Node — spawning them requires a shell. Route them
// through `cmd.exe /c`; every other platform and binary passes through.
const WINDOWS_SCRIPT_RE = /\.cmd$|\.bat$/i;

/** Spawn target for `bin args`, routing Windows script launchers through cmd.exe. */
export function wrapWindowsScript(bin: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === "win32" && WINDOWS_SCRIPT_RE.test(bin)) {
    return { file: "cmd.exe", args: ["/c", bin, ...args] };
  }
  return { file: bin, args };
}
// Retry missing binaries and failed version probes after a short backoff so
// a later install or repair is picked up without a web server restart.
const MISS_TTL_MS = 30_000;
// Launchers can stay unchanged while their underlying package is updated.
const VERSION_TTL_MS = 5 * 60_000;

/** An omp integration build, `v<ompVersion>-int.<YYYYMMDDHHMM>.g<sha7>`: the tag of a fork release. */
export const OMP_TAG = /^v\d+\.\d+\.\d+-int\.\d{12}\.g[0-9a-f]{7}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/** The protocol this ompweb speaks with its runner: the runner prints its own with `--runner-info` and in its release's
 * `ompweb-omp.json`. Bump it only with a change an older runner cannot speak; hosts then take no runner whose protocol differs. */
export const RUNNER_PROTOCOL = 1;

/** The fork release this ompweb build fetches its runner from (root `omp-runner.json`; a release build records the
 * newest one with a matching protocol, scripts/fetch-runner.ts). `tag` becomes a path segment: an OMP_TAG (a test checks). */
export const OMP_RUNNER_PIN: { repo: string; tag: string } = runnerPin;

/** This ompweb version's runner directory under the agent dir (an npm install's package dir may not be writable): one
 * `<omp tag>/ompweb-omp` per fork release (the pinned one this build fetches, and each "Update omp" install) and the
 * pointer `current.json` that names the "Update omp" one in use. */
export function ompRunnerRoot(version = packageJson.version): string {
  return join(getAgentDir(), "omp-web", "omp", version);
}
/** `tag` must already be an OMP_TAG: it becomes a path segment. */
export function ompRunnerPath(tag: string, version = packageJson.version): string {
  return join(ompRunnerRoot(version), tag, BIN_NAME);
}

/** Where this install keeps the runner it fetches from the pinned release (lib/omp/runner-fetch.ts): beside a compiled
 * ompweb, else the pinned tag's directory in ompRunnerRoot (a new pin has a new directory, never a stale runner). */
export function fetchedOmpBin(): string {
  return typeof Bun !== "undefined" && Bun.isStandaloneExecutable
    ? join(dirname(process.execPath), BIN_NAME)
    : ompRunnerPath(OMP_RUNNER_PIN.tag);
}

/** What "Update omp" installed: a fork release's runner (lib/omp/runner-fetch.ts `installOmpRunner`) and the SHA-256 it was verified with. */
export interface OmpPointer {
  tag: string;
  path: string;
  sha256: string;
}

/** The pointer of `version`, or null when absent, malformed, or naming anything but that version's own `<tag>/ompweb-omp`. */
export function readOmpPointer(version = packageJson.version): OmpPointer | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(ompRunnerRoot(version), "current.json"), "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { tag, path, sha256 } = value as Record<string, unknown>;
    return typeof tag === "string" && OMP_TAG.test(tag) && typeof sha256 === "string" && SHA256_HEX.test(sha256) && path === ompRunnerPath(tag, version) ? { tag, path, sha256 } : null;
  } catch {
    return null;
  }
}

/** Atomically points `version` at an installed runner: a reader sees the old pointer or the new one. */
export function writeOmpPointer(pointer: OmpPointer, version = packageJson.version): void {
  const file = join(ompRunnerRoot(version), "current.json");
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(pointer), { flag: "wx" });
  try { renameSync(temporary, file); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}

function fileSha256(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (let read = readSync(fd, chunk, 0, chunk.length, null); read > 0; read = readSync(fd, chunk, 0, chunk.length, null)) hash.update(chunk.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// The verdict on the pointed binary, per pointer and file identity: a ~120 MB hash is paid again only when either changes.
let pointerVerdict: { key: string; fingerprint: string; ok: boolean } | null = null;

/** The pointed runner while it still is the file whose SHA-256 the pointer records; null for the override (it names its
 * own runner), a missing, replaced or damaged binary, and no pointer. */
function pointedOmpBin(): string | null {
  const pointer = readOmpPointer();
  if (!pointer || process.env.OMP_WEB_OMP_BIN) return null;
  const fingerprint = versionFingerprint(pointer.path);
  if (!fingerprint) return null;
  const key = `${pointer.tag}:${pointer.sha256}`;
  if (pointerVerdict?.key !== key || pointerVerdict.fingerprint !== fingerprint) {
    let ok = false;
    try { ok = fileSha256(pointer.path) === pointer.sha256; } catch { /* unreadable: not the recorded file */ }
    pointerVerdict = { key, fingerprint, ok };
  }
  return pointerVerdict.ok ? pointer.path : null;
}

function probeOmpBin(): string | null {
  const override = process.env.OMP_WEB_OMP_BIN;
  if (override) return existsSync(override) ? override : null;
  if (typeof Bun !== "undefined" && Bun.isStandaloneExecutable) {
    const adjacent = fetchedOmpBin();
    return existsSync(adjacent) ? adjacent : null;
  }
  const packaged = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), BIN_NAME);
  if (existsSync(packaged)) return packaged;
  const fetched = fetchedOmpBin();
  return existsSync(fetched) ? fetched : null;
}

/** What every caller that needs omp reports when resolveOmpBin finds none. */
export const OMP_NOT_FOUND = "ompweb's omp binary (ompweb-omp) not found. Reinstall ompweb or set OMP_WEB_OMP_BIN.";

/** Resolve ompweb's omp binary: OMP_WEB_OMP_BIN override, else the runner "Update omp" pointed at (pointedOmpBin), else
 * the fetched runner (see probeOmpBin). Returns null when none exists. A hit is cached
 * while the file exists; a miss is re-probed after MISS_TTL_MS, or at once with `fresh` (after a fetch). The pointer is read
 * on every call, so a new session after an update starts the new runner and running ones keep theirs. */
export function resolveOmpBin(fresh = false): string | null {
  if (fresh) binMissAt = 0;
  const pointed = pointedOmpBin();
  if (pointed) return pointed;
  // A global Bun/npm update can replace or remove its launcher while this
  // server process is still alive. Never keep returning a stale cache entry.
  if (cachedBin && existsSync(cachedBin)) return cachedBin;
  cachedBin = null;
  if (Date.now() - binMissAt < MISS_TTL_MS) return null;
  const found = probeOmpBin();
  if (found) {
    cachedBin = found;
    binMissAt = 0;
    return found;
  }
  binMissAt = Date.now();
  return null;
}

/** Return the installed CLI version, using file metadata to invalidate cached
 * results without launching omp on every visit. An expiry covers opaque
 * launchers; concurrent callers share a probe. */
export function getOmpVersion(fresh = false): Promise<string | null> {
  // fresh: a probe of its own, past the miss caches; one in flight may have looked before the binary arrived.
  if (fresh) { binMissAt = 0; versionMiss = null; return probeOmpVersion(); }
  versionProbe ??= probeOmpVersion().finally(() => {
    versionProbe = null;
  });
  return versionProbe;
}

/** Identity of the binary on disk; changes when it is replaced or updated. */
export function versionFingerprint(bin: string): string | null {
  try {
    const target = realpathSync(bin);
    const stat = statSync(target, { bigint: true });
    return [target, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch {
    return null;
  }
}

async function probeOmpVersion(): Promise<string | null> {
  const bin = resolveOmpBin();
  const fingerprint = bin ? versionFingerprint(bin) : null;
  const now = Date.now();
  if (fingerprint && cachedVersion?.fingerprint === fingerprint && now < cachedVersion.expiresAt) {
    return cachedVersion.value;
  }
  if (versionMiss?.fingerprint === fingerprint && now < versionMiss.retryAt) return null;
  cachedVersion = null;
  if (!bin) {
    versionMiss = { fingerprint, retryAt: now + MISS_TTL_MS };
    return null;
  }
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const target = wrapWindowsScript(bin, ["--version"]);
      // Without an explicit env this probe would inherit the server's full
      // environment, including omp-web's own secrets, into the child.
      // 30 s: a fresh ~120 MB runner binary's first start on Windows waits on the antivirus scan.
      execFile(target.file, target.args, { timeout: 30_000, windowsHide: true, env: createChildProcessEnvironment() }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    const version = output.trim();
    if (version) {
      versionMiss = null;
      // Do not cache a probe across an executable replacement.
      if (fingerprint && versionFingerprint(bin) === fingerprint) {
        cachedVersion = { fingerprint, value: version, expiresAt: Date.now() + VERSION_TTL_MS };
      }
      return version;
    }
  } catch {
    // Fall through to the miss path: retry after the TTL.
  }
  versionMiss = { fingerprint, retryAt: Date.now() + MISS_TTL_MS };
  return null;
}
