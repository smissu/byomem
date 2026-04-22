#!/usr/bin/env node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from './store.js';
import { openQueueRuntime } from './queue-runtime.js';
import { searchIndex } from './search-index.js';
import { openGenerationClient } from './generation-client.js';
import { observeQueue, renderQueueObserver } from './queue-observer.js';

const GENERATION_COMMANDS = new Set(['generate', 'summarize', 'reason', 'chat']);
const OBSERVER_COMMANDS = new Set(['queue-observe']);
const OBSERVER_WATCH_INTERVAL_DEFAULT = 2;
const OBSERVER_WATCH_INTERVAL_MIN = 0.1;

type CliOptions = {
  baseDir: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingTimeoutMs?: number;
  embeddingRequireRemote?: boolean;
  generationBaseUrl?: string;
  generationModel?: string;
  generationTimeoutMs?: number;
  generationSystem?: string;
  generationMessages?: string;
};

type ObserverWatchMode = { enabled: boolean; intervalSeconds: number };

function usage(): { error: string; commands: string[] } {
  return { error: 'Usage', commands: ['store', 'search', 'prune', 'queue-observe', 'generate', 'summarize', 'reason', 'chat'] };
}

function jsonError(message: string, command: string | null): void {
  console.error(JSON.stringify({ error: message, usage: usage(), command }));
}

function requireValue(value: string | undefined, flag: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`Missing value for ${flag}`);
  return trimmed;
}

function parseMessages(raw: string | undefined): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('--messages must be a JSON array');
  return (parsed as Array<unknown>).map((item) => {
    if (!item || typeof item !== 'object') throw new Error('--messages items must be objects');
    const message = item as { role?: string; content?: unknown };
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') throw new Error('--messages roles must be system, user, or assistant');
    if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('--messages content must be a non-empty string');
    return { role: message.role as 'system' | 'user' | 'assistant', content: message.content };
  });
}

function parseWatchMode(flags: { watch: boolean; watchInterval?: string }, json: boolean): ObserverWatchMode {
  if (!flags.watch) return { enabled: false, intervalSeconds: OBSERVER_WATCH_INTERVAL_DEFAULT };
  const intervalRaw = flags.watchInterval?.trim() || String(OBSERVER_WATCH_INTERVAL_DEFAULT);
  const intervalSeconds = Number(intervalRaw);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < OBSERVER_WATCH_INTERVAL_MIN) throw new Error('--watch-interval must be a positive number');
  if (json) throw new Error('--watch is not supported with --json in queue-observe');
  return { enabled: true, intervalSeconds };
}

