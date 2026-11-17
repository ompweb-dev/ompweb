import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SYSTEMD_UNIT = "ompweb-host.service";
const LAUNCHD_LABEL = "com.kahme247.ompweb-host";
const WINDOWS_TASK = "omp-web-host";

export interface InstalledHostSupervisor {
  description: string;
  start(): Promise<void>;
}

type NativeCommand = (command: string, args: string[]) => Promise<string>;

interface SupervisorInspectionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Test root for native system paths; production always uses /. */
  root?: string;
  uid?: number;
  run?: NativeCommand;
  managerAvailable?: (user: boolean) => Promise<boolean>;
}

interface SystemdRecord {
  Id?: string;
  LoadState?: string;
  FragmentPath?: string;
  ExecStart?: string;
  Environment?: string;
}

interface WindowsInventory {
  user: string;
  tasks: { path: string; name: string; state: string; userId: string; actions: { execute: string; arguments: string }[] }[];
  services: { name: string; pathName: string; startName: string; state: string }[];
}

async function runNative(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: "utf8", env, timeout: 10_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    let detail = "";
    if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string") detail = error.stderr.trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail || (error instanceof Error ? error.message : String(error))}`);
  }
}

function records(output: string): SystemdRecord[] {
  return output.split(/\r?\n\r?\n/).map((block) => Object.fromEntries(block.split(/\r?\n/).flatMap((line) => {
    const at = line.indexOf("=");
    return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
  }))).filter((record) => Object.keys(record).length > 0);
}

async function trustedFile(path: string): Promise<string> {
  const stat = await fs.stat(path);
  const uid = process.getuid?.();
  if (!stat.isFile() || (stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o022) !== 0) throw new Error(`Native host supervisor file ${path} is not trusted`);
  return fs.readFile(path, "utf8");
}

