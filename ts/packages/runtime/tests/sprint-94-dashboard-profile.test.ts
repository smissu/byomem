import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { collectDashboardProfileSummary } from '../src/dashboard-profile.js';
import { renderByomemDashboardHtml } from '../src/dashboard.js';
import { resolveFileSearchProjectKey } from '../src/file-search-db.js';
import { openGraphDb } from '../src/graph-db.js';

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

function seedFileSearchDb(projectDir: string, runtimeDir: string): void {
  const db = new Database(join(runtimeDir, 'byomem-file-search.sqlite'));
  const projectKey = resolveFileSearchProjectKey(projectDir);
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
  `);
  const now = '2026-06-01T00:00:00.000Z';
  const insertFile = db.prepare('INSERT INTO indexed_files(id, project_key, path, file_record_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  insertFile.run('file-1', projectKey, 'src/dashboard-profile.ts', 'record-1', now, now);
  insertFile.run('file-2', projectKey, 'README.md', 'record-2', now, now);
  const insertChunk = db.prepare('INSERT INTO indexed_chunks(id, project_key, file_record_id, chunk_index, chunk_text, search_text, chunk_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertChunk.run('chunk-1', projectKey, 'record-1', 0, 'alpha', 'alpha', 'hash-1', now, now);
  insertChunk.run('chunk-2', projectKey, 'record-1', 1, 'beta', 'beta', 'hash-2', now, now);
  insertChunk.run('chunk-3', projectKey, 'record-2', 0, 'gamma', 'gamma', 'hash-3', now, now);
  const insertEmbedding = db.prepare(`
    INSERT INTO indexed_chunk_embeddings(chunk_id, project_key, file_record_id, chunk_index, chunk_hash, text_hash, model, configured_dimension, embedding, dimension, provider_key, effective_dimension, identity_version, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertEmbedding.run('chunk-1', projectKey, 'record-1', 0, 'hash-1', 'text-1', 'minishlab/potion-code-16M', 256, Buffer.from([1, 2, 3]), 256, 'local:model2vec:minishlab/potion-code-16M', 256, 'v1', 'ready', now, now);
  insertEmbedding.run('chunk-2', projectKey, 'record-1', 1, 'hash-2', 'text-2', 'minishlab/potion-code-16M', 256, Buffer.from([1, 2, 3]), 256, 'local:model2vec:minishlab/potion-code-16M', 256, 'v1', 'ready', now, now);
  db.close();
}

function seedGraphDb(projectDir: string, runtimeDir: string): void {
  const graphDb = openGraphDb({ baseDir: projectDir, dbBaseDir: runtimeDir });
  try {
    graphDb.importGraph({
      source: 'fixture',
      baseDir: projectDir,
      nodes: [
        { id: 'dashboard.ts', label: 'dashboard.ts', sourceFile: 'ts/packages/runtime/src/dashboard.ts' },
        { id: 'dashboard-profile.ts', label: 'dashboard-profile.ts', sourceFile: 'ts/packages/runtime/src/dashboard-profile.ts' },
      ],
      edges: [
        { source: 'dashboard.ts', target: 'dashboard-profile.ts', relation: 'imports' },
      ],
      reportCommunities: [{ id: 1, name: 'dashboard', nodeCount: 2 }],
    });
  } finally {
    graphDb.close();
  }
}

describe('sprint 94 dashboard profile summary', () => {
  const dirs: string[] = [];
  const originalRuntimeBaseDir = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBaseDir === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBaseDir;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('returns missing/not-collected evidence without creating file-search or graph databases', () => {
    const projectDir = tempDir('byomem-profile-project-');
    const runtimeDir = tempDir('byomem-profile-runtime-');
    dirs.push(projectDir, runtimeDir);

    expectNoRuntimeArtifacts(runtimeDir);
    const summary = collectDashboardProfileSummary({
      projectBaseDir: projectDir,
      runtimeBaseDir: runtimeDir,
      collectedAt: '2026-06-01T00:00:00.000Z',
    });

    expect(summary.fileSearch).toMatchObject({
      state: 'missing',
      evidenceTier: 'not-collected',
      indexedFileCount: null,
      chunkCount: null,
    });
    expect(summary.embedding).toMatchObject({
      state: 'missing',
      readiness: 'missing',
      evidenceTier: 'not-collected',
    });
    expect(summary.graph).toMatchObject({
      state: 'missing',
      evidenceTier: 'not-collected',
      nodeCount: null,
      edgeCount: null,
    });
    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('collects file-search, embedding, and graph stats through read-only database evidence', () => {
    const projectDir = tempDir('byomem-profile-project-');
    const runtimeDir = tempDir('byomem-profile-runtime-');
    dirs.push(projectDir, runtimeDir);
    seedFileSearchDb(projectDir, runtimeDir);
    seedGraphDb(projectDir, runtimeDir);

    const summary = collectDashboardProfileSummary({
      projectBaseDir: projectDir,
      runtimeBaseDir: runtimeDir,
      collectedAt: '2026-06-01T00:00:00.000Z',
    });

    expect(summary.fileSearch).toMatchObject({
      state: 'ready',
      source: 'db-read-only',
      evidenceTier: 'db-read-only',
      indexedFileCount: 2,
      chunkCount: 3,
    });
    expect(summary.fileSearch.languageCounts).toMatchObject({
      TypeScript: 1,
      Markdown: 1,
    });
    expect(summary.embedding).toMatchObject({
      state: 'degraded',
      source: 'db-read-only',
      readiness: 'refresh-needed',
      embeddedChunkCount: 2,
      missingChunkCount: 1,
      failedChunkCount: 0,
      model: 'minishlab/potion-code-16M',
      providerKey: 'local:model2vec:minishlab/potion-code-16M',
    });
    expect(summary.embedding.dimensions).toEqual([{ dimension: 256, chunks: 2 }]);
    expect(summary.graph).toMatchObject({
      state: 'ready',
      source: 'db-read-only',
      evidenceTier: 'db-read-only',
      nodeCount: 2,
      edgeCount: 1,
      communityCount: 1,
      relationCounts: { imports: 1 },
      lastUpdateSource: 'fixture',
    });
    expect(existsSync(join(runtimeDir, 'native-store.json'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'byomem-index.sqlite'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'queue.json'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'worker.json'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'runtime-state'))).toBe(false);
  });

  it('exposes profileSummary in dashboard JSON and the read-only dashboard-profile CLI surface', async () => {
    const projectDir = tempDir('byomem-profile-project-');
    const runtimeDir = tempDir('byomem-profile-runtime-');
    dirs.push(projectDir, runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['dashboard', '--base-dir', projectDir, '--format', 'json']);
    const dashboardPayload = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as { profileSummary?: unknown };
    expect(dashboardPayload.profileSummary).toMatchObject({
      projectBaseDir: projectDir,
      runtimeBaseDir: runtimeDir,
      fileSearch: { state: 'missing', evidenceTier: 'not-collected' },
      graph: { state: 'missing', evidenceTier: 'not-collected' },
      embedding: { readiness: 'missing', evidenceTier: 'not-collected' },
    });
    expectNoRuntimeArtifacts(runtimeDir);

    await main(['dashboard-profile', '--base-dir', projectDir, '--format', 'json']);
    const profilePayload = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as { fileSearch?: unknown; graph?: unknown; embedding?: unknown };
    expect(profilePayload).toMatchObject({
      projectBaseDir: projectDir,
      runtimeBaseDir: runtimeDir,
      fileSearch: { state: 'missing' },
      graph: { state: 'missing' },
      embedding: { state: 'missing' },
    });
    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('uses --base-dir as the project root while reading profile evidence from the runtime store', async () => {
    const projectDir = tempDir('byomem-profile-project-');
    const runtimeDir = tempDir('byomem-profile-runtime-');
    dirs.push(projectDir, runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    seedFileSearchDb(projectDir, runtimeDir);
    seedGraphDb(projectDir, runtimeDir);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['dashboard-profile', '--base-dir', projectDir, '--format', 'json']);

    const profilePayload = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      projectBaseDir?: string;
      runtimeBaseDir?: string;
      fileSearch?: { indexedFileCount?: number; chunkCount?: number };
      graph?: { nodeCount?: number; edgeCount?: number };
      embedding?: { readiness?: string; embeddedChunkCount?: number };
    };
    expect(profilePayload.projectBaseDir).toBe(projectDir);
    expect(profilePayload.runtimeBaseDir).toBe(runtimeDir);
    expect(profilePayload.fileSearch).toMatchObject({ indexedFileCount: 2, chunkCount: 3 });
    expect(profilePayload.graph).toMatchObject({ nodeCount: 2, edgeCount: 1 });
    expect(profilePayload.embedding).toMatchObject({ readiness: 'refresh-needed', embeddedChunkCount: 2 });
    expect(existsSync(join(projectDir, 'byomem-file-search.sqlite'))).toBe(false);
    expect(existsSync(join(projectDir, 'byomem-graph.sqlite'))).toBe(false);
  });

  it('renders profile summary as static HTML without executable controls or remote assets', () => {
    const projectDir = tempDir('byomem-profile-project-');
    const runtimeDir = tempDir('byomem-profile-runtime-');
    dirs.push(projectDir, runtimeDir);
    const summary = collectDashboardProfileSummary({
      projectBaseDir: projectDir,
      runtimeBaseDir: runtimeDir,
      injected: {
        fileSearch: {
          state: 'ready',
          source: 'injected',
          evidenceTier: 'db-read-only',
          dbPath: join(runtimeDir, 'byomem-file-search.sqlite'),
          indexedFileCount: 2,
          chunkCount: 4,
          languageCounts: {
            'VeryLongLanguageNameThatMustWrapInsideTheProfileSummaryCardWithoutOverflow': 2,
          },
          summary: 'Injected read-only file-search profile evidence.',
          warnings: [],
        },
      },
      collectedAt: '2026-06-01T00:00:00.000Z',
    });

    const html = renderByomemDashboardHtml({
      schemaVersion: 1,
      command: 'dashboard',
      runtimeVersion: '0.1.16',
      generatedAt: '2026-06-01T00:00:00.000Z',
      overallStatus: 'pass',
      identityMeta: {
        runtimeVersion: '0.1.16',
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

    expect(html).toContain('Profile summary');
    expect(html).toContain('File search profile');
    expect(html).toContain('Graph profile');
    expect(html).toContain('Embedding profile');
    expect(html).toContain('VeryLongLanguageNameThatMustWrapInsideTheProfileSummaryCardWithoutOverflow');
    expect(html).toContain('not-collected');
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/<button\b/i);
    expect(html).not.toMatch(/\bon[a-z]+\s*=/i);
    expect(html).not.toMatch(/\b(?:src|action)\s*=\s*["'](?:https?:)?\/\//i);
  });

  it('keeps the profile collector away from mutating storage entry points', () => {
    const source = readFileSync(new URL('../src/dashboard-profile.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('openFileSearchDb');
    expect(source).not.toContain('scanAndIndex');
    expect(source).not.toContain('refreshSemanticIndex');
    expect(source).not.toContain('openNativeStore');
    expect(source).not.toContain('graph-update');
  });
});
