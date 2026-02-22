# byomem Pipeline Architecture

## Overview

byomem processes Claude Code sessions through a two-stage pipeline: a fast hook that enqueues work (<100ms), and a background worker that summarizes, writes memory, indexes, and optionally reindexes source code.

## Pipeline Diagram

```
CC Stop Hook Fires
│
▼
┌─────────────────────────────────────┐
│  hooks/stop_hook.py  (<100ms)       │
│                                     │
│  1. Read stdin JSON                 │
│     {session_id, transcript_path,   │
│      cwd}                           │
│  2. Skip if already queued          │
│     (has_pending_job)               │
│  3. Record byte offset              │
│     (get_session_offset)            │
│  4. Skip if offset >= file_size     │
│     (no new content)                │
│  5. enqueue(job)                    │
│  6. Spawn detached worker process   │
│     (or run inline if BYOMEM_SYNC)  │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  worker.run_worker()                │
│                                     │
│  Acquire worker lock (single        │
│  worker process at a time)          │
│                                     │
│  while True:                        │
│   claim_pending() jobs              │
│   ├─ If depth >= overflow_threshold │
│   │   split jobs: primary + overflow│
│   │   overflow runs on fallback     │
│   │   model in separate thread      │
│   └─ Else: _process_jobs()          │
│                                     │
│  _process_jobs():                   │
│   max_workers threads via           │
│   ThreadPoolExecutor                │
│   (overflow gets max_workers // 2)  │
│                                     │
│  For each job → _process_one()      │
│   ├─ On success: complete_job()     │
│   ├─ On failure (retry_count < 1):  │
│   │   retry_job() → back to pending │
│   └─ On failure (already retried):  │
│       fail_job() → failed/          │
│                                     │
│  Loop back to check for new jobs    │
│  that arrived during processing     │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────┐
│  worker.process_job()                                       │
│                                                             │
│  1. Resolve project name from cwd                           │
│  2. get_or_create_branch(project, session_id)               │
│  3. flock branch dir (skip if locked)                       │
│                                                             │
│  ┌─── PHASE 1: SUMMARIZE (timed → summarize_s) ───────┐   │
│  │                                                     │   │
│  │ parse_new_turns(transcript, last_turn_id, offset)   │   │
│  │  → reads JSONL from byte offset                     │   │
│  │  → groups into Turn objects                         │   │
│  │                                                     │   │
│  │ Split turns into batches (cfg.batch_size)           │   │
│  │  → if summarizer_concurrency > 1 and batches > 1:  │   │
│  │      ThreadPoolExecutor for concurrent batches      │   │
│  │  → else: sequential batch processing                │   │
│  │                                                     │   │
│  │ summarize_batch(batch, model_override)              │   │
│  │  → backend cascade (see Summarizer Backends)        │   │
│  │  → returns TurnSummary per turn                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                         │                                   │
│                         ▼                                   │
│  ┌─── PHASE 2: EMBED + WRITE (timed → embed_s) ───────┐   │
│  │                                                     │   │
│  │  For each (turn, summary):                          │   │
│  │                                                     │   │
│  │  ALWAYS:                                            │   │
│  │    append_to_log(branch, turn)   → log.md           │   │
│  │                                                     │   │
│  │  IF milestone:                                      │   │
│  │    commit_milestone(branch)      → commit.md        │   │
│  │    index_file(commit.md)         → search.db        │   │
│  │                                                     │   │
│  │  IF important:                                      │   │
│  │    maybe_update_main(project)    → main.md          │   │
│  │    maybe_update_project_memory() → MEMORY.md        │   │
│  │    index_file(main.md)           → search.db        │   │
│  │                                                     │   │
│  │  IF log_search_mode == "index":                     │   │
│  │    index_file(log.md)            → search.db        │   │
│  │                                                     │   │
│  │  IF log_search_mode == "enrich":                    │   │
│  │    pass turn_id to commit_milestone/update_main     │   │
│  │    (embeds turn anchor in memory for traceability)  │   │
│  │                                                     │   │
│  │  update_metadata(branch)                            │   │
│  │  save_session_offset()                              │   │
│  └─────────────────────────────────────────────────────┘   │
│                         │                                   │
│                         ▼                                   │
│  ┌─── PHASE 3: CODE REINDEX (timed → db_write_s) ─────┐   │
│  │  (only if source_root configured for project)       │   │
│  │                                                     │   │
│  │  get_last_indexed_sha(project)   → code.db meta     │   │
│  │  git diff --name-status old..HEAD                   │   │
│  │  for each changed file:                             │   │
│  │    A/M → index_source_file()     → code.db          │   │
│  │    D   → delete_indexed_source() → code.db          │   │
│  │  set_last_indexed_sha(HEAD)      → code.db meta     │   │
│  │  Falls back to full walk if no prior SHA             │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Release flock                                              │
│  Return {summarize_s, embed_s, db_write_s}                  │
└─────────────────────────────────────────────────────────────┘
```

