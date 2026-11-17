import type { SessionOriginRef } from "./message-origin";
import type { SessionInfo } from "./types";

const CACHE_MS = 30_000;
let cached: { at: number; refs: Promise<SessionOriginRef[]> } | undefined;

async function loadSessionRefs(): Promise<SessionOriginRef[]> {
  const [sessionsResponse, hostsResponse] = await Promise.all([fetch("/api/sessions"), fetch("/api/hosts")]);
  if (!sessionsResponse.ok || !hostsResponse.ok) return [];
  const sessions = await sessionsResponse.json() as { sessions?: SessionInfo[] };
  const hosts = await hostsResponse.json() as { hosts?: Array<{ id: string; label?: string }> };
  const labels = new Map((hosts.hosts ?? []).map((host) => [host.id, host.label || host.id]));
  return (sessions.sessions ?? []).map((session) => {
    const hostId = session.hostId ?? "local";
    return {
      id: session.id,
      name: session.name ?? null,
      hostId,
      hostLabel: labels.get(hostId) ?? hostId,
      cwd: session.cwd,
      createdAt: session.created,
    };
  });
}

export async function resolveSessionRef(id: string): Promise<SessionOriginRef | null> {
  const now = Date.now();
  if (!cached || now - cached.at >= CACHE_MS) cached = { at: now, refs: loadSessionRefs() };
  return (await cached.refs).find((session) => session.id === id) ?? null;
}
