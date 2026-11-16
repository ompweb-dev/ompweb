import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

// A ZIP containing index.json and fixture.tgz, readable by both unzip and Windows' bundled bsdtar.
const archive = Buffer.from("UEsDBBQAAAAAAAAAIVyswTZ6JAAAACQAAAAKAAAAaW5kZXguanNvbnsiQG9oLW15LXBpL2ZpeHR1cmUiOiJmaXh0dXJlLnRneiJ9ClBLAwQUAAAAAAAAACFczMCKaRAAAAAQAAAACwAAAGZpeHR1cmUudGd6Zml4dHVyZSBwYWNrYWdlClBLAQIUAxQAAAAAAAAAIVyswTZ6JAAAACQAAAAKAAAAAAAAAAAAAACkgQAAAABpbmRleC5qc29uUEsBAhQDFAAAAAAAAAAhXMzAimkQAAAAEAAAAAsAAAAAAAAAAAAAAKSBTAAAAGZpeHR1cmUudGd6UEsFBgAAAAACAAIAcQAAAIUAAAAAAA==", "base64");

test("runner packages extract with the native ZIP tool despite a shadowing tar, and failed extraction keeps the old vendor", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-build-extract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const vendor = join(root, "vendor");
  const shadow = join(root, "shadow-path");
  for (const dir of [scripts, vendor, shadow]) mkdirSync(dir);
  const script = join(scripts, "use-omp-build.ts");
  copyFileSync(new URL("../runner/scripts/use-omp-build.ts", import.meta.url), script);
  writeFileSync(join(root, "omp-build.json"), JSON.stringify({ repo: "fixture/omp", tag: "v1.0.0-int.202601010000.g1234567" }));
  writeFileSync(join(vendor, "old-package.tgz"), "previous vendor");
  // Selecting tar from PATH must fail rather than accidentally pass with a ZIP-capable tar.
  writeFileSync(join(shadow, process.platform === "win32" ? "tar.exe" : "tar"), "not an executable", { mode: 0o700 });
  let body = Buffer.from("not a ZIP");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body) });
  t.after(() => server.stop(true));
  const env = { ...process.env, OMP_BUILD_RELEASES: server.url.origin, PATH: `${shadow}${delimiter}${process.env.PATH ?? ""}` };
  const run = async () => {
    const child = Bun.spawn([process.execPath, script], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: stdout + stderr };
  };
  const failed = await run();
  assert.notEqual(failed.code, 0, failed.output);
  assert.equal(readFileSync(join(vendor, "old-package.tgz"), "utf8"), "previous vendor");
  body = archive;
  const installed = await run();
  assert.equal(installed.code, 0, installed.output);
  assert.deepEqual(JSON.parse(readFileSync(join(vendor, "index.json"), "utf8")), { "@oh-my-pi/fixture": "fixture.tgz" });
  assert.equal(readFileSync(join(vendor, "fixture.tgz"), "utf8"), "fixture package\n");
  assert.equal(existsSync(join(vendor, "old-package.tgz")), false);
  assert.equal(existsSync(`${vendor}.new`), false);
});
