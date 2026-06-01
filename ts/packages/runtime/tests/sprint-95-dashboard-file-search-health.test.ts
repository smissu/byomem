import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDashboardProfileSummary } from '../src/dashboard-profile.js';
import { renderByomemDashboardHtml } from '../src/dashboard.js';
import { FILE_SEARCH_EMBEDDING_IDENTITY_VERSION } from '../src/embedding-client.js';
import { resolveFileSearchProjectKey } from '../src/file-search-db.js';

type SeedFileSearchDbOptions = {
  includeScannerTable?: boolean;
  includeEmbeddingTable?: boolean;
  legacyEmbeddingSchema?: boolean;
  scannerState?: 'idle' | 'running' | 'completed' | 'failed' | 'abandoned';
  scannerTrigger?: string | null;
  scannerStartedAt?: string | null;
  scannerCompletedAt?: string | null;
  scannerUpdatedAt?: string;
  fileCount?: number;
  chunkCount?: number;
  readyEmbeddingCount?: number;
  failedEmbeddingCount?: number;
};

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runtimeArtifacts(baseDir: string): Record<string, boolean> {
  return {
    nativeStoreJson: existsSync(join(baseDir, 'native-store.json')),
    nativeStoreSqlite: existsSync(join(baseDir, 'byomem-index.sqlite')),
    fileSearchSqlite: existsSync(join(baseDir, 'byomem-file-search.sqlite')),
    graphSqlite: existsSync(join(baseDir, 'byomem-graph.sqlite')),
    queueJson: existsSync(join(baseDir, 'queue.json')),
    workerJson: existsSync(join(baseDir, 'worker.json')),
    runtimeStateDir: existsSync(join(baseDir, 'runtime-state')),
  };
}

function expectNoRuntimeArtifacts(baseDir: string): void {
  expect(runtimeArtifacts(baseDir)).toEqual({
    nativeStoreJson: false,
    nativeStoreSqlite: false,
    fileSearchSqlite: false,
    graphSqlite: false,
    queueJson: false,
    workerJson: false,
    runtimeStateDir: false,
  });
}

function expectOnlyFileSearchDb(baseDir: string): void {
  expect(runtimeArtifacts(baseDir)).toEqual({
    nativeStoreJson: false,
    nativeStoreSqlite: false,
    fileSearchSqlite: true,
    graphSqlite: false,
    queueJson: false,
    workerJson: false,
    runtimeStateDir: false,
  });
}

