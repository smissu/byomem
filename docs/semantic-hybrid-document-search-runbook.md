# Semantic / Hybrid Document Search Runbook

## Status
Sprint 32 adds semantic and hybrid search over the BYOMem file-search DB. Sprint 36 makes file-search DB storage global by default while preserving per-project `project_key` partitioning. Sprint 37 adds an explicit file-search project registry with `seen`, `enabled`, and `disabled` states for future scanner automation. Sprint 38 adds direct Pi extension file-search tools for search, status, manual scan, and registry management. The file-search stack remains physically separate from the memories DB and keeps SQLite FTS as the lexical baseline. Semantic and hybrid file-search are enabled by default, and when no remote embedding endpoint is configured the runtime uses deterministic fallback embeddings so semantic/hybrid search still works.

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

## File-search project registry
Sprint 37 stores file-search project registry rows in the global file-search DB. The registry is separate from memories and is not inferred from saved memory records, `native-store.json`, `byomem-index.sqlite`, existing `byomem-file-search.sqlite` files, or memory search/write/prune activity.

Registry states:

- `seen` — the project was observed through explicit file-search scan/search/status, but is not eligible for future automation. Internal open-time scans do not opt projects into registry `seen` state.
- `enabled` — the project was explicitly registered and is eligible for future polling automation when that feature is implemented.
- `disabled` — the project was explicitly unregistered; the row is retained, but it is not eligible for automation.

Manual registry commands:

```bash
node ts/packages/runtime/dist/cli.js file-search-project-register --base-dir /path/to/project
node ts/packages/runtime/dist/cli.js file-search-project-list --json
node ts/packages/runtime/dist/cli.js file-search-project-unregister --base-dir /path/to/project
```

`file-search-project-register` and `file-search-project-unregister` require an explicit `--base-dir`; they fail instead of operating on a generated temporary directory when the flag is omitted. `file-search-project-list --json` returns all states in stable `base_dir` order and does not require `--base-dir`. Registry commands use a registry-only global DB open path; they do not create project-local memory stores, do not scan project files, and do not instantiate scheduler polling, watchers, daemons, or background scans. The direct Pi registry tools follow the same rule.

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
The scanner is not a background daemon. File scanning remains synchronous/on-open or explicit via `scanAndIndex()`. Semantic embedding generation is async and explicit:

```js
await store.fileSearchDb?.refreshSemanticIndex();
```

This avoids hidden fire-and-forget embedding work inside synchronous scanner calls.

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
