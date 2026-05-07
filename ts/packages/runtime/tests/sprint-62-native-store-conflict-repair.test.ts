import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { inspectNativeStoreConflict, repairNativeStoreConflict } from '../src/store.js';
import { normalizeLeafName } from '../src/normalizers.js';
import { openNativeStore } from '../src/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-sprint-62-native-store-'));
}

function jsonRecordId(leafName: string): string {
  return `project:byomem:root:${normalizeLeafName(leafName)}`;
}

function makeJsonOnlyRecord(): {
  id: string;
  scope: 'project';
  identity: { namespace: string; leafName: string; parentContext: string };
  provenance: { source: string; adapter: string; origin: string };
  content: { text: string };
  metadata: { createdAt: string; updatedAt: string };
} {
  return {
    id: jsonRecordId('json only record'),
    scope: 'project',
    identity: { namespace: 'byomem', leafName: 'json only record', parentContext: 'root' },
    provenance: { source: 'legacy-json', adapter: 'json', origin: 'fixture' },
    content: { text: 'json only body' },
    metadata: { createdAt: '2026-01-04T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z' },
  };
}

async function seedConflictFixture(dir: string): Promise<{
  identicalId: string;
  differingId: string;
  sqliteOnlyId: string;
  jsonOnlyId: string;
  jsonRecords: Array<ReturnType<typeof makeJsonOnlyRecord> | Record<string, unknown>>;
}> {
  const store = openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' });
  try {
    const identicalSeed = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'shared record', parentContext: 'root' },
      content: { text: 'shared body' },
      provenance: { source: 'sqlite-seed', adapter: 'native-store' },
    });
    const differingSeed = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'different record', parentContext: 'root' },
      content: { text: 'sqlite body' },
      provenance: { source: 'sqlite-seed', adapter: 'native-store' },
    });
    const sqliteOnly = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'sqlite only record', parentContext: 'root' },
      content: { text: 'sqlite only body' },
      provenance: { source: 'sqlite-seed', adapter: 'native-store' },
    });

    const jsonOnly = makeJsonOnlyRecord();
    const identical = store.read(identicalSeed.id)!;
    const differing = store.read(differingSeed.id)!;
    const jsonRecords = [
      identical,
      {
        ...differing,
        content: { ...differing.content, text: 'json body' },
        provenance: { ...differing.provenance, source: 'legacy-json', adapter: 'json' },
        metadata: { ...differing.metadata, updatedAt: '2026-01-03T00:00:00.000Z' },
      },
      jsonOnly,
    ];
    return {
      identicalId: identical.id,
      differingId: differing.id,
      sqliteOnlyId: sqliteOnly.id,
      jsonOnlyId: jsonOnly.id,
      jsonRecords,
    };
  } finally {
    store.close();
  }
}

function writeLegacySnapshot(dir: string, records: Array<Record<string, unknown>>): void {
  writeFileSync(join(dir, 'native-store.json'), `${JSON.stringify({ version: 1, records }, null, 2)}\n`, 'utf8');
}

function readBackupPath(dir: string): string | undefined {
  return readdirSync(dir).find((entry) => entry.startsWith('native-store.json.backup-'));
}

