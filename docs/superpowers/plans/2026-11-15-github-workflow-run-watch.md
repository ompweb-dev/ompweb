# GitHub Workflow Run Watches Implementation Plan

> **For agentic workers:** Use the approved design and the task ownership below. Skip mid-flight build/lint/test/format commands; the integration owner runs verification once after implementation.

**Goal:** Watch specific GitHub Actions runs through the existing GitHub tools.
**Architecture:** Extend shared target and snapshot contracts; reuse event diffing, SQLite persistence and the existing outbox poller.
**Tech Stack:** TypeScript, Bun, SQLite, GitHub REST through `gh`.
**Spec:** `docs/superpowers/specs/2026-11-15-github-workflow-run-watch-design.md`

## Global Constraints
Preserve PR/issue behavior and existing permission, cancellation, persistence and outbox fences. Automatic updates are metadata-only. No dependencies, polling service or schema migration. Only this task's linked worktree may be edited.

## Review Focus
- Run IDs cannot alias PR/issue numbers.
- Arbitrary API strings cannot enter automatic prompts.
- A completed run is removed only after durable update acceptance.
- Repeated polls/retries cannot duplicate completion.
- Explicit unsupported operations fail rather than target issue endpoints.

## Task 1: Run targets and API
Files: `lib/github/gh.ts`, `api.ts`, `gh.test.mjs`, `api.test.mjs`.
- [ ] Add failing consumer-level tests for run parsing, invalid IDs, run metadata validation and paginated job reads.
- [ ] Extend `GithubTarget` with optional `kind: "workflow_run"`; leave PR/issue targets unchanged.
- [ ] Extend `ItemKind` and `ItemSnapshot` with run metadata. Route snapshots and reads to REST run endpoints, validating metadata and deriving canonical URLs.
- [ ] Support only summary/checks on run reads; reject writes and unsupported parts.

## Task 2: Run event lifecycle
Files: `lib/github/events.ts`, `events.test.mjs`.
- [ ] Add tests for baseline silence, status/attempt transitions, terminal events and metadata-only formatting.
- [ ] Add optional run cursor state and run event variant. Completion sets `cursor.final`; event IDs distinguish attempt/status/conclusion.

## Task 3: Tool, storage and poller integration
Files: `lib/github/tools.ts`, `watch-store.ts`, `watcher.ts`, `tools.test.mjs`, `watcher.test.mjs`, existing user docs/changelog.
- [ ] Add run-key separation, tool permission/read/unwatch and terminal-delivery tests.
- [ ] Use canonical run URL keys, preserve run cursor fields through store decoding, extend tool descriptions, reject run comments and use cursor.final for pending completion.
- [ ] Document user-facing run URL and summary/checks support.

## Task 4: Verification and publication
- [ ] Install frozen dependencies and run `bun test --parallel lib/github/`, then typecheck and narrow lint.
- [ ] Run one condensed adversarial reviewer; resolve concrete findings and verify changed paths.
- [ ] Commit and push the feature branch, open a PR, register pr-watcher and handle reported CI/reviews.
