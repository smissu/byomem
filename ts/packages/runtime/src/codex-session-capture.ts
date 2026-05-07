import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { captureSessionCheckpoint, type SessionCaptureInput, type SessionCaptureWriteResult } from './session-capture.js';
import { resolveDefaultRuntimeBaseDir, resolveEmbeddingConfig, resolveSessionCaptureConfig, resolveSummarizerConfig } from './readonly-core.js';
import { openNativeStore } from './store.js';

export interface CodexStopHookInput {
  cwd: string;
  hook_event_name: string;
  last_assistant_message: string | null;
  model: string;
  permission_mode: string;
  session_id: string;
  stop_hook_active: boolean;
  transcript_path: string | null;
  turn_id: string;
}

export interface CodexSessionCaptureCommandOptions {
  input?: string;
  runtimeBaseDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CodexSessionCaptureCommandResult {
  captured: boolean;
  skipped: boolean;
  reason: string;
  sessionId?: string;
  turnId?: string;
  transcriptPath?: string;
  checkpointOffset?: number;
  pendingTurns?: number;
  rollupId?: string;
  rawArchivePath?: string;
  error?: string;
}

function parseHookPayload(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

function readPayload(options: CodexSessionCaptureCommandOptions): string {
  if (options.input !== undefined) {
    const maybePath = resolve(options.input);
    if (existsSync(maybePath)) return readFileSync(maybePath, 'utf8');
    return options.input;
  }
  return readFileSync(0, 'utf8');
}

export function normalizeCodexStopHookInput(payload: Record<string, unknown>): CodexStopHookInput | { reason: string; sessionId?: string; turnId?: string; transcriptPath?: string } {
  const eventName = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : undefined;
  const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim() ? payload.session_id : undefined;
  const turnId = typeof payload.turn_id === 'string' && payload.turn_id.trim() ? payload.turn_id : undefined;
  const transcriptPath = typeof payload.transcript_path === 'string' && payload.transcript_path.trim() ? payload.transcript_path : undefined;
  if (eventName !== 'Stop') return { reason: 'unsupported-hook-event', sessionId, turnId, transcriptPath };
  if (!sessionId) return { reason: 'missing-session-id', turnId, transcriptPath };
  if (!transcriptPath) return { reason: 'missing-transcript-path', sessionId, turnId };
  return {
    cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
    hook_event_name: 'Stop',
    last_assistant_message: typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : null,
    model: typeof payload.model === 'string' ? payload.model : '',
    permission_mode: typeof payload.permission_mode === 'string' ? payload.permission_mode : '',
    session_id: sessionId,
    stop_hook_active: typeof payload.stop_hook_active === 'boolean' ? payload.stop_hook_active : false,
    transcript_path: transcriptPath,
    turn_id: turnId ?? '',
  };
}

export function codexHookToSessionCaptureInput(input: CodexStopHookInput): SessionCaptureInput {
  return {
    sessionId: input.session_id,
    transcriptPath: input.transcript_path!,
    event: 'codex_stop',
    final: true,
    idle: false,
    agent: 'codex',
    model: input.model || undefined,
  };
}

function resultFromCapture(input: CodexStopHookInput, result: SessionCaptureWriteResult): CodexSessionCaptureCommandResult {
  return {
    captured: Boolean(result.rollup?.record),
    skipped: !result.rollup?.record,
    reason: result.reason,
    sessionId: input.session_id,
    turnId: input.turn_id,
    transcriptPath: input.transcript_path ?? undefined,
    checkpointOffset: result.checkpointOffset,
    pendingTurns: result.pendingTurns,
    rollupId: result.rollup?.record?.id,
    rawArchivePath: result.rawArchive?.path,
  };
}

export async function runCodexSessionCaptureCommand(options: CodexSessionCaptureCommandOptions = {}): Promise<CodexSessionCaptureCommandResult> {
  let payload: Record<string, unknown>;
  try {
    payload = parseHookPayload(readPayload(options));
  } catch (error) {
    return { captured: false, skipped: true, reason: 'invalid-hook-json', error: error instanceof Error ? error.message : String(error) };
  }

  const normalized = normalizeCodexStopHookInput(payload);
  if ('reason' in normalized) {
    return {
      captured: false,
      skipped: true,
      reason: normalized.reason,
      sessionId: normalized.sessionId,
      turnId: normalized.turnId,
      transcriptPath: normalized.transcriptPath,
    };
  }

  if (!existsSync(normalized.transcript_path!)) {
    return {
      captured: false,
      skipped: true,
      reason: 'unreadable-transcript',
      sessionId: normalized.session_id,
      turnId: normalized.turn_id,
      transcriptPath: normalized.transcript_path ?? undefined,
    };
  }

  const env = options.env ?? process.env;
  let store: ReturnType<typeof openNativeStore> | undefined;
  try {
    const runtimeBaseDir = options.runtimeBaseDir ?? resolveDefaultRuntimeBaseDir(env);
    const sessionCaptureConfig = resolveSessionCaptureConfig(env);
    if (!sessionCaptureConfig.enabled) {
      return {
        captured: false,
        skipped: true,
        reason: 'session-capture-disabled',
        sessionId: normalized.session_id,
        turnId: normalized.turn_id,
        transcriptPath: normalized.transcript_path ?? undefined,
      };
    }
    const embeddingConfig = resolveEmbeddingConfig(env);
    const summarizerConfig = resolveSummarizerConfig(env);
    store = openNativeStore({
      baseDir: runtimeBaseDir,
      embeddingBaseUrl: embeddingConfig.embeddingBaseUrl,
      embeddingModel: embeddingConfig.embeddingModel,
      embeddingDimension: embeddingConfig.embeddingDimension,
      embeddingTimeoutMs: embeddingConfig.embeddingTimeoutMs,
      embeddingRequireRemote: Boolean(embeddingConfig.embeddingBaseUrl),
      fileSearchScanOnOpen: false,
    });
    const result = await captureSessionCheckpoint(store, {
      baseDir: runtimeBaseDir,
      thresholdTurns: sessionCaptureConfig.thresholdTurns,
      largeTurnChars: sessionCaptureConfig.largeTurnChars,
      idleFlushSeconds: sessionCaptureConfig.idleFlushSeconds,
      minTurns: sessionCaptureConfig.minTurns,
      generation: {
        baseUrl: summarizerConfig.generationBaseUrl,
        model: summarizerConfig.generationModel,
        fallbackModel: summarizerConfig.generationFallbackModel,
        timeoutMs: summarizerConfig.generationTimeoutMs,
        transport: summarizerConfig.generationTransport,
        requestOptions: summarizerConfig.ollamaNumCtx ? { options: { num_ctx: summarizerConfig.ollamaNumCtx } } : undefined,
      },
      rawArchive: { enabled: sessionCaptureConfig.rawArchiveEnabled },
    }, codexHookToSessionCaptureInput(normalized));
    return resultFromCapture(normalized, result);
  } catch (error) {
    return {
      captured: false,
      skipped: true,
      reason: 'capture-failed',
      sessionId: normalized.session_id,
      turnId: normalized.turn_id,
      transcriptPath: normalized.transcript_path ?? undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    store?.close();
  }
}
