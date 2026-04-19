import { describe, expect, it } from 'vitest';
import type { MemoryRecord, QueueEvent } from '../src/contracts.js';
import { isCaptureCandidate } from '../src/capture-candidate.js';
import fixtures from '../fixtures/sprint-21-session-capture-fixtures.json';

const queueEvents = fixtures.queue.enqueue as QueueEvent[];
const claims = fixtures.queue.claims as Array<{ eventId: string; claimed: boolean; locked: boolean; offset: number }>;
const completions = fixtures.queue.completions as Array<{ eventId: string; completed: boolean; retries: number }>;
const retries = fixtures.queue.retries as Array<{ eventId: string; retryCount: number; nextOffset: number }>;
const nativeSessionRecord = fixtures.sessionCapture.nativeSessionRecord as MemoryRecord;

describe('Sprint 21 session capture and queue runtime slice', () => {
  it('keeps enqueue/claim/complete/retry/lock/offset ordering stable', () => {
    expect(queueEvents.map((event) => event.kind)).toEqual(['capture', 'flush', 'write', 'replay']);
    expect(queueEvents.map((event) => event.eventId)).toEqual(['evt-capture-1', 'evt-flush-1', 'evt-write-1', 'evt-replay-1']);
    expect(claims).toEqual([
      { eventId: 'evt-capture-1', claimed: true, locked: true, offset: 0 },
      { eventId: 'evt-flush-1', claimed: true, locked: true, offset: 1 },
    ]);
    expect(completions).toEqual([
      { eventId: 'evt-capture-1', completed: true, retries: 0 },
      { eventId: 'evt-flush-1', completed: true, retries: 1 },
    ]);
    expect(retries).toEqual([{ eventId: 'evt-flush-1', retryCount: 1, nextOffset: 2 }]);
  });

  it('preserves session-capture checkpoint and flush offsets across idempotent replay', () => {
    expect(fixtures.sessionCapture.checkpoint).toEqual({ offset: 1, lastEventId: 'evt-flush-1' });
    expect(fixtures.sessionCapture.flush).toEqual({ offset: 2, lastEventId: 'evt-write-1' });
    expect(fixtures.sessionCapture.replay).toEqual({
      eventId: 'evt-replay-1',
      idempotent: true,
      emittedIds: ['project:byomem:root:sprint-21-alpha'],
    });
  });

  it('emits a stable native session record with markdown disabled compatibility', () => {
    expect(nativeSessionRecord).toMatchObject({
      id: 'session:byomem:root:sprint-21-session-alpha',
      scope: 'project',
      provenance: {
        source: 'fixtures',
        adapter: 'native-store',
        origin: 'session-capture',
      },
      identity: {
        namespace: 'byomem',
        leafName: 'sprint-21-session-alpha',
        parentContext: 'root',
        stableKey: 'session:byomem:root:sprint-21-session-alpha',
      },
      content: {
        structured: {
          sessionId: 'sprint-21-session-alpha',
          checkpointOffset: 1,
          flushedOffset: 2,
          markdownEnabled: false,
          replayed: true,
        },
      },
      metadata: {
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:03.000Z',
      },
    });

    expect(fixtures.markdownDisabled).toEqual({
      enabled: false,
      compatibility: { acceptsStructuredOnly: true, skipsMarkdownRender: true },
    });
    expect(isCaptureCandidate(nativeSessionRecord, true)).toBe(true);
  });
});
