# Message Origin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist server-authored provenance on cross-session and GitHub watcher messages and render those messages distinctly from user input.

**Architecture:** A browser-safe `MessageOrigin` contract crosses only trusted internal seams. The runner journals origin beside existing `clientMessageId` correlation, the reader joins it back onto native user messages, and the outbox stores it for pending/retried delivery. React renders metadata, never parsed text, as an origin card.

**Tech Stack:** TypeScript, Bun, React, SQLite, Testing Library, lucide-react.

**Spec:** `docs/specs/2026-11-14-message-origin-design.md`

## Global Constraints

- Origin remains an optional additive field; delivery semantics and native user-message authority do not change.
- Only server-owned paths may supply origin. External commands carrying it fail with `400 origin_not_allowed`.
- Serialized origin is at most 4096 UTF-8 bytes.
- Known variants validate strictly; unknown version-1 kinds render generically.
- No dependency, setting, feature flag or protocol-version addition.
- No parsed-prefix provenance card. Missing metadata degrades to ordinary message text.
- Existing design tokens, `lucide-react`, semantic controls and mobile-browser constraints apply.

## Review Focus

1. A user types the exact model-facing header: it remains an ordinary user bubble.
2. A browser submits `origin` through HTTP, browser-link or outbox: it is rejected before any native write.
3. A malformed, oversized or abandoned-branch journal origin: the message and `clientMessageId` remain usable without origin.
4. GitHub crashes between pending-batch creation and outbox admission: replay uses identical origin and entry identity.
5. An older runner ignores origin: the message still arrives with explicit source text and no false card.

---

### Task 1: Shared origin contract

**Files:**
- Create: `lib/message-origin.ts`
- Modify: `lib/types.ts`
- Test: `lib/message-origin.test.mjs`

**Interfaces:**
- Produces `ORIGIN_MAX_BYTES`, `SessionOriginRef`, `MessageOrigin`, `parseMessageOrigin(value)`, `formatSessionOriginHeader(origin)`, and `splitOriginHeader(text)`.
- `UserMessage.origin?: MessageOrigin`; origin is also reusable by held and queued message types.

- [ ] Write tests for valid session/GitHub origins, unknown kind, invalid known shapes, 4097-byte input, exact session header, and exact-header splitting.
- [ ] Run `bun test --parallel lib/message-origin.test.mjs`; expect failure because module/type is absent.
- [ ] Implement the smallest browser-safe validator and formatters. Measure bytes with `TextEncoder`.
- [ ] Run the same test; expect pass.
- [ ] Commit `feat(origin): define trusted message provenance`.

### Task 2: Runner journal and transcript reader

**Files:**
- Modify: `runner/src/correlation.ts`
- Modify: `runner/src/commands/prompting.ts`
- Modify: `lib/session-reader.ts`
- Test: `runner/test/correlation.test.ts`
- Test: `lib/session-reader.test.mjs`

**Interfaces:**
- Runner `claimClientMessage(session, clientMessageId, origin?)` validates a plain version-1 object within 4096 bytes.
- `ClientMessageClaim.origin` journals into `client-message-entry`, stamps live message events, status messages and queue identity.
- Reader maps each entry ID to `{ clientMessageId, origin? }` and attaches valid origin only to its active-branch user message.

- [ ] Add runner tests proving journal/live/status/queue propagation and rejection without `clientMessageId` or above 4096 bytes.
- [ ] Add reader tests proving valid join, malformed drop, abandoned-branch isolation and paged-history preservation.
- [ ] Run `cd runner && bun test test/correlation.test.ts`, then `bun test --parallel lib/session-reader.test.mjs`; expect origin assertions to fail.
- [ ] Implement propagation without changing existing correlation ordering or status budgets.
- [ ] Run both commands; expect pass.
- [ ] Commit `feat(origin): persist provenance with message correlation`.

### Task 3: Durable outbox and GitHub watcher origins

**Files:**
- Modify: `lib/message-outbox-schema.ts`
- Modify: `lib/message-outbox.ts`
- Modify: `lib/types.ts`
- Modify: `lib/github/events.ts`
- Modify: `lib/github/watch-store.ts`
- Modify: `lib/github/watcher.ts`
- Test: `lib/message-outbox.test.mjs`
- Test: `lib/github/events.test.mjs`
- Test: `lib/github/watch-store.test.mjs`
- Test: `lib/github/watcher.test.mjs`

