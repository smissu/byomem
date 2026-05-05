import { describe, expect, it } from 'vitest';
import { candidateScoreMap, chunkKey, rerankTopK, type FileSearchChunkRow } from '../src/file-search-semble.js';

function chunk(filePath: string, chunkIndex: number): FileSearchChunkRow {
  const content = `export const chunk_${chunkIndex} = '${filePath}';\n`;
  return {
    projectKey: 'byomem-sprint-58',
    filePath,
    content,
    startLine: 1,
    endLine: 1,
    chunkIndex,
    chunkHash: `${filePath}:${chunkIndex}`,
    language: 'typescript',
  };
}

function rankEqualScores(rows: FileSearchChunkRow[], query = 'refresh active poller status') {
  const chunks = candidateScoreMap(rows);
  const boostedScores = new Map(rows.map((row) => [chunkKey(row), 5]));
  return rerankTopK(boostedScores, chunks, rows.length, false, query).map(({ chunk, score }) => ({
    score,
    filePath: chunk.filePath,
    chunkIndex: chunk.chunkIndex,
    key: chunkKey(chunk),
  }));
}

describe('Sprint 58 file-search rerank tie-break', () => {
  it('orders equal final scores by file path after score priority', () => {
    const zeta = chunk('src/zeta.ts', 0);
    const alpha = chunk('src/alpha.ts', 0);
    const middle = chunk('src/middle.ts', 0);

    const chunks = candidateScoreMap([zeta, alpha, middle]);
    const boostedScores = new Map<string, number>([
      [chunkKey(zeta), 5],
      [chunkKey(alpha), 5],
      [chunkKey(middle), 4],
    ]);

    const ranked = rerankTopK(boostedScores, chunks, 3, false, 'refresh active poller status').map(({ chunk, score }) => ({
      score,
      filePath: chunk.filePath,
      chunkIndex: chunk.chunkIndex,
      key: chunkKey(chunk),
    }));

    expect(ranked).toEqual([
      { score: 5, filePath: 'src/alpha.ts', chunkIndex: 0, key: chunkKey(alpha) },
      { score: 5, filePath: 'src/zeta.ts', chunkIndex: 0, key: chunkKey(zeta) },
      { score: 4, filePath: 'src/middle.ts', chunkIndex: 0, key: chunkKey(middle) },
    ]);
  });

  it('breaks same-file equal-score ties by chunk index and chunk key', () => {
    const laterChunk = chunk('src/alpha.ts', 2);
    const earlierChunk = chunk('src/alpha.ts', 0);

    const chunks = candidateScoreMap([laterChunk, earlierChunk]);
    const boostedScores = new Map<string, number>([
      [chunkKey(laterChunk), 5],
      [chunkKey(earlierChunk), 5],
    ]);

    const ranked = rerankTopK(boostedScores, chunks, 1, false, 'refresh active poller status').map(({ chunk, score }) => ({
      score,
      filePath: chunk.filePath,
      chunkIndex: chunk.chunkIndex,
      key: chunkKey(chunk),
    }));

    expect(ranked).toEqual([
      { score: 5, filePath: 'src/alpha.ts', chunkIndex: 0, key: chunkKey(earlierChunk) },
    ]);
  });

  it('returns identical ordering for repeated identical reranks when equal scores tie', () => {
    const alpha = chunk('src/alpha.ts', 0);
    const beta = chunk('src/beta.ts', 0);
    const gamma = chunk('src/gamma.ts', 0);

    const expected = [
      { score: 5, filePath: 'src/alpha.ts', chunkIndex: 0, key: chunkKey(alpha) },
      { score: 5, filePath: 'src/beta.ts', chunkIndex: 0, key: chunkKey(beta) },
      { score: 5, filePath: 'src/gamma.ts', chunkIndex: 0, key: chunkKey(gamma) },
    ];

    const reruns = [
      [gamma, alpha, beta],
      [beta, gamma, alpha],
      [alpha, beta, gamma],
    ].map((rows) => rankEqualScores(rows));

    expect(reruns).toEqual([expected, expected, expected]);
  });
});
