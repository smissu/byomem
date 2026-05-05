import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EmbeddingClientOptions {
  baseUrl?: string;
  model?: string;
  dimension?: number;
  timeoutMs?: number;
  requireRemote?: boolean;
}

export interface EmbeddingClient {
  embed(text: string): Promise<number[] | undefined>;
  embedMany(texts: string[]): Promise<Array<number[] | undefined>>;
  hashText(text: string): string;
  providerKey: string;
  configuredDimension: number;
  close?: () => void;
}

export const FILE_SEARCH_EMBEDDING_IDENTITY_VERSION = 'file-search-embedding-v1';
export const FALLBACK_EMBEDDING_PROVIDER_KEY = 'fallback:deterministic-v1';
export const SEMBLE_EMBEDDING_MODEL = 'minishlab/potion-code-16M';

export function resolveEmbeddingProviderKey(baseUrl?: string, model?: string): string {
  if (baseUrl) return `remote:${new URL('/api/embeddings', baseUrl).toString()}`;
  if (model === SEMBLE_EMBEDDING_MODEL || model === 'potion-code-16M') return `local:model2vec:${model}`;
  return FALLBACK_EMBEDDING_PROVIDER_KEY;
}

type EmbeddingPayload = {
  embedding?: unknown;
  embeddings?: unknown;
  data?: Array<{ embedding?: unknown }> ;
};

function fallbackEmbedding(text: string, dimension = 1536): number[] {
  const seed = createHash('sha256').update(text).digest();
  const vector = new Array<number>(dimension).fill(0);
  for (let i = 0; i < dimension; i += 1) vector[i] = (seed[i % seed.length] ?? 0) / 255;
  return vector;
}

function resolveModel2VecPythonExecutable(): string | undefined {
  const explicit = process.env.BYOMEM_EMBEDDING_PYTHON?.trim();
  if (explicit) return explicit;
  const siblingVenv = resolve(process.cwd(), '..', 'semble', '.venv', 'bin', 'python');
  if (existsSync(siblingVenv)) return siblingVenv;
  const localVenv = resolve(process.cwd(), '.venv', 'bin', 'python');
  if (existsSync(localVenv)) return localVenv;
  return undefined;
}

export function resolveModel2VecScriptPath(): string {
  const explicit = process.env.BYOMEM_MODEL2VEC_SCRIPT?.trim();
  if (explicit) return explicit;
  return fileURLToPath(new URL('../scripts/model2vec_embed_server.py', import.meta.url));
}

type Model2VecResponse = {
  id?: string;
  embeddings?: number[][];
  error?: string;
};

class Model2VecEmbeddingServer {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private readonly pending = new Map<string, { resolve: (embeddings: number[][]) => void; reject: (error: Error) => void }>();
  private stdoutBuffer = '';
  private stderrBuffer = '';

  constructor(private readonly pythonExecutable: string, private readonly scriptPath: string, private readonly model: string) {}

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      while (true) {
        const newline = this.stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.stdoutBuffer.slice(0, newline).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let payload: Model2VecResponse;
        try {
          payload = JSON.parse(line) as Model2VecResponse;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.failAll(new Error(`Model2Vec embedding server emitted invalid JSON: ${message}`));
          return;
        }
        const requestId = payload.id;
        if (!requestId) continue;
        const pending = this.pending.get(requestId);
        if (!pending) continue;
        this.pending.delete(requestId);
        if (payload.error) pending.reject(new Error(payload.error));
        else pending.resolve(payload.embeddings ?? []);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 8192) this.stderrBuffer = this.stderrBuffer.slice(-8192);
    });
    child.once('exit', (code, signal) => {
      const message = `Model2Vec embedding server exited${code !== null ? ` with code ${code}` : ''}${signal ? ` signal ${signal}` : ''}${this.stderrBuffer.trim() ? `: ${this.stderrBuffer.trim()}` : ''}`;
      this.child = undefined;
      this.startPromise = undefined;
      this.failAll(new Error(message));
    });
    child.once('error', (error) => {
      this.child = undefined;
      this.startPromise = undefined;
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private failAll(error: Error): void {
    this.pending.forEach((pending) => pending.reject(error));
    this.pending.clear();
  }

  private async ensureStarted(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child) return this.child;
    if (this.startPromise) {
      await this.startPromise;
      if (!this.child) throw new Error('Model2Vec embedding server failed to start');
      return this.child;
    }
    const start = new Promise<ChildProcessWithoutNullStreams>((resolvePromise, rejectPromise) => {
      const child = spawn(this.pythonExecutable, [this.scriptPath, '--model', this.model], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });
      this.child = child;
      this.attachChild(child);
      child.once('spawn', () => resolvePromise(child));
      child.once('error', rejectPromise);
    });
    this.startPromise = start.then(() => undefined);
    const child = await start;
    if (!this.child) this.child = child;
    return child;
  }

  async embedMany(texts: string[]): Promise<Array<number[] | undefined>> {
    if (!texts.length) return [];
    const child = await this.ensureStarted();
    const requestId = randomUUID();
    return await new Promise<Array<number[] | undefined>>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (embeddings) => resolve(embeddings.map((embedding) => (Array.isArray(embedding) && embedding.length ? embedding : undefined))),
        reject,
      });
      try {
        child.stdin.write(`${JSON.stringify({ id: requestId, texts })}\n`);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    if (!this.child) return;
    const child = this.child;
    this.child = undefined;
    this.startPromise = undefined;
    this.pending.clear();
    child.kill('SIGTERM');
  }
}