## Summarizer Backends

`summarize_batch()` (and `summarize_turn()`) try backends in cascade order, skipping to the next on failure. Overflow workers (with `model_override`) skip directly to OpenAI-compat.

```
  ┌──────────────────────────────────────────────────────┐
  │  1. Gemini CLI        (if summarizer_gemini_cli set) │
  │     └─ subprocess: gemini -p <prompt> -o json        │
  │                                                      │
  │  2. OpenCode CLI      (if summarizer_opencode_cli)   │
  │     └─ subprocess: opencode run <prompt> --format json│
  │                                                      │
  │  3. LM Studio         (if summarizer_lmstudio_url)   │
  │     └─ OpenAI client → local LM Studio server        │
  │                                                      │
  │  4. Ollama native     (if summarizer_base_url)       │
  │     └─ httpx POST /api/chat with JSON schema         │
  │     └─ think=false to bypass thinking tokens         │
  │                                                      │
  │  5. OpenAI-compat     (if summarizer_base_url)       │
  │     └─ 3-tier strategy:                              │
  │        T1: beta.chat.completions.parse (structured)  │
  │        T2: extra_body format schema (Ollama)         │
  │        T3: plain text, parse manually                │
  │                                                      │
  │  6. Anthropic API     (final fallback)               │
  │     └─ anthropic.messages.create                     │
  │                                                      │
  │  7. FALLBACK dict     (on total failure)             │
  │     └─ {"title":"Session turn", important:false, …}  │
  └──────────────────────────────────────────────────────┘
```

Per-thread backend tracking records which backend was used (`get_primary_backend()`). Optional debug logging writes input/output to `queue/summarizer_debug.jsonl` when `summarizer_debug: true`.

## Databases

| Database | Module | Contents |
|----------|--------|----------|
| `search.db` | `core/search_index.py` | Memory file index (main.md, commit.md, log.md) |
| `code.db` | `core/code_index.py` | Project source code index |

Both use the same hybrid search approach: FTS5 (BM25 keyword) + sqlite-vec (cosine similarity), with weighted fusion scoring. Shared embedding and chunking logic lives in `core/indexing_utils.py`.

## Indexing Details

### Two-Phase Write Pattern

Both `search_index.index_file()` and `code_index.index_source_file()` use a two-phase design to minimise SQLite write-lock hold time:

```
Phase 1 — GATHER (no write lock held)
  ├─ Read file, compute content hash
  ├─ Skip if hash unchanged (early exit)
  ├─ Chunk content
  └─ Batch-fetch embeddings via _get_embeddings_batch()
     ├─ Cache hits: read from embedding_cache table (read-only)
     └─ Cache misses: batched OpenAI API calls (slow, no DB writes)

Phase 2 — WRITE (fast transaction)
  ├─ DELETE old chunks + FTS5 sync deletes
  ├─ INSERT new chunks + FTS5 entries + vec embeddings
  ├─ Persist new embedding cache entries
  └─ UPDATE files table with new hash
  └─ COMMIT
```

