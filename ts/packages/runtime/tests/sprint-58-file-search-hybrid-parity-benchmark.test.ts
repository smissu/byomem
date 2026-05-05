import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSearchIndexBuilder } from '../src/file-search-index.js';
import {
  chunkKey,
  isSymbolQuery,
  tokenizeSearchQuery,
  type FileSearchChunkRow,
  type FileSearchSearchResult,
} from '../src/file-search-semble.js';
import { openNativeStore } from '../src/store.js';

type Store = ReturnType<typeof openNativeStore>;
type QueryCase = {
  label: string;
  query: string;
  expectedSembleTop1: string;
  expectedSembleTop5: string[];
};
type RowSpec = {
  relativePath: string;
  content: string;
  language: string;
  semanticVector: number[];
};
type HitReport = {
  path: string;
  chunkIndex: number;
  chunkHash: string;
  score: number;
  lexicalScore: number | null;
  semanticScore: number | null;
  candidateSource: 'bm25' | 'semantic' | 'bm25+semantic' | 'unobserved';
  inferredBoostReasons: string[];
  tieBreak: {
    path: string;
    chunkIndex: number;
    chunkHash: string;
  };
};

const QUERY_CASES: QueryCase[] = [
  {
    label: 'sensitive-marker-fix',
    query: 'serialized thinkingSignature encrypted_content sensitive markers',
    expectedSembleTop1: 'ts/packages/runtime/src/file-search-db.ts',
    expectedSembleTop5: [
      'ts/packages/runtime/src/file-search-db.ts',
      'ts/packages/runtime/tests/file-search-sensitive-artifacts.test.ts',
      'docs/sprint-57-file-search-chonkie-readiness.md',
      'docs/semantic-hybrid-document-search-runbook.md',
      'ts/packages/runtime/src/file-search-project-registry.ts',
    ],
  },
  {
    label: 'refresh-batch-concurrency',
    query: 'configured concurrency caps embedMany batch size refreshSemanticIndex',
    expectedSembleTop1: 'ts/packages/runtime/src/file-search-db.ts',
    expectedSembleTop5: [
      'ts/packages/runtime/src/file-search-db.ts',
      'docs/sprint-57-file-search-chonkie-readiness.md',
      'ts/packages/runtime/src/file-search-semantic-refresh.ts',
      'docs/semantic-hybrid-document-search-runbook.md',
      'ts/packages/runtime/src/file-search-index.ts',
    ],
  },
  {
    label: 'manual-scan-refresh-handoff',
    query: 'refreshSemanticIndexAfterManualScan',
    expectedSembleTop1: 'ts/packages/runtime/src/file-search-semantic-refresh.ts',
    expectedSembleTop5: [
      'ts/packages/runtime/src/file-search-semantic-refresh.ts',
      'docs/semantic-hybrid-document-search-runbook.md',
      'ts/packages/runtime/src/file-search-db.ts',
      'ts/packages/runtime/src/file-search-index.ts',
      'ts/packages/runtime/src/file-search-project-registry.ts',
    ],
  },
  {
    label: 'registry-seen-marking',
    query: 'manual-search seen project registry lastSeenAt',
    expectedSembleTop1: 'ts/packages/runtime/src/file-search-project-registry.ts',
    expectedSembleTop5: [
      'ts/packages/runtime/src/file-search-project-registry.ts',
      'ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts',
      'ts/packages/runtime/src/file-search-index.ts',
      'docs/semantic-hybrid-document-search-runbook.md',
      'ts/packages/runtime/src/file-search-db.ts',
    ],
  },
  {
    label: 'hot-index-hydration-surface',
    query: 'hot index hydrate ready vectors stale revision',
    expectedSembleTop1: 'ts/packages/runtime/src/file-search-index.ts',
    expectedSembleTop5: [
      'ts/packages/runtime/src/file-search-index.ts',
      'docs/semantic-hybrid-document-search-runbook.md',
      'ts/packages/runtime/src/file-search-db.ts',
      'ts/packages/runtime/src/file-search-project-registry.ts',
      'ts/packages/runtime/src/file-search-semantic-refresh.ts',
    ],
  },
];

const DIMENSION = QUERY_CASES.length;

