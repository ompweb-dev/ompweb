# Host-aware Session Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sidebar transcript search query the active conversation on every linked host.

**Architecture:** Add one additive `SessionOps.searchSessions(query)` operation that scores sessions on the owning daemon. Main sequences available hosts and streams one score batch per host through the existing NDJSON route; unavailable and old hosts contribute an empty batch.

**Tech Stack:** TypeScript, Bun, host-link request protocol, Node test runner

**Spec:** `docs/superpowers/specs/2026-11-16-host-aware-session-search-design.md`

## Global Constraints

- Score only each session's active conversation.
- Never use `firstMessage` as transcript-search fallback.
- Add no dependency and do not bump the link protocol for the additive operation.
- Treat host answers as untrusted and reject malformed score maps.
- Offline, failed, and `501 unknown_op` hosts contribute no transcript scores.

## Review Focus

- A malformed remote score map is rejected, not merged.
- A daemon older than the new operation does not break search on other hosts.
- Duplicate session IDs on several hosts retain the sidebar's existing host ownership/order.
- Closing the NDJSON stream starts no later host scan after the current host operation.
- Queries over 500 characters are rejected before any host operation.

---

### Task 1: Host-owned search operation

**Files:**
- Modify: `lib/hosts/session-ops.ts`
- Modify: `lib/hosts/link-protocol.ts`
- Modify: `lib/hosts/hub.ts`
- Test: `lib/hosts/session-ops.test.mjs`
- Test: `lib/hosts/hub.test.mjs`

**Interfaces:**
- Produces: `SessionOps.searchSessions(query: string): Promise<OpResult<Record<string, number>>>`
- Wire args: `SESSION_OP_PARAMS.searchSessions = ["query"]`

- [ ] **Step 1: Write failing daemon and remote-adapter tests**

Add tests proving the local operation returns active-context scores, the remote request carries `{ query }`, valid finite-number maps pass, and malformed maps fail with `502 host_bad_result`.

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test lib/hosts/session-ops.test.mjs lib/hosts/hub.test.mjs --parallel`
Expected: FAIL because `searchSessions` is absent.

- [ ] **Step 3: Implement the additive operation**

Collect `lib/session-content-search.ts`'s batches on the daemon, validate the query boundary, register the named wire argument, and add remote result validation plus the existing long-running search timeout policy.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `bun test lib/hosts/session-ops.test.mjs lib/hosts/hub.test.mjs --parallel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/hosts/session-ops.ts lib/hosts/link-protocol.ts lib/hosts/hub.ts lib/hosts/session-ops.test.mjs lib/hosts/hub.test.mjs
git commit -m "feat(search): add host-owned session scoring"
```

### Task 2: Merge host scores in the sidebar route

**Files:**
- Modify: `lib/hosts/session-index.ts`
- Modify: `app/api/sessions/search/route.ts`
- Modify: `lib/hosts/session-index.test.mjs`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `SessionOps.searchSessions(query)` from Task 1
- Produces: `searchSessionsAllHosts(query: string): AsyncGenerator<Record<string, number>>`

- [ ] **Step 1: Write failing all-host search tests**

Add tests proving local and remote score maps are both yielded, offline and `501 unknown_op` hosts yield empty batches, malformed answers do not contaminate other hosts, and generator return prevents the next host operation from starting.

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test lib/hosts/session-index.test.mjs --parallel`
Expected: FAIL because `searchSessionsAllHosts` is absent.

- [ ] **Step 3: Implement sequential host fan-out and route integration**

Use sidebar host order, skip unavailable hosts, catch host operation failures per host, and replace the route's local-only generator with `searchSessionsAllHosts` while preserving query validation, NDJSON, cancellation, and idle-timeout behavior.

- [ ] **Step 4: Update user-facing contract text**

Update `AGENTS.md` to state transcript search runs on each linked host. Update the Unreleased changelog entry to mention linked-host search.

- [ ] **Step 5: Run focused and full verification**

Run:
- `bun test lib/hosts/session-index.test.mjs lib/session-search.test.mjs server/app.test.ts --parallel`
- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`

Expected: tests/typecheck/build pass; lint has no new errors.

- [ ] **Step 6: Browser proof**

Run an isolated local daemon plus a linked test host. Search a term present only in the remote active conversation, expand the remote session, and confirm the matching hit renders. Confirm an abandoned-only remote term does not list the session.

- [ ] **Step 7: Commit**

```bash
git add lib/hosts/session-index.ts app/api/sessions/search/route.ts lib/hosts/session-index.test.mjs AGENTS.md CHANGELOG.md
git commit -m "feat(search): merge scores from linked hosts"
```
