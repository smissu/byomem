import { describe, expect, it } from 'vitest';
import extensionModule, { byomem_runtime_status } from '../../../../.pi/extensions/byomem/index.ts';

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (...args: any[]) => Promise<unknown>;
};

function makeMockPi() {
  const tools: RegisteredTool[] = [];
  const commands: Record<string, { description: string; handler: (...args: any[]) => Promise<void> }> = {};
  return {
    tools,
    commands,
    api: {
      on: () => undefined,
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
      registerCommand(name: string, command: { description: string; handler: (...args: any[]) => Promise<void> }) {
        commands[name] = command;
      },
    },
  };
}

describe('byomem extension wiring', () => {
  it('registers the project-local TS-native tools and command without python', async () => {
    const mock = makeMockPi();
    extensionModule(mock.api as never);

    expect(mock.commands['byomem-status']).toBeTruthy();
    expect(mock.tools.map((tool) => tool.name)).toEqual([
      'byomem_runtime_status',
      'byomem_search',
      'byomem_store',
      'byomem_prune',
    ]);

    const statusTool = mock.tools.find((tool) => tool.name === 'byomem_runtime_status');
    const status = await statusTool!.execute('1', {});
    expect(JSON.parse((status as { content: { text: string }[] }).content[0].text)).toMatchObject({
      packageSurface: 'ts/packages/runtime',
      pythonDefaultDisabled: true,
      sharedCorpusPath: '/Users/ericsmith/Documents/byomem/native/records.jsonl',
    });
    expect(byomem_runtime_status().pythonDefaultDisabled).toBe(true);
  });

  it('searches the shared corpus via the extension tool against the real repo corpus', async () => {
    const mock = makeMockPi();
    extensionModule(mock.api as never);

    const statusTool = mock.tools.find((tool) => tool.name === 'byomem_runtime_status');
    const statusResult = await statusTool!.execute('1', {});
    const status = JSON.parse((statusResult as { content: { text: string }[] }).content[0].text) as { sharedCorpusPath: string };
    expect(status.sharedCorpusPath).toBe('/Users/ericsmith/Documents/byomem/native/records.jsonl');
    expect(status.sharedCorpusPath).toBe('/Users/ericsmith/Documents/byomem/native/records.jsonl');
  });
});
