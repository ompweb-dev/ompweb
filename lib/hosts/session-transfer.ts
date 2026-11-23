// Daemon side of moving a session to another workspace or host, over omp's own `omp session pack|unpack|moved`: the
// archive carries the journal, artifacts and image blobs, and unpacking rewrites the header cwd and appends an `arrived`
// marker the model sees. Main carries the archive between hosts in chunks and names the hosts for that marker.
// No `next/*` or `@/` imports: the daemon loads this through plain jiti.
import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { getAgentDir } from "../omp/paths";
import { OMP_NOT_FOUND, resolveOmpBin, wrapWindowsScript } from "../omp/omp-cli";
import { archiveSessionFileWithArtifacts, readSessionHeaderSync, writeSessionFileAtomicSync } from "../omp/session-files";
import { isRecord } from "../type-guards";
import type { OpResult } from "./session-ops";

/** One `readSessionPack`/`writeSessionPack` step; base64 of it stays well under the link's 8 MiB line. */
export const SESSION_PACK_CHUNK_BYTES = 4 * 1024 * 1024;
/** omp refuses larger session archives. */
const MAX_PACK_BYTES = 2 * 1024 ** 3;
const TRANSFER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An archive a failed move left behind. */
const STALE_TRANSFER_MS = 24 * 60 * 60 * 1000;
const MAX_LABEL_CHARS = 512;
/** Characters `cmd.exe` interprets as command syntax when passing an unquoted argument to a `.cmd`/`.bat` launcher. */
const CMD_META_RE = /[&|<>^%!"\r\n\0]/;

/** Source file state captured at pack time so retirement refuses a source that changed while unpacking on another host. */
const packedSources = new Map<string, { sessionFile: string; digest: string }>();

/** Where the session comes from, for the arrival marker: `from` is null for a move between workspaces of one host. */
export interface SessionMoveOrigin {
  host: string;
  from: { host: string; home: string; platform: string } | null;
}

const execFileAsync = promisify(execFile);
const ok = <T>(value: T): OpResult<T> => ({ ok: true, value });
const fail = (status: number, code: string, error: string): OpResult<never> => ({ ok: false, status, code, error });
const badTransfer = () => fail(400, "invalid_transfer", "Invalid session transfer");
const missingTransfer = () => fail(404, "transfer_not_found", "The session archive is gone; start the move again");

function fileDigest(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function transfersDir(): string {
  return join(getAgentDir(), "omp-web", "transfers");
}

function transferPath(transfer: unknown): string | null {
  return typeof transfer === "string" && TRANSFER_RE.test(transfer) ? join(transfersDir(), `${transfer}.tar`) : null;
}

function sweepStaleTransfers(): void {
  let names: string[];
  try {
    names = readdirSync(transfersDir());
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(transfersDir(), name);
    try {
      if (Date.now() - statSync(file).mtimeMs > STALE_TRANSFER_MS) {
        rmSync(file, { force: true });
        if (name.endsWith(".tar")) packedSources.delete(name.slice(0, -4));
      }
    } catch { /* gone meanwhile */ }
  }
}

function newTransfer(): { transfer: string; file: string } {
  sweepStaleTransfers();
  mkdirSync(transfersDir(), { recursive: true, mode: 0o700 });
  const transfer = randomUUID();
  return { transfer, file: transferPath(transfer)! };
}

/** `omp session <args>`: its stdout, or the refusal omp printed (`error: …`, exit 1) as a 409. */
async function runOmpSession(args: string[]): Promise<OpResult<string>> {
  const bin = resolveOmpBin();
  if (!bin) return fail(500, "omp_not_found", OMP_NOT_FOUND);
  const target = wrapWindowsScript(bin, ["session", ...args]);
  try {
    const { stdout } = await execFileAsync(target.file, target.args, { cwd: tmpdir(), timeout: 5 * 60_000, maxBuffer: 1024 * 1024, windowsHide: true });
    return ok(stdout);
  } catch (error) {
    const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr : "";
    // chalk's colours, when omp thinks it writes to a terminal.
    const refusal = stderr.replace(/\x1b\[[0-9;]*m/g, "").split("\n").find((line) => line.startsWith("error: "));
    if (refusal) return fail(409, "session_move_refused", refusal.slice("error: ".length));
    return fail(500, "session_move_failed", error instanceof Error ? error.message : String(error));
  }
}

export async function packSessionFile(sessionFile: string): Promise<OpResult<{ transfer: string; bytes: number; home: string; platform: string }>> {
  let digest: string;
  try {
    digest = fileDigest(sessionFile);
  } catch {
    return fail(404, "session_not_found", "Session not found");
  }
  const { transfer, file } = newTransfer();
  const packed = await runOmpSession(["pack", sessionFile, file]);
  if (!packed.ok) {
    rmSync(file, { force: true });
    return packed;
  }
  const bytes = statSync(file).size;
  if (bytes > MAX_PACK_BYTES) {
    rmSync(file, { force: true });
    return fail(413, "session_too_large", "The session is too large to move");
  }
  try {
    if (fileDigest(sessionFile) !== digest) {
      rmSync(file, { force: true });
      return fail(409, "session_changed", "The session changed while preparing the move; try again");
    }
  } catch {
    rmSync(file, { force: true });
    return fail(404, "session_not_found", "Session not found");
  }
  packedSources.set(transfer, { sessionFile, digest });
  return ok({ transfer, bytes, home: homedir(), platform: process.platform });
}

export async function readSessionPack(transfer: string, offset: number): Promise<OpResult<Uint8Array>> {
  const file = transferPath(transfer);
  if (!file || !Number.isSafeInteger(offset) || offset < 0) return badTransfer();
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return missingTransfer();
  }
  try {
    const chunk = Buffer.alloc(SESSION_PACK_CHUNK_BYTES);
    return ok(chunk.subarray(0, readSync(fd, chunk, 0, chunk.length, offset)));
  } finally {
    closeSync(fd);
  }
}

/** Appends `data` (base64) to the archive being received; `offset` must be its current size, so a repeated step fails. */
export async function writeSessionPack(transfer: string, offset: number, data: string): Promise<OpResult<{ bytes: number }>> {
  const file = transferPath(transfer);
  if (!file || !Number.isSafeInteger(offset) || offset < 0 || typeof data !== "string") return badTransfer();
  const chunk = Buffer.from(data, "base64");
  if (chunk.byteLength > SESSION_PACK_CHUNK_BYTES || offset + chunk.byteLength > MAX_PACK_BYTES) return fail(413, "session_too_large", "The session is too large to move");
  if (offset === 0) {
    sweepStaleTransfers();
    mkdirSync(transfersDir(), { recursive: true, mode: 0o700 });
  }
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    if (offset !== 0) return missingTransfer();
  }
  if (size !== offset) return fail(409, "transfer_offset", `The session archive has ${size} bytes, not ${offset}`);
  appendFileSync(file, chunk, { mode: 0o600 });
  return ok({ bytes: offset + chunk.byteLength });
}

export function discardSessionPack(transfer: string): OpResult<null> {
  const file = transferPath(transfer);
  if (!file) return badTransfer();
  packedSources.delete(transfer);
  rmSync(file, { force: true });
  return ok(null);
}

function validOrigin(move: unknown): move is SessionMoveOrigin {
  const label = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= MAX_LABEL_CHARS;
  if (!isRecord(move) || !label(move.host)) return false;
  if (move.from === null) return true;
  return isRecord(move.from) && label(move.from.host) && label(move.from.home) && label(move.from.platform);
}

/** What the session reads where it arrived: omp's own words say "another machine" even for a move on one host. */
function arrivalNotice(fromCwd: string, cwd: string, move: SessionMoveOrigin): string {
  const code = (text: string) => "`" + text + "`";
  if (!move.from) {
    return `This session was moved on host ${code(move.host)} from the workspace ${code(fromCwd)} to ${code(cwd)}. Its working directory is now ${code(cwd)}; paths from earlier turns under ${code(fromCwd)} belong to the old workspace. Running processes and shell state did not move with it.`;
  }
  const lines = [`This session was moved from host ${code(move.from.host)} to host ${code(move.host)}. It ran in ${code(fromCwd)} there; its working directory is now ${code(cwd)}, and paths from earlier turns under ${code(fromCwd)} now live under ${code(cwd)}.`];
  if (move.from.home !== homedir()) lines.push(`The home directory changed from ${code(move.from.home)} to ${code(homedir())}.`);
  if (move.from.platform !== process.platform) lines.push(`The operating system changed from ${move.from.platform} to ${process.platform}.`);
  lines.push("Running processes, shell state, and files outside the working directory did not move with it.");
  return lines.join(" ");
}

/** Rewords the `arrived` marker omp just appended as the file's last line. */
function rewordArrival(sessionFile: string, move: SessionMoveOrigin): void {
  const body = readFileSync(sessionFile, "utf8");
  const end = body.endsWith("\n") ? body.length - 1 : body.length;
  const start = body.lastIndexOf("\n", end - 1) + 1;
  let entry: unknown;
  try {
    entry = JSON.parse(body.slice(start, end));
  } catch {
    return;
  }
  if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== "session-transfer") return;
  const details = entry.details;
  if (!isRecord(details) || details.kind !== "arrived" || typeof details.fromCwd !== "string" || typeof details.cwd !== "string") return;
  entry.content = arrivalNotice(details.fromCwd, details.cwd, move);
  writeSessionFileAtomicSync(sessionFile, body.slice(0, start) + JSON.stringify(entry) + body.slice(end), "move");
}

