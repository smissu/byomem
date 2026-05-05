import { describe, expect, it } from 'vitest';
import * as queryModule from '../src/file-search-query.js';
import * as indexModule from '../src/file-search-index.js';

describe('Sprint 54 file-search legacy retirement', () => {
  it('keeps the public query module thin and exposes the new index abstraction instead of the old hot-path helpers', () => {
    expect(queryModule.searchIndex).toBeTypeOf('function');
    expect(queryModule.findRelated).toBeTypeOf('function');
    expect(queryModule.buildSearchSemanticMetadata).toBeTypeOf('function');
    expect(queryModule).not.toHaveProperty('queryLexicalBm25');
    expect(queryModule).not.toHaveProperty('querySemantic');
    expect(queryModule).not.toHaveProperty('blendHits');
    expect(queryModule).not.toHaveProperty('loadAllChunks');

    expect(indexModule.FileSearchIndexBuilder).toBeTypeOf('function');
    expect(indexModule.FileSearchIndex).toBeTypeOf('function');
    expect(indexModule.buildFileSearchIndex).toBeTypeOf('function');
  });
});
