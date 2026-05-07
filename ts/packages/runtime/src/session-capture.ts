import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { MemoryRecord, QueueEvent, WriteIntent } from './contracts.js';
import { openGenerationClient, type GenerationClientOptions } from './generation-client.js';
import { openQueueRuntime, type QueueRuntime, type QueueWriteResult } from './queue-runtime.js';
import type { NativeStore } from './store.js';

export interface SessionCaptureOptions {
  baseDir: string;
  thresholdTurns?: number;
  largeTurnChars?: number;
  idleFlushSeconds?: number;
  minTurns?: number;
  summarizeOnBeforeSwitch?: boolean;
  generation?: GenerationClientOptions;
  userMessageMax?: number;
  assistantMessageMax?: number;
  rawArchive?: { enabled?: boolean };
}

interface SessionTurn {
  id: string;
  timestamp: string;
  user: string;
  assistant: string;
}

interface SessionCaptureState {
  offset: number;
  pendingTurns: SessionTurn[];
  lastTranscriptPath?: string;
  lastAgent?: string;
  lastModel?: string;
  lastActivityAt?: string;
}

interface SessionCaptureSummaryRequest {
  sessionId: string;
  turns: SessionTurn[];
  agent?: string;
  model?: string;
  event?: string;
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
}

export type SessionCaptureReason = 'checkpointed' | 'threshold' | 'large-turn' | 'idle' | 'final' | 'switch' | 'no-pending-turns';

export interface SessionCaptureWriteResult {
  checkpoint: QueueEvent[];
  record?: MemoryRecord;
  rollup?: QueueWriteResult;
  reason: SessionCaptureReason;
  pendingTurns?: number;
  checkpointOffset?: number;
  rawArchive?: { path: string; turns: number };
}