/** Lands archive `transfer` in `cwd`'s session directory. On the host it was packed on, omp replaces the copy it came
 * from, so that is the whole move; a copy that diverged meanwhile makes it a fork with a new id. */
export async function unpackSessionPack(transfer: string, cwd: string, move: unknown): Promise<OpResult<{ sessionId: string }>> {
  const file = transferPath(transfer);
  if (!file || typeof cwd !== "string" || !cwd) return badTransfer();
  if (CMD_META_RE.test(cwd)) return fail(400, "invalid_destination", "The destination path contains characters that cmd.exe reads as syntax");
  if (!validOrigin(move)) return fail(400, "invalid_request", "Invalid move origin");
  try {
    statSync(file);
  } catch {
    return missingTransfer();
  }
  try {
    const expected = packedSources.get(transfer);
    if (expected) {
      let currentDigest: string;
      try {
        currentDigest = fileDigest(expected.sessionFile);
      } catch {
        return fail(404, "session_not_found", "Session not found");
      }
      if (currentDigest !== expected.digest) {
        return fail(409, "session_changed", "The session changed during the move; keeping the source copy");
      }
    }
    const unpacked = await runOmpSession(["unpack", file, "--cwd", cwd]);
    if (!unpacked.ok) return unpacked;
    const sessionFile = unpacked.value.trim().split("\n").at(-1) ?? "";
    const sessionId = sessionFile ? readSessionHeaderSync(sessionFile)?.id : undefined;
    if (!sessionId) return fail(500, "session_move_failed", "omp did not report the unpacked session");
    rewordArrival(sessionFile, move);
    return ok({ sessionId });
  } finally {
    packedSources.delete(transfer);
    rmSync(file, { force: true });
  }
}

