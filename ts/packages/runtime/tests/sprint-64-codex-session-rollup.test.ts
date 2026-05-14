import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { openNativeStore } from '../src/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-s64-rollup-'));
}

function writeConfig(path: string): void {
  writeFileSync(path, [
    'session_capture:',
    '  enabled: true',
    '  threshold_turns: 3',
    '  min_turns: 2',
    'embeddings:',
    '  model: minishlab/potion-code-16M',
    '  dimension: 256',
  ].join('\n'), 'utf8');
}

function writeTranscript(path: string): void {
  writeFileSync(path, [
    JSON.stringify({ id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'Implement Codex Stop capture' }], encrypted_content: 'must-not-store' }),
    JSON.stringify({ id: 'a1', parentId: 'u1', role: 'assistant', content: [{ type: 'output_text', text: 'Added codex-session-capture plan.' }], thinkingSignature: 'must-not-store' }),
  ].join('\n'), 'utf8');
}

function writeHook(path: string, transcriptPath: string): void {
  writeFileSync(path, JSON.stringify({
    cwd: '/Users/example/Documents/byomem',
    hook_event_name: 'Stop',
    last_assistant_message: 'done',
    model: 'gpt-5.4',
    permission_mode: 'default',
    session_id: 'codex-session-alpha',
    stop_hook_active: false,
    transcript_path: transcriptPath,
    turn_id: 'turn-alpha',
  }), 'utf8');
}

function rollups(runtimeDir: string) {
  const store = openNativeStore({ baseDir: runtimeDir });
  try {
    return store.list().filter((record) => record.identity.namespace === 'byomem-session');
  } finally {
    store.close();
  }
}

describe('Sprint 64 Codex session rollup', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;
  const originalConfigPath = process.env.BYOMEM_CONFIG_PATH;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    if (originalConfigPath === undefined) delete process.env.BYOMEM_CONFIG_PATH;
    else process.env.BYOMEM_CONFIG_PATH = originalConfigPath;
    process.exitCode = undefined;
  });

  it('writes exactly one compact project byomem-session rollup on final Stop capture', async () => {
    const runtimeDir = tempDir();
    const transcriptDir = tempDir();
    dirs.push(runtimeDir, transcriptDir);
    const configPath = join(runtimeDir, 'config.yaml');
    const transcriptPath = join(transcriptDir, 'codex.jsonl');
    const hookPath = join(transcriptDir, 'hook.json');
    writeConfig(configPath);
    writeTranscript(transcriptPath);
    writeHook(hookPath, transcriptPath);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    process.env.BYOMEM_CONFIG_PATH = configPath;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['codex-session-capture', '--input', hookPath]);

    const output = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(output).toMatchObject({ captured: true, skipped: false, reason: 'final', sessionId: 'codex-session-alpha' });
    const records = rollups(runtimeDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      scope: 'project',
      identity: { namespace: 'byomem-session', parentContext: 'root' },
      content: {
        structured: {
          kind: 'rollup',
          sessionId: 'codex-session-alpha',
          flushReason: 'final',
          sourceStableKey: 'project:byomem-session:root:codex-session-alpha',
        },
      },
    });
    expect(Object.keys((records[0]?.content.structured ?? {}) as Record<string, unknown>)).toEqual(['kind', 'sessionId', 'flushReason', 'sourceStableKey']);
    expect(JSON.stringify(records[0])).not.toContain('encrypted_content');
    expect(JSON.stringify(records[0])).not.toContain('thinkingSignature');
    expect(existsSync(join(runtimeDir, 'native-store.json'))).toBe(false);
  });

  it('is idempotent for the same transcript offset', async () => {
    const runtimeDir = tempDir();
    const transcriptDir = tempDir();
    dirs.push(runtimeDir, transcriptDir);
    const configPath = join(runtimeDir, 'config.yaml');
    const transcriptPath = join(transcriptDir, 'codex.jsonl');
    const hookPath = join(transcriptDir, 'hook.json');
    writeConfig(configPath);
    writeTranscript(transcriptPath);
    writeHook(hookPath, transcriptPath);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    process.env.BYOMEM_CONFIG_PATH = configPath;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['codex-session-capture', '--input', hookPath]);
    await main(['codex-session-capture', '--input', hookPath]);

    const output = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(output).toMatchObject({ captured: false, skipped: true, reason: 'no-pending-turns' });
    expect(rollups(runtimeDir)).toHaveLength(1);
  });
});
