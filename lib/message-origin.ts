export const ORIGIN_MAX_BYTES = 4096;

export interface SessionOriginRef {
  id: string;
  name: string | null;
  hostId: string;
  hostLabel: string;
  cwd?: string;
  createdAt?: string;
}

export interface SessionMessageOrigin extends MessageOrigin {
  kind: "session";
  session: SessionOriginRef & {
    tool: "send_to_session" | "new_session";
    delivery: "prompt" | "steer" | "followUp";
  };
}

export interface GithubMessageOrigin extends MessageOrigin {
  kind: "github";
  github: {
    repo: string;
    number: number;
    target: "pr" | "issue" | "workflow" | "run";
    url: string;
    events: Array<{ kind: string; author?: string; bot?: boolean; state?: string }>;
  };
}

export interface MessageOrigin {
  v: 1;
  kind: string;
  sentAt: string;
  session?: SessionMessageOrigin["session"];
  github?: GithubMessageOrigin["github"];
}

const encoder = new TextEncoder();
const DELIVERIES: Record<string, true> = { prompt: true, steer: true, followUp: true };
const GITHUB_TARGETS: Record<string, true> = { pr: true, issue: true, workflow: true, run: true };
const DELIVERY_LABELS: Record<SessionMessageOrigin["session"]["delivery"], string> = {
  prompt: "new turn",
  steer: "steer",
  followUp: "follow-up",
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function validHttpUrl(value: unknown): value is string {
  if (!nonempty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function common(value: Record<string, unknown>): value is Record<string, unknown> & { v: 1; kind: string; sentAt: string } {
  return value.v === 1 && nonempty(value.kind) && nonempty(value.sentAt) && Number.isFinite(Date.parse(value.sentAt));
}

function sessionOrigin(value: Record<string, unknown>): SessionMessageOrigin | null {
  const session = value.session;
  if (!record(session) || !nonempty(session.id) || !nonempty(session.hostId) || !nonempty(session.hostLabel)
    || !(session.name === null || typeof session.name === "string") || !optionalString(session.cwd)
    || !optionalString(session.createdAt) || (session.createdAt !== undefined && !Number.isFinite(Date.parse(session.createdAt)))
    || (session.tool !== "send_to_session" && session.tool !== "new_session")
    || !DELIVERIES[session.delivery as string]) return null;
  return {
    v: 1,
    kind: "session",
    sentAt: value.sentAt as string,
    session: {
      id: session.id,
      name: session.name,
      hostId: session.hostId,
      hostLabel: session.hostLabel,
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
      tool: session.tool,
      delivery: session.delivery as SessionMessageOrigin["session"]["delivery"],
    },
  };
}

function githubOrigin(value: Record<string, unknown>): GithubMessageOrigin | null {
  const github = value.github;
  if (!record(github) || !nonempty(github.repo) || !Number.isInteger(github.number) || (github.number as number) < 1
    || !GITHUB_TARGETS[github.target as string] || !validHttpUrl(github.url)
    || !Array.isArray(github.events) || github.events.length > 20) return null;
  const events: GithubMessageOrigin["github"]["events"] = [];
  for (const event of github.events) {
    if (!record(event) || !nonempty(event.kind) || !optionalString(event.author) || !optionalString(event.state)
      || !(event.bot === undefined || typeof event.bot === "boolean")) return null;
    events.push({
      kind: event.kind,
      ...(event.author === undefined ? {} : { author: event.author }),
      ...(event.bot === undefined ? {} : { bot: event.bot }),
      ...(event.state === undefined ? {} : { state: event.state }),
    });
  }
  return {
    v: 1,
    kind: "github",
    sentAt: value.sentAt as string,
    github: {
      repo: github.repo,
      number: github.number as number,
      target: github.target as GithubMessageOrigin["github"]["target"],
      url: github.url,
      events,
    },
  };
}

export function parseMessageOrigin(value: unknown): MessageOrigin | null {
  if (!record(value)) return null;
  try {
    if (encoder.encode(JSON.stringify(value)).length > ORIGIN_MAX_BYTES) return null;
  } catch {
    return null;
  }
  if (!common(value)) return null;
  if (value.kind === "session") return sessionOrigin(value);
  if (value.kind === "github") return githubOrigin(value);
  return { v: 1, kind: value.kind, sentAt: value.sentAt };
}

export function formatSessionOriginHeader(origin: MessageOrigin): string {
  if (origin.kind !== "session" || !origin.session) throw new Error("A session origin is required");
  const { id, name, hostLabel, delivery } = origin.session;
  const source = name ? `omp-web session ${JSON.stringify(name)}` : "an unnamed omp-web session";
  const host = hostLabel.replace(/[\r\n,\]]+/g, " ").trim();
  return `[Message from ${source} (session id ${id}, host ${host}, delivery ${DELIVERY_LABELS[delivery]}).\nIt was sent by another agent session, not by the user. Reply with send_to_session to that session id.]`;
}

const SESSION_HEADER_RE = /^\[Message from (?:omp-web session "(?:[^"\\]|\\.)*"|an unnamed omp-web session) \(session id [^,\r\n]+, host [^,\r\n]+, delivery (?:new turn|steer|follow-up)\)\.\nIt was sent by another agent session, not by the user\. Reply with send_to_session to that session id\.\]/;

export function splitOriginHeader(text: string): { header: string; body: string } | null {
  const match = SESSION_HEADER_RE.exec(text);
  if (!match || text.slice(match[0].length, match[0].length + 2) !== "\n\n") return null;
  return { header: match[0], body: text.slice(match[0].length + 2) };
}
