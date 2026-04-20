import { readFileSync } from 'node:fs';
import type { MemoryRecord, QueueEvent, WriteIntent } from './contracts.js';
import type { NativeStore } from './store.js';
import { openQueueRuntime, type QueueRuntime } from './queue-runtime.js';

export interface SessionCaptureOptions {
  baseDir: string;
}

export interface SessionCaptureResult {
  runtime: QueueRuntime;
  emitted: MemoryRecord[];
}

export interface SessionCaptureInput {
  sessionId: string;
  transcriptPath: string;
  event?: string;
  final?: boolean;
  idle?: boolean;
  agent?: string;
  model?: string;
  messageCount?: number;
  transcriptBytes?: number;
}

export interface SessionCaptureWriteResult {
  checkpoint: QueueEvent[];
  record: MemoryRecord;
}

function deriveLeafName(sessionId: string): string {
  const trimmed = sessionId.trim();
  return trimmed.length ? trimmed : 'session-capture';
}

function buildSessionIntent(input: SessionCaptureInput, transcriptText: string): WriteIntent {
  const lines = transcriptText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    scope: 'project',
    identity: {
      namespace: 'byomem-session',
      leafName: deriveLeafName(input.sessionId),
      parentContext: 'root',
      stableKey: `project:byomem-session:root:${deriveLeafName(input.sessionId)}`,
    },
    content: {
      text: `Session ${input.sessionId} checkpoint from ${input.event ?? 'turn_end'}`,
      structured: {
        sessionId: input.sessionId,
        event: input.event ?? 'turn_end',
        final: input.final ?? false,
        idle: input.idle ?? false,
        agent: input.agent ?? null,
        model: input.model ?? null,
        transcriptPath: input.transcriptPath,
        transcriptBytes: input.transcriptBytes ?? Buffer.byteLength(transcriptText, 'utf8'),
        messageCount: input.messageCount ?? lines.length,
        transcriptPreview: lines.slice(-5),
      },
    },
    provenance: {
      source: 'session-capture',
      adapter: 'native-store',
      origin: 'session-capture',
    },
  };
}

export function openSessionCapture(store: NativeStore, options: SessionCaptureOptions): SessionCaptureResult {
  const emitted: MemoryRecord[] = [];
  const runtime = openQueueRuntime(store, options);

  return { runtime, emitted };
}

export async function emitSessionRecord(store: NativeStore, intent: WriteIntent, event: QueueEvent): Promise<MemoryRecord> {
  const record = await store.write(intent);
  return {
    ...record,
    provenance: { ...record.provenance, origin: event.kind },
  };
}

export async function captureSessionCheckpoint(store: NativeStore, _options: SessionCaptureOptions, input: SessionCaptureInput): Promise<SessionCaptureWriteResult> {
  const transcriptText = readFileSync(input.transcriptPath, 'utf8');
  const record = await store.write(buildSessionIntent(input, transcriptText));
  return { checkpoint: [], record };
}
