export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  hostId?: string;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;
  const hostId = searchParams.get(requestedCwd ? "hostId" : "host");

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : searchParams.get("session"),
    ...(hostId !== null ? { hostId } : {}),
  };
}

export function initialSessionMatches(
  session: { id: string; hostId?: string },
  navigation: Pick<InitialNavigation, "sessionId" | "hostId">,
): boolean {
  return session.id === navigation.sessionId
    && (navigation.hostId === undefined || (session.hostId ?? "local") === navigation.hostId);
}