function createFileSearchFixtureDb(projectDir: string, runtimeDir: string, options: SeedFileSearchDbOptions = {}): string {
  const dbPath = join(runtimeDir, 'byomem-file-search.sqlite');
  const db = new Database(dbPath);
  const projectKey = resolveFileSearchProjectKey(projectDir);
  const fileCount = options.fileCount ?? 2;
  const chunkCount = options.chunkCount ?? 3;
  const readyEmbeddingCount = options.readyEmbeddingCount ?? chunkCount;
  const failedEmbeddingCount = options.failedEmbeddingCount ?? 0;
  const scannerState = options.scannerState ?? 'completed';
  const scannerTrigger = options.scannerTrigger ?? 'manual';
  const scannerStartedAt = options.scannerStartedAt ?? '2026-06-01T00:00:00.000Z';
  const scannerCompletedAt = Object.hasOwn(options, 'scannerCompletedAt') ? options.scannerCompletedAt : '2026-06-01T00:01:30.000Z';
  const scannerUpdatedAt = options.scannerUpdatedAt ?? scannerCompletedAt;

  db.exec(`
    CREATE TABLE indexed_files (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      path TEXT NOT NULL,
      file_record_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE indexed_chunks (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      file_record_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      search_text TEXT NOT NULL,
      chunk_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    ${options.includeEmbeddingTable === false ? '' : options.legacyEmbeddingSchema ? `
    CREATE TABLE indexed_chunk_embeddings (
      chunk_id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      file_record_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_hash TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      embedding BLOB NOT NULL,
      dimension INTEGER NOT NULL,
      effective_dimension INTEGER,
      identity_version TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    ` : `
    CREATE TABLE indexed_chunk_embeddings (
      chunk_id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      file_record_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_hash TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      configured_dimension INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      dimension INTEGER NOT NULL,
      provider_key TEXT,
      effective_dimension INTEGER,
      identity_version TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    `}
    ${options.includeScannerTable === false ? '' : `
    CREATE TABLE file_search_scanner_status (
      project_key TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      run_id TEXT,
      trigger TEXT,
      base_dir TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER,
      current_path TEXT,
      last_path TEXT,
      last_error TEXT,
      progress_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    `}
  `);

  const files = Array.from({ length: fileCount }, (_, index) => ({
    id: `file-${index + 1}`,
    path: index === 0 ? 'src/dashboard-profile.ts' : index === 1 ? 'README.md' : `fixtures/file-${index + 1}.md`,
    fileRecordId: `record-${index + 1}`,
  }));
  const chunks = Array.from({ length: chunkCount }, (_, index) => ({
    id: `chunk-${index + 1}`,
    fileRecordId: files[index % files.length]!.fileRecordId,
    chunkIndex: index,
    chunkHash: `hash-${index + 1}`,
    text: index === 0 ? 'alpha' : index === 1 ? 'beta' : 'gamma',
  }));

  const insertFile = db.prepare('INSERT INTO indexed_files(id, project_key, path, file_record_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insertChunk = db.prepare('INSERT INTO indexed_chunks(id, project_key, file_record_id, chunk_index, chunk_text, search_text, chunk_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertEmbeddingCurrent = options.includeEmbeddingTable === false || options.legacyEmbeddingSchema ? undefined : db.prepare(`
    INSERT INTO indexed_chunk_embeddings(
      chunk_id, project_key, file_record_id, chunk_index, chunk_hash, text_hash, model, configured_dimension, embedding, dimension, provider_key, effective_dimension, identity_version, status, error, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEmbeddingLegacy = options.includeEmbeddingTable === false || !options.legacyEmbeddingSchema ? undefined : db.prepare(`
    INSERT INTO indexed_chunk_embeddings(
      chunk_id, project_key, file_record_id, chunk_index, chunk_hash, text_hash, model, embedding, dimension, effective_dimension, identity_version, status, error, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = '2026-06-01T00:00:00.000Z';
  for (const file of files) {
    insertFile.run(file.id, projectKey, file.path, file.fileRecordId, now, now);
  }
  for (const chunk of chunks) {
    insertChunk.run(chunk.id, projectKey, chunk.fileRecordId, chunk.chunkIndex, chunk.text, chunk.text, chunk.chunkHash, now, now);
  }

  if (options.includeEmbeddingTable !== false) {
    const embeddingModel = 'minishlab/potion-code-16M';
    const embeddingProviderKey = 'local:model2vec:minishlab/potion-code-16M';
    for (let index = 0; index < readyEmbeddingCount; index += 1) {
      const chunk = chunks[index]!;
      if (options.legacyEmbeddingSchema) {
        insertEmbeddingLegacy!.run(
          chunk.id,
          projectKey,
          chunk.fileRecordId,
          chunk.chunkIndex,
          chunk.chunkHash,
          `text-${index + 1}`,
          embeddingModel,
          Buffer.from([1, 2, 3]),
          256,
          256,
          FILE_SEARCH_EMBEDDING_IDENTITY_VERSION,
          'ready',
          null,
          now,
          now,
        );
      } else {
        insertEmbeddingCurrent!.run(
          chunk.id,
          projectKey,
          chunk.fileRecordId,
          chunk.chunkIndex,
          chunk.chunkHash,
          `text-${index + 1}`,
          embeddingModel,
          256,
          Buffer.from([1, 2, 3]),
          256,
          embeddingProviderKey,
          256,
          FILE_SEARCH_EMBEDDING_IDENTITY_VERSION,
          'ready',
          null,
          now,
          now,
        );
      }
    }
    for (let index = 0; index < failedEmbeddingCount; index += 1) {
      const chunk = chunks[readyEmbeddingCount + index]!;
      if (options.legacyEmbeddingSchema) {
        insertEmbeddingLegacy!.run(
          chunk.id,
          projectKey,
          chunk.fileRecordId,
          chunk.chunkIndex,
          chunk.chunkHash,
          `failed-text-${index + 1}`,
          embeddingModel,
          Buffer.from([]),
          0,
          0,
          FILE_SEARCH_EMBEDDING_IDENTITY_VERSION,
          'failed',
          `embedding failed ${index + 1}`,
          now,
          now,
        );
      } else {
        insertEmbeddingCurrent!.run(
          chunk.id,
          projectKey,
          chunk.fileRecordId,
          chunk.chunkIndex,
          chunk.chunkHash,
          `failed-text-${index + 1}`,
          embeddingModel,
          256,
          Buffer.from([]),
          0,
          embeddingProviderKey,
          0,
          FILE_SEARCH_EMBEDDING_IDENTITY_VERSION,
          'failed',
          `embedding failed ${index + 1}`,
          now,
          now,
        );
      }
    }
  }

  if (options.includeScannerTable !== false) {
    db.prepare(`
      INSERT INTO file_search_scanner_status(
        project_key, state, run_id, trigger, base_dir, started_at, completed_at, duration_ms, current_path, last_path, last_error, progress_json, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectKey,
      scannerState,
      'run-1',
      scannerTrigger,
      projectDir,
      scannerStartedAt,
      scannerCompletedAt,
      90000,
      null,
      null,
      null,
      '{}',
      scannerUpdatedAt,
    );
  }

  db.close();
  return dbPath;
}

function collectSummary(projectDir: string, runtimeDir: string, injectedFileSearch?: Record<string, unknown>) {
  return collectDashboardProfileSummary({
    projectBaseDir: projectDir,
    runtimeBaseDir: runtimeDir,
    collectedAt: '2026-06-01T00:00:00.000Z',
    injected: injectedFileSearch ? { fileSearch: injectedFileSearch as never } : undefined,
  });
}

describe('sprint 95 dashboard file-search health contract', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('exposes the exact file-search health shape from read-only SQLite evidence', () => {
    const projectDir = tempDir('byomem-sprint95-project-');
    const runtimeDir = tempDir('byomem-sprint95-runtime-');
    dirs.push(projectDir, runtimeDir);
    createFileSearchFixtureDb(projectDir, runtimeDir, {
      scannerState: 'completed',
      scannerTrigger: 'manual',
      scannerStartedAt: '2026-06-01T00:00:00.000Z',
      scannerCompletedAt: '2026-06-01T00:01:30.000Z',
      scannerUpdatedAt: '2026-06-01T00:01:30.000Z',
      chunkCount: 3,
      readyEmbeddingCount: 3,
      failedEmbeddingCount: 0,
    });

    const summary = collectSummary(projectDir, runtimeDir);

    expectOnlyFileSearchDb(runtimeDir);
    expect(summary.fileSearch).toMatchObject({
      state: 'ready',
      source: 'db-read-only',
      evidenceTier: 'db-read-only',
      indexedFileCount: 2,
      chunkCount: 3,
      lastIndexedAt: '2026-06-01T00:01:30.000Z',
      health: {
        scannerState: 'completed',
        scannerTrigger: 'manual',
        scannerStartedAt: '2026-06-01T00:00:00.000Z',
        scannerCompletedAt: '2026-06-01T00:01:30.000Z',
        scannerUpdatedAt: '2026-06-01T00:01:30.000Z',
        lastIndexedAt: '2026-06-01T00:01:30.000Z',
        indexedFileCount: 2,
        indexedChunkCount: 3,
        embeddedChunkCount: 3,
        missingChunkCount: 0,
        failedChunkCount: 0,
        embeddingReadiness: 'ready',
        embeddingModel: 'minishlab/potion-code-16M',
        embeddingProviderKey: 'local:model2vec:minishlab/potion-code-16M',
        embeddingDimensions: [{ dimension: 256, chunks: 3 }],
        hotIndexState: 'not-collected',
        hotIndexSource: 'not-collected',
        warnings: [],
      },
    });
  });

  it('treats failed embeddings and stale evidence as degraded instead of ready', () => {
    const projectDir = tempDir('byomem-sprint95-project-');
    const runtimeDir = tempDir('byomem-sprint95-runtime-');
    dirs.push(projectDir, runtimeDir);
    createFileSearchFixtureDb(projectDir, runtimeDir, {
      scannerState: 'failed',
      scannerTrigger: 'scheduler-post-activity',
      scannerStartedAt: '2026-06-01T00:05:00.000Z',
      scannerCompletedAt: null,
      scannerUpdatedAt: '2026-06-01T00:06:45.000Z',
      chunkCount: 3,
      readyEmbeddingCount: 1,
      failedEmbeddingCount: 1,
    });

    const summary = collectSummary(projectDir, runtimeDir);

    expectOnlyFileSearchDb(runtimeDir);
    expect(summary.fileSearch).toMatchObject({
      health: {
        scannerState: 'failed',
        scannerTrigger: 'scheduler-post-activity',
        scannerStartedAt: '2026-06-01T00:05:00.000Z',
        scannerCompletedAt: null,
        scannerUpdatedAt: '2026-06-01T00:06:45.000Z',
        lastIndexedAt: '2026-06-01T00:06:45.000Z',
        indexedFileCount: 2,
        indexedChunkCount: 3,
        embeddedChunkCount: 1,
        missingChunkCount: 1,
        failedChunkCount: 1,
        embeddingReadiness: 'refresh-needed',
        embeddingModel: 'minishlab/potion-code-16M',
        embeddingProviderKey: 'local:model2vec:minishlab/potion-code-16M',
        embeddingDimensions: [{ dimension: 256, chunks: 1 }],
        hotIndexState: 'not-collected',
        hotIndexSource: 'not-collected',
      },
    });
  });

  it('does not mark stale provider/model/dimension identity rows as current readiness', () => {
    const projectDir = tempDir('byomem-sprint95-project-');
    const runtimeDir = tempDir('byomem-sprint95-runtime-');
    dirs.push(projectDir, runtimeDir);
    const dbPath = createFileSearchFixtureDb(projectDir, runtimeDir, {
      scannerState: 'completed',
      chunkCount: 2,
      readyEmbeddingCount: 2,
      failedEmbeddingCount: 0,
    });
    const db = new Database(dbPath);
    db.prepare(`
      UPDATE indexed_chunk_embeddings
      SET model = 'wrong-model',
          provider_key = 'remote:https://example.invalid/api/embeddings',
          configured_dimension = 1536,
          dimension = 1536,
          identity_version = 'old-embedding-v0'
    `).run();
    db.close();

    const summary = collectSummary(projectDir, runtimeDir);

    expect(summary.fileSearch.health).toMatchObject({
      indexedChunkCount: 2,
      embeddedChunkCount: 0,
      missingChunkCount: 2,
      failedChunkCount: 0,
      embeddingReadiness: 'refresh-needed',
      embeddingModel: 'wrong-model',
      embeddingProviderKey: 'remote:https://example.invalid/api/embeddings',
      embeddingDimensions: [],
      hotIndexState: 'not-collected',
      hotIndexSource: 'not-collected',
    });
  });

  it('uses CLI-supplied remote embedding identity when collecting dashboard health', () => {
    const projectDir = tempDir('byomem-sprint95-project-');
    const runtimeDir = tempDir('byomem-sprint95-runtime-');
    dirs.push(projectDir, runtimeDir);
    const dbPath = createFileSearchFixtureDb(projectDir, runtimeDir, {
      scannerState: 'completed',
      chunkCount: 2,
      readyEmbeddingCount: 2,
      failedEmbeddingCount: 0,
    });
    const db = new Database(dbPath);
    db.prepare(`
      UPDATE indexed_chunk_embeddings
      SET model = 'remote-embedding-model',
          provider_key = 'remote:https://embeddings.example/api/embeddings',
          configured_dimension = 0,
          dimension = 1536
    `).run();
    db.close();

    const summary = collectDashboardProfileSummary({
      projectBaseDir: projectDir,
      runtimeBaseDir: runtimeDir,
      collectedAt: '2026-06-01T00:00:00.000Z',
      embeddingBaseUrl: 'https://embeddings.example',
      embeddingModel: 'remote-embedding-model',
    });

    expect(summary.fileSearch.health).toMatchObject({
      embeddedChunkCount: 2,
      missingChunkCount: 0,
      failedChunkCount: 0,
      embeddingReadiness: 'ready',
      embeddingModel: 'remote-embedding-model',
      embeddingProviderKey: 'remote:https://embeddings.example/api/embeddings',
      embeddingDimensions: [{ dimension: 1536, chunks: 2 }],
    });
  });

  it('degrades safely when the file-search db is missing, the scanner table is missing, the embeddings table is missing, or the embedding schema is legacy', () => {
    const missingDbProjectDir = tempDir('byomem-sprint95-project-');
    const missingDbRuntimeDir = tempDir('byomem-sprint95-runtime-');
    dirs.push(missingDbProjectDir, missingDbRuntimeDir);

    const missingDbSummary = collectSummary(missingDbProjectDir, missingDbRuntimeDir);
    expectNoRuntimeArtifacts(missingDbRuntimeDir);
    expect(missingDbSummary.fileSearch).toMatchObject({
      state: 'missing',
      source: 'missing',
      evidenceTier: 'not-collected',
      health: {
        scannerState: 'missing',
        scannerTrigger: null,
        scannerStartedAt: null,
        scannerCompletedAt: null,
        scannerUpdatedAt: null,
        lastIndexedAt: null,
        indexedFileCount: null,
        indexedChunkCount: null,
        embeddedChunkCount: null,
        missingChunkCount: null,
        failedChunkCount: null,
        embeddingReadiness: 'missing',
        embeddingModel: null,
        embeddingProviderKey: null,
        embeddingDimensions: [],
        hotIndexState: 'not-collected',
        hotIndexSource: 'not-collected',
        warnings: [],
      },
    });

    const missingScannerProjectDir = tempDir('byomem-sprint95-project-');
    const missingScannerRuntimeDir = tempDir('byomem-sprint95-runtime-');
    dirs.push(missingScannerProjectDir, missingScannerRuntimeDir);
    createFileSearchFixtureDb(missingScannerProjectDir, missingScannerRuntimeDir, {
      includeScannerTable: false,
      readyEmbeddingCount: 3,
      failedEmbeddingCount: 0,
    });
    const missingScannerSummary = collectSummary(missingScannerProjectDir, missingScannerRuntimeDir);
    expectOnlyFileSearchDb(missingScannerRuntimeDir);
    expect(missingScannerSummary.fileSearch).toMatchObject({
      state: 'ready',
      health: {
        scannerState: 'not-collected',
        scannerTrigger: null,
        scannerStartedAt: null,
        scannerCompletedAt: null,
        scannerUpdatedAt: null,
        lastIndexedAt: null,
        indexedFileCount: 2,
        indexedChunkCount: 3,
        embeddedChunkCount: 3,
        missingChunkCount: 0,
        failedChunkCount: 0,
        embeddingReadiness: 'ready',
        embeddingModel: 'minishlab/potion-code-16M',
        embeddingProviderKey: 'local:model2vec:minishlab/potion-code-16M',
        embeddingDimensions: [{ dimension: 256, chunks: 3 }],
        hotIndexState: 'not-collected',
        hotIndexSource: 'not-collected',
      },
    });

    const missingEmbeddingProjectDir = tempDir('byomem-sprint95-project-');
    const missingEmbeddingRuntimeDir = tempDir('byomem-sprint95-runtime-');
    dirs.push(missingEmbeddingProjectDir, missingEmbeddingRuntimeDir);
    createFileSearchFixtureDb(missingEmbeddingProjectDir, missingEmbeddingRuntimeDir, {
      includeEmbeddingTable: false,
      readyEmbeddingCount: 0,
      failedEmbeddingCount: 0,
    });
    const missingEmbeddingSummary = collectSummary(missingEmbeddingProjectDir, missingEmbeddingRuntimeDir);
    expectOnlyFileSearchDb(missingEmbeddingRuntimeDir);
    expect(missingEmbeddingSummary.fileSearch).toMatchObject({
      health: {
        scannerState: 'completed',
        scannerTrigger: 'manual',
        scannerStartedAt: '2026-06-01T00:00:00.000Z',
        scannerCompletedAt: '2026-06-01T00:01:30.000Z',
        scannerUpdatedAt: '2026-06-01T00:01:30.000Z',
        lastIndexedAt: '2026-06-01T00:01:30.000Z',
        indexedFileCount: 2,
        indexedChunkCount: 3,
        embeddedChunkCount: null,
        missingChunkCount: null,
        failedChunkCount: null,
        embeddingReadiness: 'missing',
        embeddingModel: null,
        embeddingProviderKey: null,
        embeddingDimensions: [],
        hotIndexState: 'not-collected',
        hotIndexSource: 'not-collected',
      },
    });

    const legacySchemaProjectDir = tempDir('byomem-sprint95-project-');
    const legacySchemaRuntimeDir = tempDir('byomem-sprint95-runtime-');
    dirs.push(legacySchemaProjectDir, legacySchemaRuntimeDir);
    createFileSearchFixtureDb(legacySchemaProjectDir, legacySchemaRuntimeDir, {
      legacyEmbeddingSchema: true,
      readyEmbeddingCount: 2,
      failedEmbeddingCount: 0,
      chunkCount: 2,
      scannerState: 'completed',
      scannerTrigger: 'manual',
      scannerStartedAt: '2026-06-01T00:00:00.000Z',
      scannerCompletedAt: '2026-06-01T00:01:30.000Z',
      scannerUpdatedAt: '2026-06-01T00:01:30.000Z',
    });
    const legacySchemaSummary = collectSummary(legacySchemaProjectDir, legacySchemaRuntimeDir);
    expectOnlyFileSearchDb(legacySchemaRuntimeDir);
    expect(legacySchemaSummary.fileSearch).toMatchObject({
      health: {
        scannerState: 'completed',
        scannerTrigger: 'manual',
        scannerStartedAt: '2026-06-01T00:00:00.000Z',
        scannerCompletedAt: '2026-06-01T00:01:30.000Z',
        scannerUpdatedAt: '2026-06-01T00:01:30.000Z',
        lastIndexedAt: '2026-06-01T00:01:30.000Z',
        indexedFileCount: 2,
        indexedChunkCount: 2,
        embeddedChunkCount: 0,
        missingChunkCount: 2,
        failedChunkCount: 0,
        embeddingReadiness: 'refresh-needed',
        embeddingProviderKey: null,
        embeddingModel: 'minishlab/potion-code-16M',
        hotIndexState: 'not-collected',
        hotIndexSource: 'not-collected',
      },
    });
  });

  it('accepts injected hot-index evidence and surfaces it without importing hot-index runtime modules', () => {
    const projectDir = tempDir('byomem-sprint95-project-');
    const runtimeDir = tempDir('byomem-sprint95-runtime-');
    dirs.push(projectDir, runtimeDir);

    const summary = collectSummary(projectDir, runtimeDir, {
      state: 'ready',
      source: 'injected',
      evidenceTier: 'db-read-only',
      dbPath: join(runtimeDir, 'byomem-file-search.sqlite'),
      indexedFileCount: 2,
      chunkCount: 3,
      lastIndexedAt: '2026-06-01T00:01:30.000Z',
      languageCounts: {},
      summary: 'Injected file-search profile evidence.',
      warnings: [],
      health: {
        scannerState: 'completed',
        scannerTrigger: 'manual',
        scannerStartedAt: '2026-06-01T00:00:00.000Z',
        scannerCompletedAt: '2026-06-01T00:01:30.000Z',
        scannerUpdatedAt: '2026-06-01T00:01:30.000Z',
        lastIndexedAt: '2026-06-01T00:01:30.000Z',
        indexedFileCount: 2,
        indexedChunkCount: 3,
        embeddedChunkCount: 3,
        missingChunkCount: 0,
        failedChunkCount: 0,
        embeddingReadiness: 'ready',
        embeddingModel: 'minishlab/potion-code-16M',
        embeddingProviderKey: 'local:model2vec:minishlab/potion-code-16M',
        embeddingDimensions: [{ dimension: 256, chunks: 3 }],
        hotIndexState: 'injected',
        hotIndexSource: 'injected',
        warnings: [],
      },
    });

    expect(summary.fileSearch).toMatchObject({
      health: {
        hotIndexState: 'injected',
        hotIndexSource: 'injected',
      },
    });

    const source = readFileSync(new URL('../src/dashboard-profile.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      'openFileSearchDb',
      'openNativeStore',
      'scanAndIndex',
      'refreshSemanticIndex',
      'buildFileSearchIndex',
      'openFileSearchIndex',
      'FileIndexScheduler',
      'file-search-index',
      'file-search-query',
      'file-search-active-poller',
      'file-search-worker',
      'file-search-worker-runner',
      'file-search-semantic-refresh',
      'graph-update',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('renders a file-search health subsection in static HTML without executable controls or remote assets', () => {
    const projectDir = tempDir('byomem-sprint95-project-');
    const runtimeDir = tempDir('byomem-sprint95-runtime-');
    dirs.push(projectDir, runtimeDir);

    const summary = collectSummary(projectDir, runtimeDir, {
      state: 'ready',
      source: 'injected',
      evidenceTier: 'db-read-only',
      dbPath: join(runtimeDir, 'byomem-file-search.sqlite'),
      indexedFileCount: 2,
      chunkCount: 3,
      lastIndexedAt: '2026-06-01T00:01:30.000Z',
      languageCounts: {},
      summary: 'Injected file-search profile evidence.',
      warnings: [],
      health: {
        scannerState: 'completed',
        scannerTrigger: 'manual',
        scannerStartedAt: '2026-06-01T00:00:00.000Z',
        scannerCompletedAt: '2026-06-01T00:01:30.000Z',
        scannerUpdatedAt: '2026-06-01T00:01:30.000Z',
        lastIndexedAt: '2026-06-01T00:01:30.000Z',
        indexedFileCount: 2,
        indexedChunkCount: 3,
        embeddedChunkCount: 3,
        missingChunkCount: 0,
        failedChunkCount: 0,
        embeddingReadiness: 'ready',
        embeddingModel: 'VeryLongEmbeddingModelNameThatShouldWrapInsideTheStaticProfileCardWithoutOverflow',
        embeddingProviderKey: 'provider://very-long-provider-key-that-should-wrap-inside-the-profile-card-and-stay-readable',
        embeddingDimensions: [{ dimension: 256, chunks: 3 }],
        hotIndexState: 'injected',
        hotIndexSource: 'injected',
        warnings: [],
      },
    });

    const html = renderByomemDashboardHtml({
      schemaVersion: 1,
      command: 'dashboard',
      runtimeVersion: '0.1.19',
      generatedAt: '2026-06-01T00:00:00.000Z',
      overallStatus: 'pass',
      identityMeta: {
        runtimeVersion: '0.1.19',
        projectBaseDir: projectDir,
        runtimeBaseDir: runtimeDir,
        generatedAt: '2026-06-01T00:00:00.000Z',
        overallStatus: 'pass',
      },
      projectBaseDir: projectDir,
      runtimeBaseDir: runtimeDir,
      paths: { projectBaseDir: projectDir, runtimeBaseDir: runtimeDir },
      degradedComponents: [],
      kpiCards: [],
      capabilityBanners: [],
      profileSummary: summary,
      firstRunGuidance: [],
      sectionSummaries: [],
      commandCards: [],
      statusComponents: [],
      doctorChecks: [],
      warnings: [],
      suggestedActions: [],
    });

    expect(html).toContain('File search health');
    expect(html).toContain('Scanner state');
    expect(html).toContain('Embedding provider');
    expect(html).toContain('Hot index');
    expect(html).toContain('VeryLongEmbeddingModelNameThatShouldWrapInsideTheStaticProfileCardWithoutOverflow');
    expect(html).toContain('provider://very-long-provider-key-that-should-wrap-inside-the-profile-card-and-stay-readable');
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/<button\b/i);
    expect(html).not.toMatch(/\bon[a-z]+\s*=/i);
    expect(html).not.toMatch(/\b(?:src|action)\s*=\s*["'](?:https?:)?\/\//i);
  });
});