const ROW_SPECS: RowSpec[] = [
  {
    relativePath: 'ts/packages/runtime/src/file-search-db.ts',
    language: 'typescript',
    content: [
      'const SENSITIVE_CONTENT_MARKERS = new Set(["thinkingSignature", "textSignature", "encrypted_content", "encryptedContent"]);',
      'export function containsSensitiveFileSearchContent(serialized: string): boolean {',
      '  return serialized.includes("\\"thinkingSignature\\"") || serialized.includes("\\"encrypted_content\\"");',
      '}',
    ].join('\n'),
    semanticVector: [0.99, 0.24, 0.08, 0.08, 0.1],
  },
  {
    relativePath: 'ts/packages/runtime/src/file-search-db.ts',
    language: 'typescript',
    content: [
      'export async function refreshSemanticIndex(options?: { concurrency?: number }) {',
      '  const configuredConcurrencyCaps = Math.max(1, options?.concurrency ?? 4);',
      '  const embedManyBatchSize = 8;',
      '  while (pending.length) await embedMany(pending.splice(0, embedManyBatchSize));',
      '}',
    ].join('\n'),
    semanticVector: [0.06, 0.99, 0.2, 0.06, 0.16],
  },
  {
    relativePath: 'ts/packages/runtime/src/file-search-semantic-refresh.ts',
    language: 'typescript',
    content: [
      'export async function refreshSemanticIndexAfterManualScan(fileDb: FileSearchDbHandle, options?: { concurrency?: number }) {',
      '  const scan = fileDb.scanAndIndex();',
      '  return scan.changedFiles >= 0 ? fileDb.refreshSemanticIndex({ concurrency: options?.concurrency }) : undefined;',
      '}',
    ].join('\n'),
    semanticVector: [0.04, 0.78, 0.99, 0.08, 0.14],
  },
  {
    relativePath: 'ts/packages/runtime/src/file-search-project-registry.ts',
    language: 'typescript',
    content: [
      'export function markFileSearchProjectSeen(db: Database, baseDir: string, source: "manual-search" | "manual-scan") {',
      '  return upsertRegistryRow({ baseDir, source, state: "seen", lastSeenAt: new Date().toISOString() });',
      '}',
    ].join('\n'),
    semanticVector: [0.04, 0.04, 0.08, 0.99, 0.22],
  },
  {
    relativePath: 'ts/packages/runtime/src/file-search-index.ts',
    language: 'typescript',
    content: [
      'export class FileSearchIndex {',
      '  hydrate() { return { rows, vectors, revision, state: "ready", hydrateMs, buildCount, hydrateCount }; }',
      '  invalidate() { this.hotState = "stale"; }',
      '}',
    ].join('\n'),
    semanticVector: [0.04, 0.1, 0.1, 0.24, 0.99],
  },
  {
    relativePath: 'ts/packages/runtime/tests/file-search-sensitive-artifacts.test.ts',
    language: 'typescript',
    content: [
      'it("filters stale thinkingSignature encrypted_content rows before shaping query results", async () => {',
      '  expect(result).not.toContain("thinkingSignature");',
      '});',
    ].join('\n'),
    semanticVector: [0.86, 0.02, 0.02, 0.02, 0.02],
  },
  {
    relativePath: 'docs/sprint-57-file-search-chonkie-readiness.md',
    language: 'markdown',
    content: [
      'Benchmark query: configured concurrency caps embedMany batch size refreshSemanticIndex',
      'Compare BYOMem and Semble for target implementation query ranking.',
    ].join('\n'),
    semanticVector: [0.12, 0.88, 0.04, 0.02, 0.02],
  },
  {
    relativePath: 'docs/semantic-hybrid-document-search-runbook.md',
    language: 'markdown',
    content: [
      'Manual scan and explicit refresh guidance.',
      'await store.fileSearchDb?.refreshSemanticIndex();',
      'Registry seen/manual-search surfaces are documented here.',
      'The hot index hydrate path reports vectors, revision, and ready state.',
    ].join('\n'),
    semanticVector: [0.22, 0.5, 0.8, 0.44, 0.82],
  },
  {
    relativePath: 'ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts',
    language: 'typescript',
    content: [
      'it("marks a project seen from manual-search", () => {',
      '  expect(entry.lastSeenAt).toBeTruthy();',
      '});',
    ].join('\n'),
    semanticVector: [0.02, 0.02, 0.02, 0.86, 0.04],
  },
];

function tempDir(prefix = 'byomem-sprint-58-hybrid-parity-benchmark-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function basisVector(index: number): number[] {
  return Array.from({ length: DIMENSION }, (_, position) => (position === index ? 1 : 0));
}

function chunk(projectDir: string, spec: RowSpec, chunkIndex: number): FileSearchChunkRow {
  return {
    projectKey: 'project:sprint-58-hybrid-parity-benchmark',
    filePath: join(projectDir, spec.relativePath),
    content: spec.content,
    startLine: 1,
    endLine: spec.content.split('\n').length,
    chunkIndex,
    chunkHash: `${spec.relativePath}:${chunkIndex}`,
    language: spec.language,
  };
}

