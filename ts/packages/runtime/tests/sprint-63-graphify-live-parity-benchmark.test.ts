import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openGraphDb, type GraphDbHandle, type GraphEdgeRecord, type GraphNodeRecord } from '../src/graph-db.js';

type GraphFacts = {
  labels: Set<string>;
  files: Set<string>;
  relations: Set<string>;
};

type BenchmarkCase = {
  name: string;
  graphifyArgs: string[];
  byomemRun: (graphDb: GraphDbHandle) => { facts: GraphFacts; found?: boolean };
  minLabelOverlap: number;
  minFileOverlap?: number;
  minRelationOverlap?: number;
};

const baseDir = process.cwd();
const graphJsonPath = join(baseDir, 'graphify-out', 'graph.json');

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function emptyFacts(): GraphFacts {
  return { labels: new Set(), files: new Set(), relations: new Set() };
}

function addNode(facts: GraphFacts, node: GraphNodeRecord | undefined): void {
  if (!node) return;
  facts.labels.add(normalize(node.label));
  if (node.sourceFile) facts.files.add(node.sourceFile);
}

function addEdge(facts: GraphFacts, edge: GraphEdgeRecord): void {
  facts.relations.add(edge.relation);
  if (edge.sourceFile) facts.files.add(edge.sourceFile);
}

function factsFromNodesAndEdges(nodes: GraphNodeRecord[], edges: GraphEdgeRecord[]): GraphFacts {
  const facts = emptyFacts();
  for (const node of nodes) addNode(facts, node);
  for (const edge of edges) addEdge(facts, edge);
  return facts;
}

function extractGraphifyFacts(output: string): GraphFacts {
  const facts = emptyFacts();
  for (const match of output.matchAll(/^NODE\s+(.+?)\s+\[src=([^\]\s]+)/gm)) {
    facts.labels.add(normalize(match[1]));
    facts.files.add(match[2]);
  }
  for (const match of output.matchAll(/^Node:\s+(.+)$/gm)) facts.labels.add(normalize(match[1]));
  for (const match of output.matchAll(/Source:\s+(\S+)/g)) facts.files.add(match[1]);
  for (const match of output.matchAll(/-->\s*(.+?)\s+\[([a-z_]+)\]\s+\[/gi)) {
    facts.labels.add(normalize(match[1]));
    facts.relations.add(match[2]);
  }
  for (const line of output.split('\n')) {
    if (!line.includes('--')) continue;
    for (const relation of line.matchAll(/--([a-z_]+)\s+\[/gi)) facts.relations.add(relation[1]);
    for (const label of line.trim().split(/\s+--[a-z_]+\s+\[[^\]]+\]-->\s+/i)) {
      const cleaned = label.trim();
      if (cleaned && !cleaned.startsWith('Shortest path')) facts.labels.add(normalize(cleaned));
    }
  }
  return facts;
}

function overlap(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => right.has(value)).sort();
}

