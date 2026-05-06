import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { containsSensitiveFileSearchContent, isIgnoredFileSearchArtifact } from '../src/file-search-db.js';

describe('Sprint 60 session artifact file-search exclusion', () => {
  it('excludes session-capture runtime artifact paths', () => {
    const baseDir = '/repo';
    expect(isIgnoredFileSearchArtifact(join(baseDir, 'queue.json'), baseDir)).toBe(true);
    expect(isIgnoredFileSearchArtifact(join(baseDir, 'worker.json'), baseDir)).toBe(true);
    expect(isIgnoredFileSearchArtifact(join(baseDir, 'queue', 'session-capture-state.json'), baseDir)).toBe(true);
    expect(isIgnoredFileSearchArtifact(join(baseDir, 'queue', 'debug', 'byomem-turn-end.jsonl'), baseDir)).toBe(true);
    expect(isIgnoredFileSearchArtifact(join(baseDir, 'queue', 'events.jsonl'), baseDir)).toBe(true);
    expect(isIgnoredFileSearchArtifact(join(baseDir, '.byomem', 'runtime.json'), baseDir)).toBe(true);
  });

  it('detects sensitive transcript/signature/encrypted payload markers before indexing content', () => {
    expect(containsSensitiveFileSearchContent('{"thinkingSignature":"hidden"}')).toBe(true);
    expect(containsSensitiveFileSearchContent('{"textSignature":"hidden"}')).toBe(true);
    expect(containsSensitiveFileSearchContent('{"encrypted_content":"opaque"}')).toBe(true);
    expect(containsSensitiveFileSearchContent('{"encryptedContent":{"ciphertext":"opaque"}}')).toBe(true);
    expect(containsSensitiveFileSearchContent('regular implementation note')).toBe(false);
  });
});