function relativePath(projectDir: string, filePath: string): string {
  return filePath.slice(projectDir.length + 1);
}

function inferCandidateSource(hit: FileSearchSearchResult): HitReport['candidateSource'] {
  const lexical = hit.file?.lexicalScore !== undefined;
  const semantic = hit.file?.semanticScore !== undefined;
  if (lexical && semantic) return 'bm25+semantic';
  if (lexical) return 'bm25';
  if (semantic) return 'semantic';
  return 'unobserved';
}

function splitIdentifier(token: string): string[] {
  const lower = token.toLowerCase();
  if (token.includes('_')) {
    const parts = lower.split('_').filter(Boolean);
    return parts.length >= 2 ? [lower, ...parts] : [lower];
  }
  const parts = token.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g)?.map((part) => part.toLowerCase()) ?? [];
  return parts.length >= 2 ? [lower, ...parts] : [lower];
}

function pathVariants(filePath: string): Set<string> {
  return new Set(filePath.replace(/\\/g, '/').split('/').flatMap((part) => splitIdentifier(part.replace(/\.[^.]+$/, ''))).filter(Boolean));
}

function queryKeywordSet(query: string): Set<string> {
  return new Set(tokenizeSearchQuery(query).filter((token) => token.length > 1));
}

function definesSymbol(content: string, symbolName: string): boolean {
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keywords = [
    'class',
    'module',
    'defmodule',
    'def',
    'interface',
    'struct',
    'enum',
    'trait',
    'type',
    'func',
    'function',
    'object',
    'abstract class',
    'data class',
    'fn',
    'fun',
    'package',
    'namespace',
    'protocol',
    'record',
    'typedef',
  ].map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const nsPrefix = '(?:[A-Za-z_][A-Za-z0-9_]*(?:\\.|::))*';
  return new RegExp(`(?:^|(?<=\\s))(?:${keywords})\\s+${nsPrefix}${escaped}(?:\\s|[<({:\\[]|$)`, 'm').test(content);
}

function extractEmbeddedSymbols(query: string): string[] {
  return query.match(/\b(?:[A-Z][a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]+)\b/g) ?? [];
}

function inferBoostReasons(hit: FileSearchSearchResult, top5: FileSearchSearchResult[], query: string): string[] {
  const reasons: string[] = [];
  const filePath = hit.file?.path ?? hit.chunk.filePath;
  const variants = pathVariants(filePath);
  const keywords = queryKeywordSet(query);
  if ([...keywords].some((token) => variants.has(token))) reasons.push('stem-match');
  if (isSymbolQuery(query) && definesSymbol(hit.chunk.content, query.trim())) reasons.push('symbol-definition');
  const embedded = extractEmbeddedSymbols(query);
  if (embedded.some((symbol) => definesSymbol(hit.chunk.content, symbol))) reasons.push('embedded-symbol-definition');
  if (top5.filter((entry) => (entry.file?.path ?? entry.chunk.filePath) === filePath).length > 1) reasons.push('multi-chunk-context');
  return reasons;
}

async function buildHarness(): Promise<{
  index: ReturnType<typeof FileSearchIndexBuilder.fromPath> extends { build(store: Store): infer T } ? T : never;
  projectDir: string;
  runtimeDir: string;
  store: Store;
}> {
  const projectDir = tempDir();
  const runtimeDir = tempDir('byomem-sprint-58-hybrid-parity-benchmark-runtime-');
  const store = openNativeStore({
    baseDir: projectDir,
    fileSearchDbBaseDir: runtimeDir,
    fileSearchScanOnOpen: false,
    fileSearchSchedulerEnabled: false,
    fileSearchSemanticEnabled: true,
    fileSearchIncludeTextFiles: true,
  });

  const rows = ROW_SPECS.map((spec, chunkIndex) => chunk(projectDir, spec, chunkIndex));
  const indexedRows = rows.map((row) => ({ ...row, searchText: row.content }));
  const index = FileSearchIndexBuilder.fromPath(projectDir).build(store);

  vi.spyOn(store.fileSearchDb!, 'embedQuery').mockImplementation(async (query: string) => {
    const queryIndex = QUERY_CASES.findIndex((entry) => entry.query === query);
    return queryIndex >= 0 ? basisVector(queryIndex) : undefined;
  });

  const vectors = new Map(
    rows.map((row, index) => [
      chunkKey(row),
      { vector: ROW_SPECS[index]!.semanticVector, dimension: DIMENSION },
    ]),
  );

  (index as { hydrate: () => unknown }).hydrate = () => ({
    rows: indexedRows,
    vectors,
    perLanguageCounts: indexedRows.reduce<Record<string, number>>((counts, row) => {
      counts[row.language ?? 'text'] = (counts[row.language ?? 'text'] ?? 0) + 1;
      return counts;
    }, {}),
    indexedFiles: new Set(indexedRows.map((row) => row.filePath)).size,
    revision: store.fileSearchDb!.indexRevision,
    source: 'memory',
    hydrateStartedAt: new Date(0).toISOString(),
    hydratedAt: new Date(0).toISOString(),
    hydrateMs: 0,
  });

  return { index, projectDir, runtimeDir, store };
}

