# Message origin: messages from other sessions and tools

Status: approved by the user (2026-11-14), adapted to current `main` (2026-11-15).

## Intent

Some messages a session receives were not typed by the user. Another agent session sends them through omp-web's agent tools (`send_to_session`, `new_session` with a first prompt), and omp-web's GitHub watcher sends repository updates through the message outbox. Today both become native user messages and render like the user typed them.

The UI must show at a glance that omp-web generated the message, identify its source, and link to a sending session or GitHub item. The receiving model must still get enough plain text to understand and reply to the source.

## Goals

- Every message omp-web sends on behalf of another session or an internal watcher carries server-written structured `origin` metadata.
- Origin metadata persists with the native message, survives reloads, branches, queueing, reconnects and outbox retries, and never changes model authority.
- The chat renders trusted-origin messages as distinctive, left-aligned cards rather than user bubbles.
- Pending outbox messages and native queue chips expose origin before delivery.
- Agent-tool confirmations and sender-side tool rows use session names and links instead of raw UUID labels.
- GitHub watcher cards link to the watched item and summarize the batch without rendering GitHub-authored prose.

## Non-goals

- Rewriting UUIDs inside arbitrary transcript text.
- Changing prompt, steer, follow-up, wait, outbox or watcher delivery semantics.
- Granting watcher or cross-session messages developer/system authority.
- Adding dependencies, protocol versions, settings or feature flags.

## Anti-goals

- **Forgeable provenance:** typed text must never produce a trusted origin card.
- **Client-supplied origin:** HTTP, browser-link and browser outbox commands must not set `origin`.
- **Lost delivery evidence:** origin support must not weaken `clientMessageId`, outbox idempotency or GitHub pending-batch crash recovery.

## Origin contract

```ts
interface SessionOriginRef {
  id: string;
  name: string | null;
  hostId: string;
  hostLabel: string;
  cwd?: string;
  createdAt?: string;
}

type MessageOrigin =
  | {
      v: 1;
      kind: "session";
      sentAt: string;
      session: SessionOriginRef & {
        tool: "send_to_session" | "new_session";
        delivery: "prompt" | "steer" | "followUp";
      };
    }
  | {
      v: 1;
      kind: "github";
      sentAt: string;
      github: {
        repo: string;
        number: number;
        target: "pr" | "issue" | "workflow" | "run";
        url: string;
        events: Array<{ kind: string; author?: string; bot?: boolean; state?: string }>;
      };
    }
  | { v: 1; kind: string; sentAt: string };
```

`parseMessageOrigin` accepts version 1, bounds serialized UTF-8 size to 4096 bytes, validates known variants strictly, and preserves an unknown kind as a generic origin. Only server-owned paths construct origins.

## Storage and transport

OMP's message entries cannot carry arbitrary fields. Its runner already journals `clientMessageId` in a `client-message-entry` custom entry. The same entry gains `origin`; live `message_start` and `message_end` frames, queue snapshots and reconciliation status carry it beside the existing ID.

The session reader joins journaled origin onto the active branch's user message. Malformed, oversized or abandoned-branch metadata is dropped without losing the message or `clientMessageId`.

The outbox gains a nullable `origin` column. It appears in browser snapshots and is forwarded to the runner, but browser commands cannot populate it. GitHub pending batches persist the same origin with the batch so a crash cannot change or lose provenance on replay.

Current and older runners ignore unknown command fields. Therefore no link capability or protocol bump is needed. An older runner stores the native message without metadata; the model-facing header remains visible as ordinary text instead of being parsed into a forgeable card.

## Model-facing text

A cross-session message starts with a fixed header:

```text
[Message from omp-web session "Incident review" (session id 01a1c9d8-4206-736f-b9cf-ebccf7912207, host worker-1, delivery follow-up).
It was sent by another agent session, not by the user. Reply with send_to_session to that session id.]

<body>
```

An unnamed sender says `an unnamed omp-web session`. GitHub updates keep their existing `GitHub update (omp-web): ...` header. Trusted cards hide only a recognized server-generated header and provide **Show raw**. The same text without metadata remains an ordinary user bubble.

## UI

### Incoming card

`OriginMessageView` is full-width, left-aligned, and uses existing design tokens. Its header identifies `Session message` or the GitHub target, source, host, delivery and time. The body uses the existing markdown renderer and 300px overflow behavior. It keeps Edit and Fork semantics; editing drops origin because the resent message is then user-authored.

The card uses semantic links, keyboard-accessible controls, `role="article"`, explicit accessible labels, and mobile wrapping without horizontal scrolling. It uses `lucide-react` icons and no new colors.

### Session links

`SessionLink` renders the origin's name snapshot and host-qualified URL. Untitled sessions use project/date context when available, never the UUID as visible text. Plain clicks use omp-web navigation; modified clicks remain normal browser navigation. Deleted and offline targets retain their snapshot label and report the existing appropriate error.

### Confirmations and sender tool rows

Server-owned confirmation payloads show source, destination, delivery and escaped message text. Runner-supplied UI requests cannot inject these payloads. `send_to_session` and `new_session` tool rows show the named target, delivery and actual result state; raw arguments remain in the existing details view.

### Held messages and queue chips

Outbox-held messages and native queued messages use compact origin identity (`From <name>` or the GitHub target). They remain in their current order and retain existing actions and statuses.

## Security and compatibility

- External commands carrying `origin` fail with `400 origin_not_allowed`.
- The runner and reader enforce the 4096-byte cap independently.
- React escapes all origin labels and message text; no raw HTML is introduced.
- GitHub origin stores bounded metadata only, never comment, review or workflow text.
- Unknown origin kinds render a generic automated-message card.
- Missing or invalid metadata degrades to the ordinary user message.
- Existing transcripts and old runners remain readable; no parsed-prefix card fallback is used.
