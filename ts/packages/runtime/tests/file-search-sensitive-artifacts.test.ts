import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsSensitiveFileSearchContent, openFileSearchDb } from '../src/file-search-db.js';
import { searchIndex } from '../src/file-search-query.js';

function tempDir(prefix = 'byomem-sensitive-file-search-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('file-search sensitive runtime artifact safety', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('detects serialized sensitive fields instead of bare marker literals', () => {
    expect(containsSensitiveFileSearchContent(`
      export const thinkingSignature = 'thinkingSignature';
      export const aliases = ['textSignature', 'encrypted_content', 'encryptedContent'];
    `)).toBe(false);
    expect(containsSensitiveFileSearchContent('{"thinkingSignature":"hidden-signature"}')).toBe(true);
    expect(containsSensitiveFileSearchContent('{"encrypted_content":"opaque"}')).toBe(true);
    expect(containsSensitiveFileSearchContent(`const payload = '{"encryptedContent":{"ciphertext":"opaque"}}';`)).toBe(true);
  });

  it('indexes code files containing marker literals while skipping runtime artifacts and serialized support fields', async () => {
    const projectDir = tempDir('byomem-sensitive-project-');
    const runtimeDir = tempDir('byomem-sensitive-runtime-');
    dirs.push(projectDir, runtimeDir);
    writeFileSync(join(projectDir, 'queue.json'), '{"thinkingSignature":"leak"}\n', 'utf8');
    writeFileSync(join(projectDir, 'worker.json'), '{"encrypted_content":"leak"}\n', 'utf8');
    writeFileSync(join(projectDir, 'source.ts'), `
export const thinkingSignature = 'thinkingSignature';
export const aliases = ['textSignature', 'encrypted_content', 'encryptedContent'];

export function markerSummary(): string {
  return aliases.join(' ');
}
`, 'utf8');
    writeFileSync(join(projectDir, 'payload.ts'), `
export const rawPayload = '{"thinkingSignature":"hidden-signature","encrypted_content":"opaque"}';
`, 'utf8');

    const fileDb = openFileSearchDb({ baseDir: projectDir, dbBaseDir: runtimeDir, scanOnOpen: false, schedulerEnabled: false, semanticSearchEnabled: false });
    try {
      const status = fileDb.scanAndIndex({ trigger: 'manual' });
      const indexedPaths = fileDb.db.prepare('SELECT path FROM indexed_files ORDER BY path').all() as Array<{ path: string }>;
      const hits = await searchIndex({ baseDir: projectDir, fileSearchProjectBaseDir: projectDir, fileSearchDb: fileDb } as never, {
        query: 'thinkingSignature encrypted_content',
        mode: 'bm25',
        limit: 5,
      });

      expect(status.progress.ignoredFiles).toBeGreaterThanOrEqual(3);
      expect(indexedPaths.map((row) => row.path)).toEqual([join(projectDir, 'source.ts')]);
      expect(fileDb.db.prepare('SELECT chunk_text FROM indexed_chunks').all()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ chunk_text: expect.stringContaining('hidden-signature') })]),
      );
      expect(hits).toEqual(expect.arrayContaining([
        expect.objectContaining({
          chunk: expect.objectContaining({
            filePath: join(projectDir, 'source.ts'),
            content: expect.stringContaining('encryptedContent'),
          }),
        }),
      ]));
    } finally {
      fileDb.close();
    }
  });

  it('reconciles a previously indexed file out when it later contains sensitive session fields', () => {
    const projectDir = tempDir('byomem-sensitive-reconcile-project-');
    const runtimeDir = tempDir('byomem-sensitive-reconcile-runtime-');
    dirs.push(projectDir, runtimeDir);
    const filePath = join(projectDir, 'capture.ts');
    writeFileSync(filePath, 'export const capture = "initially safe searchable content";\n', 'utf8');

    const fileDb = openFileSearchDb({ baseDir: projectDir, dbBaseDir: runtimeDir, scanOnOpen: false, schedulerEnabled: false, semanticSearchEnabled: false });
    try {
      fileDb.scanAndIndex({ trigger: 'manual' });
      expect(fileDb.db.prepare('SELECT COUNT(*) AS count FROM indexed_files').get()).toMatchObject({ count: 1 });

      writeFileSync(filePath, `export const rawPayload = '{"thinkingSignature":"hidden-signature","encrypted_content":"opaque"}';\n`, 'utf8');
      const status = fileDb.scanAndIndex({ trigger: 'manual' });

      expect(status.progress.deletedFiles).toBe(1);
      expect(fileDb.db.prepare('SELECT COUNT(*) AS count FROM indexed_files').get()).toMatchObject({ count: 0 });
      expect(fileDb.db.prepare('SELECT COUNT(*) AS count FROM indexed_chunks').get()).toMatchObject({ count: 0 });
      expect(fileDb.db.prepare('SELECT reconciliation_state FROM reconciled_files WHERE file_path = ? ORDER BY created_at DESC LIMIT 1').get(filePath)).toMatchObject({ reconciliation_state: 'deleted' });
    } finally {
      fileDb.close();
    }
  });

  it('filters stale indexed rows containing sensitive markers before shaping query results', async () => {
    const projectDir = tempDir('byomem-sensitive-query-project-');
    const runtimeDir = tempDir('byomem-sensitive-query-runtime-');
    dirs.push(projectDir, runtimeDir);
    const filePath = join(projectDir, 'stale.ts');
    writeFileSync(filePath, 'export const staleBody = "ordinary stale searchable content";\n', 'utf8');

    const fileDb = openFileSearchDb({ baseDir: projectDir, dbBaseDir: runtimeDir, scanOnOpen: false, schedulerEnabled: false, semanticSearchEnabled: false });
    try {
      fileDb.scanAndIndex({ trigger: 'manual' });
      const row = fileDb.db.prepare('SELECT id FROM indexed_chunks LIMIT 1').get() as { id: string };
      fileDb.db.prepare('UPDATE indexed_chunks SET chunk_text = ?, search_text = ?, chunk_hash = ? WHERE id = ?')
        .run(
          '{"thinkingSignature":"stale-support","encrypted_content":"opaque"}',
          'stale searchable {"thinkingSignature":"stale-support","encrypted_content":"opaque"}',
          'stale-sensitive-hash',
          row.id,
        );

      const hits = await searchIndex({ baseDir: projectDir, fileSearchProjectBaseDir: projectDir, fileSearchDb: fileDb } as never, {
        query: 'thinkingSignature encrypted_content',
        mode: 'bm25',
        limit: 5,
      });

      expect(hits).toEqual([]);
    } finally {
      fileDb.close();
    }
  });
});
