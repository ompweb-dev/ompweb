import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const {
  DEFAULT_WEB_SERVICE_CONFIG,
  sanitizePort,
  sanitizeHostname,
  sanitizeMode,
  getWebServiceConfigPath,
  getWebServiceLogPath,
  getWindowsShortcutPaths,
  getWebServiceStatus,
  getWindowsServiceDefinitions,
  getHostDaemonStatus,
  getAppVersion,
  getRepoRoot,
  getSystemRoot,
  resolvePowerShellBin,
  resolveWscriptBin,
  resolveTaskkillBin,
  getWindowsExecutionEnv,
  isTrayProcessRunning,
  invalidateTrayRunningCache,
} = await import("./windows-service.ts");

test("DEFAULT_WEB_SERVICE_CONFIG has correct production ports and settings", () => {
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.port, 30177);
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.hostname, "127.0.0.1");
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.mode, "start");
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.autostart, true);
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.openBrowserOnLaunch, false);
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.autoRestart, true);
});

test("sanitizePort validates numeric and string port values", () => {
  assert.equal(sanitizePort(30177), 30177);
  assert.equal(sanitizePort("30178"), 30178);
  assert.equal(sanitizePort(80), 80);
  assert.equal(sanitizePort(65535), 65535);

  // Invalid values fallback to default or provided fallback
  assert.equal(sanitizePort(0), 30177);
  assert.equal(sanitizePort(-1), 30177);
  assert.equal(sanitizePort(70000), 30177);
  assert.equal(sanitizePort("invalid"), 30177);
  assert.equal(sanitizePort(null, 8080), 8080);
  assert.equal(sanitizePort(undefined, 8080), 8080);
});

test("sanitizeHostname validates and trims hostname strings", () => {
  assert.equal(sanitizeHostname("127.0.0.1"), "127.0.0.1");
  assert.equal(sanitizeHostname("  0.0.0.0  "), "0.0.0.0");
  assert.equal(sanitizeHostname("localhost"), "localhost");
  assert.equal(sanitizeHostname("192.168.1.100"), "192.168.1.100");

  // Invalid values fallback
  assert.equal(sanitizeHostname(""), "127.0.0.1");
  assert.equal(sanitizeHostname("   "), "127.0.0.1");
  assert.equal(sanitizeHostname(null, "fallback.host"), "fallback.host");
  assert.equal(sanitizeHostname(undefined, "fallback.host"), "fallback.host");
});

test("sanitizeMode restricts mode to 'start' or 'dev'", () => {
  assert.equal(sanitizeMode("start"), "start");
  assert.equal(sanitizeMode("dev"), "dev");
  assert.equal(sanitizeMode("other"), "start");
  assert.equal(sanitizeMode(null, "dev"), "dev");
  assert.equal(sanitizeMode(undefined), "start");
});

test("getWebServiceConfigPath returns expected web-service.json path", () => {
  const configPath = getWebServiceConfigPath();
  assert.ok(configPath.endsWith(path.join(".omp", "agent", "web-service.json")) || configPath.endsWith("web-service.json"));
});

test("getWebServiceLogPath returns expected log path", () => {
  const logPath = getWebServiceLogPath();
  assert.ok(logPath.endsWith(path.join("logs", "omp-web-service.log")));
});

test("getWindowsShortcutPaths returns expected .lnk shortcut locations", () => {
  const shortcuts = getWindowsShortcutPaths();
  assert.ok(shortcuts.desktop.endsWith(path.join("Desktop", "omp-web.lnk")));
  assert.ok(shortcuts.startMenu.endsWith(path.join("Programs", "omp-web.lnk")));
  assert.ok(shortcuts.startup.endsWith(path.join("Startup", "omp-web-tray.lnk")));
});

test("getAppVersion returns package version string", () => {
  const ver = getAppVersion();
  assert.match(ver, /^\d+\.\d+\.\d+/);
});

