import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGraphDb } from '../src/graph-db.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function labels(result: ReturnType<ReturnType<typeof openGraphDb>['query']>): string[] {
  return result.results.map((entry) => entry.node.label);
}

describe('Sprints 66-69 native graph parity', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('builds Graphify-like TypeScript symbols and relationships from native source', () => {
    const runtimeDir = tempDir('byomem-graph-parity-runtime-');
    const projectDir = tempDir('byomem-graph-parity-ts-');
    dirs.push(runtimeDir, projectDir);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'model.ts'), `
export interface Persistable {
  save(): void;
}

export type TradeId = string;

export enum Side {
  Call = 'CALL',
  Put = 'PUT',
}

export class BaseTracker {
  reset() {
    return true;
  }
}
`, 'utf8');
    writeFileSync(join(projectDir, 'src', 'tracker.ts'), `
import { BaseTracker, Side } from './model';

export function emitProgress() {
  return Side.Call;
}

export class EntryProgressTracker extends BaseTracker {
  getProgress() {
    return emitProgress();
  }
}
`, 'utf8');
    writeFileSync(join(projectDir, 'src', 'a_child.ts'), `
import { LaterBase } from './z_base';

export class LateTracker extends LaterBase {
  run() {
    return laterCall();
  }
}
`, 'utf8');
    writeFileSync(join(projectDir, 'src', 'z_base.ts'), `
export function laterCall() {
  return true;
}

export class LaterBase {}
`, 'utf8');

    const graphDb = openGraphDb({ baseDir: projectDir, dbBaseDir: runtimeDir });
    try {
      const update = graphDb.update({ mode: 'native-source' });
      expect(update.source).toBe('native-source');
      expect(update.reportCommunityCount).toBeGreaterThan(0);
      expect(update.edgeCount).toBeGreaterThan(8);
      expect(graphDb.status().relationCounts).toMatchObject({
        contains: expect.any(Number),
        imports_from: expect.any(Number),
        calls: expect.any(Number),
        method: expect.any(Number),
      });
      expect(labels(graphDb.query({ query: 'Persistable', limit: 5 }))).toContain('Persistable');
      expect(labels(graphDb.query({ query: 'TradeId', limit: 5 }))).toContain('TradeId');
      expect(labels(graphDb.query({ query: 'Side', limit: 5 }))).toContain('Side');
      expect(labels(graphDb.query({ query: 'EntryProgressTracker', limit: 5 }))).toContain('EntryProgressTracker');
      const lateTracker = graphDb.explain({ query: 'LateTracker', limit: 20 });
      expect([...lateTracker.incoming, ...lateTracker.outgoing].some((edge) => edge.relation === 'extends')).toBe(true);
      const explain = graphDb.explain({ query: 'EntryProgressTracker.getProgress', limit: 20 });
      expect(explain.node?.label).toBe('EntryProgressTracker.getProgress()');
      expect([...explain.incoming, ...explain.outgoing].some((edge) => edge.relation === 'calls')).toBe(true);
      expect(graphDb.pathQuery({ source: 'tracker.ts', target: 'model.ts', maxDepth: 2 }).found).toBe(true);
    } finally {
      graphDb.close();
    }
  });

  it('builds Graphify-like Python symbols and relationships from native source', () => {
    const runtimeDir = tempDir('byomem-graph-parity-runtime-');
    const projectDir = tempDir('byomem-graph-parity-py-');
    dirs.push(runtimeDir, projectDir);
    mkdirSync(join(projectDir, 'pkg'), { recursive: true });
    writeFileSync(join(projectDir, 'pkg', 'base.py'), `
class BaseTracker:
    def reset(self):
        return True

def emit_progress():
    return 1
`, 'utf8');
    writeFileSync(join(projectDir, 'pkg', 'entry.py'), `
from base import BaseTracker
from base import emit_progress

class EntryProgressTracker(BaseTracker):
    def get_progress(self):

        return emit_progress()
`, 'utf8');
    writeFileSync(join(projectDir, 'pkg', 'a_entry.py'), `
from z_base import LaterBase

class LateTracker(LaterBase):
    def run(self):

        return later_call()
`, 'utf8');
    writeFileSync(join(projectDir, 'pkg', 'z_base.py'), `
class LaterBase:
    pass

def later_call():
    return 1
`, 'utf8');

    const graphDb = openGraphDb({ baseDir: projectDir, dbBaseDir: runtimeDir });
    try {
      const update = graphDb.update({ mode: 'native-source' });
      expect(update.source).toBe('native-source');
      expect(update.nodeCount).toBeGreaterThanOrEqual(6);
      expect(graphDb.status().relationCounts).toMatchObject({
        contains: expect.any(Number),
        imports_from: expect.any(Number),
        calls: expect.any(Number),
        method: expect.any(Number),
        extends: expect.any(Number),
      });
      expect(labels(graphDb.query({ query: 'EntryProgressTracker', limit: 5 }))).toContain('EntryProgressTracker');
      expect(labels(graphDb.query({ query: 'get_progress', limit: 5 }))).toContain('EntryProgressTracker.get_progress()');
      const explain = graphDb.explain({ query: 'EntryProgressTracker.get_progress', limit: 20 });
      expect([...explain.incoming, ...explain.outgoing].some((edge) => edge.relation === 'calls')).toBe(true);
      const lateTracker = graphDb.explain({ query: 'LateTracker', limit: 20 });
      expect([...lateTracker.incoming, ...lateTracker.outgoing].some((edge) => edge.relation === 'extends')).toBe(true);
      const lateRun = graphDb.explain({ query: 'LateTracker.run', limit: 20 });
      expect([...lateRun.incoming, ...lateRun.outgoing].some((edge) => edge.relation === 'calls')).toBe(true);
    } finally {
      graphDb.close();
    }
  });

  it('ignores virtualenv and generated dependency directories during native graph builds', () => {
    const runtimeDir = tempDir('byomem-graph-parity-runtime-');
    const projectDir = tempDir('byomem-graph-parity-ignore-');
    dirs.push(runtimeDir, projectDir);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    mkdirSync(join(projectDir, '.venv', 'lib', 'python3.12', 'site-packages', 'external'), { recursive: true });
    mkdirSync(join(projectDir, 'vendor_repo', 'packages', 'external'), { recursive: true });
    writeFileSync(join(projectDir, '.gitignore'), 'vendor_repo/\n', 'utf8');
    writeFileSync(join(projectDir, 'src', 'keeper.ts'), `
export function projectResolve() {
  return true;
}
`, 'utf8');
    writeFileSync(join(projectDir, '.venv', 'lib', 'python3.12', 'site-packages', 'external', 'noise.py'), `
class ExternalOnly:
    def noisy_method(self):
        return True

def noisy_resolve():
    return ExternalOnly()
`, 'utf8');
    writeFileSync(join(projectDir, 'vendor_repo', 'packages', 'external', 'ignored.ts'), `
export function vendoredOnly() {
  return true;
}
`, 'utf8');

    const graphDb = openGraphDb({ baseDir: projectDir, dbBaseDir: runtimeDir });
    try {
      graphDb.update({ mode: 'native-source' });
      expect(labels(graphDb.query({ query: 'projectResolve', limit: 5 }))).toContain('projectResolve()');
      expect(graphDb.query({ query: 'ExternalOnly', limit: 5 }).results).toHaveLength(0);
      expect(graphDb.query({ query: 'site-packages', limit: 5 }).results).toHaveLength(0);
      expect(graphDb.query({ query: 'vendoredOnly', limit: 5 }).results).toHaveLength(0);
      expect(graphDb.query({ query: 'vendor_repo', limit: 5 }).results).toHaveLength(0);
    } finally {
      graphDb.close();
    }
  });

  it('does not silently replace a richer graph with materially smaller native-source output', () => {
    const runtimeDir = tempDir('byomem-graph-parity-runtime-');
    const projectDir = tempDir('byomem-graph-parity-safe-');
    dirs.push(runtimeDir, projectDir);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'small.ts'), 'export function onlyOne() { return 1; }\n', 'utf8');
    const nodes = Array.from({ length: 20 }, (_, index) => ({
      id: `rich_${index}`,
      label: `rich${index}()`,
      sourceFile: 'src/rich.ts',
      sourceLocation: `L${index + 1}`,
      kind: 'graphify-node',
    }));
    const edges = nodes.slice(1).map((node, index) => ({
      source: nodes[index]!.id,
      target: node.id,
      relation: 'calls',
      sourceFile: 'src/rich.ts',
      sourceLocation: `L${index + 1}`,
    }));

    const graphDb = openGraphDb({ baseDir: projectDir, dbBaseDir: runtimeDir });
    try {
      graphDb.importGraph({ source: 'graphify-export', baseDir: projectDir, nodes, edges });
      const update = graphDb.update({ mode: 'native-source' });
      expect(update.skipped).toBe(true);
      expect(update.source).toBe('graphify-export');
      expect(update.nodeCount).toBe(20);
      expect(graphDb.status().nodeCount).toBe(20);

      const forced = graphDb.update({ mode: 'native-source', allowNativeDowngrade: true });
      expect(forced.skipped).toBeUndefined();
      expect(forced.source).toBe('native-source');
      expect(forced.nodeCount).toBeLessThan(20);
    } finally {
      graphDb.close();
    }
  });
});