`search_index` uses `_get_lite_db()` (no `_init_schema` DDL) for both the read connection in Phase 1 and the write connection in Phase 2. This avoids DDL contention when concurrent threads finish Phase 1 at roughly the same time.

### Memory Index (search.db)

Triggered inline during `process_job()` Phase 2 whenever memory files are written.

**Chunking strategy** (`_chunk_structured`): file-type aware splitting:
- `main.md` — splits on `- [` entry lines
- `commit.md` — splits on `## This Commit` headers
- `log.md` — splits on `<!-- last_id:` anchors
- Other files — generic line-based chunking with overlap

### Source Code Index (code.db)

Triggered at the end of `process_job()` Phase 3, only if `source_root` is configured for the project in `config.yaml`.

**Incremental reindex flow:**
1. Look up the last indexed git SHA from `code.db` meta table
2. `git diff --name-status <last_sha> HEAD` to find changed files
3. Deleted files — `delete_indexed_source_file()`
4. Added/modified files — `index_source_file()` (skipped if SHA256 hash unchanged)
5. Renames — emits a delete for old path + add for new path
6. Store new HEAD SHA for next run
7. Falls back to full file walk if no prior SHA or git errors

**Chunking strategy** (`_chunk_code`): language-aware:
- `.py` files — splits on `def`/`class` boundaries; methods get enclosing class header prepended
- Other files — generic line-based chunking
- Oversized chunks are sub-chunked in both cases

### Shared Infrastructure (`core/indexing_utils.py`)

**Embeddings**: generated lazily via OpenAI-compatible API (supports Ollama). Two fetch modes:
- `_get_embedding()` — single text, reads cache + saves on miss (backward-compat)
- `_get_embeddings_batch()` — batch texts, reads cache + batched API calls for misses (defers DB writes to caller's Phase 2 transaction)

Cached by SHA256 text hash in an `embedding_cache` table per database, so unchanged chunks never re-embed.

**Hybrid search scoring:**
```
final_score = (vector_weight * cosine_similarity) + (keyword_weight * BM25_score)
```

Log.md hits are demoted by `log_score_demotion` factor when `log_search_mode == "index"`.

## Concurrency Model

### Worker-level
- `run_worker()` acquires a process-level worker lock — only one worker process runs at a time
- Runs a `while True` loop: processes all pending, then rechecks for jobs that arrived during processing
- When queue depth >= `overflow_threshold`, jobs are split between primary and overflow threads (overflow uses a fallback model)

### Job-level
- `process_job()` acquires an `flock` on the **branch directory** — prevents concurrent processing of the same session
- `_process_jobs()` uses `ThreadPoolExecutor` with `max_workers` threads (overflow gets `max_workers // 2`)

### Intra-job (summarizer)
- When `summarizer_concurrency > 1` and multiple batches exist, batches are processed concurrently via a separate `ThreadPoolExecutor`

### search.db Lock Contention (mitigated)

The two-phase write pattern was introduced specifically to address lock contention on `search.db`. Previously, embedding API calls (slow) happened while holding the write lock, causing `OperationalError: database is locked` under concurrent writes.

Now: Phase 1 (GATHER) does all slow work (API calls) with no write lock. Phase 2 (WRITE) is a fast DELETE+INSERT transaction. `_get_lite_db()` avoids additional DDL contention from `_init_schema`.

`code.db` is a separate database and is not involved in search.db contention.

## Retry and Failure Handling

```
_process_one(job)
  ├─ Success → complete_job() → history.jsonl (status: "ok")
  ├─ Failure (retry_count == 0) → retry_job() → back to pending
  │     history.jsonl (status: "retry")
  └─ Failure (retry_count >= 1) → fail_job() → failed/
        history.jsonl (status: "failed")
```

Processing history is logged to `queue/history.jsonl` with timing breakdown (`summarize_s`, `embed_s`, `db_write_s`) and the actual backend used.
