import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

export function tempDir(prefix = 'byomem-s38-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export type RegisteredTool = {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (...args: any[]) => Promise<unknown> | unknown;
};

type RegisteredCommand = {
  description?: string;
  handler: (...args: any[]) => Promise<void> | void;
};

export type MockPi = {
  tools: RegisteredTool[];
  commands: Record<string, RegisteredCommand>;
  events: Record<string, Array<(...args: any[]) => any>>;
  api: {
    on(name: string, handler: (...args: any[]) => any): void;
    registerTool(tool: RegisteredTool): void;
    registerCommand(name: string, command: RegisteredCommand): void;
  };
};

export function makeMockPi(): MockPi {
  const tools: RegisteredTool[] = [];
  const commands: Record<string, RegisteredCommand> = {};
  const events: Record<string, Array<(...args: any[]) => any>> = {};

  return {
    tools,
    commands,
    events,
    api: {
      on(name: string, handler: (...args: any[]) => any) {
        events[name] ??= [];
        events[name].push(handler);
      },
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
      registerCommand(name: string, command: RegisteredCommand) {
        commands[name] = command;
      },
    },
  };
}

export async function disposeMockPi(mock: Pick<MockPi, 'events'>): Promise<void> {
  for (const handler of mock.events.dispose ?? []) {
    await handler({}, {});
  }
}

export async function loadExtension() {
  vi.resetModules();
  return import('../../src/pi-extension.js');
}

export function findRegisteredTool(mock: Pick<MockPi, 'tools'>, name: string): RegisteredTool | undefined {
  return mock.tools.find((tool) => tool.name === name);
}

export function requireRegisteredTool(mock: Pick<MockPi, 'tools'>, name: string): RegisteredTool {
  const tool = findRegisteredTool(mock, name);
  if (!tool) throw new Error(`missing Pi tool ${name}`);
  return tool;
}

export function firstContentText(result: { content?: Array<{ text?: string }> } | null | undefined): string | undefined {
  return result?.content?.[0]?.text;
}

export function parseFirstContentJson<T>(result: { content?: Array<{ text?: string }> } | null | undefined): T | undefined {
  const text = firstContentText(result);
  if (!text) return undefined;
  return JSON.parse(text) as T;
}
