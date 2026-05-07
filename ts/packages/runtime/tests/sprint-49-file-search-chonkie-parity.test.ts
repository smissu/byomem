import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const runtimeSourcePath = fileURLToPath(new URL('../src/file-search-semble.ts', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const TYPESCRIPT_WASM = fileURLToPath(new URL('../../../../node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm', import.meta.url));

type ChunkSummary = {
  content: string;
  startLine: number;
  endLine: number;
  filePath?: string;
  language?: string;
};

function buildFixture(): string {
  const payload = 'x'.repeat(700);
  return `export function alpha() {
  const payload = '${payload}';
  return payload.length;
}

export function beta() {
  const payload = '${payload}';
  return payload.length;
}

export function gamma() {
  const payload = '${payload}';
  return payload.length;
}

export function delta() {
  const payload = '${payload}';
  return payload.length;
}
`;
}

function runParityProbe(filePath: string, content: string): { expected: ChunkSummary[]; actual: ChunkSummary[] } {
  const payload = JSON.stringify({ filePath, content });
  const command = `node <<'NODE'\nimport { CodeChunker } from '@chonkiejs/core';\nimport { chunkFileContent, chonkieCodeChunkersReady } from ${JSON.stringify(runtimeSourcePath)};\nconst payload = ${payload};\nfunction lineNumberAt(text, index) {\n  return text.slice(0, Math.max(0, index)).split(/\\r?\\n/).length;\n}\nawait chonkieCodeChunkersReady;\nconst oracle = await CodeChunker.create({ language: ${JSON.stringify(TYPESCRIPT_WASM)}, chunkSize: 2048 });\nconst expected = (await oracle.chunk(payload.content)).map((chunk) => ({\n  filePath: payload.filePath,\n  content: chunk.text,\n  startLine: lineNumberAt(payload.content, chunk.startIndex),\n  endLine: lineNumberAt(payload.content, Math.max(chunk.startIndex, chunk.endIndex - 1)),\n  language: 'typescript',\n}));\nconst actual = chunkFileContent(payload.filePath, payload.content).map((chunk) => ({\n  filePath: chunk.filePath,\n  content: chunk.content,\n  startLine: chunk.startLine,\n  endLine: chunk.endLine,\n  language: chunk.language,\n}));\nprocess.stdout.write(JSON.stringify({ expected, actual }));\nNODE`;
  const stdout = execFileSync('/bin/bash', ['-lc', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PWD: repoRoot,
    },
  });
  return JSON.parse(stdout) as { expected: ChunkSummary[]; actual: ChunkSummary[] };
}

function runProjectCwdProbe(projectDir: string, filePath: string, content: string): { source?: string; fallbackReason?: string | null; count: number } {
  const payload = JSON.stringify({ projectDir, filePath, content });
  const command = `node <<'NODE'\nconst payload = ${payload};\nprocess.chdir(payload.projectDir);\nconst { chunkFileContentReady } = await import(${JSON.stringify(runtimeSourcePath)});\nconst result = await chunkFileContentReady(payload.filePath, payload.content);\nprocess.stdout.write(JSON.stringify({\n  source: result.chunker.source,\n  fallbackReason: result.chunker.fallbackReason,\n  count: result.chunks.length,\n}));\nNODE`;
  const stdout = execFileSync('/bin/bash', ['-lc', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PWD: repoRoot,
    },
  });
  return JSON.parse(stdout) as { source?: string; fallbackReason?: string | null; count: number };
}

describe('Sprint 49 chunking parity', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('matches Chonkie CodeChunker output for code-aware TypeScript files', () => {
    const content = buildFixture();
    const { expected, actual } = runParityProbe('fixture.ts', content);

    expect(expected.length).toBeGreaterThan(1);
    expect(actual).toEqual(expected);
  });

  it('uses runtime-local Chonkie WASM when imported from another active project cwd', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'byomem-s49-project-cwd-'));
    dirs.push(projectDir);

    const result = runProjectCwdProbe(projectDir, 'fixture.ts', buildFixture());

    expect(result).toEqual({
      source: 'chonkie',
      fallbackReason: null,
      count: 2,
    });
  });
});
