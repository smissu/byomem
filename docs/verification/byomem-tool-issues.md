# BYOMem Tool Issues

## Brief summary
This note captures a few currently observed BYOMem issues from local dispatcher/session evidence. The goal is to record the symptoms without over-claiming root cause.

## Evidence observed
- **`byomem_search` appears to return no data even when memories exist in the backing database.**
  - User-reported symptom: search returns empty results despite known stored memories.
- **Dispatcher test results show `byomem_search` executes, but the returned result set is empty.**
  - Example session evidence includes a successful tool call followed by `{"results": []}`.
- **`byomem_store` appears to require top-level `identity` and `content` objects, then fails with `Invalid write intent`.**
  - Local session logs show validation complaints about `identity` and `content` being objects, followed by `Invalid write intent`.
- **`byomem_prune` appears to require a top-level `identity`, then fails with `Invalid prune intent`.**
  - Local session logs show validation complaints tied to prune input, followed by `Invalid prune intent`.
- **The active dispatcher-visible schema appears to differ from older/local BYOMem docs or source examples.**
  - Current dispatcher-visible usage seems to center on `identity` / `content`, while older/local examples refer to `text` / `summary` / `tags` and `record_id`.

## Open questions / next steps
- Confirm the exact dispatcher-side request schema currently enforced for each BYOMem tool.
- Compare the live dispatcher contract against the local BYOMem docs/source examples and identify which layer diverged.
- Verify whether the empty `byomem_search` results are caused by indexing, filtering, scope mismatch, or a schema/adapter mismatch.
- Reproduce the `Invalid write intent` and `Invalid prune intent` paths with minimal payloads and record the exact request/response shapes.
