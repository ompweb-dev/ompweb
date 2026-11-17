# GitHub workflow-run watches

## Intent and scope
Extend the existing GitHub agent tools to watch one Actions run, selected by its GitHub run URL, until completion. The user approved this scope. Continuous workflow subscriptions, log streaming and GitHub writes on runs are out of scope.

## Approach
Reuse the existing poller, SQLite watch store, permission checks and durable message outbox. A separate watcher would duplicate delivery and recovery machinery; continuous workflow watching requires selection/filtering semantics not requested here.

## Contract
- `watch_github`, `unwatch_github` and `github_read` accept `https://github.com/OWNER/REPO/actions/runs/ID`.
- Run keys use the canonical run URL, never `OWNER/REPO#ID`, which remains a PR/issue reference. IDs are positive safe integers.
- Watch updates report changes to allow-listed status/conclusion and attempt number. Completion is final, including failure, cancellation and skipped runs. Registering an already completed run returns its state without registering a watch.
- Automatic updates contain metadata only: IDs, canonical URLs, status, conclusion, attempt and commit SHA. Never names, branch names, logs or arbitrary GitHub text.
- Explicit `github_read` supports `summary` (run details) and `checks` (paginated jobs); unsupported run read parts and comment writes fail clearly.
- Existing PR/issue watches, replay safety, remote repository grants, cancellation, watch limits and restart-safe delivery remain unchanged. No new dependency or schema migration is needed.

## Verification
Cover parsing/key isolation, malformed API fields, status transitions, completion delivery/retry, explicit reads, unsupported operations and existing PR/issue regression tests. One condensed adversarial review covers contract, hostile inputs, test honesty and over-engineering.

## API references
- [Workflow runs](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run): run IDs are int64; statuses include queued, requested, waiting and pending.
- [Workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run): jobs are paginated, with a maximum page size of 100.
