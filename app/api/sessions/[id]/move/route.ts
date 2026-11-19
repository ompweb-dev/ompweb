import { hostname } from "os";
import { apiErrorResponse, hostOfflineResponse, opErrorResponse, resolveHostOrError, resolveSessionHostOr404 } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { comparableProjectPath } from "@/lib/comparable-path";
import type { Host } from "@/lib/hosts/host";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { customLocalLabel, LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { invalidateHostSessionList } from "@/lib/hosts/session-index";
import { clearExitedRpcSession, getRpcSession, getRunningRpcSessionIds } from "@/lib/rpc-manager";

/** Session ids with a move in progress in this server process. */
const sessionsMoving = new Set<string>();

/** Characters `cmd.exe` interprets as command syntax when passing an unquoted argument to a `.cmd`/`.bat` launcher. */
const CMD_META_RE = /[&|<>^%!"\r\n\0]/;

/** The name the moved session reads: "This machine" says nothing to the model. */
function sessionHostName(host: Host): string {
  return host.id === LOCAL_HOST_ID ? customLocalLabel() || hostname() : host.label;
}

/** Copies a packed archive from `source` to `target` over the two links, one chunk per round trip. */
async function copyPack(source: Host, target: Host, transfer: string, bytes: number): Promise<void> {
  for (let offset = 0; offset < bytes;) {
    const chunk = await source.sessionOps.readSessionPack(transfer, offset);
    if (!chunk.ok) throw new HostOpError(chunk.status, chunk.code, chunk.error);
    if (chunk.value.byteLength === 0) throw new HostOpError(502, "transfer_truncated", `${source.label} sent a truncated session archive`);
    const written = await target.sessionOps.writeSessionPack(transfer, offset, Buffer.from(chunk.value).toString("base64"));
    if (!written.ok) throw new HostOpError(written.status, written.code, written.error);
    const nextOffset = offset + chunk.value.byteLength;
    if (written.value.bytes !== nextOffset) {
      throw new HostOpError(502, "host_bad_result", `${target.label} reported an unexpected session archive offset`);
    }
    offset = nextOffset;
  }
}

/** POST /api/sessions/[id]/move  body: { hostId?: string, cwd: string } — move a stopped session into workspace `cwd`
 * of host `hostId` (this machine when absent). omp packs it with its artifacts and blobs and unpacks it there, which
 * tells the session where it came from; a copy left on another host is marked moved and archived. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let reserved = false;
  try {
    const { hostId, cwd } = await parseJsonWithinLimit<{ hostId?: unknown; cwd?: unknown }>(req, 64 * 1024);
    if (typeof cwd !== "string" || !cwd.trim()) {
      return Response.json({ error: "cwd is required", code: "cwd_required" }, { status: 400 });
    }
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const source = resolved.host;
    const offline = hostOfflineResponse(source);
    if (offline) return offline;
    const targetResolved = resolveHostOrError(hostId);
    if ("response" in targetResolved) return targetResolved.response;
    const target = targetResolved.host;

    // Check and reserve in one synchronous step, before any await.
    if (sessionsMoving.has(id)) {
      return Response.json({ error: "This session is already moving", code: "session_busy" }, { status: 409 });
    }
    sessionsMoving.add(id);
    reserved = true;

    if (getRunningRpcSessionIds().includes(id) || getRpcSession(id)?.isEditingHistory()) {
      return Response.json({ error: "Wait for the response to finish before moving this session", code: "session_busy" }, { status: 409 });
    }
    // Children may name their parent by path, which the move changes.
    const sessions = await source.sessionOps.listSessions();
    if (sessions.some((session) => session.parentSessionId === id)) {
      return Response.json({ error: "Move child sessions before moving this session", code: "session_has_children" }, { status: 409 });
    }
    const selected = await target.sessionOps.validateCwd(cwd);
    if (!selected.ok) return opErrorResponse(selected);
    const { cwd: destination, projectRoot } = selected.value;
    const sameHost = source.id === target.id;
    const destinationLabel = `${sessionHostName(target)}:${destination}`;
    if (CMD_META_RE.test(sameHost ? destination : destinationLabel)) {
      return Response.json({ error: "The destination path contains characters that cmd.exe reads as syntax", code: "invalid_destination" }, { status: 400 });
    }
    const current = sessions.find((session) => session.id === id);
    if (sameHost && current && comparableProjectPath(current.cwd) === comparableProjectPath(destination)) {
      return Response.json({ ok: true, sessionId: id, hostId: target.id, cwd: destination, projectRoot });
    }

    const live = getRpcSession(id);
    if (!live?.hostOwnedLifecycle) await live?.destroyAndWait?.("move", true);
    const packed = await source.sessionOps.packSession(id);
    if (!packed.ok) return opErrorResponse(packed);
    const { transfer, bytes, home, platform } = packed.value;

    let sessionId: string;
    let unpackSent = false;
    try {
      if (!sameHost) await copyPack(source, target, transfer, bytes);
      unpackSent = true;
      const unpacked = await target.sessionOps.unpackSession(transfer, destination, {
        host: sessionHostName(target),
        from: sameHost ? null : { host: sessionHostName(source), home, platform },
      });
      if (!unpacked.ok) throw new HostOpError(unpacked.status, unpacked.code, unpacked.error);
      sessionId = unpacked.value.sessionId;
    } catch (error) {
      if (unpackSent && error instanceof HostOpError && error.code === "host_offline") {
        // The destination may have already unpacked the session before the reply was lost; keep the destination untouched.
        if (!sameHost) await source.sessionOps.discardSessionPack(transfer).catch(() => {});
        return Response.json(
          { error: `${target.label} went offline before confirming the move; check ${target.label} before retrying`, code: "move_outcome_unknown", hostOffline: true },
          { status: 503 },
        );
      }
      await Promise.allSettled([source.sessionOps.discardSessionPack(transfer), ...(sameHost ? [] : [target.sessionOps.discardSessionPack(transfer)])]);
      throw error;
    } finally {
      invalidateHostSessionList(target.id);
    }

    // The session now lives on the target; a copy left behind would be listed twice.
    let staleCopy: string | undefined;
    if (!sameHost) {
      const retired = await source.sessionOps.finishSessionMove(id, transfer, destinationLabel)
        .catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
      if (!retired.ok) {
        staleCopy = retired.error;
        console.warn(`[omp-web] session ${id} moved to ${target.label}, but its copy on ${source.label} was not retired: ${retired.error}`);
      }
      invalidateHostSessionList(source.id);
    }
    clearExitedRpcSession(id);
    return Response.json({ ok: true, sessionId, hostId: target.id, cwd: destination, projectRoot, ...(staleCopy ? { staleCopy } : {}) });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: "Request body is too large", code: "request_too_large" }, { status: 413 });
    }
    if (error instanceof SyntaxError) {
      return Response.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
    }
    if (error instanceof HostOpError) return apiErrorResponse(error);
    console.error("[api/sessions/move]", error);
    return Response.json({ error: "Session move failed", code: "session_move_failed" }, { status: 500 });
  } finally {
    if (reserved) sessionsMoving.delete(id);
  }
}
