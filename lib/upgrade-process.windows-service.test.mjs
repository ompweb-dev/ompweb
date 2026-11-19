import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { windowsPowerShellEnvironment } from "./hosts/update-fixture.test-helper.mjs";

// Real Windows Service Control Manager throughout: a disposable service named by this file (a tiny ServiceBase
// executable called ompweb.exe, started as `ompweb.exe host`, in a scratch installation) is inspected, stopped and
// restarted by the production code. Nothing here mocks process.platform; on any other OS the tests skip, loudly.
const windows = process.platform === "win32";
const NOT_WINDOWS = `Windows service tests run only on Windows (this host is ${process.platform})`;
const moduleUrl = new URL("./upgrade-process.ts", import.meta.url).href;
const base = windows ? realpathSync.native(mkdtempSync(join(tmpdir(), "ompweb-scm-"))) : "";
const owned = []; // every service this file created: { name, dir, exe }
let upgrade;
let admin = false;
let serviceExe;

const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
const powershellExe = join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function ps(script, timeout = 120000) {
  const wrapped = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'\n${script}`;
  return execFileSync(powershellExe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(wrapped, "utf16le").toString("base64")], { encoding: "utf8", timeout, windowsHide: true, env: windowsPowerShellEnvironment() });
}

/** The smallest real Windows service: idles until stopped; optionally starts the command in ompweb.child (two lines: file, arguments) and ends that tree when it stops. */
const SERVICE_SOURCE = `using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;

public class OmpwebTestService : ServiceBase {
  private Process child;
  public OmpwebTestService() { ServiceName = "ompweb-upgrade-test"; }
  protected override void OnStart(string[] args) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string spec = Path.Combine(dir, "ompweb.child");
    if (!File.Exists(spec)) return;
    string[] lines = File.ReadAllLines(spec);
    ProcessStartInfo info = new ProcessStartInfo(lines[0], lines[1]);
    info.UseShellExecute = false;
    info.CreateNoWindow = true;
    info.WorkingDirectory = dir;
    child = Process.Start(info);
  }
  protected override void OnStop() {
    if (child == null) return;
    ProcessStartInfo kill = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe"), "/PID " + child.Id + " /T /F");
    kill.UseShellExecute = false;
    kill.CreateNoWindow = true;
    Process.Start(kill).WaitForExit(10000);
  }
  public static void Main() { ServiceBase.Run(new OmpwebTestService()); }
}
`;

const isAdmin = () => ps("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)").trim() === "True";
const DEFAULT_SDDL = "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)";
// Administrators may query, read and change the permissions of the service, but neither start nor stop it.
const NO_STOP_SDDL = "D:(A;;0x0007008D;;;BA)(A;;0x0002008D;;;SY)";

before(async () => {
  if (!windows) return;
  upgrade = await import("./upgrade-process.ts");
  admin = isAdmin();
  if (!admin) return;
  mkdirSync(join(base, "compile"));
  serviceExe = join(base, "compile", "service.exe");
  ps(`Add-Type -TypeDefinition ${q(SERVICE_SOURCE)} -ReferencedAssemblies 'System.ServiceProcess' -OutputAssembly ${q(serviceExe)} -OutputType ConsoleApplication`);
  assert.ok(existsSync(serviceExe), "the test service executable was built");
});