test("getWebServiceStatus returns a complete status object", async () => {
  const status = await getWebServiceStatus();
  assert.equal(typeof status.isWindows, "boolean");
  assert.equal(typeof status.isInstalled, "boolean");
  assert.equal(typeof status.autostart, "boolean");
  assert.equal(typeof status.isRunning, "boolean");
  assert.equal(typeof status.port, "number");
  assert.equal(typeof status.hostname, "string");
  assert.ok(status.mode === "start" || status.mode === "dev");
  assert.equal(typeof status.desktopShortcutExists, "boolean");
  assert.equal(typeof status.startMenuShortcutExists, "boolean");
  assert.equal(typeof status.startupShortcutExists, "boolean");
  assert.equal(typeof status.logFile, "string");
  assert.equal(typeof status.configFile, "string");
  assert.equal(typeof status.serviceUrl, "string");
  assert.equal(typeof status.version, "string");
  assert.ok(status.serviceUrl.startsWith("http://"));
  assert.equal(typeof status.daemon.isInstalled, "boolean");
  assert.equal(typeof status.daemon.isRunning, "boolean");
});

test("getWindowsServiceDefinitions names the web service and the host daemon, and the installers register both", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const { web, host } = getWindowsServiceDefinitions(root);
  assert.equal(web.name, "omp-web");
  assert.equal(host.name, "omp-web-host");
  for (const { script } of [web, host]) assert.ok(existsSync(script), script);
  assert.equal(path.basename(host.script), "omp-web-host.ps1");
  const installer = readFileSync(path.join(root, "scripts", "windows", "install-tray.ps1"), "utf8");
  const uninstaller = readFileSync(path.join(root, "scripts", "windows", "uninstall-tray.ps1"), "utf8");
  for (const { name, script } of [web, host]) {
    assert.ok(installer.includes(`"${name}"`), `install-tray.ps1 registers ${name}`);
    assert.ok(installer.includes(path.basename(script)), `install-tray.ps1 runs ${path.basename(script)}`);
    assert.ok(uninstaller.includes(`"${name}"`), `uninstall-tray.ps1 removes ${name}`);
  }
  assert.match(readFileSync(host.script, "utf8"), /\$LauncherJs`" host >>/);
});

test("Windows launchers never keep the installation directory as a working directory", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const windows = path.join(root, "scripts", "windows");
  for (const name of ["omp-web-tray.ps1", "omp-web-service.ps1", "omp-web-host.ps1", "install-tray.ps1"]) {
    const source = readFileSync(path.join(windows, name), "utf8");
    const assignments = source.match(/\.WorkingDirectory\s*=\s*[^\r\n]+/g) ?? [];
    assert.ok(assignments.length > 0, `${name} sets a working directory`);
    for (const line of assignments) {
      // A process whose working directory is inside the installation blocks the next
      // update on Windows (ERROR_SHARING_VIOLATION on the directory rename).
      assert.doesNotMatch(line, /\$RepoRoot/, `${name}: ${line.trim()}`);
    }
  }
  // The working directory is outside the installation, so a relative dev entry would resolve
  // against the user profile instead of the installation (breaking dev launches, or worse,
  // running a server/dev.ts planted there).
  for (const name of ["omp-web-tray.ps1", "omp-web-service.ps1"]) {
    const source = readFileSync(path.join(windows, name), "utf8");
    assert.doesNotMatch(source, /--hot "?server[\\/]dev\.ts/, `${name}: the dev entry is not relative`);
    assert.match(source, /--hot .*Join-Path \$RepoRoot/, `${name}: the dev entry resolves from the installation`);
    assert.match(source, /--config=\$\(Join-Path \$RepoRoot 'bunfig\.toml'\)/, `${name}: Bun is told where bunfig.toml is`);
  }
  // Rejecting the text "$RepoRoot" alone would pass "$LaunchWorkingDirectory = $RepoRoot" followed
  // by ".WorkingDirectory = $LaunchWorkingDirectory", so pin the variable to the user profile and
  // require the refusal when it is empty.
  const workingDirectories = {
    "omp-web-tray.ps1": "LaunchWorkingDirectory",
    "omp-web-service.ps1": "LaunchWorkingDirectory",
    "omp-web-host.ps1": "LaunchWorkingDirectory",
    "install-tray.ps1": "ShortcutWorkingDirectory",
  };
  for (const [name, variable] of Object.entries(workingDirectories)) {
    const source = readFileSync(path.join(windows, name), "utf8");
    assert.match(source, new RegExp(`^\\$${variable} = \\$env:USERPROFILE$`, "m"), `${name}: ${variable} is the user profile`);
    for (const line of source.match(/\.WorkingDirectory\s*=\s*[^\r\n]+/g) ?? []) {
      assert.match(line, new RegExp(`\\$${variable}`), `${name}: ${line.trim()} uses ${variable}`);
    }
    assert.match(source, new RegExp(`IsNullOrWhiteSpace\\(\\$${variable}\\)`), `${name}: refuses an empty ${variable}`);
  }
  const hooks = readFileSync(path.join(root, "lib", "windows-service.ts"), "utf8");
  assert.doesNotMatch(hooks, /\$sc\.WorkingDirectory = '\$\{repoRoot/, "the startup shortcut starts outside the installation");
  const tray = readFileSync(path.join(root, "native", "tray", "Program.cs"), "utf8");
  assert.doesNotMatch(tray, /WorkingDirectory = _repoRoot/, "the native tray starts the launcher outside the installation");
  assert.doesNotMatch(tray, /--hot "?server[\\/]dev\.ts/, "the native tray passes an absolute dev entry");
  assert.match(tray, /Path\.Combine\(_repoRoot, "server", "dev\.ts"\)/, "the native tray resolves the dev entry from the installation");
  assert.match(tray, /--config=\{bunfig\}/, "the native tray tells Bun where bunfig.toml is");
  assert.match(tray, /var workingDirectory = Environment\.GetFolderPath\(Environment\.SpecialFolder\.UserProfile\);/, "the native tray resolves the user profile");
  assert.match(tray, /string\.IsNullOrWhiteSpace\(workingDirectory\)/, "the native tray refuses an empty working directory");
  assert.match(tray, /WorkingDirectory = workingDirectory,/, "the native tray starts the launcher outside the installation");
});

test("getHostDaemonStatus reports no daemon off Windows", async () => {
  if (process.platform === "win32") return;
  assert.deepEqual(await getHostDaemonStatus(), { isInstalled: false, isRunning: false });
});

test("getRepoRoot resolves valid repository directory containing package.json", () => {
  const repo = getRepoRoot();
  assert.equal(typeof repo, "string");
  assert.ok(repo.length > 0);
});

test("getSystemRoot returns a valid root path", () => {
  const sysRoot = getSystemRoot();
  assert.equal(typeof sysRoot, "string");
  assert.ok(sysRoot.length > 0);
});

test("binary resolution helpers return valid executable paths on Windows", () => {
  const psBin = resolvePowerShellBin();
  const wscriptBin = resolveWscriptBin();
  const taskkillBin = resolveTaskkillBin();

  assert.equal(typeof psBin, "string");
  assert.equal(typeof wscriptBin, "string");
  assert.equal(typeof taskkillBin, "string");

  if (process.platform === "win32") {
    assert.match(psBin.toLowerCase(), /(powershell|pwsh)(\.exe)?/);
    assert.match(wscriptBin.toLowerCase(), /wscript(\.exe)?/);
    assert.match(taskkillBin.toLowerCase(), /taskkill(\.exe)?/);
  }
});

test("getWindowsExecutionEnv includes System32 and PowerShell paths in PATH on Windows", () => {
  const env = getWindowsExecutionEnv();
  assert.ok(env);
  if (process.platform === "win32") {
    const pathVal = env.PATH || env.Path || "";
    assert.match(pathVal.toLowerCase(), /system32/);
    assert.match(pathVal.toLowerCase(), /windowspowershell/);
    assert.ok(env.SystemRoot);
  }
});

test("isTrayProcessRunning caches status and refreshes on invalidateTrayRunningCache", async () => {
  invalidateTrayRunningCache();
  const running1 = await isTrayProcessRunning();
  assert.equal(typeof running1, "boolean");

  const running2 = await isTrayProcessRunning();
  assert.equal(running1, running2);

  invalidateTrayRunningCache();
  const running3 = await isTrayProcessRunning();
  assert.equal(typeof running3, "boolean");
});
