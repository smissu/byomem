import { describe, expect, it } from 'vitest';
import { applyQueryBoost, candidateScoreMap, chunkKey, resolveAlpha, rerankTopK, type FileSearchChunkRow } from '../src/file-search-semble.js';

function chunk(filePath: string, content: string, chunkIndex: number): FileSearchChunkRow {
  return {
    projectKey: 'fastapi-bench',
    filePath,
    content,
    startLine: 1,
    endLine: content.split('\n').length,
    chunkIndex,
    chunkHash: `${filePath}:${chunkIndex}`,
    language: filePath.endsWith('.py') ? 'python' : 'markdown',
  };
}

describe('Sprint 51 file-search rank parity', () => {
  it('matches Semble-style alpha weights for symbol and natural-language queries', () => {
    expect(resolveAlpha('Depends', undefined)).toBe(0.3);
    expect(resolveAlpha('fastapi.Depends', undefined)).toBe(0.3);
    expect(resolveAlpha('how are routes registered', undefined)).toBe(0.5);
  });

  it('keeps bare symbol queries code-first after query boosts and reranking', () => {
    const code = chunk(
      'fastapi/param_functions.py',
      'class Depends:\n    pass\n\n\ndef dependency_provider():\n    return Depends()\n',
      0,
    );
    const code2 = chunk(
      'fastapi/dependencies/utils.py',
      'class Depends:\n    pass\n\n\ndef get_depends():\n    return Depends()\n',
      1,
    );
    const docs = chunk(
      'docs/de/docs/advanced/wsgi.md',
      'Depends Depends Depends Depends Depends\nThis docs page repeats Depends many times.\n',
      2,
    );
    const tests = chunk(
      'tests/test_dependency_overrides.py',
      'from fastapi import Depends\n\n\ndef test_dependency_overrides():\n    assert Depends is not None\n',
      3,
    );

    const chunks = candidateScoreMap([code, code2, docs, tests]);
    const scores = new Map<string, number>([
      [chunkKey(code), 0.2],
      [chunkKey(code2), 0.18],
      [chunkKey(docs), 1.0],
      [chunkKey(tests), 0.4],
    ]);

    const boosted = applyQueryBoost(scores, 'Depends', chunks);
    const ranked = rerankTopK(boosted, chunks, 4, true, 'Depends');

    expect(ranked).not.toHaveLength(0);
    expect(ranked[0]?.chunk.filePath).toMatch(/fastapi\/(param_functions|dependencies\/utils)\.py$/);
    expect(ranked[0]?.chunk.filePath).not.toContain('/docs/');
  });
});
