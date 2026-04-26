# Semantic / Hybrid Document Search Runbook

## Status
Sprint 32 adds semantic and hybrid search over the BYOMem file-search DB. Sprint 36 makes file-search DB storage global by default while preserving per-project `project_key` partitioning. Sprint 37 adds an explicit file-search project registry with `seen`, `enabled`, and `disabled` states for future scanner automation. Sprint 38 adds direct Pi extension file-search tools for search, status, manual scan, and registry management. Sprint 39 adds explicit active-project file-search polling controls that remain default/global off. The file-search stack remains physically separate from the memories DB and keeps SQLite FTS as the lexical baseline. Semantic and hybrid file-search are enabled by default, and when no remote embedding endpoint is configured the runtime uses deterministic fallback embeddings so semantic/hybrid search still works.

## Prerequisites
For real Ollama-backed semantic search, install/pull the embedding model:

```bash
ollama pull nomic-embed-text
```

Default model:

```text
nomic-embed-text
```

Default local Ollama embedding URL:

```text
http://localhost:11434
```

Automated tests use mocked embeddings and do not require live Ollama.


## File-search DB location and project scoping
By default, file-search commands store their physical SQLite DB globally at:

```text
${BYOMEM_RUNTIME_BASE_DIR:-~/.byomem/runtime}/byomem-file-search.sqlite
```

`--base-dir <project>` is the scan/search project root. It is used to walk files, derive the `project_key`, scope `file-search` results, and report scanner `baseDir`; it is **not** the default DB storage directory. Running `file-search-scan --base-dir /path/to/project` should not create `/path/to/project/byomem-file-search.sqlite` unless an explicit DB override is used by tests/dev tooling.

Legacy project-local `byomem-file-search.sqlite` files are left in place and ignored by the new default. There is no automatic migration, import, or deletion in Sprint 36. To troubleshoot or intentionally use a legacy/local DB, pass an explicit DB override through the runtime API (`fileSearchDbFile`/`fileSearchDbBaseDir` on `openNativeStore`, or `dbFile`/`dbBaseDir` on `openFileSearchDb`). Guards still reject memory-store paths such as `byomem-index.sqlite` and `native-store.json`.

## Direct Pi extension file-search tools
Sprint 38 exposes direct Pi tools with these exact names:

- `byomem_file_search`
- `byomem_file_search_status`
- `byomem_file_search_scan`
- `byomem_file_search_project_register`
- `byomem_file_search_project_list`
- `byomem_file_search_project_unregister`

Sprint 39 adds polling-specific Pi tools:

- `byomem_file_search_polling_status`
- `byomem_file_search_polling_enable`
- `byomem_file_search_polling_disable`

These tools are the preferred agent interface when available. They use the target project root for identity and the global file-search DB for storage. `baseDir` always means the project root to search/scan/register, not the runtime DB directory.

### Active project / default `baseDir`
- When a search/status/scan tool omits `baseDir`, it uses the active project resolved from the current Pi session / cwd context.
- If no active project can be resolved, the direct tools fail with a deterministic error and the user/agent should provide `baseDir` explicitly.
- `BYOMEM_RUNTIME_BASE_DIR` is storage-only; it must not be treated as the project being searched.
- Registry register/unregister tools require explicit `baseDir` and never default to the active project.

### Direct tool behavior
- `byomem_file_search` searches the current index only. It does not scan project files and does not refresh semantic embeddings implicitly.
- `byomem_file_search_status` reports scanner state without scanning.
- `byomem_file_search_scan` performs one explicit synchronous manual scan so the index can catch up after known file edits.
- Registry tools are explicit opt-in/soft-disable operations and do not scan or start background workers.
- The direct tools do not rely on hidden polling, file watchers, or daemons.
- Existing direct search/status/scan and registry tools remain non-polling by default. Polling only starts through the polling-specific enable surface.

### CLI fallback
When the direct Pi tools are not available in the current session, use the CLI fallback below.

Registry fallback commands:

```bash
node ts/packages/runtime/dist/cli.js file-search-project-register --base-dir /path/to/project
node ts/packages/runtime/dist/cli.js file-search-project-list --json
node ts/packages/runtime/dist/cli.js file-search-project-unregister --base-dir /path/to/project
```