function destroy(service) {
  try { writeFileSync(join(service.dir, "helper.stop"), ""); } catch { /* the directory is already gone */ }
  try { execFileSync("sc.exe", ["sdset", service.name, DEFAULT_SDDL], { stdio: "ignore", windowsHide: true }); } catch { /* never created, or already deleted */ }
  try { ps(`$s = Get-Service -Name ${q(service.name)} -ErrorAction SilentlyContinue\nif ($s -and $s.Status -ne 'Stopped') { Stop-Service -InputObject $s -Force; $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)) }`); } catch { /* a stuck service is killed below */ }
  try { execFileSync("sc.exe", ["delete", service.name], { stdio: "ignore", windowsHide: true }); } catch { /* never created, or already deleted */ }
}
after(async () => {
  if (!windows) return;
  for (const service of owned) destroy(service);
  try {
    // Only what runs from this file's own scratch directory (the service executables).
    ps(`$root = ${q(`${base.toLowerCase()}\\`)}\nGet-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant().StartsWith($root) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
  } catch { /* nothing left to stop */ }
  await sleep(500);
  for (let tries = 0; ; tries++) {
    try { return rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch (error) { if (tries === 100) throw error; await sleep(100); }
  }
});

async function waitFor(check, what, timeout = 60000) {
  for (const stop = Date.now() + timeout; Date.now() < stop; await sleep(100)) {
    const value = await check();
    if (value) return value;
  }
  return assert.fail(`Timed out waiting for ${what}`);
}
const processes = () => JSON.parse(ps(`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; exe = [string]$_.ExecutablePath; created = $(if ($_.CreationDate) { [string]$_.CreationDate.ToUniversalTime().Ticks } else { '' }) } })`));
const service = (name) => JSON.parse(ps(`$s = Get-CimInstance Win32_Service -Filter ${q(`Name='${name}'`)}\nif ($s) { ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ state = [string]$s.State; pid = [int]$s.ProcessId }) } else { 'null' }`));
const instancesOf = (exe) => processes().filter((row) => row.exe && row.exe.toLowerCase() === exe.toLowerCase());

/** Skips (with the reason) only when this machine cannot create services; the hosted CI runner can, so there it fails instead. */
function canCreateServices(t) {
  if (admin) return true;
  const reason = "creating a Windows service needs an elevated administrator and this process is not one";
  assert.ok(!process.env.GITHUB_ACTIONS, `${reason}; the hosted Windows runner must provide it`);
  t.skip(reason);
  return false;
}

/** A new disposable service: ompweb.exe in its own installation directory, run as `ompweb.exe host`. */
function createService(label) {
  const dir = join(base, label);
  mkdirSync(dir);
  const exe = join(dir, "ompweb.exe");
  copyFileSync(serviceExe, exe);
  const created = { name: `ompweb-upgrade-test-${randomUUID().slice(0, 8)}`, dir, exe, launch: { command: exe, args: ["host"], cwd: dir } };
  owned.push(created);
  ps(`New-Service -Name ${q(created.name)} -BinaryPathName ${q(`"${exe}" host`)} -DisplayName ${q(created.name)} -StartupType Manual | Out-Null`);
  return created;
}
/** Starts the service and returns its single process: pid and the test's own creation-time identity. */
function startService(created) {
  ps(`Start-Service -Name ${q(created.name)}`);
  const { state, pid } = service(created.name);
  assert.equal(state, "Running");
  assert.ok(pid > 1, "the running service has a process");
  const rows = instancesOf(created.exe);
  assert.deepEqual(rows.map((row) => row.pid), [pid], "exactly the service's process runs ompweb.exe");
  return { pid, created: rows[0].created };
}
const inspect = (created, pid, role = "host") => upgrade.inspectUpgradeProcess({ pid, installDir: created.dir, role, launch: created.launch });

test("Windows PowerShell failures retain the native reason without an encoded command", { skip: windows ? false : NOT_WINDOWS, timeout: 30_000 }, async () => {
  await assert.rejects(upgrade.secureUpgradeDirectory(join(base, "missing-directory")), (error) => {
    assert.match(error.message, /PowerShell failed:.*missing-directory/s);
    assert.doesNotMatch(error.message, /-EncodedCommand/i);
    assert.ok(error.message.length <= 1020, "native diagnostics stay bounded");
    return true;
  });
});

test("a Windows service is inspected, refused once changed, stopped and restarted as one new instance", { skip: windows ? false : NOT_WINDOWS, timeout: 300_000 }, async (t) => {
  if (!canCreateServices(t)) return;
  const svc = createService("lifecycle");
  const first = startService(svc);

  await assert.rejects(inspect(svc, first.pid, "server"), /is not the server process/);
  const plan = await inspect(svc, first.pid);
  assert.equal(plan.platform, "win32");
  assert.equal(plan.supervisor.kind, "windows-service");
  assert.equal(plan.supervisor.name, svc.name);
  assert.equal(typeof plan.supervisor.configHash, "string");
  assert.equal(plan.args.at(-1), "host");
  assert.deepEqual(plan.current, { pid: first.pid, identity: plan.identity });
  await upgrade.assertUpgradeProcessControl(plan);
  assert.equal(service(svc.name).pid, first.pid, "authorization inspection never stops or restarts the service");
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan, "the plan is plain JSON");
  await assert.rejects(upgrade.stopUpgradeProcess({ ...plan, current: { pid: null, identity: null } }), /cannot identify|no longer running/);
  assert.equal(service(svc.name).state, "Running", "an unknown instance never stops the service");

  // A service whose configuration changed after inspection is never controlled.
  ps(`Set-Service -Name ${q(svc.name)} -StartupType Automatic`);
  await assert.rejects(upgrade.stopUpgradeProcess(plan), /changed since it was inspected/);
  assert.equal(service(svc.name).state, "Running", "the refused stop left the service running");
  ps(`Set-Service -Name ${q(svc.name)} -StartupType Manual`);

  await upgrade.stopUpgradeProcess(plan);
  assert.equal(service(svc.name).state, "Stopped");
  assert.deepEqual(instancesOf(svc.exe), [], "the old process is gone");
  await upgrade.stopUpgradeProcess(plan); // already stopped: nothing to do

  const pid = await upgrade.restartUpgradeProcess(plan, svc.launch);
  assert.ok(Number.isSafeInteger(pid), "the new instance was identified");
  assert.deepEqual(service(svc.name), { state: "Running", pid });
  assert.equal(plan.pid, first.pid, "the inspected process stays recorded");
  assert.equal(plan.current.pid, pid);
  assert.notEqual(plan.current.identity, plan.identity);
  const restarted = instancesOf(svc.exe);
  assert.deepEqual(restarted.map((row) => row.pid), [pid]);
  assert.notEqual(restarted[0].created, first.created, "a different process, not the old one");
  await sleep(1000);
  assert.equal(instancesOf(svc.exe).length, 1, "no second instance appeared");
  await assert.rejects(upgrade.restartUpgradeProcess(plan, svc.launch), /still running/, "a running instance is never joined by a second one");
  assert.equal(instancesOf(svc.exe).length, 1);
  await assert.rejects(upgrade.stopUpgradeProcess({ ...plan, current: { pid: first.pid, identity: plan.identity } }), /no longer running/);
  assert.equal(service(svc.name).pid, pid, "a stale plan never stops the replacement service");

  // After a restart a stop acts on the new instance.
  await upgrade.stopUpgradeProcess(plan);
  assert.equal(service(svc.name).state, "Stopped");
  assert.deepEqual(instancesOf(svc.exe), []);
});

test("without the right to stop the service the stop is refused and nothing is killed", { skip: windows ? false : NOT_WINDOWS, timeout: 300_000 }, async (t) => {
  if (!canCreateServices(t)) return;
  const svc = createService("denied");
  const first = startService(svc);
  const plan = await inspect(svc, first.pid);
  const untouched = JSON.stringify(plan);
  execFileSync("sc.exe", ["sdset", svc.name, NO_STOP_SDDL], { windowsHide: true });
  try {
    assert.deepEqual(service(svc.name), { state: "Running", pid: first.pid }, "the service can still be queried, only not stopped");
    await assert.rejects(upgrade.assertUpgradeProcessControl(plan), /PowerShell failed/, "readable configuration is not effective stop/start authority");
    await assert.rejects(upgrade.stopUpgradeProcess(plan), (error) => /PowerShell failed/.test(error.message) && !/Service not found|changed since it was inspected/.test(error.message));
    assert.deepEqual(service(svc.name), { state: "Running", pid: first.pid });
    assert.equal(instancesOf(svc.exe)[0].created, first.created, "the same process still runs");
    assert.equal(JSON.stringify(plan), untouched, "the plan was not touched");
  } finally {
    execFileSync("sc.exe", ["sdset", svc.name, DEFAULT_SDDL], { windowsHide: true });
  }
  await upgrade.stopUpgradeProcess(plan); // permitted again: the very same plan still works
  assert.equal(service(svc.name).state, "Stopped");
});

test("a helper launched under a service survives the service being stopped, with the caller that started it", { skip: windows ? false : NOT_WINDOWS, timeout: 300_000 }, async (t) => {
  if (!canCreateServices(t)) return;
  const svc = createService("survival");
  const helper = join(svc.dir, "helper.cjs");
  const caller = join(svc.dir, "caller.mjs");
  // The helper idles until told to stop (never longer than five minutes), so cleaning up needs no right to kill a SYSTEM process.
  writeFileSync(helper, `const fs = require("node:fs"); const path = require("node:path");\nconst dir = process.argv[2];\nfs.writeFileSync(path.join(dir, "helper.pid"), String(process.pid));\nsetInterval(() => { if (fs.existsSync(path.join(dir, "helper.stop"))) process.exit(0); }, 200);\nsetTimeout(() => process.exit(0), 300000);\n`);
  // The service starts this caller as its child (ompweb.child); the caller launches the helper and idles.
  writeFileSync(caller, `import { launchDetachedUpgrade } from ${JSON.stringify(moduleUrl)};\nimport { writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\nconst dir = process.argv[2];\nlet report;\ntry { report = { caller: process.pid, helper: await launchDetachedUpgrade({ command: process.execPath, args: [${JSON.stringify(helper)}, dir], cwd: tmpdir() }) }; }\ncatch (error) { report = { error: error.message }; }\nwriteFileSync(join(dir, "report.json"), JSON.stringify(report));\nsetInterval(() => {}, 1000);\n`);
  writeFileSync(join(svc.dir, "ompweb.child"), `${process.execPath}\n"${caller}" "${svc.dir}"\n`);

  const first = startService(svc);
  const report = await waitFor(() => { try { return JSON.parse(readFileSync(join(svc.dir, "report.json"), "utf8")); } catch { return null; } }, "the caller to launch the helper");
  assert.equal(report.error, undefined, `launchDetachedUpgrade failed under the service: ${report.error}`);
  assert.equal(Number(await waitFor(() => (existsSync(join(svc.dir, "helper.pid")) ? readFileSync(join(svc.dir, "helper.pid"), "utf8") : ""), "the helper to run")), report.helper, "the pid launchDetachedUpgrade returned is the helper");

  const rows = processes();
  const row = (pid) => rows.find((r) => r.pid === pid);
  const ancestors = (pid) => {
    const chain = [];
    for (let at = row(pid); at && row(at.ppid) && BigInt(row(at.ppid).created || 0) <= BigInt(at.created || 0) && chain.length < 16; at = row(at.ppid)) chain.push(at.ppid);
    return chain;
  };
  assert.ok(ancestors(report.caller).includes(first.pid), "the caller runs under the service");
  assert.ok(!ancestors(report.helper).includes(first.pid), "the helper is outside the service's process tree");
  const helperCreated = row(report.helper).created;

  const plan = await inspect(svc, first.pid);
  assert.equal(plan.supervisor.kind, "windows-service");
  await upgrade.stopUpgradeProcess(plan);
  assert.equal(service(svc.name).state, "Stopped");
  await waitFor(() => !processes().some((r) => r.pid === report.caller && r.created === row(report.caller).created), "the caller to end with the service");
  for (let i = 0; i < 2; i++) {
    const survivor = processes().find((r) => r.pid === report.helper);
    assert.ok(survivor && survivor.created === helperCreated, "the helper outlived the service and the caller");
    await sleep(1000);
  }
});

const INSTALL = "C:/Users/x/AppData/Roaming/npm/node_modules/@kahme247/ompweb";

test("the Schedule service's svchost is never a supervisor candidate, even with no readable executable path", async () => {
  const { supervisorCandidatePids } = await import("./upgrade-process.ts");
  // A non-administrator's Win32_Process rows: SYSTEM processes have a name but an empty ExecutablePath (issue #537).
  const chain = [
    { pid: 10, name: "node.exe", exe: "E:/Nodev/node.exe" },
    { pid: 11, name: "cmd.exe", exe: "C:\\Windows\\System32\\cmd.exe" },
    { pid: 12, name: "powershell.exe", exe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
    { pid: 3336, name: "svchost.exe", exe: "" },
    { pid: 13, name: "SVCHOST.EXE", exe: "" },
    { pid: 14, exe: "C:\\Windows\\System32\\svchost.exe" },
    { pid: 700, name: "services.exe", exe: "" },
  ];
  assert.deepEqual(supervisorCandidatePids(chain), [10, 11, 12, 700]);
});

test("a tray exe inside the package is selected without a pid in web-service.json", async () => {
  const { selectInstallLockingProcesses } = await import("./upgrade-process.ts");
  const rows = [
    { pid: 10, ppid: 1, exe: `${INSTALL}/bin/omp-web-tray.exe`, command: "-Startup" },
    { pid: 11, ppid: 1, exe: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", command: `powershell -File "${INSTALL}\\scripts\\windows\\omp-web-tray.ps1" -Startup` },
    { pid: 12, ppid: 1, exe: "C:/Program Files/Code/Code.exe", command: `code ${INSTALL}` },
  ];
  const selected = selectInstallLockingProcesses(rows, INSTALL, [], [99]);
  assert.deepEqual(selected.blocked, []);
  assert.deepEqual(selected.stop.map((hit) => hit.pid), [10, 11]);
  assert.ok(selected.stop.every((hit) => hit.kind === "tray"));
});

test("a bun or node process whose command line references the install is selected even when it is not a descriptor pid", async () => {
  const { selectInstallLockingProcesses } = await import("./upgrade-process.ts");
  const rows = [
    { pid: 20, ppid: 10, exe: "C:/Program Files/nodejs/node.exe", command: `"${INSTALL}\\bin\\omp-web.js" -p 30177` },
    { pid: 30, ppid: 20, exe: `${INSTALL}/node_modules/bun/bin/bun.exe`, command: `${INSTALL}\\server\\main.ts` },
    { pid: 31, ppid: 1, exe: "C:/Program Files/bun/bun.exe", command: `bun ${INSTALL}-other/server/main.ts` },
    { pid: 99, ppid: 4, exe: "C:/Temp/runtime.exe", command: "C:/Temp/worker.mjs" },
  ];
  const selected = selectInstallLockingProcesses(rows, INSTALL, [99], [99]);
  assert.deepEqual(selected.stop.map((hit) => hit.pid), [20, 30]);
  assert.ok(selected.stop.every((hit) => hit.kind === "runtime"));
});

test("scoped to the server launcher, a surviving bun child is selected after the launcher is gone; the host daemon and unrelated processes are not", async () => {
  const { selectInstallLockingProcesses } = await import("./upgrade-process.ts");
  // Launcher 20 was stopped (absent from the table); Windows keeps its child's ppid, so the chain ends at a pid that no longer exists.
  const rows = [
    { pid: 30, ppid: 20, exe: `${INSTALL}/node_modules/bun/bin/bun.exe`, command: `${INSTALL}\\server\\main.ts` },
    { pid: 31, ppid: 30, exe: `${INSTALL}/node_modules/bun/bin/bun.exe`, command: `${INSTALL}\\server\\worker.ts` },
    { pid: 40, ppid: 1, exe: "C:/Program Files/nodejs/node.exe", command: `"${INSTALL}\\bin\\omp-web-host.js"` },
    { pid: 41, ppid: 40, exe: `${INSTALL}/node_modules/bun/bin/bun.exe`, command: `${INSTALL}\\runner.ts` },
    { pid: 50, ppid: 1, exe: "C:/Program Files/bun/bun.exe", command: `bun ${INSTALL}\\other.ts` },
  ];
  const selected = selectInstallLockingProcesses(rows, INSTALL, [99], [99], [20]);
  assert.deepEqual(selected.stop.map((hit) => hit.pid), [30, 31]);
  assert.deepEqual(selectInstallLockingProcesses(rows, INSTALL, [99], [99]).stop.map((hit) => hit.pid), [30, 31, 40, 41, 50]);
});

test("the tray's cmd.exe wrapper between the tray and the launcher is owned; an unrelated cmd.exe referencing the install is not", async () => {
  const { selectOwnedTrayPids } = await import("./upgrade-process.ts");
  const row = (pid, ppid, exe, args) => ({ pid, ppid, exe, command: [exe, ...args].join("\0"), args });
  const cmd = "C:/Windows/System32/cmd.exe";
  const bun = `${INSTALL}/node_modules/bun/bin/bun.exe`;
  const rows = [
    row(10, 1, `${INSTALL}/bin/omp-web-tray.exe`, [`${INSTALL}/bin/omp-web-tray.exe`, "-Startup"]),
    row(15, 10, cmd, [cmd, "/d", "/s", "/c", `"node.exe ${INSTALL}\\bin\\omp-web.js"`]),
    row(20, 15, "C:/Program Files/nodejs/node.exe", ["node.exe", `${INSTALL}\\bin\\omp-web.js`]),
    row(30, 20, bun, [bun, `${INSTALL}\\server\\main.ts`]),
    // Not between the tray and the launcher: a user's shell, one under another parent, and a wrapper of an unrelated process.
    row(60, 1, cmd, [cmd, "/k", `cd ${INSTALL}`]),
    row(61, 10, cmd, [cmd, "/c", `echo ${INSTALL}`]),
    row(62, 61, "C:/Program Files/nodejs/node.exe", ["node.exe", "other.js"]),
  ];
  assert.deepEqual(selectOwnedTrayPids(rows, INSTALL, [99], [20, 30]).sort((a, b) => a - b), [10, 15]);
  assert.deepEqual(selectOwnedTrayPids(rows, INSTALL, [99], [62]).sort((a, b) => a - b), [10, 61], "only the wrapper above the given server pids is owned");
  assert.deepEqual(selectOwnedTrayPids(rows.filter((r) => r.pid !== 10), INSTALL, [99], [20, 30]), [], "a cmd.exe with no tray above it is not owned");
});

test("the update does not select a process the worker descends from", async () => {
  const { selectInstallLockingProcesses } = await import("./upgrade-process.ts");
  const rows = [
    { pid: 10, ppid: 1, exe: `${INSTALL}/bin/omp-web-tray.exe`, command: `${INSTALL}\\bin\\omp-web-tray.exe -Startup` },
    { pid: 99, ppid: 10, exe: "C:/Temp/runtime.exe", command: "C:/Temp/worker.mjs" },
  ];
  const selected = selectInstallLockingProcesses(rows, INSTALL, [99], [99]);
  assert.deepEqual(selected.stop, []);
  assert.deepEqual(selected.blocked, [{ pid: 10, kind: "tray" }]);
});

test("update working directories stay outside the installation", async () => {
  const { installSpawnCwd, cwdOutsideInstall } = await import("./upgrade-process.ts");
  const { homedir, tmpdir } = await import("node:os");
  assert.equal(installSpawnCwd(), tmpdir());
  assert.equal(cwdOutsideInstall(INSTALL), homedir());
  assert.notEqual(cwdOutsideInstall(INSTALL), INSTALL);
  assert.throws(() => installSpawnCwd("/tmp/ompweb-install", "/tmp/ompweb-install"), /inside the installation/);
  assert.equal(cwdOutsideInstall(homedir(), homedir(), tmpdir()), tmpdir());
});

test("a tray that started the server is relaunched alone; otherwise the server restarts directly", async () => {
  const { traySupervisor, serverRestartChoice } = await import("./upgrade-process.ts");
  const install = "C:/Users/x/AppData/Roaming/npm/node_modules/@kahme247/ompweb";
  const cwd = "C:/Users/x";
  const rows = [
    { pid: 10, ppid: 1, exe: `${install}/bin/omp-web-tray.exe`, command: "", args: [`${install}/bin/omp-web-tray.exe`, "-Startup"] },
    { pid: 20, ppid: 10, exe: "C:/Program Files/nodejs/node.exe", command: "", args: [`${install}/bin/omp-web.js`] },
    { pid: 30, ppid: 20, exe: `${install}/node_modules/bun/bin/bun.exe`, command: "", args: [`${install}/server/main.ts`] },
    { pid: 40, ppid: 1, exe: `${install}/bin/omp-web-tray.exe`, command: "", args: [`${install}/bin/omp-web-tray.exe`, "-OpenBrowser"] },
  ];
  const tray = traySupervisor(rows, [20, 30], install);
  assert.deepEqual(tray, { exe: `${install}/bin/omp-web-tray.exe`, args: ["-Startup"] });
  const choice = serverRestartChoice(tray, install, cwd);
  assert.equal(choice.kind, "tray");
  if (choice.kind !== "tray") return;
  assert.equal(choice.command, join(install, "bin", "omp-web-tray.exe"));
  assert.deepEqual(choice.args, ["-Startup"]);
  assert.equal(choice.cwd, cwd);
  assert.equal(traySupervisor(rows, [99], install), null, "a tray that did not start this server is not its supervisor");
  assert.deepEqual(serverRestartChoice(null, install, cwd), { kind: "direct" });
});

test("a PowerShell tray supervisor keeps its flags and script but not its own executable (argv[0])", async () => {
  const { traySupervisor, serverRestartChoice } = await import("./upgrade-process.ts");
  const install = "C:/Users/x/AppData/Roaming/npm/node_modules/@kahme247/ompweb";
  const script = `${install}/scripts/windows/omp-web-tray.ps1`;
  // Production rows: args is the parsed command line (executable first) and command joins exe and args.
  const row = (pid, ppid, exe, args) => ({ pid, ppid, exe, command: [exe, ...args].join("\0"), args });
  const pwshArgs = ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoProfile", "-File", script, "-Startup"];
  const rows = [
    row(10, 1, "C:/Program Files/PowerShell/7/pwsh.exe", pwshArgs),
    row(20, 10, "C:/Program Files/nodejs/node.exe", ["C:/Program Files/nodejs/node.exe", `${install}/bin/omp-web.js`]),
  ];
  const tray = traySupervisor(rows, [20], install);
  assert.deepEqual(tray, { exe: "C:/Program Files/PowerShell/7/pwsh.exe", args: ["-NoProfile", "-File", script, "-Startup"] });
  const choice = serverRestartChoice(tray, install, "C:/Users/x");
  assert.equal(choice.kind === "tray" && choice.command, "C:/Program Files/PowerShell/7/pwsh.exe");
  assert.deepEqual(choice.kind === "tray" && choice.args, ["-NoProfile", "-File", join(install, "scripts", "windows", "omp-web-tray.ps1"), "-Startup"]);
});

test("the interactive tray task is unique per operation, runs the selected command, and quotes hostile paths", async () => {
  const { interactiveTrayTask } = await import("./upgrade-process.ts");
  const exe = "C:/Users/a b/o'mpweb/bin/omp-web-tray.exe";
  const cwd = "C:/Users/a b";
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const task = interactiveTrayTask({ command: exe, args: ["-Startup"], cwd }, first);
  const other = interactiveTrayTask({ command: exe, args: ["-Startup"], cwd }, second);
  assert.notEqual(task.taskName, other.taskName);
  assert.match(task.taskName, new RegExp(first));
  assert.equal(task.exe, exe);
  assert.equal(task.args, "-Startup");
  const inner = Buffer.from(task.encoded, "base64").toString("utf16le");
  // Windows PowerShell 5.1 Start-Process has -FilePath but no -LiteralPath.
  assert.equal(inner, `Start-Process -FilePath '${exe.replaceAll("'", "''")}' -ArgumentList '-Startup' -WorkingDirectory '${cwd}'`);
  assert.match(task.script, /LogonType Interactive/);
  assert.match(task.script, /Unregister-ScheduledTask/);
  assert.equal(task.script.includes("a b"), false, "a spaced path is not spliced into the registration script");
  assert.equal(task.script.includes("o'mpweb"), false, "a quoted path is not spliced into the registration script");
  assert.throws(() => interactiveTrayTask({ command: exe, args: [], cwd }, "not-an-id"), /operation id/);
});