function asEmbeddingVector(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number') ? value : undefined;
}

function extractEmbedding(payload: EmbeddingPayload): number[] | undefined {
  const directEmbeddings = asEmbeddingVector(payload.embeddings);
  const nestedEmbeddings = Array.isArray(payload.embeddings) ? asEmbeddingVector(payload.embeddings[0]) : undefined;
  return asEmbeddingVector(payload.embedding)
    ?? asEmbeddingVector(payload.data?.[0]?.embedding)
    ?? nestedEmbeddings
    ?? directEmbeddings;
}

async function remoteEmbedding(url: string, model: string, text: string, timeoutMs?: number): Promise<number[] | undefined> {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timeout = timeoutMs && controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: text, input: text }),
      signal: controller?.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as EmbeddingPayload;
    return extractEmbedding(payload);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function openEmbeddingClient(options: EmbeddingClientOptions = {}): EmbeddingClient {
  const model = options.model ?? SEMBLE_EMBEDDING_MODEL;
  const model2VecPython = !options.baseUrl && (model === SEMBLE_EMBEDDING_MODEL || model === 'potion-code-16M') ? resolveModel2VecPythonExecutable() : undefined;
  const model2VecServer = model2VecPython ? new Model2VecEmbeddingServer(model2VecPython, resolveModel2VecScriptPath(), model) : undefined;
  return {
    providerKey: resolveEmbeddingProviderKey(options.baseUrl, model),
    configuredDimension: options.dimension ?? 0,
    hashText(text: string): string {
      return createHash('sha256').update(text).digest('hex');
    },
    async embed(text: string): Promise<number[] | undefined> {
      const [vector] = await this.embedMany([text]);
      return vector;
    },
    async embedMany(texts: string[]): Promise<Array<number[] | undefined>> {
      const filtered = texts.map((text) => text.trim());
      const originalIndexes = filtered.map((text, index) => ({ text, index })).filter((entry) => entry.text.length > 0);
      const results = new Array<number[] | undefined>(texts.length).fill(undefined);
      if (!originalIndexes.length) return results;
      if (!options.baseUrl && options.requireRemote) throw new Error('Remote embedding provider is required but no embedding base URL is configured');
      if (model2VecServer) {
        if (options.baseUrl) throw new Error('Model2Vec backend only applies when no embedding base URL is configured');
        const vectors = await model2VecServer.embedMany(originalIndexes.map((entry) => entry.text));
        vectors.forEach((vector, index) => {
          results[originalIndexes[index]!.index] = vector;
        });
        return results;
      }
      if (!options.baseUrl) {
        for (const entry of originalIndexes) results[entry.index] = fallbackEmbedding(entry.text, options.dimension);
        return results;
      }
      const url = new URL('/api/embeddings', options.baseUrl).toString();
      const vectors = await Promise.all(originalIndexes.map(async (entry) => remoteEmbedding(url, model, entry.text, options.timeoutMs)));
      vectors.forEach((vector, index) => {
        results[originalIndexes[index]!.index] = vector;
      });
      if (options.requireRemote && vectors.some((vector) => !vector?.length)) {
        throw new Error(`Remote embedding request returned no embedding for model ${model}`);
      }
      if (!options.requireRemote) {
        vectors.forEach((vector, index) => {
          if (!vector?.length) results[originalIndexes[index]!.index] = fallbackEmbedding(originalIndexes[index]!.text, options.dimension);
        });
      }
      return results;
    },
    close(): void {
      model2VecServer?.close();
    },
  };
}
