// The OS folder dialog for the machine running the server. Only meaningful when the page is
// opened on that same desktop, so the /api/cwd routes gate on the connection's peer address.
import { spawn, spawnSync } from "node:child_process";

export type PickedDirectory = { path: string } | { cancelled: true };

const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

/** The folder-dialog command for this platform, or null where we know no chooser. */
export function pickerCommand(platform: NodeJS.Platform = process.platform): { file: string; args: string[] } | null {
  if (platform === "win32") {
    // ponytail: the classic WinForms dialog, not IFileOpenDialog — it works from a non-console
    // parent without COM plumbing; swap in the Vista-style picker if the look ever matters.
    return {
      file: "powershell.exe",
      args: [
        "-NoProfile",
        "-STA",
        "-Command",
        [
          "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
          "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
          "$d.Description = 'Select a folder'",
          "$d.SelectedPath = $env:USERPROFILE",
          "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
        ].join("; "),
      ],
    };
  }
  if (platform === "darwin") return { file: "osascript", args: ["-e", 'POSIX path of (choose folder with prompt "Select a folder")'] };
  if (platform === "linux") return { file: "zenity", args: ["--file-selection", "--directory", "--title", "Select a folder"] };
  return null;
}

/** Whether this platform's chooser is installed: Windows and macOS ship theirs, Linux needs zenity. */
export function hasPicker(platform: NodeJS.Platform = process.platform): boolean {
  const command = pickerCommand(platform);
  if (!command) return false;
  if (platform !== "linux") return true;
  return spawnSync("which", [command.file], { stdio: "ignore" }).status === 0;
}

/** Both the Browse button and the pick request need this: a chooser on the machine the browser is on. */
export function pickerAvailable(localPeer: boolean, platform: NodeJS.Platform = process.platform): boolean {
  return localPeer && hasPicker(platform);
}

/** What a finished dialog means: a chosen path, a dismissal, or a failure worth reporting. */
export type DialogOutcome = PickedDirectory | { error: string };

/** Reads a chooser's exit status: only a real dismissal counts as cancellation. */
export function dialogOutcome(
  platform: NodeJS.Platform | string,
  code: number | null,
  stdout: string,
  stderr: string,
): DialogOutcome {
  // Only the chooser's own line terminator: a directory name may end in a space.
  const path = stdout.replace(/[\r\n]+$/, "");
  if (path) return { path };
  // Dismissed: zenity exits 1, the Windows dialog exits 0 with no output, and osascript exits 1
  // for a cancelled dialog — but every other AppleScript error exits 1 too, so it needs -128.
  const dismissed =
    code === 0 || (code === 1 && (platform === "linux" || (platform === "darwin" && stderr.includes("(-128)"))));
  if (dismissed) return { cancelled: true };
  return { error: stderr.replace(/[\r\n]+$/, "") || `The folder dialog exited with code ${code}` };
}

/** Opens the dialog and waits for it; null when this platform has no chooser. */
export function pickDirectory(platform: NodeJS.Platform = process.platform): Promise<PickedDirectory | null> {
  const command = pickerCommand(platform);
  if (!command) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), DIALOG_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const outcome = dialogOutcome(platform, code, stdout, stderr);
      if ("error" in outcome) reject(new Error(outcome.error));
      else resolve(outcome);
    });
  });
}