test("the interactive tray task starts a PowerShell tray with its script and arguments, not the exe", async () => {
  const { interactiveTrayTask } = await import("./upgrade-process.ts");
  const script = "C:/Users/a b/npm/ompweb/scripts/windows/omp-web-tray.ps1";
  const task = interactiveTrayTask({ command: "powershell.exe", args: ["-NoProfile", "-File", script, "-Startup"], cwd: "C:/Users/a b" }, "11111111-1111-4111-8111-111111111111");
  assert.equal(task.exe, "powershell.exe");
  assert.equal(task.args, `-NoProfile -File "${script}" -Startup`);
  const inner = Buffer.from(task.encoded, "base64").toString("utf16le");
  assert.ok(inner.startsWith("Start-Process -FilePath 'powershell.exe' -ArgumentList '"), inner);
  assert.equal(inner.includes("omp-web-tray.exe"), false);
});

test("a NUL-joined command line still matches an install path in its own argument", async () => {
  const { selectInstallLockingProcesses } = await import("./upgrade-process.ts");
  const install = "C:/Users/x/AppData/Roaming/npm/node_modules/@kahme247/ompweb";
  const node = "C:/Program Files/nodejs/node.exe";
  const powershell = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const rows = [
    { pid: 20, ppid: 1, exe: node, command: [node, `${install}/bin/omp-web.js`, "-p", "30177"].join("\0") },
    { pid: 11, ppid: 1, exe: powershell, command: [powershell, "-File", `${install}/scripts/windows/omp-web-tray.ps1`, "-Startup"].join("\0") },
  ];
  const selected = selectInstallLockingProcesses(rows, install, [], [99]);
  assert.deepEqual(selected.stop.map((hit) => hit.pid), [11, 20]);
});
