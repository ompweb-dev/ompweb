# Host-aware session search

## Intent

Sidebar transcript search must find sessions on every linked host without showing results whose expanded active conversation has no matching hit.

## Contract

- Add an additive `searchSessions(query)` session operation to the host seam.
- Each host scores only its own sessions and only each session's active conversation.
- The main `/api/sessions/search` route merges and streams score batches from all available hosts.
- Unknown-op, offline, and failed hosts contribute no transcript scores; their sessions remain searchable by explicit title/name only.
- `firstMessage` is never used as a transcript-search fallback because it can reference abandoned or pre-compaction content.
- Existing limits, cancellation, title ranking, and local search behavior remain unchanged.

## Approaches

1. **Host-owned search operation — chosen.** One bounded operation per host; no transcript transfer; correct ownership and active-context semantics.
2. **Main-side `readContext` fan-out — rejected.** N+1 operations and large remote transcript transfers.
3. **Restore client `firstMessage` fallback — rejected.** Recreates empty expandable results.

## Compatibility

The operation is additive. Older daemons answer `501 unknown_op`; search continues with other hosts and explicit title/name matching.