Search/status/scan fallback commands:

```bash
node ts/packages/runtime/dist/cli.js file-search --base-dir /path/to/project --mode hybrid --query "semantic document search"
node ts/packages/runtime/dist/cli.js file-search-status --base-dir /path/to/project --json
node ts/packages/runtime/dist/cli.js file-search-scan --base-dir /path/to/project --json
```

The file-search stack remains physically separate from the memories DB and keeps SQLite FTS as the lexical baseline.


## Active-project file-search polling
Sprint 39 adds opt-in polling for one active project in the current process/session. Polling is **default/global off**: opening BYOMem, using memory tools, using registry tools, and using existing file-search search/status/scan tools does not start a timer.

### Pi polling tools

Use these tools only when you intentionally want session-owned polling:

- `byomem_file_search_polling_status` — read polling state for a project without scanning. `baseDir` is optional and defaults to the active project.
- `byomem_file_search_polling_enable` — enable polling for the active project. `baseDir` is optional, but if provided it must match the active project. Parameters:
  - `pollIntervalSeconds` — positive integer interval in seconds; defaults to `60` when omitted in the Pi tool.
  - `idleDisableAfterPolls` — optional positive integer; after this many consecutive successful no-change poll scans, polling disables itself.
- `byomem_file_search_polling_disable` — disable polling for a project. `baseDir` is optional and defaults to the active project; `reason` is optional and defaults to `manually-disabled`.

Pi polling enable is active-project-gated. If no active project can be resolved, enable fails closed with a `no-active-project` error. If an explicit `baseDir` differs from the active project, enable fails closed with `not-active-project`. The status/disable tools use the normal file-search active-project defaulting behavior when `baseDir` is omitted.

### CLI polling commands

The CLI polling commands require an explicit `--base-dir`; they do not infer the active project and do not fall back to a temporary/runtime directory:

```bash
node ts/packages/runtime/dist/cli.js file-search-polling-status --base-dir /path/to/project --json
node ts/packages/runtime/dist/cli.js file-search-polling-enable \
  --base-dir /path/to/project \
  --poll-interval-seconds 60 \
  --idle-disable-after-polls 5 \
  --json
node ts/packages/runtime/dist/cli.js file-search-polling-disable --base-dir /path/to/project --json
```

CLI responses use the top-level shape `{ "polling": ..., "status": ... }`, where both values contain the same polling DTO. `--poll-interval-seconds` is required for CLI enable and must be a positive integer. `--idle-disable-after-polls` is optional and must be a positive integer when supplied.

### Polling fields

Polling status and registry serialization use stable snake_case fields:

- `project_key` — collision-safe file-search project key for the target `base_dir`.
- `base_dir` — canonical project root being polled or inspected.
- `display_name` — display name derived from the project root.
- `polling_enabled` — `true` only while polling is currently enabled for the project.
- `poll_interval_seconds` — configured polling interval, or `null` when not configured.
- `last_poll_at` — timestamp for the most recent poll attempt start, or `null` before the first poll.
- `next_poll_at` — next scheduled poll timestamp while polling remains enabled; cleared to `null` when polling disables.
- `consecutive_no_change_polls` — number of consecutive successful poll-triggered scans that found no indexed content changes. It resets to `0` when a poll detects changes.
- `idle_disable_after_polls` — configured no-change shutoff threshold, or `null` when idle shutoff is not configured.
- `polling_disabled_reason` — deterministic reason for a disabled state, such as `default-off`, `idle-no-changes`, `manually-disabled`, `session-ended`, `project-disabled`, `no-active-project`, `not-active-project`, `unregistered-project`, or `poll-error`.
- `last_scan_at` — timestamp of the last successful completed scan recorded for polling/status purposes. Poll failures do not advance it.

A no-change poll is counted only after a successful poll-triggered scan with `changedFiles === 0`, `deletedFiles === 0`, and `chunksWritten === 0`. Failed poll scans do not increment the no-change counter; failures disable polling with `poll-error`, clear `next_poll_at`, and surface through existing scanner/registry error fields.

### Process/session ownership and operational expectations