/** The copy a move to another host left here: marked moved to `to` (resuming it forks), then archived. */
export async function retireMovedSession(sessionFile: string, transfer: string, to: unknown): Promise<OpResult<null>> {
  if (!transferPath(transfer)) return badTransfer();
  if (typeof to !== "string" || !to.trim() || to.length > MAX_LABEL_CHARS) return fail(400, "invalid_request", "Invalid move label");
  if (CMD_META_RE.test(to)) return fail(400, "invalid_destination", "The destination path contains characters that cmd.exe reads as syntax");
  const expected = packedSources.get(transfer);
  if (expected) {
    let currentDigest: string;
    try {
      currentDigest = fileDigest(sessionFile);
    } catch {
      discardSessionPack(transfer);
      return fail(404, "session_not_found", "Session not found");
    }
    if (expected.sessionFile !== sessionFile || currentDigest !== expected.digest) {
      discardSessionPack(transfer);
      return fail(409, "session_changed", "The session changed during the move; keeping the source copy");
    }
  }
  const discarded = discardSessionPack(transfer);
  if (!discarded.ok) return discarded;
  const marked = await runOmpSession(["moved", sessionFile, "--to", to]);
  if (!marked.ok) return marked;
  archiveSessionFileWithArtifacts(sessionFile);
  return ok(null);
}
