import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
  const command = `node <<'NODE'\nimport { CodeChunker } from '@chonkiejs/core';\nimport { chunkFileContent, chonkieCodeChunkersReady } from ${JSON.stringify(runtimeSourcePath)};\nconst payload = ${payload};\nfunction lineNumberAt(text, index) {\n  return text.slice(0, Math.max(0, index)).split(/\\r?\\n/).length;\n}\nawait chonkieCodeChunkersReady;\nconst oracle = await CodeChunker.create({ language: ${JSON.stringify(TYPESCRIPT_WASM)}, chunkSize: 2048 });\nconst expected = (await oracle.chunk(payload.content)).map((chunk) => ({\n  filePath: payload.filePath,\n  content: chunk.text,\n  startLine: lineNumberAt(payload.content, chunk.startIndex),\n  endLine: lineNumberAt(payload.content, chunk.endIndex),\n  language: 'typescript',\n}));\nconst actual = chunkFileContent(payload.filePath, payload.content).map((chunk) => ({\n  filePath: chunk.filePath,\n  content: chunk.content,\n  startLine: chunk.startLine,\n  endLine: chunk.endLine,\n  language: chunk.language,\n}));\nprocess.stdout.write(JSON.stringify({ expected, actual }));\nNODE`;
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

describe('Sprint 49 chunking parity', () => {
  it('matches Chonkie CodeChunker output for code-aware TypeScript files', () => {
    const content = buildFixture();
    const { expected, actual } = runParityProbe('fixture.ts', content);

    expect(expected.length).toBeGreaterThan(1);
    expect(actual).toEqual(expected);
  });
});
