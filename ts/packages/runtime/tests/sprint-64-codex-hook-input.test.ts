import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { codexHookToSessionCaptureInput, normalizeCodexStopHookInput, runCodexSessionCaptureCommand } from '../src/codex-session-capture.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-s64-hook-'));
}

function writeConfig(path: string, enabled: boolean, rawArchiveEnabled = false): void {
  writeFileSync(path, [
    'session_capture:',
    `  enabled: ${enabled ? 'true' : 'false'}`,
    '  threshold_turns: 2',
    '  min_turns: 2',
    `  raw_archive_enabled: ${rawArchiveEnabled ? 'true' : 'false'}`,
    'embeddings:',
    '  model: minishlab/potion-code-16M',
    '  dimension: 256',
  ].join('\n'), 'utf8');
}

function writeTranscript(path: string): void {
  writeFileSync(path, [
    JSON.stringify({ id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'capture this' }] }),
    JSON.stringify({ id: 'a1', parentId: 'u1', role: 'assistant', content: [{ type: 'output_text', text: 'captured response' }] }),
  ].join('\n'), 'utf8');
}

function hookPayload(transcriptPath: string, overrides: Record<string, unknown> = {}) {
  return {
    cwd: '/Users/example/Documents/byomem',
    hook_event_name: 'Stop',
    last_assistant_message: 'done',
    model: 'gpt-5.4',
    permission_mode: 'default',
    session_id: 'codex-session-alpha',
    stop_hook_active: false,
    transcript_path: transcriptPath,
    turn_id: 'turn-alpha',
    ...overrides,
  };
}

describe('Sprint 64 Codex hook input', () => {
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

  it('maps valid Stop hook JSON to final SessionCaptureInput', () => {
    const normalized = normalizeCodexStopHookInput(hookPayload('/tmp/transcript.jsonl'));
    expect(normalized).toMatchObject({ hook_event_name: 'Stop', session_id: 'codex-session-alpha', transcript_path: '/tmp/transcript.jsonl' });
    expect(codexHookToSessionCaptureInput(normalized as never)).toEqual({
      sessionId: 'codex-session-alpha',
      transcriptPath: '/tmp/transcript.jsonl',
      event: 'codex_stop',
      final: true,
      idle: false,
      agent: 'codex',
      model: 'gpt-5.4',
    });
  });

  it('soft-skips unsupported hook events and missing transcript paths', async () => {
    const unsupported = await runCodexSessionCaptureCommand({ input: JSON.stringify(hookPayload('/tmp/transcript.jsonl', { hook_event_name: 'UserPromptSubmit' })) });
    expect(unsupported).toMatchObject({ captured: false, skipped: true, reason: 'unsupported-hook-event' });

    const missingTranscript = await runCodexSessionCaptureCommand({ input: JSON.stringify(hookPayload('/tmp/transcript.jsonl', { transcript_path: null })) });
    expect(missingTranscript).toMatchObject({ captured: false, skipped: true, reason: 'missing-transcript-path' });
  });

  it('uses configured runtime base dir and skips cleanly when disabled', async () => {
    const runtimeDir = tempDir();
    const transcriptDir = tempDir();
    dirs.push(runtimeDir, transcriptDir);
    const configPath = join(runtimeDir, 'config.yaml');
    const transcriptPath = join(transcriptDir, 'codex.jsonl');
    writeConfig(configPath, false);
    writeTranscript(transcriptPath);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    process.env.BYOMEM_CONFIG_PATH = configPath;

    const result = await runCodexSessionCaptureCommand({ input: JSON.stringify(hookPayload(transcriptPath)) });

    expect(result).toMatchObject({ captured: false, skipped: true, reason: 'session-capture-disabled' });
    expect(existsSync(join(runtimeDir, 'byomem-index.sqlite'))).toBe(false);
  });

  it('CLI command accepts --input file and writes hook-safe JSON status', async () => {
    const runtimeDir = tempDir();
    const transcriptDir = tempDir();
    dirs.push(runtimeDir, transcriptDir);
    const configPath = join(runtimeDir, 'config.yaml');
    const transcriptPath = join(transcriptDir, 'codex.jsonl');
    const inputPath = join(transcriptDir, 'hook.json');
    writeConfig(configPath, false);
    writeTranscript(transcriptPath);
    writeFileSync(inputPath, JSON.stringify(hookPayload(transcriptPath)), 'utf8');
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    process.env.BYOMEM_CONFIG_PATH = configPath;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['codex-session-capture', '--input', inputPath]);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      captured: false,
      skipped: true,
      reason: 'session-capture-disabled',
      sessionId: 'codex-session-alpha',
    });
  });

  it('CLI command treats raw --input JSON as a payload for fixture-friendly tests', async () => {
    const runtimeDir = tempDir();
    const transcriptDir = tempDir();
    dirs.push(runtimeDir, transcriptDir);
    const configPath = join(runtimeDir, 'config.yaml');
    const transcriptPath = join(transcriptDir, 'codex.jsonl');
    writeConfig(configPath, false);
    writeTranscript(transcriptPath);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    process.env.BYOMEM_CONFIG_PATH = configPath;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['codex-session-capture', '--input', JSON.stringify(hookPayload(transcriptPath))]);

    const output = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(output.reason).toBe('session-capture-disabled');
    expect(readFileSync(configPath, 'utf8')).toContain('enabled: false');
  });

  it('soft-skips store open failures with hook-safe JSON', async () => {
    const configDir = tempDir();
    const transcriptDir = tempDir();
    dirs.push(configDir, transcriptDir);
    const runtimePath = join(configDir, 'runtime-is-a-file');
    const configPath = join(configDir, 'config.yaml');
    const transcriptPath = join(transcriptDir, 'codex.jsonl');
    writeConfig(configPath, true);
    writeFileSync(runtimePath, 'not a directory', 'utf8');
    writeTranscript(transcriptPath);
    process.env.BYOMEM_CONFIG_PATH = configPath;

    const result = await runCodexSessionCaptureCommand({
      input: JSON.stringify(hookPayload(transcriptPath)),
      runtimeBaseDir: runtimePath,
    });

    expect(result).toMatchObject({
      captured: false,
      skipped: true,
      reason: 'capture-failed',
      sessionId: 'codex-session-alpha',
    });
    expect(result.error).toBeTruthy();
  });

  it('honors raw_archive_enabled config through the Codex capture command', async () => {
    const runtimeDir = tempDir();
    const transcriptDir = tempDir();
    dirs.push(runtimeDir, transcriptDir);
    const configPath = join(runtimeDir, 'config.yaml');
    const transcriptPath = join(transcriptDir, 'codex.jsonl');
    writeConfig(configPath, true, true);
    writeTranscript(transcriptPath);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    process.env.BYOMEM_CONFIG_PATH = configPath;

    const result = await runCodexSessionCaptureCommand({ input: JSON.stringify(hookPayload(transcriptPath)) });

    expect(result).toMatchObject({ captured: true, skipped: false, reason: 'final' });
    expect(result.rawArchivePath).toContain(join(runtimeDir, 'queue', 'session-archive'));
    expect(readFileSync(result.rawArchivePath!, 'utf8')).toContain('session-capture-raw-archive-v1');
  });
});