function hasGraphifyCli(): boolean {
  try {
    execFileSync('graphify', ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasLiveGraphifyBaseline = existsSync(graphJsonPath) && hasGraphifyCli();
const describeLive = hasLiveGraphifyBaseline ? describe : describe.skip;

describeLive('Sprint 63 live graphify-vs-BYOMem graph search parity benchmark', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function openLiveGraph(): GraphDbHandle {
    const runtimeDir = tempDir('byomem-sprint-63-live-graph-parity-runtime-');
    dirs.push(runtimeDir);
    const graphDb = openGraphDb({ baseDir, dbBaseDir: runtimeDir });
    graphDb.update({ mode: 'graphify-export' });
    return graphDb;
  }

  function runGraphify(args: string[]): { facts: GraphFacts; elapsedMs: number; output: string } {
    const startedAt = performance.now();
    const output = execFileSync('graphify', [...args, '--graph', graphJsonPath], { cwd: baseDir, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return { facts: extractGraphifyFacts(output), elapsedMs: performance.now() - startedAt, output };
  }

  it('compares graphify query/explain/path results with BYOMem graph search overlap', () => {
    const graphDb = openLiveGraph();
    try {
      const cases: BenchmarkCase[] = [
        {
          name: 'query openGraphDb',
          graphifyArgs: ['query', 'openGraphDb'],
          byomemRun: (db) => {
            const result = db.query({ query: 'openGraphDb', limit: 20 });
            return { facts: factsFromNodesAndEdges(result.results.map((entry) => entry.node), result.results.flatMap((entry) => entry.edges)) };
          },
          minLabelOverlap: 1,
          minFileOverlap: 1,
        },
        {
          name: 'query FileSearchIndex',
          graphifyArgs: ['query', 'FileSearchIndex'],
          byomemRun: (db) => {
            const result = db.query({ query: 'FileSearchIndex', limit: 20 });
            return { facts: factsFromNodesAndEdges(result.results.map((entry) => entry.node), result.results.flatMap((entry) => entry.edges)) };
          },
          minLabelOverlap: 1,
          minFileOverlap: 1,
        },
        {
          name: 'query buildRuntimeContext',
          graphifyArgs: ['query', 'buildRuntimeContext'],
          byomemRun: (db) => {
            const result = db.query({ query: 'buildRuntimeContext', limit: 20 });
            return { facts: factsFromNodesAndEdges(result.results.map((entry) => entry.node), result.results.flatMap((entry) => entry.edges)) };
          },
          minLabelOverlap: 1,
          minFileOverlap: 1,
        },
        {
          name: 'query openNativeStore',
          graphifyArgs: ['query', 'openNativeStore'],
          byomemRun: (db) => {
            const result = db.query({ query: 'openNativeStore', limit: 20 });
            return { facts: factsFromNodesAndEdges(result.results.map((entry) => entry.node), result.results.flatMap((entry) => entry.edges)) };
          },
          minLabelOverlap: 1,
          minFileOverlap: 1,
        },
        {
          name: 'explain openGraphDb',
          graphifyArgs: ['explain', 'openGraphDb()'],
          byomemRun: (db) => {
            const result = db.explain({ query: 'openGraphDb()', limit: 20 });
            return { facts: factsFromNodesAndEdges([result.node, ...result.matches.map((entry) => entry.node)].filter((node): node is GraphNodeRecord => Boolean(node)), [...result.incoming, ...result.outgoing]) };
          },
          minLabelOverlap: 1,
          minFileOverlap: 1,
          minRelationOverlap: 1,
        },
        {
          name: 'explain FileSearchIndex',
          graphifyArgs: ['explain', 'FileSearchIndex'],
          byomemRun: (db) => {
            const result = db.explain({ query: 'FileSearchIndex', limit: 20 });
            return { facts: factsFromNodesAndEdges([result.node, ...result.matches.map((entry) => entry.node)].filter((node): node is GraphNodeRecord => Boolean(node)), [...result.incoming, ...result.outgoing]) };
          },
          minLabelOverlap: 1,
          minFileOverlap: 1,
          minRelationOverlap: 1,
        },
        {
          name: 'path registerOperationsTools to openGraphDb',
          graphifyArgs: ['path', 'registerOperationsTools()', 'openGraphDb()'],
          byomemRun: (db) => {
            const result = db.pathQuery({ source: 'registerOperationsTools()', target: 'openGraphDb()', maxDepth: 4 });
            return { facts: factsFromNodesAndEdges(result.path, result.edges), found: result.found };
          },
          minLabelOverlap: 3,
          minRelationOverlap: 2,
        },
        {
          name: 'path buildRuntimeContext to getRuntimeContext',
          graphifyArgs: ['path', 'buildRuntimeContext()', 'getRuntimeContext()'],
          byomemRun: (db) => {
            const result = db.pathQuery({ source: 'buildRuntimeContext()', target: 'getRuntimeContext()', maxDepth: 3 });
            return { facts: factsFromNodesAndEdges(result.path, result.edges), found: result.found };
          },
          minLabelOverlap: 2,
          minRelationOverlap: 1,
        },
      ];

      const byomemTimes: number[] = [];
      const graphifyTimes: number[] = [];
      for (const testCase of cases) {
        const graphify = runGraphify(testCase.graphifyArgs);
        expect(graphify.output, `${testCase.name} graphify output`).not.toContain('No path found');
        graphifyTimes.push(graphify.elapsedMs);

        const startedAt = performance.now();
        const byomem = testCase.byomemRun(graphDb);
        byomemTimes.push(performance.now() - startedAt);
        expect(byomem.found ?? true, `${testCase.name} BYOMem path found`).toBe(true);

        expect(overlap(graphify.facts.labels, byomem.facts.labels).length, `${testCase.name} label overlap`).toBeGreaterThanOrEqual(testCase.minLabelOverlap);
        if (testCase.minFileOverlap) expect(overlap(graphify.facts.files, byomem.facts.files).length, `${testCase.name} file overlap`).toBeGreaterThanOrEqual(testCase.minFileOverlap);
        if (testCase.minRelationOverlap) expect(overlap(graphify.facts.relations, byomem.facts.relations).length, `${testCase.name} relation overlap`).toBeGreaterThanOrEqual(testCase.minRelationOverlap);
      }

      const byomemAverageMs = byomemTimes.reduce((total, value) => total + value, 0) / byomemTimes.length;
      const graphifyAverageMs = graphifyTimes.reduce((total, value) => total + value, 0) / graphifyTimes.length;
      expect(byomemAverageMs).toBeLessThan(50);
      expect(graphifyAverageMs).toBeGreaterThan(0);
    } finally {
      graphDb.close();
    }
  });
});
