import type { QueueEvent } from './contracts.js';

export interface TranscriptLine {
  sessionId: string;
  eventId: string;
  offset: number;
  content: string;
}

export function parseTranscriptLine(line: string): TranscriptLine | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const [sessionId, eventId, offset, ...rest] = trimmed.split('|');
  if (!sessionId || !eventId || !offset || rest.length === 0) return undefined;
  const parsedOffset = Number(offset);
  if (Number.isNaN(parsedOffset)) return undefined;
  return { sessionId, eventId, offset: parsedOffset, content: rest.join('|') };
}

export function toQueueEvent(line: TranscriptLine): QueueEvent {
  return {
    eventId: line.eventId,
    sessionId: line.sessionId,
    recordId: line.eventId,
    kind: 'capture',
    createdAt: new Date().toISOString(),
    payload: { content: line.content, offset: line.offset },
  };
}
