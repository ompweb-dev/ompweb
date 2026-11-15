# GitHub Watch Initial Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return the exact metadata snapshot used as the `watch_github` registration baseline.

**Architecture:** Extend the existing additive tool result in `lib/github/tools.ts`. Reuse `fetchSnapshot`; remove internal `rateLimit` plus GitHub-written review-thread paths and check names before returning its metadata under `snapshot`.

**Tech Stack:** TypeScript, Bun, Node test runner

**Spec:** `docs/superpowers/specs/2026-11-15-github-watch-initial-snapshot-design.md`

## Global Constraints

- Preserve existing response fields and watch registration behavior.
- Return metadata only; never return GitHub-written prose, review-thread paths, or check names.
- Do not return `rateLimit`.
- Add no dependency or persistence change.

## Review Focus

- New watch: returned snapshot must exactly describe the cursor baseline.
- Existing watch: registration remains idempotent while the current snapshot is returned.
- Finished item: no watch is stored, but current metadata is returned.
- Workflow run: its current run metadata is returned without pull-request-only fields.
- Internal GraphQL rate-limit metadata never enters the tool result.

---

### Task 1: Extend `watch_github` result

**Files:**
- Modify: `lib/github/tools.ts:33-36,196-213`
- Test: `lib/github/tools.test.mjs:28-43,265-310`

**Interfaces:**
- Consumes: `fetchSnapshot(run, target): Promise<ItemSnapshot>` and `baselineCursor(snapshot): WatchCursor`.
- Produces: existing watch result plus `snapshot`, containing the fetched `ItemSnapshot` without `rateLimit`, review-thread paths, or check names.

- [ ] **Step 1: Write the failing contract tests**

Extend the open-item and finished-item assertions with current comment/review/thread/head metadata under `snapshot`. Include `rateLimit` in the fake GraphQL response and assert it is absent from the tool result. Existing-watch assertion must still equal the first result.

- [ ] **Step 2: Verify RED**

Run: `bun test lib/github/tools.test.mjs`

Expected: FAIL because `watch_github` does not return `snapshot`.

- [ ] **Step 3: Implement the minimal additive result**

In `executeGithubTool`, destructure `rateLimit` from the fetched snapshot and return the remaining fields as `snapshot` on both open and finished paths. Update the tool description to state the initial metadata snapshot contract.

- [ ] **Step 4: Verify GREEN**

Run: `bun test lib/github/tools.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run repository gates**

Run the repository's required targeted tests, typecheck, and lint before review and landing.

- [ ] **Step 6: Commit**

Commit the implementation, tests, spec, and plan as one atomic behavior change.