function parseArgs(argv: string[]): { command?: string; options: CliOptions; payload: Record<string, string>; flags: { watch: boolean; watchInterval?: string } } {
  const payload: Record<string, string> = {};
  const flags = { watch: false, watchInterval: undefined as string | undefined };
  const options: CliOptions = { baseDir: mkdtempSync(join(tmpdir(), 'byomem-cli-')) };
  let command: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (!command && !arg.startsWith('--')) { command = arg; continue; }
    if (arg === '--help' || arg === '-h') return { command: 'help', options, payload };
    if (arg === '--base-dir') { options.baseDir = requireValue(next, '--base-dir'); i += 1; }
    else if (arg === '--embedding-base-url') { options.embeddingBaseUrl = requireValue(next, '--embedding-base-url'); i += 1; }
    else if (arg === '--embedding-model') { options.embeddingModel = requireValue(next, '--embedding-model'); i += 1; }
    else if (arg === '--embedding-timeout-ms') { options.embeddingTimeoutMs = Number(requireValue(next, '--embedding-timeout-ms')); i += 1; }
    else if (arg === '--generation-base-url') { options.generationBaseUrl = requireValue(next, '--generation-base-url'); i += 1; }
    else if (arg === '--generation-model') { options.generationModel = requireValue(next, '--generation-model'); i += 1; }
    else if (arg === '--generation-timeout-ms') { options.generationTimeoutMs = Number(requireValue(next, '--generation-timeout-ms')); i += 1; }
    else if (arg === '--generation-system') { options.generationSystem = requireValue(next, '--generation-system'); i += 1; }
    else if (arg === '--messages') { options.generationMessages = requireValue(next, '--messages'); i += 1; }
    else if (arg === '--input') { payload.input = requireValue(next, '--input'); i += 1; }
    else if (arg === '--json') { payload.json = 'true'; }
    else if (arg === '--watch') { flags.watch = true; }
    else if (arg === '--watch-interval') { flags.watchInterval = requireValue(next, '--watch-interval'); i += 1; }
    else if (arg === '--history') { payload.history = requireValue(next, '--history'); i += 1; }
    else if (arg === '--query') { payload.query = requireValue(next, '--query'); i += 1; }
    else if (arg === '--id') { payload.id = requireValue(next, '--id'); i += 1; }
    else if (arg === '--scope') { payload.scope = requireValue(next, '--scope'); i += 1; }
    else if (arg === '--prompt') { payload.prompt = requireValue(next, '--prompt'); i += 1; }
    else if (arg === '--text') { payload.text = requireValue(next, '--text'); i += 1; }
  }
  return { command, options, payload, flags };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { command, options, payload, flags } = parseArgs(argv);
  if (!command) {
    jsonError('Missing command', null);
    process.exitCode = 1;
    return;
  }
  if (command === 'help') {
    console.log(JSON.stringify(usage(), null, 2));
    return;
  }

  const isGenerationCommand = GENERATION_COMMANDS.has(command);
  const isObserverCommand = OBSERVER_COMMANDS.has(command);
  const store = isGenerationCommand || isObserverCommand ? undefined : openNativeStore({ ...options, embeddingRequireRemote: true });
  const queueRuntime = store ? openQueueRuntime(store, { baseDir: options.baseDir }) : undefined;
  try {
    if (command === 'store') {
      if (!store) throw new Error('Missing native store');
      if (!payload.input) throw new Error('Missing --input for store');
      const intent = JSON.parse(payload.input) as Parameters<typeof queueRuntime.write>[0];
      console.log(JSON.stringify({ record: await queueRuntime!.write(intent) }, null, 2));
      return;
    }
    if (command === 'search') {
      if (!store) throw new Error('Missing native store');
      const query = payload.query?.trim();
      if (!query) throw new Error('Missing --query for search');
      console.log(JSON.stringify({ results: await searchIndex(store, { query, scope: payload.scope?.trim() as 'project' | 'user' | undefined }) }, null, 2));
      return;
    }
    if (command === 'prune') {
      if (!queueRuntime) throw new Error('Missing queue runtime');
      const id = payload.id?.trim();
      if (!id) throw new Error('Missing --id for prune');
      const parts = id.split(':');
      if (parts.length < 4) throw new Error('Invalid --id for prune');
      const [scope, namespace, parentContext, ...leafParts] = parts;
      if (!scope || !namespace || !parentContext || leafParts.length === 0) throw new Error('Invalid --id for prune');
      const result = await queueRuntime.write({
        scope: scope as 'project' | 'dir' | 'user' | 'agent',
        identity: { namespace, parentContext, leafName: leafParts.join(':'), stableKey: id },
        content: { text: `Prune ${id}` },
        provenance: { source: 'cli-prune', adapter: 'native-store', origin: 'write' },
      } as never);
      console.log(JSON.stringify({ result }, null, 2));
      return;
    }
    if (isObserverCommand) {
      const history = Number(payload.history?.trim() || '5');
      const snapshot = observeQueue({ baseDir: options.baseDir, history, json: Boolean(payload.json) });
      const watchMode = parseWatchMode(flags, Boolean(payload.json));
      if (watchMode.enabled) {
        let shutdown = false;
        let resolveSleep: (() => void) | undefined;
        const render = () => {
          const nextSnapshot = observeQueue({ baseDir: options.baseDir, history, json: false });
          process.stdout.write('\u001b[2J\u001b[H');
          process.stdout.write(`${renderQueueObserver(nextSnapshot)}\n`);
        };
        const stop = () => {
          if (shutdown) return;
          shutdown = true;
          resolveSleep?.();
        };
        const onSigint = () => stop();
        process.once('SIGINT', onSigint);
        try {
          while (!shutdown) {
            render();
            await new Promise<void>((resolve) => {
              resolveSleep = resolve;
              setTimeout(() => {
                resolveSleep = undefined;
                resolve();
              }, watchMode.intervalSeconds * 1000);
              if (shutdown) {
                resolveSleep = undefined;
                resolve();
              }
            });
          }
        } finally {
          process.removeListener('SIGINT', onSigint);
          process.stdout.write('\n');
        }
        return;
      }
      if (payload.json) console.log(JSON.stringify(snapshot, null, 2));
      else console.log(renderQueueObserver(snapshot));
      return;
    }
    if (GENERATION_COMMANDS.has(command)) {
      const client = openGenerationClient({ baseUrl: options.generationBaseUrl, model: options.generationModel, timeoutMs: options.generationTimeoutMs });
      const promptText = payload.prompt?.trim() || payload.text?.trim() || '';
      const messages = parseMessages(options.generationMessages);
      if (!promptText && !messages?.length) throw new Error(`Missing --prompt, --text, or --messages for ${command}`);
      const system = options.generationSystem ?? (command === 'summarize' ? 'Summarize the input concisely.' : command === 'reason' ? 'Reason carefully about the input and answer clearly.' : command === 'chat' ? 'Respond like a helpful assistant.' : undefined);
      const resolvedPrompt = promptText || messages?.at(-1)?.content || '';
      const result = await client.generate({ prompt: resolvedPrompt, system, messages: messages ?? (command === 'chat' ? [{ role: 'user', content: resolvedPrompt }] : undefined) });
      console.log(JSON.stringify({ result }, null, 2));
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    jsonError(error instanceof Error ? error.message : String(error), command);
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    jsonError(error instanceof Error ? error.message : String(error), null);
    process.exitCode = 1;
  });
}