**Interfaces:**
- SQLite `entries.origin TEXT` is nullable and migrated additively.
- Internal `runOutboxCommand(..., owner, origin?)` accepts parsed server origin; snapshots expose it and dispatcher forwards it with `clientMessageId`.
- Browser-originated outbox calls cannot populate the internal argument.
- Each persisted watcher batch contains `{ entryId, message, origin }`; event splitting builds bounded GitHub origin metadata for that exact batch.

- [ ] Add outbox tests for migration, snapshots, forwarding, retry identity and malformed stored-origin degradation.
- [ ] Add watcher/store tests proving batch-specific metadata and crash replay retain identical origin.
- [ ] Run the four focused test files; expect origin assertions to fail.
- [ ] Implement the nullable column, internal plumbing and persisted watcher batch contract.
- [ ] Run focused tests; expect pass.
- [ ] Commit `feat(github): attribute durable watcher messages`.

### Task 4: Agent-tool origins and trusted confirmation payloads

**Files:**
- Modify: `lib/agent-tools.ts`
- Modify: `lib/rpc-manager.ts`
- Modify: `lib/agent-command.ts`
- Modify: `lib/types.ts`
- Modify: `components/ExtensionDialog.tsx`
- Test: `lib/agent-tools.test.mjs`
- Test: `lib/rpc-manager.test.mjs`
- Test: `lib/agent-command.test.mjs`
- Test: `components/ExtensionDialog.test.mjs`

**Interfaces:**
- Agent-tool context includes source name/host label and `confirm(title, payload?)`.
- `AgentToolDeliverInput` and initial-session input carry a server-built origin and stable `clientMessageId`.
- `AgentSessionWrapper.send(command, { origin? })` adds origin only through its internal option; untrusted command objects containing `origin` are refused.
- Server confirm payload is a discriminated union for `send_to_session` and `new_session`; runner frames have any lookalike payload stripped.
- Results add target/session names and explicit declined state.

- [ ] Add tests for named origin construction, exact model header, prompt/steer/follow-up propagation, pooled replay IDs, external rejection, payload stripping and escaped accessible confirmation rendering.
- [ ] Run the four focused test files; expect failure on missing origin/payload behavior.
- [ ] Implement trusted internal options, source lookup, header text, names/results and confirmation UI.
- [ ] Run focused tests; expect pass.
- [ ] Commit `feat(agent-tools): identify cross-session messages`.

### Task 5: Origin cards, links and compact queue surfaces

**Files:**
- Create: `components/SessionLink.tsx`
- Create: `components/OriginMessageView.tsx`
- Modify: `components/MessageView.tsx`
- Modify: `components/MessageView-tool-format.ts`
- Modify: `components/AppShell.tsx`
- Modify: `components/ChatWindow.tsx`
- Modify: `hooks/useAgentSession.ts`
- Modify: `lib/pi-types.ts`
- Modify: `lib/notification-client.ts`
- Modify: i18n catalogues containing `messageView.*` and held/queue labels
- Test: `components/MessageView.test.mjs`
- Test: `components/SessionLink.test.mjs`
- Test: queue/composer tests covering native queue chips

**Interfaces:**
- `SessionLink` renders host-qualified names and delegates plain clicks to existing app navigation.
- `OriginMessageView` receives a trusted-origin `UserMessage` and existing edit/fork props.
- Held entries and queued-message snapshots carry optional origin and render compact source identity.
- Tool rows resolve named targets from structured results/current session list, never display UUID as the primary label.

- [ ] Add component tests for session/GitHub/generic cards, forged-header ordinary rendering, raw toggle, mobile wrapping, keyboard labels, links, Edit/Fork, held origin and queue-chip origin.
- [ ] Add tool-row tests for sending, accepted, response, declined and failed states with named links.
- [ ] Run focused component/queue tests; expect missing-card/link failures.
- [ ] Implement the components and minimal plumbing with existing tokens and controls.
- [ ] Run focused tests; expect pass.
- [ ] Build and launch the UI, verify card and confirmation surfaces in a browser at desktop and 320px widths, including keyboard operation and no console errors.
- [ ] Commit `feat(ui): distinguish automated message origins`.

### Task 6: Documentation and final compatibility checks

**Files:**
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Modify: Settings copy describing agent tools
- Test: existing repository checks

**Interfaces:**
- Documents the journal field, server-only trust boundary, watcher persistence and old-runner degradation.

- [ ] Update design notes, changelog and Settings copy.
- [ ] Run focused origin tests, `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.
- [ ] Run the repository smoke path that exercises built server and runner.
- [ ] Commit `docs: document trusted message origins`.
