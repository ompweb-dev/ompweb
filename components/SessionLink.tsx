"use client";

import type { MouseEvent } from "react";
import type { SessionOriginRef } from "@/lib/message-origin";
import { OPEN_SESSION_EVENT } from "@/lib/notification-client";

function sessionLabel(session: SessionOriginRef): string {
  if (session.name?.trim()) return session.name.trim();
  const project = session.cwd?.split(/[\\/]/).filter(Boolean).at(-1);
  const created = session.createdAt ? new Date(session.createdAt) : null;
  const date = created && Number.isFinite(created.getTime())
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(created)
    : null;
  return ["Untitled session", project, date].filter(Boolean).join(" · ");
}

export function SessionLink({ session, newTab = false }: { session: SessionOriginRef; newTab?: boolean }) {
  const label = sessionLabel(session);
  const href = `/?session=${encodeURIComponent(session.id)}&host=${encodeURIComponent(session.hostId)}`;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (newTab || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, {
      detail: { sessionId: session.id, hostId: session.hostId },
    }));
  };
  return (
    <a
      href={href}
      onClick={open}
      target={newTab ? "_blank" : undefined}
      rel={newTab ? "noopener" : undefined}
      aria-label={`Open session ${label} on ${session.hostLabel}`}
      style={{ color: "var(--accent)", fontWeight: 600 }}
    >
      {label}
    </a>
  );
}
