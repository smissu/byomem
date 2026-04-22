import type { QueueEvent, WriteIntent } from './contracts.js';
import type { NativeStore } from './store.js';
import { openNativeQueue } from './queue.js';
import { openNativeWorker } from './worker.js';
import { openQueueWriter } from './queue-writer.js';
import { normalizeWriteIntent } from './normalizers.js';
import { parseTranscriptLine, toQueueEvent } from './transcript-parser.js';

export interface QueueRuntimeOptions {
  baseDir: string;
}

export interface QueueWriteResult {
  event?: QueueEvent;
  record?: Awaited<ReturnType<ReturnType<typeof openQueueWriter>['write']>>['record'];
}

export interface QueueRuntime {
  capture(line: string, intent: WriteIntent): QueueEvent | undefined;
  replay(event: QueueEvent, intent: WriteIntent): QueueEvent | undefined;
  write(intent: WriteIntent): Promise<QueueWriteResult | undefined>;
  state(): { workerId: string; sessionId: string; offset: number; lock: string | null };
}

export function openQueueRuntime(store: NativeStore, options: QueueRuntimeOptions): QueueRuntime {
  const queue = openNativeQueue(options);
  const worker = openNativeWorker(options);
  const queueWriter = openQueueWriter(store);
  const seen = new Set(queue.list().map((job) => job.jobId));

  async function withLock<T>(lockKey: string, run: (state: ReturnType<typeof worker.readState>) => Promise<T>): Promise<T> {
    const state = worker.acquireLock(lockKey);
    try {
      return await run(state);
    } finally {
      worker.releaseLock();
    }
  }

  return {
    async capture(line: string, intent: WriteIntent): Promise<QueueEvent | undefined> {
      const transcript = parseTranscriptLine(line);
      if (!transcript) return undefined;
      return await withLock(transcript.sessionId, async (state) => {
        worker.advanceOffset(transcript.offset);
        const event = toQueueEvent(transcript);
        if (seen.has(event.eventId)) return event;
        seen.add(event.eventId);
        queue.enqueue(event, state.workerId, transcript.offset, intent);
        queue.checkpoint(event.eventId);
        const provenance = intent.provenance ?? { source: 'native-store' };
        await queueWriter.write({ ...intent, provenance: provenance.origin ? provenance : { ...provenance, origin: event.kind } });
        queue.flush(event.eventId);
        return event;
      });
    },
    async write(intent: WriteIntent): Promise<QueueWriteResult | undefined> {
      const normalized = normalizeWriteIntent(intent);
      return await withLock(normalized.identity.stableKey ?? normalized.identity.leafName, async (state) => {
        const event: QueueEvent = {
          eventId: `${state.workerId}:${state.offset + 1}`,
          sessionId: state.sessionId,
          recordId: normalized.identity.stableKey ?? normalized.identity.leafName,
          kind: 'write',
          createdAt: new Date().toISOString(),
          payload: { offset: state.offset + 1 },
        };
        if (seen.has(event.eventId)) return undefined;
        seen.add(event.eventId);
        worker.advanceOffset(state.offset + 1);
        queue.enqueue(event, state.workerId, state.offset + 1, normalized);
        queue.checkpoint(event.eventId);
        const record = await queueWriter.write({ ...normalized, provenance: { ...(normalized.provenance ?? { source: 'native-store' }), origin: event.kind } });
        queue.flush(event.eventId);
        return { event, record };
      });
    },
    async replay(event: QueueEvent, intent: WriteIntent): Promise<QueueEvent | undefined> {
      const transcriptOffset = Number(event.payload?.offset ?? 0);
      worker.advanceOffset(transcriptOffset);
      if (seen.has(event.eventId)) return undefined;
      seen.add(event.eventId);
      queue.enqueue(event, worker.readState().workerId, transcriptOffset);
      queue.checkpoint(event.eventId);
      const provenance = intent.provenance ?? { source: 'native-store' };
      await queueWriter.write({ ...intent, provenance: provenance.origin ? provenance : { ...provenance, origin: event.kind } });
      queue.flush(event.eventId);
      return event;
    },
    state() {
      return worker.readState();
    },
  };
}