async function smallTextFile(path: string, required = false): Promise<string> {
  try {
    const stat = await fs.stat(path);
    return stat.isFile() && stat.size <= 64 * 1024 ? await fs.readFile(path, "utf8") : "";
  } catch (error) {
    if (!required) return "";
    throw new Error(`Could not inspect native supervisor program ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function optionalDirectory(path: string): Promise<string[]> {
  try {
    return (await fs.readdir(path, { withFileTypes: true })).filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".plist")).map((entry) => join(path, entry.name));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw new Error(`Could not inspect native host supervisors in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function nativePathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw new Error(`Could not inspect native supervisor path ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function xmlValue(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function pending(description: string): InstalledHostSupervisor {
  return { description, start: async () => undefined };
}

function normal(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value;
}

function commandArguments(command: string, platform: NodeJS.Platform): string[] {
  const args: string[] = [];
  let current = "", quote = "";
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = "";
      else if (character === "\\" && platform !== "win32" && /[\s'"\\]/.test(command[index + 1] ?? "")) current += command[++index];
      else current += character;
    } else if (character === "'" || character === "\"") quote = character;
    else if (/\s/.test(character)) {
      if (current) { args.push(current); current = ""; }
    } else if (character === ";") break;
    else if (character === "\\" && platform !== "win32" && /[\s'"\\]/.test(command[index + 1] ?? "")) current += command[++index];
    else current += character;
  }
  if (current) args.push(current);
  return args;
}

function configuredCommands(text: string, platform: NodeJS.Platform): string[][] {
  return [...text.matchAll(/^(?:ExecStart=|\s*exec\s+)(.+)$/gm)].map((match) => commandArguments(match[1].trim(), platform));
}

function systemdCommand(execStart: string | undefined, platform: NodeJS.Platform): string[] {
  const argv = execStart?.match(/\bargv\[\]=(.*?)\s+;/)?.[1];
  return argv ? commandArguments(argv, platform) : [];
}

/** Finds native supervisors proven to target this installation or agent. Absence is distinct from an inspection failure. */
export async function inspectInstalledHostSupervisor(options: SupervisorInspectionOptions = {}): Promise<InstalledHostSupervisor | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const commandEnv = platform === "linux" && !env.XDG_RUNTIME_DIR && (options.uid !== undefined || process.getuid)
    ? { ...env, XDG_RUNTIME_DIR: join(options.root ?? "/", "run", "user", String(options.uid ?? process.getuid!())) }
    : env;
  const run = options.run ?? ((command, args) => runNative(command, args, commandEnv));
  const pathApi = platform === "win32" ? win32 : { basename, isAbsolute, join, relative, resolve, sep };
  const agentDir = pathApi.resolve(env.PI_CODING_AGENT_DIR ?? pathApi.join(home, ".omp", "agent"));
  const defaultAgentDir = pathApi.resolve(pathApi.join(home, ".omp", "agent"));
  const installDir = pathApi.resolve(env.OMP_WEB_PACKAGE_DIR ?? process.cwd());
  const inside = (value: string, directory: string) => {
    if (!pathApi.isAbsolute(value)) return false;
    const child = pathApi.relative(normal(directory, platform), normal(value, platform));
    return child === "" || (child !== ".." && !child.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(child));
  };
  const ownedPath = (value: string) => inside(value, agentDir) || inside(value, installDir);
  const ownsCommand = (args: string[]) => args.some(ownedPath);
  const hostCommand = (args: string[]) => args.some((argument, index) => {
    const name = normal(pathApi.basename(argument), platform);
    if (ownedPath(argument) && ["omp-web-host.js", "omp-web-host.ps1", "ompweb-host.ps1"].includes(name)) return true;
    return ["ompweb", "ompweb.exe", "omp-web.js"].includes(name) && args[index + 1] === "host";
  });
  const root = options.root ?? "/";
  const uid = options.uid ?? process.getuid?.();
  const managerAvailable = options.managerAvailable ?? (async (user: boolean) => {
    if (!user) return nativePathExists(join(root, "run", "systemd", "system"));
    if (uid === undefined) return false;
    const runtime = env.XDG_RUNTIME_DIR ?? join(root, "run", "user", String(uid));
    return nativePathExists(join(runtime, "systemd", "private"));
  });

  if (platform === "linux") {
    const found: { record: SystemdRecord; user: boolean }[] = [];
    for (const user of [true, false]) {
      if (!await managerAvailable(user)) continue;
      const prefix = user ? ["--user"] : [];
      const listed = await run("systemctl", [...prefix, "list-unit-files", "--type=service", "--no-legend", "--no-pager"]);
      const loaded = await run("systemctl", [...prefix, "list-units", "--all", "--plain", "--type=service", "--no-legend", "--no-pager"]);
      const units = [...new Set(`${listed}\n${loaded}`.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0])
        .filter((unit): unit is string => typeof unit === "string" && unit.endsWith(".service") && !unit.endsWith("@.service")))];
      if (units.length === 0) continue;
      const shown = records(await run("systemctl", [...prefix, "show", ...units, "--property=Id", "--property=LoadState", "--property=FragmentPath", "--property=ExecStart", "--property=Environment"]));
      for (const record of shown) {
        if (record.LoadState !== "loaded" || !record.FragmentPath || !record.Id) continue;
        const environmentPaths = commandArguments(record.Environment ?? "", platform).flatMap((entry) => {
          const match = entry.match(/^(?:PI_CODING_AGENT_DIR|OMP_WEB_PACKAGE_DIR)=(.+)$/);
          return match ? [match[1]] : [];
        });
        const exactUserUnit = user && record.Id === SYSTEMD_UNIT && resolve(record.FragmentPath) === resolve(join(home, ".config", "systemd", "user", SYSTEMD_UNIT));
        const defaultExact = exactUserUnit && agentDir === defaultAgentDir;
        const commands = [systemdCommand(record.ExecStart, platform)].filter((args) => args.length > 0);
        let ownershipKnown = environmentPaths.some(ownedPath) || commands.some(ownsCommand);
        const program = commands[0]?.[0];
        if (program && (commands[0].length === 1 || ownedPath(program))) {
          const wrapper = await smallTextFile(program, ownershipKnown);
          commands.push(...configuredCommands(wrapper, platform));
          ownershipKnown ||= commands.some(ownsCommand);
        }
        if (ownershipKnown || defaultExact) {
          commands.push(...configuredCommands(await fs.readFile(record.FragmentPath, "utf8"), platform));
          ownershipKnown ||= commands.some(ownsCommand);
        }
        if ((ownershipKnown || defaultExact) && commands.some(hostCommand)) found.push({ record, user });
      }
    }
    if (found.length > 1) throw new Error("More than one native systemd service targets this local host; refusing unmanaged startup");
    if (found.length === 0) return null;
    const [{ record, user }] = found;
    const exactPath = join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
    if (user && record.Id === SYSTEMD_UNIT && resolve(record.FragmentPath!) === resolve(exactPath)) {
      const unit = await trustedFile(exactPath);
      if (!configuredCommands(unit, platform).some(hostCommand)) throw new Error(`Installed native host supervisor ${exactPath} could not be verified`);
      return {
        description: `systemd user unit ${SYSTEMD_UNIT}`,
        start: async () => { await run("systemctl", ["--user", "start", SYSTEMD_UNIT]); },
      };
    }
    return pending(`systemd ${user ? "user " : ""}unit ${record.Id}`);
  }

  if (platform === "darwin") {
    if (uid === undefined) throw new Error("Could not determine launchd user domains while inspecting native host supervisors");
    const locations = [
      { dir: join(home, "Library", "LaunchAgents"), domain: `gui/${uid}`, controllable: true },
      { dir: join(root, "Library", "LaunchAgents"), domain: `gui/${uid}`, controllable: false },
      { dir: join(root, "Library", "LaunchDaemons"), domain: "system", controllable: false },
    ];
    const found: { path: string; label: string; domain: string; controllable: boolean; contents: string }[] = [];
    for (const location of locations) {
      for (const path of await optionalDirectory(location.dir)) {
        const bytes = await fs.readFile(path);
        const contents = bytes.subarray(0, 6).toString("ascii") === "bplist"
          ? await run("plutil", ["-convert", "xml1", "-o", "-", path])
          : bytes.toString("utf8");
        const label = contents.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
        if (!label) continue;
        const argumentsBlock = contents.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
        const argumentsList = [...argumentsBlock.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => xmlValue(match[1]));
        const program = contents.match(/<key>Program<\/key>\s*<string>([\s\S]*?)<\/string>/)?.[1];
        if (program) argumentsList.unshift(xmlValue(program));
        const environment = contents.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? "";
        const ownershipEnvironment = [...environment.matchAll(/<key>(?:PI_CODING_AGENT_DIR|OMP_WEB_PACKAGE_DIR)<\/key>\s*<string>([\s\S]*?)<\/string>/g)].map((match) => xmlValue(match[1]));
        const commands = [argumentsList];
        let ownershipKnown = ownershipEnvironment.some(ownedPath) || ownsCommand(argumentsList);
        for (const [index, argument] of argumentsList.entries()) {
          if ((argument.startsWith("/") || pathApi.isAbsolute(argument)) && (index === 0 || /\.(?:sh|command|js|mjs|cjs|py|pl|rb)$/i.test(argument))) {
            commands.push(...configuredCommands(await smallTextFile(argument, ownershipKnown), platform));
          }
        }
        ownershipKnown ||= commands.some(ownsCommand);
        const defaultExact = location.controllable && label === LAUNCHD_LABEL && agentDir === defaultAgentDir;
        if ((ownershipKnown || defaultExact) && commands.some(hostCommand)) found.push({ path, label, domain: location.domain, controllable: location.controllable, contents });
      }
    }
    if (found.length > 1) throw new Error("More than one native launchd job targets this local host; refusing unmanaged startup");
    if (found.length === 0) return null;
    const [job] = found;
    const targetName = `${job.domain}/${job.label}`;
    await run("launchctl", ["print", targetName]);
    if (job.controllable && job.label === LAUNCHD_LABEL) {
      await trustedFile(job.path);
      return {
        description: `launchd agent ${targetName}`,
        start: async () => { await run("launchctl", ["kickstart", targetName]); },
      };
    }
    return pending(`launchd job ${targetName}`);
  }

  if (platform === "win32") {
    const powershell = win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const fields = `$tasks=@(Get-ScheduledTask | ForEach-Object { $t=$_; [pscustomobject]@{path=[string]$t.TaskPath;name=[string]$t.TaskName;state=[string]$t.State;userId=[string]$t.Principal.UserId;actions=@($t.Actions | ForEach-Object {[pscustomobject]@{execute=[string]$_.Execute;arguments=[string]$_.Arguments}})}}); $services=@(Get-CimInstance Win32_Service | ForEach-Object {[pscustomobject]@{name=[string]$_.Name;pathName=[string]$_.PathName;startName=[string]$_.StartName;state=[string]$_.State}}); ConvertTo-Json -Compress -Depth 6 -InputObject ([pscustomobject]@{user=[Security.Principal.WindowsIdentity]::GetCurrent().Name;tasks=$tasks;services=$services})`;
    let inventory: WindowsInventory;
    try {
      inventory = JSON.parse(await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; ${fields}`])) as WindowsInventory;
    } catch (error) {
      throw new Error(`Could not inspect Windows host supervisors: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!inventory || typeof inventory.user !== "string" || !Array.isArray(inventory.tasks) || !Array.isArray(inventory.services)) throw new Error("Could not verify Windows host supervisor inventory");
    const expectedScriptPath = win32.join(installDir, "scripts", "windows", "omp-web-host.ps1");
    const expectedArguments = normal(`-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${expectedScriptPath}"`, platform);
    const currentUser = normal(inventory.user, platform);
    const recognizedTasks = inventory.tasks.filter((task) => {
      if (normal(task.userId, platform) !== currentUser || !Array.isArray(task.actions) || task.actions.length !== 1) return false;
      const action = task.actions[0];
      const args = [action.execute, ...commandArguments(action.arguments, platform)];
      const commands = [args];
      for (let index = 0; index < args.length - 1; index++) {
        if (/^-Command$/i.test(args[index])) commands.push(commandArguments(args[index + 1], platform));
      }
      return commands.some(ownsCommand) && commands.some(hostCommand);
    });
    const services = inventory.services.filter((service) => {
      const args = commandArguments(service.pathName, platform);
      const ownsAgent = args.some((argument) => inside(argument, agentDir));
      return (normal(service.startName, platform) === currentUser || ownsAgent) && ownsCommand(args) && hostCommand(args);
    });
    if (recognizedTasks.length + services.length > 1) throw new Error("More than one native Windows supervisor targets this local host; refusing unmanaged startup");
    if (services.length === 1) return pending(`Windows service ${services[0].name}`);
    if (recognizedTasks.length === 0) return null;
    const [task] = recognizedTasks;
    const exactInstallerTask = agentDir === defaultAgentDir
      && task.name === WINDOWS_TASK
      && task.path === "\\"
      && /^(?:powershell|pwsh)(?:\.exe)?$/i.test(win32.basename(task.actions[0].execute))
      && normal(task.actions[0].arguments.trim(), platform) === expectedArguments;
    if (!exactInstallerTask) return pending(`Windows scheduled task ${task.path}${task.name}`);
    const start = `$ErrorActionPreference='Stop'; Start-ScheduledTask -TaskName '${WINDOWS_TASK}' -TaskPath '\\' -ErrorAction Stop`;
    return {
      description: `Windows scheduled task ${WINDOWS_TASK}`,
      start: async () => {
        if (task.state !== "Running" && task.state !== "Queued") await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", start]);
      },
    };
  }

  return null;
}
