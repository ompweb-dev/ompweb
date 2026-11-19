// `bun scripts/fetch-runner.ts [--latest] [<os>-<arch> ...]`: downloads the omp runner (`ompweb-omp-<os>-<arch>[.exe]`, default
// this machine's) of the oh-my-pi fork release that omp-runner.json pins into release/runners/<tag>/, checked against the
// release's ompweb-omp.sha256, and prints each file's path. A file already there is kept (its directory names the tag).
// --latest first rewrites omp-runner.json to the newest published fork release whose ompweb-omp.json names
// RUNNER_PROTOCOL and that attaches the runner of every platform: what publish and prerelease builds record (never committed back).
// Also the runner builds and smoke tests use: build-binary.ts, smoke.ts.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fetchHostUpdateBytes } from "../lib/hosts/update-worker";
import { OMP_RUNNER_PIN, OMP_TAG, RUNNER_PROTOCOL, runnerAsset } from "../lib/omp/omp-cli";
import { downloadRunner, findRunnerRelease } from "../lib/omp/runner-fetch";

const root = path.join(import.meta.dir, "..");
/** Every platform a release's runner is built for. */
const RELEASE_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"];
/** This machine's `<os>-<arch>`. */
export const thisTarget = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

/** `release/runners/<tag>/<asset>` of `target`, downloaded (SHA-256-checked) unless already there. */
export async function pinnedRunner(target = thisTarget, pin = OMP_RUNNER_PIN): Promise<string> {
  if (!OMP_TAG.test(pin.tag)) throw new Error(`omp-runner.json pins ${pin.tag}, which is not an omp build tag`);
  const asset = runnerAsset(target);
  const file = path.join(root, "release", "runners", pin.tag, asset);
  if (!existsSync(file)) await downloadRunner(pin, asset, file);
  return file;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), options: { latest: { type: "boolean" } }, allowPositionals: true });
  const targets = positionals.length ? positionals : [thisTarget];
  let pin = OMP_RUNNER_PIN;
  if (values.latest) {
    // api.github.com rate-limits a shared CI address without a token; downloads (github.com) need none.
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    const read = async (url: string, maxBytes: number, timeout: number): Promise<Buffer> => {
      if (!token || !url.startsWith("https://api.github.com/")) return fetchHostUpdateBytes(url, maxBytes, timeout);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "ompweb-fetch-runner" }, signal: AbortSignal.timeout(timeout) });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    };
    const found = await findRunnerRelease(pin.repo, RELEASE_TARGETS.map(runnerAsset), read);
    if (!found) throw new Error(`${pin.repo} has no published release whose runner speaks protocol ${RUNNER_PROTOCOL} for every platform`);
    pin = { repo: pin.repo, tag: found.tag };
    writeFileSync(path.join(root, "omp-runner.json"), `${JSON.stringify(pin, null, 2)}\n`);
    console.error(`omp-runner.json: ${pin.repo} ${pin.tag}`);
  }
  for (const target of targets) console.log(await pinnedRunner(target, pin));
}
