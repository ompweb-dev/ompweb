import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const mac = process.platform === "darwin";
const base = realpathSync(mkdtempSync(join(tmpdir(), "upgrade-process-launchd-")));
const moduleUrl = new URL("./upgrade-process.ts", import.meta.url).href;
let upgrade;

after(() => rmSync(base, { recursive: true, force: true }));

const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const ctl = (...args) => execFileSync("launchctl", args, { encoding: "utf8", timeout: 60_000 });
const sudo = (...args) => execFileSync("sudo", ["-n", ...args], { encoding: "utf8", timeout: 60_000 });
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(check, what) {
  for (const stop = Date.now() + 30_000; Date.now() < stop; await sleep(50)) {
    const value = check();
    if (value) return value;
  }
  return assert.fail(`Timed out waiting for ${what}`);
}
function fixture(name) {
  const dir = join(base, name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  const host = join(dir, "bin", "omp-web-host.js");
  const pidFile = join(dir, "pid");
  writeFileSync(host, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const launch = { command: process.execPath, args: [host], cwd: dir };
  return { dir, host, pidFile, launch };
}
function plist(label, fixture_, user) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(fixture_.host)}</string></array>
${user ? `<key>UserName</key><string>${xml(user)}</string>` : ""}
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>`;
}
const pidOf = (fixture_) => existsSync(fixture_.pidFile) && Number(readFileSync(fixture_.pidFile, "utf8"));
const inspect = (fixture_, pid) => upgrade.inspectUpgradeProcess({ pid, installDir: fixture_.dir, role: "host", launch: fixture_.launch });

test("a GUI LaunchAgent is stopped and restarted through its unchanged launchd job", { skip: !mac && "launchd exists only on macOS", timeout: 120_000 }, async () => {
  upgrade = await import("./upgrade-process.ts");
  const fixture_ = fixture("gui");
  const label = `dev.ompweb.upgrade-test.${randomUUID()}`;
  const domain = `gui/${process.getuid()}`;
  const file = join(fixture_.dir, `${label}.plist`);
  const definition = plist(label, fixture_);
  writeFileSync(file, definition, { mode: 0o600 });
  try {
    ctl("bootstrap", domain, file);
    const first = await waitFor(() => pidOf(fixture_), "the GUI LaunchAgent");
    const plan = await inspect(fixture_, first);
    assert.deepEqual({ kind: plan.supervisor.kind, domain: plan.supervisor.domain, label: plan.supervisor.label }, { kind: "launchd", domain, label });
    await upgrade.assertUpgradeProcessControl(plan);
    assert.ok(running(first), "admission does not mutate the job");
    writeFileSync(file, `${definition}\n<!-- edited -->`);
    await assert.rejects(upgrade.stopUpgradeProcess(plan), /property list.*changed since it was inspected/);
    assert.ok(running(first), "an edited property list stops nothing");
    writeFileSync(file, definition);
    await upgrade.stopUpgradeProcess(plan);
    assert.ok(!running(first));
    const restarted = await upgrade.restartUpgradeProcess(plan, fixture_.launch);
    assert.ok(restarted && restarted !== first && running(restarted));
    await upgrade.stopUpgradeProcess(plan);
  } finally {
    try { ctl("bootout", `${domain}/${label}`); } catch { /* already unloaded */ }
  }
});

test("a same-user system LaunchDaemon is discovered, refused without mutation for non-root, and controllable as root", { skip: !mac && "launchd exists only on macOS", timeout: 180_000 }, async (t) => {
  try { sudo("true"); } catch { return t.skip("passwordless sudo is required for an isolated system LaunchDaemon"); }
  upgrade ??= await import("./upgrade-process.ts");
  const fixture_ = fixture("system");
  const label = `dev.ompweb.upgrade-test.${randomUUID()}`;
  const user = execFileSync("id", ["-un"], { encoding: "utf8" }).trim();
  const source = join(fixture_.dir, `${label}.plist`);
  const file = `/Library/LaunchDaemons/${label}.plist`;
  writeFileSync(source, plist(label, fixture_, user));
  try {
    sudo("install", "-o", "root", "-g", "wheel", "-m", "644", source, file);
    sudo("launchctl", "bootstrap", "system", file);
    const first = await waitFor(() => pidOf(fixture_), "the system LaunchDaemon");
    const plan = await inspect(fixture_, first);
    assert.deepEqual({ kind: plan.supervisor.kind, domain: plan.supervisor.domain, label: plan.supervisor.label, plist: plan.supervisor.plist }, { kind: "launchd", domain: "system", label, plist: file });

    if (process.geteuid() === 0) await upgrade.assertUpgradeProcessControl(plan);
    else await assert.rejects(upgrade.assertUpgradeProcessControl(plan), /Cannot verify non-root stop and start authorization for system launchd job/);
    assert.ok(running(first), "admission leaves the same daemon running");

    const helper = join(fixture_.dir, "root-control.mjs");
    writeFileSync(helper, `import { assertUpgradeProcessControl, restartUpgradeProcess, stopUpgradeProcess } from ${JSON.stringify(moduleUrl)};
const plan = JSON.parse(process.argv[2]); const launch = JSON.parse(process.argv[3]);
await assertUpgradeProcessControl(plan); await stopUpgradeProcess(plan);
const restarted = await restartUpgradeProcess(plan, launch);
if (!restarted || restarted === plan.pid) throw new Error("launchd did not start a new instance");
await stopUpgradeProcess(plan); console.log(JSON.stringify({ restarted, current: plan.current }));`);
    const result = JSON.parse(sudo(process.execPath, helper, JSON.stringify(plan), JSON.stringify(fixture_.launch)).trim());
    assert.equal(result.restarted, result.current.pid);
    assert.ok(!running(result.restarted), "root controlled only the isolated job and stopped its restarted instance");
  } finally {
    try { sudo("launchctl", "bootout", `system/${label}`); } catch { /* already unloaded */ }
    try { sudo("rm", "-f", file); } catch { /* fixture was never installed */ }
  }
});