describe('Sprint 62 native-store conflict repair', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('inspects conflicting JSON and SQLite records without mutating either file', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const fixture = await seedConflictFixture(dir);
    writeLegacySnapshot(dir, fixture.jsonRecords);

    const inspection = inspectNativeStoreConflict({ baseDir: dir });

    expect(inspection).toMatchObject({
      jsonPath: join(dir, 'native-store.json'),
      memoryDbPath: join(dir, 'byomem-index.sqlite'),
      jsonCount: 3,
      sqliteCount: 3,
      identical: { ids: [fixture.identicalId], count: 1 },
      differing: { ids: [fixture.differingId], count: 1 },
      jsonOnly: { ids: [fixture.jsonOnlyId], count: 1 },
      sqliteOnly: { ids: [fixture.sqliteOnlyId], count: 1 },
    });
    expect(existsSync(join(dir, 'native-store.json'))).toBe(true);
    expect(existsSync(join(dir, 'native-store.json.backup-'))).toBe(false);
  });

  it('prints inspect output from the CLI and advertises the command in help', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const fixture = await seedConflictFixture(dir);
    writeLegacySnapshot(dir, fixture.jsonRecords);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['--help']);
    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      commands: expect.arrayContaining(['native-store-inspect', 'native-store-repair']),
    });

    spy.mockClear();
    await main(['native-store-inspect', '--base-dir', dir]);
    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      inspection: {
        jsonPath: join(dir, 'native-store.json'),
        memoryDbPath: join(dir, 'byomem-index.sqlite'),
        differing: { ids: [fixture.differingId], count: 1 },
      },
    });
  });

  it('dry-runs sqlite-authority repair without mutating the snapshot', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const fixture = await seedConflictFixture(dir);
    writeLegacySnapshot(dir, fixture.jsonRecords);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['native-store-repair', '--base-dir', dir, '--authority', 'sqlite', '--dry-run']);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      repair: {
        authority: 'sqlite',
        dryRun: true,
        applied: false,
        inspection: {
          differing: { ids: [fixture.differingId], count: 1 },
        },
      },
    });
    expect(existsSync(join(dir, 'native-store.json'))).toBe(true);
    expect(readBackupPath(dir)).toBeUndefined();
  });

  it('repairs with sqlite authority by moving JSON aside and keeping SQLite authoritative', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const fixture = await seedConflictFixture(dir);
    writeLegacySnapshot(dir, fixture.jsonRecords);

    const result = repairNativeStoreConflict({ baseDir: dir, authority: 'sqlite' });

    expect(result).toMatchObject({
      authority: 'sqlite',
      dryRun: false,
      applied: true,
      inspection: {
        differing: { ids: [fixture.differingId], count: 1 },
      },
    });
    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
    const backup = readBackupPath(dir);
    expect(backup).toMatch(/^native-store\.json\.backup-/);
    expect(readFileSync(join(dir, backup!), 'utf8')).toContain('json body');

    const reopened = openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' });
    try {
      expect(reopened.list().map((record) => record.id)).toEqual([fixture.differingId, fixture.identicalId, fixture.sqliteOnlyId].sort());
    } finally {
      reopened.close();
    }
  });

  it('repairs with json authority by replacing SQLite contents and backing up JSON', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const fixture = await seedConflictFixture(dir);
    writeLegacySnapshot(dir, fixture.jsonRecords);

    const result = repairNativeStoreConflict({ baseDir: dir, authority: 'json' });

    expect(result).toMatchObject({
      authority: 'json',
      dryRun: false,
      applied: true,
      inspection: {
        jsonOnly: { ids: [fixture.jsonOnlyId], count: 1 },
      },
    });
    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
    const backup = readBackupPath(dir);
    expect(backup).toMatch(/^native-store\.json\.backup-/);
    expect(readFileSync(join(dir, backup!), 'utf8')).toContain('json only body');

    const reopened = openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' });
    try {
      expect(reopened.list().map((record) => record.id)).toEqual(fixture.jsonRecords.map((record) => String(record.id)).sort());
    } finally {
      reopened.close();
    }
  });

  it('aborts repair without mutating files when authority is abort', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const fixture = await seedConflictFixture(dir);
    writeLegacySnapshot(dir, fixture.jsonRecords);

    const result = repairNativeStoreConflict({ baseDir: dir, authority: 'abort' });

    expect(result).toMatchObject({
      authority: 'abort',
      dryRun: false,
      applied: false,
      aborted: true,
      inspection: {
        differing: { ids: [fixture.differingId], count: 1 },
      },
    });
    expect(existsSync(join(dir, 'native-store.json'))).toBe(true);
    expect(readBackupPath(dir)).toBeUndefined();
  });

  it('rejects invalid repair authority before mutating JSON or SQLite state', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const fixture = await seedConflictFixture(dir);
    writeLegacySnapshot(dir, fixture.jsonRecords);

    expect(() => repairNativeStoreConflict({
      baseDir: dir,
      authority: 'unknown' as never,
    })).toThrow(/repair authority/i);

    expect(existsSync(join(dir, 'native-store.json'))).toBe(true);
    expect(readBackupPath(dir)).toBeUndefined();
    expect(inspectNativeStoreConflict({ baseDir: dir })).toMatchObject({
      jsonCount: 3,
      sqliteCount: 3,
      differing: { ids: [fixture.differingId], count: 1 },
      jsonOnly: { ids: [fixture.jsonOnlyId], count: 1 },
      sqliteOnly: { ids: [fixture.sqliteOnlyId], count: 1 },
    });
  });
});
