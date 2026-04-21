import { createHash } from 'node:crypto';

export interface GenerationClientOptions {
  baseUrl?: string;
  model?: string;
  fallbackModel?: string;
  timeoutMs?: number;
  requestOptions?: Record<string, unknown>;
  transport?: 'openai-chat-completions' | 'ollama-native-chat';
}

export interface GenerationRequest {
  prompt: string;
  system?: string;
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

export class GenerationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationInputError';
  }
}

export interface GenerationClient {
  generate(input: GenerationRequest): Promise<string>;
  hashText(text: string): string;
}

function fallbackGeneration(input: GenerationRequest): string {
  const prompt = input.messages?.at(-1)?.content ?? input.prompt;
  return prompt.trim().slice(0, 280);
}

function validateGenerationInput(input: GenerationRequest): void {
  if (!input.prompt.trim() && !input.messages?.length) throw new GenerationInputError('Missing generation input');
}

function resolveMessages(input: GenerationRequest) {
  return input.messages ?? [
    ...(input.system ? [{ role: 'system' as const, content: input.system }] : []),
    { role: 'user' as const, content: input.prompt },
  ];
}

async function remoteChatCompletion(url: string, model: string, input: GenerationRequest, timeoutMs?: number, requestOptions?: Record<string, unknown>): Promise<string | undefined> {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timeout = timeoutMs && controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  const messages = resolveMessages(input);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0, ...(requestOptions ?? {}) }),
      signal: controller?.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; output?: string; response?: string; text?: string };
    return payload.choices?.[0]?.message?.content ?? payload.output ?? payload.response ?? payload.text;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function remoteOllamaNativeChat(url: string, model: string, input: GenerationRequest, timeoutMs?: number, requestOptions?: Record<string, unknown>): Promise<string | undefined> {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timeout = timeoutMs && controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  const messages = resolveMessages(input);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, ...(requestOptions ?? {}) }),
      signal: controller?.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { message?: { content?: string }; output?: string; response?: string; text?: string };
    return payload.message?.content ?? payload.output ?? payload.response ?? payload.text;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function openGenerationClient(options: GenerationClientOptions = {}): GenerationClient {
  async function generateWithModel(model: string, input: GenerationRequest): Promise<string | undefined> {
    if (options.transport === 'ollama-native-chat') {
      const url = new URL('/api/chat', options.baseUrl!).toString();
      return remoteOllamaNativeChat(url, model, input, options.timeoutMs, options.requestOptions);
    }
    const url = new URL('/v1/chat/completions', options.baseUrl!).toString();
    return remoteChatCompletion(url, model, input, options.timeoutMs, options.requestOptions);
  }

  return {
    hashText(text: string): string {
      return createHash('sha256').update(text).digest('hex');
    },
    async generate(input: GenerationRequest): Promise<string> {
      validateGenerationInput(input);
      const fallback = fallbackGeneration(input);
      if (!options.baseUrl) return fallback;
      const primaryModel = options.model ?? 'gpt-4o-mini';
      const fallbackModel = options.fallbackModel;
      try {
        const primary = await generateWithModel(primaryModel, input);
        if (primary) return primary;
        if (fallbackModel && fallbackModel !== primaryModel) {
          const secondary = await generateWithModel(fallbackModel, input);
          if (secondary) return secondary;
        }
        return fallback;
      } catch (primaryError) {
        if (fallbackModel && fallbackModel !== primaryModel) {
          try {
            const secondary = await generateWithModel(fallbackModel, input);
            if (secondary) return secondary;
          } catch {
            // fall through to existing local fallback
          }
        }
        return fallback;
      }
    },
  };
}