Polling is owned by the current Pi extension runtime/session or the explicit CLI command process that enabled/configured it. It does not create a detached daemon, launch agent, cross-session worker, filesystem watcher, or `fs.watch` listener. It targets exactly one project per owning process/session and never loops over all registered projects.

When polling starts through the Pi tool, BYOMem records configuration in the registry, performs a baseline manual scan, and then uses an in-process timer for later poll scans. When the session/runtime ends, cleanup clears the active timer, clears `next_poll_at`, and records `session-ended`. Explicit disable clears the timer, clears `next_poll_at`, and records `manually-disabled` unless another reason is supplied. If idle shutoff reaches `idle_disable_after_polls`, polling disables itself with `idle-no-changes` and no later polls run until explicitly re-enabled.

Polling is a freshness convenience, not a durable background indexing service. For deterministic one-off refreshes, continue to use `byomem_file_search_scan` or `file-search-scan`.

## File-search project registry
Sprint 37 stores file-search project registry rows in the global file-search DB. The registry is separate from memories and is not inferred from saved memory records, `native-store.json`, `byomem-index.sqlite`, existing `byomem-file-search.sqlite` files, or memory search/write/prune activity.

Registry states:

- `seen` — the project was observed through explicit file-search scan/search/status, but is not eligible for future automation. Internal open-time scans do not opt projects into registry `seen` state.
- `enabled` — the project was explicitly registered and is eligible for opt-in active-project polling. Registration alone does not start polling; a polling-specific enable tool/command is still required.
- `disabled` — the project was explicitly unregistered; the row is retained, but it is not eligible for automation.

Manual registry commands:

```bash
node ts/packages/runtime/dist/cli.js file-search-project-register --base-dir /path/to/project
node ts/packages/runtime/dist/cli.js file-search-project-list --json
node ts/packages/runtime/dist/cli.js file-search-project-unregister --base-dir /path/to/project
```

`file-search-project-register` and `file-search-project-unregister` require an explicit `--base-dir`; they fail instead of operating on a generated temporary directory when the flag is omitted. `file-search-project-list --json` returns all states in stable `base_dir` order and does not require `--base-dir`. Registry commands use a registry-only global DB open path; they do not create project-local memory stores, do not scan project files, and do not instantiate polling timers, watchers, daemons, or background scans. The direct Pi registry tools follow the same rule. Active-project polling must be enabled separately with the polling-specific Pi tools or CLI commands.

## Modes
Document/file search supports:

- `fts` — lexical SQLite FTS5 only; does not require embeddings.
- `semantic` — query and chunk vectors only; requires persisted chunk embeddings.
- `hybrid` — combines FTS and semantic candidates with deterministic score blending and deduplication.

FTS-only behavior remains safe when semantic search is disabled or unconfigured. `--semantic-file-search` is legacy/explicit and should not be required for the default-on path.

## Runtime API
Use the file-search query path, not the memory search path. Direct Pi tools and the CLI fallback should both resolve the active project the same way:

```js
import { openNativeStore, searchFileIndex } from './ts/packages/runtime/dist/index.js';

const store = openNativeStore({
  baseDir: process.cwd(),
  embeddingBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  fileSearchSemanticEnabled: true,
});

await store.fileSearchDb?.refreshSemanticIndex();
const results = await searchFileIndex(store, {
  query: 'semantic document search',
  mode: 'hybrid',
  limit: 10,
});

console.log(results.map((hit) => ({
  path: hit.file?.path,
  chunk: hit.file?.chunkText,
  score: hit.score,
  semanticScore: hit.file?.semanticScore,
  lexicalScore: hit.file?.lexicalScore,
})));

store.close();
```

## CLI smoke test
The memory `search` command still searches memories. Use `file-search` for document/file-search modes:

```bash
npm run build
node ts/packages/runtime/dist/cli.js \
  file-search \
  --base-dir /path/to/project \
  --embedding-base-url http://localhost:11434 \
  --embedding-model nomic-embed-text \
  --mode hybrid \
  --query "semantic document search"
```

For FTS-only smoke testing:

```bash
node ts/packages/runtime/dist/cli.js \
  file-search \
  --base-dir /path/to/project \
  --mode fts \
  --query "exact lexical terms" \
  --limit 10
```

