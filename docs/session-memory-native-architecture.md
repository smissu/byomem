# Native Session Memory Architecture for BYOMem

## Status
Target architecture / recommended direction. This note describes the desired end state while acknowledging that some parts of the current system may still be transitional. Sprint 23 is the runtime cutover point: the TS-native path is the sole active/default steady-state path, and any Python surface is offline/dev-only or disabled by default.

## Goal
Make session-derived knowledge first-class BYOMem data:

- **Pi session history remains the raw transcript source**.
- **BYOMem stores distilled session knowledge as native searchable memory records**.
- **Markdown is optional projection/export, not the source of truth**.
- **Session-derived memory is a native memory type** with project scope and session provenance.
- **Retrieval uses the native BYOMem API/DB path**, not grep over markdown.

## Recommended model
Treat each Pi session as two layers:

1. **Raw transcript layer**
   - Owned by Pi/session history.
   - Used for provenance, reprocessing, and auditability.
   - Not the primary retrieval target for BYOMem.

2. **Distilled memory layer**
   - Stored in BYOMem as native records.
   - Represents durable facts, decisions, preferences, action items, and summaries derived from the session.
   - Queryable through the same retrieval/indexing path as other BYOMem records.

## Recommended record shape
A session-derived memory record should include, at minimum:

- `id`: stable native record identifier
- `type`: e.g. `session_knowledge` or equivalent native memory type
- `scope`: project-scoped
- `source`: `pi_session`
- `session_id`: originating Pi session identifier
- `provenance`: pointers to transcript location, timestamps, and/or extract source
- `content`: the distilled memory text
- `tags`: optional normalized tags for retrieval
- `created_at` / `updated_at`
- `confidence` or `importance` when useful for ranking and curation
- `links`: optional references to related records, tasks, or follow-up items

Suggested shape example:

```json
{
  "id": "mem_123",
  "type": "session_knowledge",
  "scope": "project",
  "source": "pi_session",
  "session_id": "pi_session_456",
  "provenance": {
    "transcript_ref": "...",
    "created_from": "distillation"
  },
  "content": "We decided to keep session history as raw transcript and store distilled memory as native records.",
  "tags": ["architecture", "memory"],
  "confidence": 0.92,
  "created_at": "2026-04-17T00:00:00Z"
}
```

## Retrieval model
Recommended retrieval flow:

1. Search native BYOMem records first-class, including session-derived memory.
2. Rank by scope, recency, importance, and query relevance.
3. Use transcript provenance only when a user needs traceability or reconstruction.
4. Expose markdown exports only as a convenience view for humans or downstream tooling that explicitly wants Markdown.

This keeps retrieval consistent, avoids parallel truth stores, and lets the same API/DB path serve all memory types. As of Sprint 23, this is the active/default runtime path; Python remains only as an explicit non-default compatibility or offline/dev surface.

## Rationale
- **Single source of truth:** native records reduce duplication and drift.
- **Better retrieval:** structured records are easier to index, rank, and filter than free-form markdown.
- **Clear provenance:** session linkage remains available without making transcripts the retrieval substrate.
- **Less operational friction:** markdown can be generated when needed, rather than maintained as authoritative storage.
- **Extensibility:** a native session-memory type can evolve with new metadata without changing the underlying representation model.

## Non-goals
- Replacing Pi session history as the canonical transcript store.
- Removing markdown exports entirely.
- Reworking all existing memory data at once.
- Requiring every distilled fact to preserve verbatim transcript text.
- Introducing a separate markdown-only retrieval path.

## Migration note
If the current implementation still uses markdown in any part of the pipeline, treat this note as the desired target architecture: keep markdown as an export/projection layer while moving retrieval and durable storage to native BYOMem records.
