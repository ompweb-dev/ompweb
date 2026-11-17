# GitHub Watch Initial Snapshot Design

## Intent

Prevent a race between reading a GitHub item and registering `watch_github`. A successful registration must tell the caller exactly which current activity became the watch baseline.

## Design

`watch_github` will return a metadata-only projection of the `ItemSnapshot` fetched to create the watch cursor in an additive `snapshot` field. It includes current comment, review, inline-thread-comment, head-check-status, or workflow-run metadata. It excludes GitHub-written prose, review-thread paths, check names, and rate-limit bookkeeping. The field is returned for new watches, existing watches, and finished items that are not registered.

The returned snapshot and stored cursor come from one fetch. Activity after that fetch remains observable through normal watch updates. Callers can pass returned IDs to `github_read` when they need untrusted GitHub-written text.

## Approaches

- **Chosen: return the registration snapshot.** Reuses the existing fetch, identifies the exact baseline, and adds no API call or race window.
- Return only the latest item from each collection. Smaller, but loses state and cannot identify all baseline events.
- Perform `github_read` during registration. Returns bodies but duplicates requests, increases untrusted output, and still needs a baseline contract.

## Constraints

- Preserve existing response fields and registration semantics.
- Keep watch results metadata-only.
- Do not expose `rateLimit`; it is internal polling state.
- Add no dependency or persistence format.
