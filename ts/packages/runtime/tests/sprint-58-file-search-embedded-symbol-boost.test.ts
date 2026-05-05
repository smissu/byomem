import { describe, expect, it } from 'vitest';
import {
  applyQueryBoost,
  buildSearchResult,
  candidateScoreMap,
  chunkKey,
  rerankTopK,
  type FileSearchChunkRow,
} from '../src/file-search-semble.js';

function chunk(
  filePath: string,
  content: string,
  chunkIndex: number,
  overrides: Partial<FileSearchChunkRow> = {},
): FileSearchChunkRow {
  return {
    projectKey: 'byomem-runtime',
    filePath,
    content,
    startLine: 1,
    endLine: content.split('\n').length,
    chunkIndex,
    chunkHash: `${filePath}:${chunkIndex}`,
    language: 'typescript',
    ...overrides,
  };
}

describe('Sprint 58 embedded symbol boost RED tests', () => {
  it('ignores embedded symbol boosts for candidate rows that only reference the symbol', () => {
    const referenceOnly = chunk(
      'src/refreshSemanticIndex.ts',
      [
        'const invokeRefresh = () => refreshSemanticIndex();',
        'export function scheduleRefresh() {',
        '  return invokeRefresh();',
        '}',
      ].join('\n'),
      0,
    );
    const bystander = chunk('src/fileSearchIndex.ts', 'export function hydrateIndex() { return true; }\n', 1);
    const rows = candidateScoreMap([referenceOnly, bystander]);
    const baseScores = new Map<string, number>([
      [chunkKey(referenceOnly), 0.4],
      [chunkKey(bystander), 0.2],
    ]);

    const boosted = applyQueryBoost(baseScores, 'why refreshSemanticIndex stalls', rows);

    expect(boosted.get(chunkKey(referenceOnly))).toBeCloseTo(0.4, 6);
  });

  it('keeps the definition-tier embedded symbol boost for matching definitions', () => {
    const definition = chunk(
      'src/refreshSemanticIndex.ts',
      [
        'export async function refreshSemanticIndex() {',
        '  return true;',
        '}',
      ].join('\n'),
      0,
    );
    const bystander = chunk('src/fileSearchIndex.ts', 'export function hydrateIndex() { return true; }\n', 1);
    const rows = candidateScoreMap([definition, bystander]);
    const baseScores = new Map<string, number>([
      [chunkKey(definition), 0.4],
      [chunkKey(bystander), 0.2],
    ]);

    const boosted = applyQueryBoost(baseScores, 'why refreshSemanticIndex stalls', rows);

    expect(boosted.get(chunkKey(definition))).toBeCloseTo(1.3, 6);
  });

  it('keeps boosted scores observable through the result payload without exposing more than the redacted snippet', () => {
    const definition = chunk(
      'src/refreshSemanticIndex.ts',
      [
        'const refreshSecret = "top-secret-token";',
        'export async function refreshSemanticIndex() {',
        '  return refreshSecret;',
        '}',
      ].join('\n'),
      0,
      { lexicalScore: 0.31, semanticScore: 0.72 },
    );
    const rows = candidateScoreMap([definition]);
    const baseScores = new Map<string, number>([[chunkKey(definition), 0.4]]);
    const boosted = applyQueryBoost(baseScores, 'why refreshSemanticIndex stalls', rows);
    const ranked = rerankTopK(boosted, rows, 1, false, 'why refreshSemanticIndex stalls');
    const result = buildSearchResult({ ...definition, score: ranked[0]!.score }, 'hybrid', () => '[redacted snippet]');

    expect(result.score).toBeCloseTo(ranked[0]!.score, 6);
    expect(result.file?.lexicalScore).toBe(0.31);
    expect(result.file?.semanticScore).toBe(0.72);
    expect(result.chunk.content).toBe('[redacted snippet]');
    expect(result.file?.chunkText).toBe('[redacted snippet]');
    expect(result.chunk.content).not.toContain('top-secret-token');
    expect(result.file?.chunkText).not.toContain('top-secret-token');
  });
});