describe('Sprint 58 file-search hybrid parity benchmark', () => {
  const dirs: string[] = [];
  const stores: Store[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('rebaselines the Sprint 57 sensitive implementation query set against Semble-style expectations', async () => {
    const harness = await buildHarness();
    dirs.push(harness.projectDir, harness.runtimeDir);
    stores.push(harness.store);

    const queryReports = [];

    for (const entry of QUERY_CASES) {
      const samples: number[] = [];
      let finalHits: FileSearchSearchResult[] = [];
      for (let iteration = 0; iteration < 3; iteration += 1) {
        const startedAt = performance.now();
        const hits = await harness.index.search(entry.query, { mode: 'hybrid', topK: 5 });
        samples.push(performance.now() - startedAt);
        finalHits = hits;
      }

      const top5 = finalHits.map((hit): HitReport => ({
        path: relativePath(harness.projectDir, hit.file?.path ?? hit.chunk.filePath),
        chunkIndex: hit.file?.chunkIndex ?? -1,
        chunkHash: hit.file?.chunkHash ?? 'missing',
        score: Number(hit.score.toFixed(6)),
        lexicalScore: hit.file?.lexicalScore === undefined ? null : Number(hit.file.lexicalScore.toFixed(6)),
        semanticScore: hit.file?.semanticScore === undefined ? null : Number(hit.file.semanticScore.toFixed(6)),
        candidateSource: inferCandidateSource(hit),
        inferredBoostReasons: inferBoostReasons(hit, finalHits, entry.query),
        tieBreak: {
          path: relativePath(harness.projectDir, hit.file?.path ?? hit.chunk.filePath),
          chunkIndex: hit.file?.chunkIndex ?? -1,
          chunkHash: hit.file?.chunkHash ?? 'missing',
        },
      }));

      queryReports.push({
        label: entry.label,
        query: entry.query,
        expectedSembleTop1: entry.expectedSembleTop1,
        expectedSembleTop5: entry.expectedSembleTop5,
        byomemTop1: top5[0]?.path ?? null,
        byomemTop5: top5.map((hit) => hit.path),
        top5,
        top1MatchesExpected: top5[0]?.path === entry.expectedSembleTop1,
        top5ContainsExpectedTop1: top5.some((hit) => hit.path === entry.expectedSembleTop1),
        elapsedMsMedian: Number(samples.sort((a, b) => a - b)[1]!.toFixed(3)),
      });
    }

    const stableReport = {
      summary: {
        queryCount: QUERY_CASES.length,
        top1Matches: queryReports.filter((report) => report.top1MatchesExpected).length,
        top5ContainsExpectedTop1: queryReports.filter((report) => report.top5ContainsExpectedTop1).length,
      },
      note: 'Candidate sources come from lexicalScore/semanticScore presence in the hit payload. Boost reasons are inferred from the controlled fixture because the runtime result payload does not emit reason tags.',
      queries: queryReports.map((report) => ({
        label: report.label,
        query: report.query,
        expectedSembleTop1: report.expectedSembleTop1,
        expectedSembleTop5: report.expectedSembleTop5,
        byomemTop1: report.byomemTop1,
        byomemTop5: report.byomemTop5,
        top1MatchesExpected: report.top1MatchesExpected,
        top5ContainsExpectedTop1: report.top5ContainsExpectedTop1,
        top5: report.top5,
      })),
    };

    expect(queryReports.every((report) => Number.isFinite(report.elapsedMsMedian) && report.elapsedMsMedian >= 0)).toBe(true);
    expect(stableReport).toMatchInlineSnapshot(`
      {
        "note": "Candidate sources come from lexicalScore/semanticScore presence in the hit payload. Boost reasons are inferred from the controlled fixture because the runtime result payload does not emit reason tags.",
        "queries": [
          {
            "byomemTop1": "ts/packages/runtime/src/file-search-db.ts",
            "byomemTop5": [
              "ts/packages/runtime/src/file-search-db.ts",
              "docs/semantic-hybrid-document-search-runbook.md",
              "docs/sprint-57-file-search-chonkie-readiness.md",
              "ts/packages/runtime/src/file-search-project-registry.ts",
              "ts/packages/runtime/src/file-search-index.ts",
            ],
            "expectedSembleTop1": "ts/packages/runtime/src/file-search-db.ts",
            "expectedSembleTop5": [
              "ts/packages/runtime/src/file-search-db.ts",
              "ts/packages/runtime/tests/file-search-sensitive-artifacts.test.ts",
              "docs/sprint-57-file-search-chonkie-readiness.md",
              "docs/semantic-hybrid-document-search-runbook.md",
              "ts/packages/runtime/src/file-search-project-registry.ts",
            ],
            "label": "sensitive-marker-fix",
            "query": "serialized thinkingSignature encrypted_content sensitive markers",
            "top1MatchesExpected": true,
            "top5": [
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-db.ts:0",
                "chunkIndex": 0,
                "inferredBoostReasons": [],
                "lexicalScore": 18.854471,
                "path": "ts/packages/runtime/src/file-search-db.ts",
                "score": 0.019513,
                "semanticScore": 0.961346,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-db.ts:0",
                  "chunkIndex": 0,
                  "path": "ts/packages/runtime/src/file-search-db.ts",
                },
              },
              {
                "candidateSource": "semantic",
                "chunkHash": "docs/semantic-hybrid-document-search-runbook.md:7",
                "chunkIndex": 7,
                "inferredBoostReasons": [],
                "lexicalScore": null,
                "path": "docs/semantic-hybrid-document-search-runbook.md",
                "score": 0.009014,
                "semanticScore": 0.163778,
                "tieBreak": {
                  "chunkHash": "docs/semantic-hybrid-document-search-runbook.md:7",
                  "chunkIndex": 7,
                  "path": "docs/semantic-hybrid-document-search-runbook.md",
                },
              },
              {
                "candidateSource": "semantic",
                "chunkHash": "docs/sprint-57-file-search-chonkie-readiness.md:6",
                "chunkIndex": 6,
                "inferredBoostReasons": [],
                "lexicalScore": null,
                "path": "docs/sprint-57-file-search-chonkie-readiness.md",
                "score": 0.008873,
                "semanticScore": 0.134908,
                "tieBreak": {
                  "chunkHash": "docs/sprint-57-file-search-chonkie-readiness.md:6",
                  "chunkIndex": 6,
                  "path": "docs/sprint-57-file-search-chonkie-readiness.md",
                },
              },
              {
                "candidateSource": "semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-project-registry.ts:3",
                "chunkIndex": 3,
                "inferredBoostReasons": [],
                "lexicalScore": null,
                "path": "ts/packages/runtime/src/file-search-project-registry.ts",
                "score": 0.008604,
                "semanticScore": 0.039259,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-project-registry.ts:3",
                  "chunkIndex": 3,
                  "path": "ts/packages/runtime/src/file-search-project-registry.ts",
                },
              },
              {
                "candidateSource": "semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-index.ts:4",
                "chunkIndex": 4,
                "inferredBoostReasons": [],
                "lexicalScore": null,
                "path": "ts/packages/runtime/src/file-search-index.ts",
                "score": 0.008476,
                "semanticScore": 0.038864,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-index.ts:4",
                  "chunkIndex": 4,
                  "path": "ts/packages/runtime/src/file-search-index.ts",
                },
              },
            ],
            "top5ContainsExpectedTop1": true,
          },
          {
            "byomemTop1": "ts/packages/runtime/src/file-search-db.ts",
            "byomemTop5": [
              "ts/packages/runtime/src/file-search-db.ts",
              "docs/sprint-57-file-search-chonkie-readiness.md",
              "ts/packages/runtime/src/file-search-semantic-refresh.ts",
              "docs/semantic-hybrid-document-search-runbook.md",
              "ts/packages/runtime/src/file-search-index.ts",
            ],
            "expectedSembleTop1": "ts/packages/runtime/src/file-search-db.ts",
            "expectedSembleTop5": [
              "ts/packages/runtime/src/file-search-db.ts",
              "docs/sprint-57-file-search-chonkie-readiness.md",
              "ts/packages/runtime/src/file-search-semantic-refresh.ts",
              "docs/semantic-hybrid-document-search-runbook.md",
              "ts/packages/runtime/src/file-search-index.ts",
            ],
            "label": "refresh-batch-concurrency",
            "query": "configured concurrency caps embedMany batch size refreshSemanticIndex",
            "top1MatchesExpected": true,
            "top5": [
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-db.ts:1",
                "chunkIndex": 1,
                "inferredBoostReasons": [
                  "embedded-symbol-definition",
                ],
                "lexicalScore": 16.046597,
                "path": "ts/packages/runtime/src/file-search-db.ts",
                "score": 0.048784,
                "semanticScore": 0.96481,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-db.ts:1",
                  "chunkIndex": 1,
                  "path": "ts/packages/runtime/src/file-search-db.ts",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "docs/sprint-57-file-search-chonkie-readiness.md:6",
                "chunkIndex": 6,
                "inferredBoostReasons": [],
                "lexicalScore": 15.242984,
                "path": "docs/sprint-57-file-search-chonkie-readiness.md",
                "score": 0.018469,
                "semanticScore": 0.989326,
                "tieBreak": {
                  "chunkHash": "docs/sprint-57-file-search-chonkie-readiness.md:6",
                  "chunkIndex": 6,
                  "path": "docs/sprint-57-file-search-chonkie-readiness.md",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-semantic-refresh.ts:2",
                "chunkIndex": 2,
                "inferredBoostReasons": [
                  "stem-match",
                ],
                "lexicalScore": 5.046464,
                "path": "ts/packages/runtime/src/file-search-semantic-refresh.ts",
                "score": 0.018028,
                "semanticScore": 0.613565,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-semantic-refresh.ts:2",
                  "chunkIndex": 2,
                  "path": "ts/packages/runtime/src/file-search-semantic-refresh.ts",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "docs/semantic-hybrid-document-search-runbook.md:7",
                "chunkIndex": 7,
                "inferredBoostReasons": [
                  "stem-match",
                ],
                "lexicalScore": 3.442079,
                "path": "docs/semantic-hybrid-document-search-runbook.md",
                "score": 0.017746,
                "semanticScore": 0.372223,
                "tieBreak": {
                  "chunkHash": "docs/semantic-hybrid-document-search-runbook.md:7",
                  "chunkIndex": 7,
                  "path": "docs/semantic-hybrid-document-search-runbook.md",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-index.ts:4",
                "chunkIndex": 4,
                "inferredBoostReasons": [
                  "stem-match",
                ],
                "lexicalScore": 0.636546,
                "path": "ts/packages/runtime/src/file-search-index.ts",
                "score": 0.017341,
                "semanticScore": 0.097161,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-index.ts:4",
                  "chunkIndex": 4,
                  "path": "ts/packages/runtime/src/file-search-index.ts",
                },
              },
            ],
            "top5ContainsExpectedTop1": true,
          },
          {
            "byomemTop1": "ts/packages/runtime/src/file-search-semantic-refresh.ts",
            "byomemTop5": [
              "ts/packages/runtime/src/file-search-semantic-refresh.ts",
              "ts/packages/runtime/src/file-search-db.ts",
              "docs/semantic-hybrid-document-search-runbook.md",
              "docs/sprint-57-file-search-chonkie-readiness.md",
              "ts/packages/runtime/src/file-search-project-registry.ts",
            ],
            "expectedSembleTop1": "ts/packages/runtime/src/file-search-semantic-refresh.ts",
            "expectedSembleTop5": [
              "ts/packages/runtime/src/file-search-semantic-refresh.ts",
              "docs/semantic-hybrid-document-search-runbook.md",
              "ts/packages/runtime/src/file-search-db.ts",
              "ts/packages/runtime/src/file-search-index.ts",
              "ts/packages/runtime/src/file-search-project-registry.ts",
            ],
            "label": "manual-scan-refresh-handoff",
            "query": "refreshSemanticIndexAfterManualScan",
            "top1MatchesExpected": true,
            "top5": [
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-semantic-refresh.ts:2",
                "chunkIndex": 2,
                "inferredBoostReasons": [
                  "stem-match",
                  "symbol-definition",
                  "embedded-symbol-definition",
                ],
                "lexicalScore": 8.450756,
                "path": "ts/packages/runtime/src/file-search-semantic-refresh.ts",
                "score": 0.076194,
                "semanticScore": 0.778755,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-semantic-refresh.ts:2",
                  "chunkIndex": 2,
                  "path": "ts/packages/runtime/src/file-search-semantic-refresh.ts",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-db.ts:1",
                "chunkIndex": 1,
                "inferredBoostReasons": [],
                "lexicalScore": 2.0398,
                "path": "ts/packages/runtime/src/file-search-db.ts",
                "score": 0.018978,
                "semanticScore": 0.194911,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-db.ts:1",
                  "chunkIndex": 1,
                  "path": "ts/packages/runtime/src/file-search-db.ts",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "docs/semantic-hybrid-document-search-runbook.md:7",
                "chunkIndex": 7,
                "inferredBoostReasons": [
                  "stem-match",
                ],
                "lexicalScore": 4.765441,
                "path": "docs/semantic-hybrid-document-search-runbook.md",
                "score": 0.018741,
                "semanticScore": 0.595557,
                "tieBreak": {
                  "chunkHash": "docs/semantic-hybrid-document-search-runbook.md:7",
                  "chunkIndex": 7,
                  "path": "docs/semantic-hybrid-document-search-runbook.md",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "docs/sprint-57-file-search-chonkie-readiness.md:6",
                "chunkIndex": 6,
                "inferredBoostReasons": [],
                "lexicalScore": 2.433659,
                "path": "docs/sprint-57-file-search-chonkie-readiness.md",
                "score": 0.018113,
                "semanticScore": 0.044969,
                "tieBreak": {
                  "chunkHash": "docs/sprint-57-file-search-chonkie-readiness.md:6",
                  "chunkIndex": 6,
                  "path": "docs/sprint-57-file-search-chonkie-readiness.md",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-project-registry.ts:3",
                "chunkIndex": 3,
                "inferredBoostReasons": [],
                "lexicalScore": 1.999518,
                "path": "ts/packages/runtime/src/file-search-project-registry.ts",
                "score": 0.017876,
                "semanticScore": 0.078518,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-project-registry.ts:3",
                  "chunkIndex": 3,
                  "path": "ts/packages/runtime/src/file-search-project-registry.ts",
                },
              },
            ],
            "top5ContainsExpectedTop1": true,
          },
          {
            "byomemTop1": "ts/packages/runtime/src/file-search-project-registry.ts",
            "byomemTop5": [
              "ts/packages/runtime/src/file-search-project-registry.ts",
              "ts/packages/runtime/src/file-search-db.ts",
              "docs/semantic-hybrid-document-search-runbook.md",
              "ts/packages/runtime/src/file-search-index.ts",
              "ts/packages/runtime/src/file-search-semantic-refresh.ts",
            ],
            "expectedSembleTop1": "ts/packages/runtime/src/file-search-project-registry.ts",
            "expectedSembleTop5": [
              "ts/packages/runtime/src/file-search-project-registry.ts",
              "ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts",
              "ts/packages/runtime/src/file-search-index.ts",
              "docs/semantic-hybrid-document-search-runbook.md",
              "ts/packages/runtime/src/file-search-db.ts",
            ],
            "label": "registry-seen-marking",
            "query": "manual-search seen project registry lastSeenAt",
            "top1MatchesExpected": true,
            "top5": [
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-project-registry.ts:3",
                "chunkIndex": 3,
                "inferredBoostReasons": [
                  "stem-match",
                ],
                "lexicalScore": 9.538242,
                "path": "ts/packages/runtime/src/file-search-project-registry.ts",
                "score": 0.02971,
                "semanticScore": 0.971663,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-project-registry.ts:3",
                  "chunkIndex": 3,
                  "path": "ts/packages/runtime/src/file-search-project-registry.ts",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-db.ts:0",
                "chunkIndex": 0,
                "inferredBoostReasons": [
                  "stem-match",
                ],
                "lexicalScore": 0.391304,
                "path": "ts/packages/runtime/src/file-search-db.ts",
                "score": 0.022298,
                "semanticScore": 0.077685,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-db.ts:0",
                  "chunkIndex": 0,
                  "path": "ts/packages/runtime/src/file-search-db.ts",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "docs/semantic-hybrid-document-search-runbook.md:7",
                "chunkIndex": 7,
                "inferredBoostReasons": [
                  "stem-match",
                ],
                "lexicalScore": 4.034084,
                "path": "docs/semantic-hybrid-document-search-runbook.md",
                "score": 0.021914,
                "semanticScore": 0.327557,
                "tieBreak": {
                  "chunkHash": "docs/semantic-hybrid-document-search-runbook.md:7",
                  "chunkIndex": 7,
                  "path": "docs/semantic-hybrid-document-search-runbook.md",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-index.ts:4",
                "chunkIndex": 4,
                "inferredBoostReasons": [
                  "stem-match",
                ],
                "lexicalScore": 0.458675,
                "path": "ts/packages/runtime/src/file-search-index.ts",
                "score": 0.021493,
                "semanticScore": 0.233186,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-index.ts:4",
                  "chunkIndex": 4,
                  "path": "ts/packages/runtime/src/file-search-index.ts",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-semantic-refresh.ts:2",
                "chunkIndex": 2,
                "inferredBoostReasons": [
                  "stem-match",
                ],
                "lexicalScore": 1.056924,
                "path": "ts/packages/runtime/src/file-search-semantic-refresh.ts",
                "score": 0.021359,
                "semanticScore": 0.06293,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-semantic-refresh.ts:2",
                  "chunkIndex": 2,
                  "path": "ts/packages/runtime/src/file-search-semantic-refresh.ts",
                },
              },
            ],
            "top5ContainsExpectedTop1": true,
          },
          {
            "byomemTop1": "ts/packages/runtime/src/file-search-index.ts",
            "byomemTop5": [
              "ts/packages/runtime/src/file-search-index.ts",
              "ts/packages/runtime/src/file-search-db.ts",
              "docs/semantic-hybrid-document-search-runbook.md",
              "ts/packages/runtime/src/file-search-semantic-refresh.ts",
              "docs/sprint-57-file-search-chonkie-readiness.md",
            ],
            "expectedSembleTop1": "ts/packages/runtime/src/file-search-index.ts",
            "expectedSembleTop5": [
              "ts/packages/runtime/src/file-search-index.ts",
              "docs/semantic-hybrid-document-search-runbook.md",
              "ts/packages/runtime/src/file-search-db.ts",
              "ts/packages/runtime/src/file-search-project-registry.ts",
              "ts/packages/runtime/src/file-search-semantic-refresh.ts",
            ],
            "label": "hot-index-hydration-surface",
            "query": "hot index hydrate ready vectors stale revision",
            "top1MatchesExpected": true,
            "top5": [
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-index.ts:4",
                "chunkIndex": 4,
                "inferredBoostReasons": [
                  "stem-match",
                ],
                "lexicalScore": 10.266955,
                "path": "ts/packages/runtime/src/file-search-index.ts",
                "score": 0.02141,
                "semanticScore": 0.961891,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-index.ts:4",
                  "chunkIndex": 4,
                  "path": "ts/packages/runtime/src/file-search-index.ts",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-db.ts:1",
                "chunkIndex": 1,
                "inferredBoostReasons": [],
                "lexicalScore": 0.555604,
                "path": "ts/packages/runtime/src/file-search-db.ts",
                "score": 0.018667,
                "semanticScore": 0.155929,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-db.ts:1",
                  "chunkIndex": 1,
                  "path": "ts/packages/runtime/src/file-search-db.ts",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "docs/semantic-hybrid-document-search-runbook.md:7",
                "chunkIndex": 7,
                "inferredBoostReasons": [],
                "lexicalScore": 7.561563,
                "path": "docs/semantic-hybrid-document-search-runbook.md",
                "score": 0.018432,
                "semanticScore": 0.610446,
                "tieBreak": {
                  "chunkHash": "docs/semantic-hybrid-document-search-runbook.md:7",
                  "chunkIndex": 7,
                  "path": "docs/semantic-hybrid-document-search-runbook.md",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "ts/packages/runtime/src/file-search-semantic-refresh.ts:2",
                "chunkIndex": 2,
                "inferredBoostReasons": [],
                "lexicalScore": 0.865521,
                "path": "ts/packages/runtime/src/file-search-semantic-refresh.ts",
                "score": 0.017719,
                "semanticScore": 0.110127,
                "tieBreak": {
                  "chunkHash": "ts/packages/runtime/src/file-search-semantic-refresh.ts:2",
                  "chunkIndex": 2,
                  "path": "ts/packages/runtime/src/file-search-semantic-refresh.ts",
                },
              },
              {
                "candidateSource": "bm25+semantic",
                "chunkHash": "docs/sprint-57-file-search-chonkie-readiness.md:6",
                "chunkIndex": 6,
                "inferredBoostReasons": [],
                "lexicalScore": 0.662883,
                "path": "docs/sprint-57-file-search-chonkie-readiness.md",
                "score": 0.017072,
                "semanticScore": 0.022485,
                "tieBreak": {
                  "chunkHash": "docs/sprint-57-file-search-chonkie-readiness.md:6",
                  "chunkIndex": 6,
                  "path": "docs/sprint-57-file-search-chonkie-readiness.md",
                },
              },
            ],
            "top5ContainsExpectedTop1": true,
          },
        ],
        "summary": {
          "queryCount": 5,
          "top1Matches": 5,
          "top5ContainsExpectedTop1": 5,
        },
      }
    `);
    expect(stableReport.summary).toEqual({
      queryCount: 5,
      top1Matches: 5,
      top5ContainsExpectedTop1: 5,
    });
  });
});
