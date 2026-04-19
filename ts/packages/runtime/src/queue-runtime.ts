import type { QueueEvent, WriteIntent } from './contracts.js';
import type { NativeStore } from './store.js';
import { openNativeQueue } from './queue.js';
import { openNativeWorker } from './worker.js';
import { openWritePath } from './write-path.js';
import { parseTranscriptLine, toQueueEvent } from './transcript-parser.js';
import { emitSessionRecord } from './session-capture.js';

export interface QueueRuntimeOptions {
  baseDir: string;
}

export interface QueueRuntime {
  capture(line: string, intent: WriteIntent): QueueEvent | undefined;
  replay(event: QueueEvent, intent: WriteIntent): QueueEvent | undefined;
  state(): { workerId: string; sessionId: string; offset: number; lock: string | null };
}

export function openQueueRuntime(store: NativeStore, options: QueueRuntimeOptions): QueueRuntime {
  const queue = openNativeQueue(options);
  const worker = openNativeWorker(options);
  const writePath = openWritePath(store);
  const seen = new Set(queue.list().map((job) => job.jobId));

  return {
    capture(line: string, intent: WriteIntent): QueueEvent | undefined {
      const transcript = parseTranscriptLine(line);
      if (!transcript) return undefined;
      const state = worker.acquireLock(transcript.sessionId);
      worker.advanceOffset(transcript.offset);
      const event = toQueueEvent(transcript);
      if (seen.has(event.eventId)) return event;
      seen.add(event.eventId);
      queue.enqueue(event, state.workerId, transcript.offset);
      queue.checkpoint(event.eventId);
      emitSessionRecord(store, intent, event);
      writePath.write({ ...intent, provenance: { ...(intent.provenance ?? { source: 'native-store' }), origin: event.kind } });
      queue.flush(event.eventId);
      worker.releaseLock();
      return event;
    },
    replay(event: QueueEvent, intent: WriteIntent): QueueEvent | undefined {
      const transcriptOffset = Number(event.payload?.offset ?? 0);
      worker.advanceOffset(transcriptOffset);
      if (seen.has(event.eventId)) return undefined;
      seen.add(event.eventId);
      queue.enqueue(event, worker.readState().workerId, transcriptOffset);
      queue.checkpoint(event.eventId);
      emitSessionRecord(store, intent, event);
      writePath.write({ ...intent, provenance: { ...(intent.provenance ?? { source: 'native-store' }), origin: event.kind } });
      queue.flush(event.eventId);
      return event;
    },
    state() {
      return worker.readState();
    },
  };
}
