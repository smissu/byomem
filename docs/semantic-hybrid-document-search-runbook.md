# Semantic / Hybrid Document Search Runbook

## Status
Sprint 32 adds semantic and hybrid search over the BYOMem file-search DB. The file-search stack remains physically separate from the memories DB and keeps SQLite FTS as the lexical baseline.

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

## Modes
Document/file search supports:

- `fts` — lexical SQLite FTS5 only; does not require embeddings.
- `semantic` — query and chunk vectors only; requires persisted chunk embeddings.
- `hybrid` — combines FTS and semantic candidates with deterministic score blending and deduplication.

FTS-only behavior remains safe when semantic search is disabled or unconfigured.

## Runtime API
Use the file-search query path, not the memory search path:

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
  --semantic-file-search \
  --mode hybrid \
  --query "semantic document search"
```

For FTS-only smoke testing:

```bash
node ts/packages/runtime/dist/cli.js \
  file-search \
  --base-dir /path/to/project \
  --mode fts \
  --query "exact lexical terms"
```

## Indexing / refresh model
The scanner is not a background daemon. File scanning remains synchronous/on-open or explicit via `scanAndIndex()`. Semantic embedding generation is async and explicit:

```js
await store.fileSearchDb?.refreshSemanticIndex();
```

This avoids hidden fire-and-forget embedding work inside synchronous scanner calls.

## Diagnostics
Use:

```js
store.fileSearchDb?.getEmbeddingDiagnostics();
```

Diagnostic fields include:

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
- Semantic/hybrid modes require semantic search to be enabled and chunk embeddings to be present.
- When remote embeddings are not required, the embedding client may use deterministic fallback embeddings for test/dev mechanics.
- When `embeddingRequireRemote` is true, remote embedding failures fail loudly.

## Known MVP limitations
- Vector search uses a simple JS cosine scan over persisted chunk embeddings; no ANN/vector DB is included in this sprint.
- Chunking remains line-oriented.
- Binary/non-UTF8 file handling remains a future scanner hardening item.
- Deterministic fallback embeddings are useful for testing mechanics but should not be treated as production semantic quality.