const SESSION_CAPTURE_STATE_FILE = 'session-capture-state.json';
const DEFAULT_THRESHOLD_TURNS = 3;
const DEFAULT_MIN_TURNS = 2;
const DEFAULT_LARGE_TURN_CHARS = 4096;
const DEFAULT_USER_MESSAGE_MAX = 2000;
const DEFAULT_ASSISTANT_MESSAGE_MAX = 3000;
const ROLLUP_SYSTEM_PROMPT = [
  'You write compact memory rollups for coding sessions.',
  'Summarize only the provided pending turns.',
  'Return 2-4 short bullet points and one final sentence.',
  'Keep concrete facts: files, functions, models, errors, decisions, and next steps.',
  'Do not add markdown headings or code fences.',
].join(' ');
const RAW_TOOL_TRACE_MARKER_PATTERN = /["']?(?:tool_call|tool_result|toolCall|toolResult)["']?\s*:\s*/;
const SENSITIVE_CAPTURE_FIELD_PATTERN = /\b(?:thinkingSignature|textSignature|encrypted_content|encryptedContent)\b/g;
const SENSITIVE_CAPTURE_JSON_FIELD_PATTERN = /["'](?:thinkingSignature|textSignature|encrypted_content|encryptedContent)["']\s*:\s*(?:"[^"]*"|'[^']*'|[{[][\s\S]*?[}\]]|true\b|false\b|null\b|-?\d+(?:\.\d+)?)/g;
const SESSION_CAPTURE_RAW_ARCHIVE_VERSION = 'session-capture-raw-archive-v1';

function stripRawToolTraceText(value: string): string {
  return value.split(/\r?\n/).map((line) => {
    const markerIndex = line.search(RAW_TOOL_TRACE_MARKER_PATTERN);
    if (markerIndex < 0) return line;
    const prefix = line.slice(0, markerIndex).trimEnd();
    return prefix ? `${prefix} [REDACTED TOOL TRACE]` : '[REDACTED TOOL TRACE]';
  }).join('\n');
}

function sanitizeCaptureText(value: string): string {
  return stripRawToolTraceText(value)
    .replace(SENSITIVE_CAPTURE_JSON_FIELD_PATTERN, '[REDACTED]')
    .replace(SENSITIVE_CAPTURE_FIELD_PATTERN, '[REDACTED]');
}

function statePath(baseDir: string): string {
  return resolve(baseDir, 'queue', SESSION_CAPTURE_STATE_FILE);
}

function loadAllState(baseDir: string): Record<string, SessionCaptureState> {
  const path = statePath(baseDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, SessionCaptureState>;
  } catch {
    return {};
  }
}

function saveAllState(baseDir: string, state: Record<string, SessionCaptureState>): void {
  const path = statePath(baseDir);
  mkdirSync(resolve(baseDir, 'queue'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function loadSessionState(baseDir: string, sessionId: string): SessionCaptureState {
  return loadAllState(baseDir)[sessionId] ?? { offset: 0, pendingTurns: [] };
}

function saveSessionState(baseDir: string, sessionId: string, state: SessionCaptureState): void {
  const all = loadAllState(baseDir);
  all[sessionId] = state;
  saveAllState(baseDir, all);
}

function clampThreshold(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.max(1, Math.floor(value as number)) : fallback;
}

function hashTurn(turn: SessionTurn): string {
  return createHash('sha256').update(JSON.stringify(turn)).digest('hex').slice(0, 16);
}

function hashFlushKey(sessionId: string, checkpointOffset: number, turns: SessionTurn[]): string {
  return createHash('sha256').update(`${sessionId}:${checkpointOffset}:${turns.map((turn) => turn.id).join('|')}`).digest('hex').slice(0, 12);
}

function nestedObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function eventMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const message = nestedObject(msg.message);
  if (message) return message;
  const item = nestedObject(msg.item);
  if (item && typeof item.role === 'string') return item;
  if (typeof msg.role === 'string') return msg;
  return {};
}

function eventMessageRole(msg: Record<string, unknown>): string | undefined {
  const message = eventMessage(msg);
  return typeof message.role === 'string' ? message.role : undefined;
}

function eventMessageUuid(msg: Record<string, unknown>): string | undefined {
  const message = eventMessage(msg);
  const value = message.uuid ?? message.id ?? msg.uuid ?? msg.id;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function eventParentUuid(msg: Record<string, unknown>): string | undefined {
  const message = eventMessage(msg);
  const value = message.parentUUID ?? message.parentUuid ?? message.parentId ?? msg.parentUUID ?? msg.parentUuid ?? msg.parentId;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function eventMessageTimestamp(msg: Record<string, unknown>): string {
  const message = eventMessage(msg);
  const value = message.timestamp ?? msg.timestamp;
  return value === undefined || value === null ? '' : String(value);
}

function eventText(msg: Record<string, unknown>): string {
  const message = eventMessage(msg);
  const content = message.content;
  if (typeof content === 'string') return sanitizeCaptureText(content);
  if (Array.isArray(content)) {
    return sanitizeCaptureText(content
      .filter((item) => {
        if (!item || typeof item !== 'object') return false;
        const type = (item as Record<string, unknown>).type;
        return type === 'text' || type === 'input_text' || type === 'output_text';
      })
      .map((item) => String((item as Record<string, unknown>).text ?? ''))
      .join(' '));
  }
  if (typeof message.text === 'string') return sanitizeCaptureText(message.text);
  return '';
}

function joinAssistant(messages: Array<Record<string, unknown>>, maxLen: number): string {
  return messages
    .map((message) => eventText(message).trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(0, maxLen);
}

function parseEventTranscriptTurns(messages: Array<Record<string, unknown>>, options: SessionCaptureOptions): SessionTurn[] {
  const turns: SessionTurn[] = [];
  const userMessageMax = clampThreshold(options.userMessageMax, DEFAULT_USER_MESSAGE_MAX);
  const assistantMessageMax = clampThreshold(options.assistantMessageMax, DEFAULT_ASSISTANT_MESSAGE_MAX);
  const messageById = new Map<string, Record<string, unknown>>();
  const childrenByParent = new Map<string, Array<Record<string, unknown>>>();
  const userMessages = messages.filter((message) => eventMessageRole(message) === 'user');

  for (const message of messages) {
    const id = eventMessageUuid(message);
    if (id) messageById.set(id, message);
    const parent = eventParentUuid(message);
    if (parent) {
      const existing = childrenByParent.get(parent) ?? [];
      existing.push(message);
      childrenByParent.set(parent, existing);
    }
  }

  for (const userMessage of userMessages) {
    const userId = eventMessageUuid(userMessage);
    if (!userId) continue;
    const queue = [...(childrenByParent.get(userId) ?? [])];
    const visited = new Set<string>([userId]);
    const assistantMessages: Array<Record<string, unknown>> = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentId = eventMessageUuid(current);
      if (currentId) {
        if (visited.has(currentId)) continue;
        visited.add(currentId);
      }
      const role = eventMessageRole(current);
      if (role === 'assistant') {
        assistantMessages.push(current);
      }
      if ((role === 'assistant' || role === 'toolResult') && currentId) {
        queue.push(...(childrenByParent.get(currentId) ?? []));
      }
    }

    const assistant = joinAssistant(assistantMessages, assistantMessageMax);
    if (!assistant.trim()) continue;
    const user = eventText(userMessage).slice(0, userMessageMax).trim();
    if (!user) continue;
    turns.push({
      id: userId,
      timestamp: eventMessageTimestamp(userMessage),
      user,
      assistant,
    });
  }

  return turns.length > 0 ? turns : parseSequentialEventTranscriptTurns(messages, userMessageMax, assistantMessageMax);
}

function parseSequentialEventTranscriptTurns(messages: Array<Record<string, unknown>>, userMessageMax: number, assistantMessageMax: number): SessionTurn[] {
  const turns: SessionTurn[] = [];
  let activeUser: Record<string, unknown> | undefined;
  const assistantMessages: Array<Record<string, unknown>> = [];

  const flush = () => {
    if (!activeUser) return;
    const user = eventText(activeUser).slice(0, userMessageMax).trim();
    const assistant = joinAssistant(assistantMessages, assistantMessageMax);
    if (user && assistant.trim()) {
      turns.push({
        id: eventMessageUuid(activeUser) ?? hashTurn({ id: '', timestamp: eventMessageTimestamp(activeUser), user, assistant }),
        timestamp: eventMessageTimestamp(activeUser),
        user,
        assistant,
      });
    }
    activeUser = undefined;
    assistantMessages.length = 0;
  };

  for (const message of messages) {
    const role = eventMessageRole(message);
    if (role === 'user') {
      flush();
      activeUser = message;
      continue;
    }
    if (role === 'assistant' && activeUser) {
      assistantMessages.push(message);
    }
  }
  flush();

  return turns;
}

function parseSimpleTranscriptTurns(text: string): SessionTurn[] {
  const turns: SessionTurn[] = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let activeUser: string | undefined;
  const assistantParts: string[] = [];

  const flush = () => {
    if (!activeUser) return;
    const assistant = assistantParts.join('\n').trim();
    if (assistant) {
      const turn: SessionTurn = { id: hashTurn({ id: '', timestamp: '', user: activeUser, assistant }), timestamp: '', user: activeUser, assistant };
      turns.push(turn);
    }
    activeUser = undefined;
    assistantParts.length = 0;
  };

  for (const line of lines) {
    if (line.startsWith('user:')) {
      flush();
      activeUser = sanitizeCaptureText(line.slice('user:'.length).trim());
      continue;
    }
    if (line.startsWith('assistant:')) {
      assistantParts.push(sanitizeCaptureText(line.slice('assistant:'.length).trim()));
    }
  }
  flush();

  return turns;
}

function parseTurnsFromTranscriptBuffer(buffer: Buffer, startOffset: number, options: SessionCaptureOptions): { turns: SessionTurn[]; endOffset: number } {
  const endOffset = buffer.length;
  if (startOffset >= endOffset) return { turns: [], endOffset };
  const slice = buffer.toString('utf8', startOffset);
  const lines = slice.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const messages: Array<Record<string, unknown>> = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      messages.push(parsed);
    } catch {
      // non-JSON line; handled by fallback parser below
    }
  }

  const looksLikeEventTranscript = messages.some((message) => Boolean(eventMessageRole(message)));
  if (looksLikeEventTranscript) {
    return { turns: parseEventTranscriptTurns(messages, options), endOffset };
  }
  return { turns: parseSimpleTranscriptTurns(slice), endOffset };
}

function isLargeTurn(turn: SessionTurn, threshold: number): boolean {
  return threshold > 0 && (turn.user.length + turn.assistant.length) >= threshold;
}

function summarizeTurnsPrompt(request: SessionCaptureSummaryRequest): string {
  const body = request.turns.map((turn, index) => [
    `Turn ${index + 1} (${turn.id}):`,
    `User: ${sanitizeCaptureText(turn.user)}`,
    `Assistant: ${sanitizeCaptureText(turn.assistant)}`,
  ].join('\n')).join('\n\n');

  return [
    'Summarize the pending agent session turns into a compact memory rollup.',
    request.sessionId ? `Session: ${request.sessionId}` : undefined,
    request.agent ? `Agent: ${request.agent}` : undefined,
    request.model ? `Conversation model: ${request.model}` : undefined,
    request.event ? `Flush trigger: ${request.event}` : undefined,
    '',
    body,
  ].filter(Boolean).join('\n');
}

async function generateRollupSummary(options: SessionCaptureOptions, request: SessionCaptureSummaryRequest): Promise<string> {
  const client = openGenerationClient(options.generation ?? {});
  const summary = await client.generate({
    prompt: summarizeTurnsPrompt(request),
    system: ROLLUP_SYSTEM_PROMPT,
  });
  return summary.trim();
}

function summarizeFallback(turns: SessionTurn[]): string {
  return sanitizeCaptureText(turns.map((turn, index) => `- ${index + 1}. ${turn.user} => ${turn.assistant}`).join('\n')).slice(0, 1600);
}

function determineFlushReason(input: SessionCaptureInput, pendingTurns: SessionTurn[], options: SessionCaptureOptions): SessionCaptureReason | undefined {
  if (pendingTurns.length === 0) return 'no-pending-turns';
  if (input.final) return 'final';
  if (input.idle) return 'idle';
  if (options.summarizeOnBeforeSwitch === true && input.event === 'session_before_switch') return 'switch';
  const thresholdTurns = clampThreshold(options.thresholdTurns, DEFAULT_THRESHOLD_TURNS);
  if (pendingTurns.length >= thresholdTurns) return 'threshold';
  const largeTurnChars = clampThreshold(options.largeTurnChars, DEFAULT_LARGE_TURN_CHARS);
  if (pendingTurns.some((turn) => isLargeTurn(turn, largeTurnChars))) return 'large-turn';
  return undefined;
}

function deriveLeafName(sessionId: string): string {
  const trimmed = sessionId.trim();
  const safe = trimmed.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '').slice(0, 120);
  return safe.length ? safe : 'session-capture';
}

function buildSessionRollupIntent(input: SessionCaptureInput, summary: string, turns: SessionTurn[], reason: SessionCaptureReason): WriteIntent {
  const rollupKey = hashFlushKey(input.sessionId, input.transcriptPath.length, turns);
  const sessionLeaf = deriveLeafName(input.sessionId);
  return {
    scope: 'project',
    identity: {
      namespace: 'byomem-session',
      leafName: `${sessionLeaf}-rollup-${rollupKey}`,
      parentContext: 'root',
      stableKey: `project:byomem-session:root:${sessionLeaf}:rollup:${rollupKey}`,
    },
    content: {
      text: summary,
      structured: {
        kind: 'rollup',
        sessionId: input.sessionId,
        flushReason: reason,
        sourceStableKey: `project:byomem-session:root:${sessionLeaf}`,
      },
    },
    provenance: {
      source: 'session-capture',
      adapter: 'native-store',
      origin: 'session-rollup',
    },
  };
}

function rawArchivePath(baseDir: string, sessionId: string, checkpointOffset: number, turns: SessionTurn[]): string {
  const rollupKey = hashFlushKey(sessionId, checkpointOffset, turns);
  return resolve(baseDir, 'queue', 'session-archive', `${deriveLeafName(sessionId)}-${rollupKey}.json`);
}

function writeRawArchive(options: SessionCaptureOptions, input: SessionCaptureInput, turns: SessionTurn[], checkpointOffset: number, reason: SessionCaptureReason): { path: string; turns: number } | undefined {
  if (options.rawArchive?.enabled !== true || turns.length === 0) return undefined;
  const path = rawArchivePath(options.baseDir, input.sessionId, checkpointOffset, turns);
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    version: SESSION_CAPTURE_RAW_ARCHIVE_VERSION,
    sessionId: input.sessionId,
    event: input.event,
    flushReason: reason,
    transcriptPath: input.transcriptPath,
    checkpointOffset,
    createdAt: new Date().toISOString(),
    sanitizer: 'visible-user-assistant-text-only',
    turns: turns.map((turn) => ({
      id: turn.id,
      timestamp: turn.timestamp,
      user: sanitizeCaptureText(turn.user),
      assistant: sanitizeCaptureText(turn.assistant),
    })),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { path, turns: turns.length };
}


export function openSessionCapture(store: NativeStore, options: SessionCaptureOptions): SessionCaptureResult {
  const emitted: MemoryRecord[] = [];
  const runtime = openQueueRuntime(store, options);

  return { runtime, emitted };
}


export async function captureSessionCheckpoint(store: NativeStore, options: SessionCaptureOptions, input: SessionCaptureInput): Promise<SessionCaptureWriteResult> {
  const transcriptBuffer = readFileSync(input.transcriptPath);
  const transcriptText = transcriptBuffer.toString('utf8');
  const state = loadSessionState(options.baseDir, input.sessionId);
  const { turns: newTurns, endOffset } = parseTurnsFromTranscriptBuffer(transcriptBuffer, state.offset || 0, options);
  const pendingTurns = [...(state.pendingTurns ?? []), ...newTurns];
  const queueRuntime = openQueueRuntime(store, options);
  const reason = determineFlushReason(input, pendingTurns, options);

  if (reason === 'no-pending-turns') {
    saveSessionState(options.baseDir, input.sessionId, {
      offset: endOffset,
      pendingTurns: [],
      lastTranscriptPath: input.transcriptPath,
      lastAgent: input.agent,
      lastModel: input.model,
      lastActivityAt: new Date().toISOString(),
    });
    return { checkpoint: [], record: undefined as never, rollup: undefined, pendingTurns: 0, checkpointOffset: endOffset, reason };
  }

  const nextState: SessionCaptureState = {
    offset: endOffset,
    pendingTurns,
    lastTranscriptPath: input.transcriptPath,
    lastAgent: input.agent,
    lastModel: input.model,
    lastActivityAt: new Date().toISOString(),
  };

  const minTurns = clampThreshold(options.minTurns, DEFAULT_MIN_TURNS);
  const forceFlush = reason === 'final' || reason === 'idle' || reason === 'switch';
  if (!reason || (!forceFlush && pendingTurns.length < minTurns)) {
    saveSessionState(options.baseDir, input.sessionId, nextState);
    return { checkpoint: [], record: undefined as never, rollup: undefined, pendingTurns: pendingTurns.length, checkpointOffset: endOffset, reason: 'checkpointed' };
  }

  const summary = sanitizeCaptureText((await generateRollupSummary(options, {
    sessionId: input.sessionId,
    turns: pendingTurns,
    agent: input.agent,
    model: input.model,
    event: input.event,
  }).catch(() => summarizeFallback(pendingTurns))) || summarizeFallback(pendingTurns));

  const rawArchive = writeRawArchive(options, input, pendingTurns, endOffset, reason);
  const rollupIntent = buildSessionRollupIntent(input, summary, pendingTurns, reason);
  const rollup = await queueRuntime.write(rollupIntent);
  if (!rollup?.record) throw new Error('Failed to persist session rollup');
  saveSessionState(options.baseDir, input.sessionId, {
    offset: endOffset,
    pendingTurns: [],
    lastTranscriptPath: input.transcriptPath,
    lastAgent: input.agent,
    lastModel: input.model,
    lastActivityAt: new Date().toISOString(),
  });
  return { checkpoint: [], record: undefined as never, rollup, pendingTurns: 0, checkpointOffset: endOffset, reason, rawArchive };
}
