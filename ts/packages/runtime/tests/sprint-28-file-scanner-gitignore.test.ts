import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';

type FileSearchDbHandle = {
  path: string;
  close: () => void;
  scanAndIndex?: () => void;
  db?: {
    prepare: (sql: string) => {
      all: (...args: unknown[]) => unknown[];
      get: (...args: unknown[]) => unknown;
      run: (...args: unknown[]) => unknown;
    };
  };
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-gitignore-'));
}

function openFileDb(dir: string): FileSearchDbHandle | undefined {
  return (openNativeStore({ baseDir: dir, fileSearchDbBaseDir: dir }) as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;
}

function indexedPaths(fileDb: FileSearchDbHandle | undefined): string[] {
  return (fileDb?.db?.prepare('SELECT path FROM indexed_files ORDER BY path').all() as Array<{ path: string }> | undefined)?.map((row) => row.path) ?? [];
}

function indexedChunks(fileDb: FileSearchDbHandle | undefined): string[] {
  return (fileDb?.db?.prepare('SELECT chunk_text FROM indexed_chunks ORDER BY chunk_text').all() as Array<{ chunk_text: string }> | undefined)?.map((row) => row.chunk_text) ?? [];
}

describe('file scanner honors .gitignore', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('excludes root .gitignore ignored files and directories from indexing', () => {
    const dir = tempDir();
    dirs.push(dir);
    mkdirSync(join(dir, 'ignored-dir'), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), 'ignored-dir/\n*.log\n', 'utf8');
    writeFileSync(join(dir, 'keep.md'), 'keep indexed content\n', 'utf8');
    writeFileSync(join(dir, 'debug.log'), 'ignored log content\n', 'utf8');
    writeFileSync(join(dir, 'ignored-dir', 'secret.txt'), 'ignored secret content\n', 'utf8');

    const fileDb = openFileDb(dir);
    const paths = indexedPaths(fileDb);
    const chunks = indexedChunks(fileDb);

    expect(paths).toEqual(expect.arrayContaining([expect.stringContaining('keep.md')]));
    expect(paths).toEqual(expect.not.arrayContaining([expect.stringContaining('debug.log')]));
    expect(paths).toEqual(expect.not.arrayContaining([expect.stringContaining('secret.txt')]));
    expect(chunks).toEqual(expect.arrayContaining(['keep indexed content']));
    expect(chunks).toEqual(expect.not.arrayContaining(['ignored log content', 'ignored secret content']));
  });

  it('honors .gitignore negation patterns', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, '.gitignore'), '*.md\n!important.md\n', 'utf8');
    writeFileSync(join(dir, 'ignored.md'), 'ignored markdown content\n', 'utf8');
    writeFileSync(join(dir, 'important.md'), 'important markdown content\n', 'utf8');

    const fileDb = openFileDb(dir);
    const paths = indexedPaths(fileDb);

    expect(paths).toEqual(expect.arrayContaining([expect.stringContaining('important.md')]));
    expect(paths).toEqual(expect.not.arrayContaining([expect.stringContaining('ignored.md')]));
  });

  it('applies nested .gitignore rules only within their directory scope', () => {
    const dir = tempDir();
    dirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'root.tmp'), 'root tmp content\n', 'utf8');
    writeFileSync(join(dir, 'src', '.gitignore'), '*.tmp\n', 'utf8');
    writeFileSync(join(dir, 'src', 'generated.tmp'), 'ignored generated tmp content\n', 'utf8');
    writeFileSync(join(dir, 'src', 'keep.txt'), 'nested keep content\n', 'utf8');

    const fileDb = openFileDb(dir);
    const paths = indexedPaths(fileDb);

    expect(paths).toEqual(expect.arrayContaining([expect.stringContaining('root.tmp'), expect.stringContaining('keep.txt')]));
    expect(paths).toEqual(expect.not.arrayContaining([expect.stringContaining('generated.tmp')]));
  });

  it('excludes BYOMem runtime artifacts and raw session support fields from indexing', () => {
    const dir = tempDir();
    dirs.push(dir);
    mkdirSync(join(dir, 'queue', 'debug'), { recursive: true });
    mkdirSync(join(dir, '.byomem'), { recursive: true });
    mkdirSync(join(dir, 'src', 'queue'), { recursive: true });
    writeFileSync(join(dir, 'keep.md'), 'safe searchable body\n', 'utf8');
    writeFileSync(join(dir, 'src', 'queue', 'implementation.txt'), 'legitimate nested queue source\n', 'utf8');
    writeFileSync(join(dir, 'queue.json'), '{"thinkingSignature":"hidden-signature","encrypted_content":"opaque"}\n', 'utf8');
    writeFileSync(join(dir, 'worker.json'), '{"workerId":"worker-alpha"}\n', 'utf8');
    writeFileSync(join(dir, 'queue', 'safe-looking.txt'), 'root queue runtime body should stay private\n', 'utf8');
    writeFileSync(join(dir, 'queue', 'session-capture-state.json'), '{"textSignature":"hidden-text-signature"}\n', 'utf8');
    writeFileSync(join(dir, 'queue', 'debug', 'turn.jsonl'), '{"encrypted_content":"debug-opaque"}\n', 'utf8');
    writeFileSync(join(dir, '.byomem', 'runtime.json'), 'byomem runtime body should stay private\n', 'utf8');
    writeFileSync(join(dir, 'transcript.jsonl'), '{"thinkingSignature":"hidden-support-field"}\n', 'utf8');

    const fileDb = openFileDb(dir);
    const paths = indexedPaths(fileDb);
    const chunks = indexedChunks(fileDb).join('\n');

    expect(paths).toEqual(expect.arrayContaining([expect.stringContaining('keep.md'), expect.stringContaining(join('src', 'queue', 'implementation.txt'))]));
    expect(paths).toEqual(expect.not.arrayContaining([
      expect.stringContaining('queue.json'),
      expect.stringContaining('worker.json'),
      expect.stringContaining(join('queue', 'safe-looking.txt')),
      expect.stringContaining('session-capture-state.json'),
      expect.stringContaining('turn.jsonl'),
      expect.stringContaining('.byomem'),
      expect.stringContaining('transcript.jsonl'),
    ]));
    expect(chunks).toContain('safe searchable body');
    expect(chunks).toContain('legitimate nested queue source');
    expect(chunks).not.toContain('root queue runtime body');
    expect(chunks).not.toContain('byomem runtime body');
    expect(chunks).not.toContain('thinkingSignature');
    expect(chunks).not.toContain('textSignature');
    expect(chunks).not.toContain('encrypted_content');
  });

  it('reconciles files out of the index when their content becomes sensitive', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'public.txt'), 'public body\n', 'utf8');

    const fileDb = openFileDb(dir);
    expect(indexedPaths(fileDb)).toEqual(expect.arrayContaining([expect.stringContaining('public.txt')]));

    writeFileSync(join(dir, 'public.txt'), '{"thinkingSignature":"hidden-support-field"}\n', 'utf8');
    fileDb?.scanAndIndex?.();

    expect(indexedPaths(fileDb)).toEqual(expect.not.arrayContaining([expect.stringContaining('public.txt')]));
    expect(indexedChunks(fileDb).join('\n')).not.toContain('thinkingSignature');
    expect(fileDb?.db?.prepare('SELECT * FROM reconciled_files WHERE file_path LIKE ?').all('%public.txt%')).toEqual(
      expect.arrayContaining([expect.objectContaining({ reconciliation_state: 'deleted' })]),
    );
  });

  it('reconciles newly ignored previously indexed files out of the index on rescan', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'artifact.txt'), 'artifact content\n', 'utf8');

    const fileDb = openFileDb(dir);
    expect(indexedPaths(fileDb)).toEqual(expect.arrayContaining([expect.stringContaining('artifact.txt')]));

    writeFileSync(join(dir, '.gitignore'), 'artifact.txt\n', 'utf8');
    fileDb?.scanAndIndex?.();

    expect(indexedPaths(fileDb)).toEqual(expect.not.arrayContaining([expect.stringContaining('artifact.txt')]));
    expect(indexedChunks(fileDb)).toEqual(expect.not.arrayContaining(['artifact content']));
    expect(fileDb?.db?.prepare('SELECT * FROM reconciled_files WHERE file_path LIKE ?').all('%artifact.txt%')).toEqual(
      expect.arrayContaining([expect.objectContaining({ reconciliation_state: 'deleted' })]),
    );
  });
});