Use `--limit <positive-integer>` to bound `file-search` result count. If omitted, the CLI keeps the default limit of 10. Invalid limits fail closed with a JSON CLI error.

## File-search DB location
File-search storage is global by default. `--base-dir` identifies the project to scan/search, but the physical file-search SQLite DB defaults to:

```text
${BYOMEM_RUNTIME_BASE_DIR:-~/.byomem/runtime}/byomem-file-search.sqlite
```

The scanner still walks the project passed with `--base-dir`, derives `project_key` from that project, and stores scanner status with the project path as `baseDir`. Multiple projects can share the same global file-search DB through `project_key` partitioning, while searches remain scoped to the active project. Existing project-local `byomem-file-search.sqlite` files are ignored by default; they are not migrated or deleted automatically.

## Indexing / refresh model
The scanner is not a background daemon. File scanning remains synchronous/on-open, explicit via `scanAndIndex()`, or opt-in active-project polling while the current process/session owns a polling timer. Semantic embedding generation is async and explicit:

```js
await store.fileSearchDb?.refreshSemanticIndex();
```

This avoids hidden fire-and-forget embedding work inside synchronous scanner calls. Poll-triggered scans also do not perform hidden semantic embedding refreshes.

## Diagnostics
Use scanner status for file discovery/indexing visibility:

```js
store.fileSearchDb?.getScannerStatus();
```

CLI status is available without running a search query:

```bash
node ts/packages/runtime/dist/cli.js file-search-status --base-dir /path/to/project --json
```

To explicitly refresh the file-search index without running a search query, use:

```bash
node ts/packages/runtime/dist/cli.js file-search-scan --base-dir /path/to/project --json
```

`file-search-scan` opens file-search with scan-on-open disabled, invokes the same synchronous `scanAndIndex()` path against the project passed by `--base-dir`, and returns the resulting scanner status with trigger `manual`. It does not start semantic embedding refreshes; run semantic refresh/search separately when needed.

Scanner status fields include:

- state: `idle`, `running`, `completed`, `failed`, or `abandoned`
- runId and trigger/source (`open`, `manual`, `scheduler-activation`, `scheduler-post-activity`, `scheduler-backstop`)
- startedAt, completedAt, durationMs, and lastError
- progress counters: discoveredFiles, scannedFiles, indexedFiles, unchangedFiles, changedFiles, deletedFiles, ignoredFiles, errorFiles, chunksWritten, bytesRead, filesRemaining (`ignoredFiles` is a coarse ignored file/directory entry count)
- database counts: indexedFiles, indexedChunks, changedRows, reconciledRows, projects
- read-only embedding diagnostics when available
- polling fields: polling_enabled, poll_interval_seconds, last_poll_at, next_poll_at, consecutive_no_change_polls, idle_disable_after_polls, polling_disabled_reason, last_scan_at

Progress is intentionally narrow: the scanner remains synchronous, so a separate CLI process should be treated as reading the latest persisted scan snapshot. `file-search-status` opens the DB with open-time scanning disabled, so it does not walk/read/hash the project just to report status. Status reads do not start semantic embedding refreshes or hidden async scanner work.

Use embedding diagnostics for semantic chunk coverage:

```js
store.fileSearchDb?.getEmbeddingDiagnostics();
```

Embedding diagnostic fields include:

- enabled
- model
- configuredDimension
- embeddedChunks
- missingChunks
- failures
- fallbacks
- lastError

## Failure behavior
- FTS mode remains usable without Ollama.
- Semantic mode requires semantic search to be enabled and ready chunk embeddings to return semantic results. Hybrid mode uses semantic candidates when available and falls back to FTS candidates when semantic search is disabled, unconfigured, or has no ready embeddings.
- When remote embeddings are not required, the embedding client may use deterministic fallback embeddings for test/dev mechanics.
- When `embeddingRequireRemote` is true, remote embedding failures fail loudly.

## Known MVP limitations
- Vector search uses a simple JS cosine scan over persisted chunk embeddings; no ANN/vector DB is included in this sprint.
- Chunking remains line-oriented.
- Binary/non-UTF8 file handling remains a future scanner hardening item.
- Deterministic fallback embeddings are useful for testing mechanics but should not be treated as production semantic quality.
