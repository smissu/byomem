import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-cli-'));
}

describe('runtime cli', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('prints JSON usage for --help', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--help']);
    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({ error: 'Usage', commands: expect.arrayContaining(['store', 'search', 'prune', 'generate']) });
    spy.mockRestore();
  });

  it('prints JSON usage for generation errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await main(['generate']);
    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({ error: 'Missing --prompt, --text, or --messages for generate', command: 'generate', usage: { error: 'Usage' } });
    errSpy.mockRestore();
  });

  it('does not open the store for generation-only commands', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['generate', '--prompt', 'hello']);
    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({ result: 'hello' });
    spy.mockRestore();
  });

  it('store creates DB and snapshot artifacts', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['store', '--base-dir', dir, '--input', JSON.stringify({ scope: 'project', identity: { namespace: 'byomem', leafName: 'CLI Alpha', parentContext: 'root' }, content: { text: 'cli body' }, provenance: { source: 'fixtures' } })]);
    expect(existsSync(join(dir, 'native-store.json'))).toBe(true);
    expect(existsSync(join(dir, 'byomem-index.sqlite'))).toBe(true);
    spy.mockRestore();
  });
});
