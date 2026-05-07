import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureSessionCheckpoint } from '../src/session-capture.js';
import { openNativeStore } from '../src/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-s64-archive-'));
}

function writeTranscript(path: string): void {
  writeFileSync(path, [
    JSON.stringify({ id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'Keep this user text' }], encrypted_content: 'archive-secret' }),
    JSON.stringify({ id: 'a1', parentId: 'u1', role: 'assistant', content: [{ type: 'output_text', text: 'Keep this assistant text' }], thinkingSignature: 'archive-signature', reasoning: 'private archive reasoning' }),
  ].join('\n'), 'utf8');
}

describe('Sprint 64 sanitized raw archive', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('is disabled by default and does not create archive artifacts', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'codex.jsonl');
    writeTranscript(transcriptPath);
    const store = openNativeStore({ baseDir: dir });

    const result = await captureSessionCheckpoint(store, { baseDir: dir }, {
      sessionId: 'codex-session-alpha',
      transcriptPath,
      event: 'codex_stop',
      final: true,
      idle: false,
    });

    expect(result.rollup?.record).toBeTruthy();
    expect(result.rawArchive).toBeUndefined();
    expect(existsSync(join(dir, 'queue', 'session-archive'))).toBe(false);
  });

  it('stores sanitized visible conversation text outside canonical memory when enabled', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'codex.jsonl');
    writeTranscript(transcriptPath);
    const store = openNativeStore({ baseDir: dir });

    const result = await captureSessionCheckpoint(store, {
      baseDir: dir,
      rawArchive: { enabled: true },
    }, {
      sessionId: 'codex-session-alpha',
      transcriptPath,
      event: 'codex_stop',
      final: true,
      idle: false,
    });

    expect(result.rawArchive?.path).toContain(join(dir, 'queue', 'session-archive'));
    const archive = JSON.parse(readFileSync(result.rawArchive!.path, 'utf8')) as { version: string; turns: Array<{ user: string; assistant: string }> };
    expect(archive.version).toBe('session-capture-raw-archive-v1');
    expect(archive.turns).toEqual([{ id: 'u1', timestamp: '', user: 'Keep this user text', assistant: 'Keep this assistant text' }]);
    const archiveText = JSON.stringify(archive);
    expect(archiveText).not.toContain('encrypted_content');
    expect(archiveText).not.toContain('archive-secret');
    expect(archiveText).not.toContain('thinkingSignature');
    expect(archiveText).not.toContain('archive-signature');
    expect(archiveText).not.toContain('private archive reasoning');
    expect(store.list()).toHaveLength(1);
    expect(JSON.stringify(store.list())).not.toContain('session-capture-raw-archive-v1');
  });

  it('confines archive files to queue/session-archive for unsafe session ids', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'codex.jsonl');
    writeTranscript(transcriptPath);
    const store = openNativeStore({ baseDir: dir });
    const archiveDir = join(dir, 'queue', 'session-archive');

    const result = await captureSessionCheckpoint(store, {
      baseDir: dir,
      rawArchive: { enabled: true },
    }, {
      sessionId: '/tmp/../outside/session',
      transcriptPath,
      event: 'codex_stop',
      final: true,
      idle: false,
    });

    expect(dirname(result.rawArchive!.path)).toBe(archiveDir);
    expect(result.rawArchive!.path).not.toContain('/outside/session');
    expect(existsSync(result.rawArchive!.path)).toBe(true);
  });
});
