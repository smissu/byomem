import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGraphDb, parseGraphReport } from '../src/graph-db.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeGraphifyFixture(projectDir: string): void {
  const graphDir = join(projectDir, 'graphify-out');
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, 'graph.json'), JSON.stringify({
    directed: true,
    multigraph: true,
    graph: {},
    nodes: [
      { id: 'alpha', label: 'alpha()', file_type: 'code', source_file: 'src/alpha.ts', source_location: 'L1', community: 0, norm_label: 'alpha()' },
      { id: 'beta', label: 'beta()', file_type: 'code', source_file: 'src/beta.ts', source_location: 'L2', community: 42, norm_label: 'beta()' },
      { id: 'gamma', label: 'gamma()', file_type: 'code', source_file: 'src/gamma.ts', source_location: 'L3', community: 42, norm_label: 'gamma()' },
    ],
    links: [
      { source: 'alpha', target: 'beta', _src: 'alpha', _tgt: 'beta', relation: 'calls', confidence: 'EXTRACTED', confidence_score: 1, weight: 1, source_file: 'src/alpha.ts', source_location: 'L4' },
      { source: 'beta', target: 'gamma', _src: 'beta', _tgt: 'gamma', relation: 'method', confidence: 'INFERRED', confidence_score: 0.8, weight: 1, source_file: 'src/beta.ts', source_location: 'L5' },
    ],
    hyperedges: [],
  }), 'utf8');
  writeFileSync(join(graphDir, 'GRAPH_REPORT.md'), `# Graph Report - fixture  (2026-05-07)

## Corpus Check
- 3 files · ~120 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3 nodes · 2 edges · 2 communities detected
- Extraction: 50% EXTRACTED · 50% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. \`alpha()\` - 1 edges

## Communities

### Community 0 - "Community 0"
Cohesion: 0.50
Nodes (1): alpha()

### Community 42 - "Community 42"
Cohesion: 0.25
Nodes (2): beta(), gamma()

- **1 isolated node(s):** \`delta()\`
- **Thin community \`Community 42\`** (2 nodes): \`beta()\`, \`gamma()\`

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does \`alpha()\` connect \`Community 0\` to \`Community 42\`?**
  _High betweenness centrality._
`, 'utf8');
}

describe('Sprint 63 native graph DB', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('imports graphify export data into an isolated graph sqlite store without using native memory files', () => {
    const runtimeDir = tempDir('byomem-sprint-63-runtime-');
    const projectDir = tempDir('byomem-sprint-63-project-');
    dirs.push(runtimeDir, projectDir);
    writeGraphifyFixture(projectDir);

    const graphDb = openGraphDb({ baseDir: projectDir, dbBaseDir: runtimeDir });
    try {
      const update = graphDb.update();
      expect(update).toMatchObject({
        source: 'graphify-export',
        baseDir: projectDir,
        nodeCount: 3,
        edgeCount: 2,
        reportCommunityCount: 2,
      });
      expect(update.dbPath).toBe(join(runtimeDir, 'byomem-graph.sqlite'));
      expect(existsSync(join(runtimeDir, 'byomem-graph.sqlite'))).toBe(true);
      expect(existsSync(join(runtimeDir, 'byomem-index.sqlite'))).toBe(false);
      expect(existsSync(join(runtimeDir, 'native-store.json'))).toBe(false);

      const status = graphDb.status();
      expect(status).toMatchObject({
        nodeCount: 3,
        edgeCount: 2,
        reportCommunityCount: 2,
        nodeCommunityCount: 2,
        relationCounts: { calls: 1, method: 1 },
        confidenceCounts: { EXTRACTED: 1, INFERRED: 1 },
      });
      expect(status.lastImport?.reportStats).toMatchObject({
        reportDate: '2026-05-07',
        corpusFiles: 3,
        corpusWordsApprox: 120,
        summaryNodes: 3,
        summaryEdges: 2,
        summaryCommunities: 2,
        godNodeCount: 1,
        isolatedNodeCount: 1,
        thinCommunityCount: 1,
        suggestedQuestionCount: 1,
      });
    } finally {
      graphDb.close();
    }
  });

  it('queries, explains, and paths over imported graph records', () => {
    const runtimeDir = tempDir('byomem-sprint-63-runtime-');
    const projectDir = tempDir('byomem-sprint-63-project-');
    dirs.push(runtimeDir, projectDir);
    writeGraphifyFixture(projectDir);

    const graphDb = openGraphDb({ baseDir: projectDir, dbBaseDir: runtimeDir });
    try {
      graphDb.update();
      const query = graphDb.query({ query: 'alpha', limit: 1 });
      expect(query.results[0]).toMatchObject({
        node: { id: 'alpha', label: 'alpha()' },
        outDegree: 1,
      });
      expect(query.results[0]?.edges[0]).toMatchObject({ source: 'alpha', target: 'beta', relation: 'calls' });

      const explain = graphDb.explain({ query: 'beta', limit: 5 });
      expect(explain.node).toMatchObject({ id: 'beta', community: 42 });
      expect(explain.incoming[0]).toMatchObject({ source: 'alpha', target: 'beta' });
      expect(explain.outgoing[0]).toMatchObject({ source: 'beta', target: 'gamma' });
      expect(explain.reportCommunity).toMatchObject({ id: 42, name: 'Community 42' });

      const path = graphDb.pathQuery({ source: 'alpha', target: 'gamma', maxDepth: 3 });
      expect(path.found).toBe(true);
      expect(path.path.map((node) => node.id)).toEqual(['alpha', 'beta', 'gamma']);
      expect(path.edges.map((edge) => edge.relation)).toEqual(['calls', 'method']);
    } finally {
      graphDb.close();
    }
  });

  it('builds a native source graph when no graphify export exists', () => {
    const runtimeDir = tempDir('byomem-sprint-63-runtime-');
    const projectDir = tempDir('byomem-sprint-63-project-');
    dirs.push(runtimeDir, projectDir);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'alpha.ts'), `import { beta } from './beta';
export function alpha() {
  return beta();
}
`, 'utf8');

    const graphDb = openGraphDb({ baseDir: projectDir, dbBaseDir: runtimeDir });
    try {
      const update = graphDb.update({ mode: 'native-source' });
      expect(update.source).toBe('native-source');
      expect(update.nodeCount).toBeGreaterThanOrEqual(3);
      expect(update.edgeCount).toBeGreaterThanOrEqual(2);
      expect(graphDb.status().relationCounts).toMatchObject({
        contains: expect.any(Number),
        imports_from: expect.any(Number),
      });
    } finally {
      graphDb.close();
    }
  });

  it('keeps multiple project graphs isolated inside the same graph sqlite store', () => {
    const runtimeDir = tempDir('byomem-sprint-63-runtime-');
    const projectOne = tempDir('byomem-sprint-63-project-one-');
    const projectTwo = tempDir('byomem-sprint-63-project-two-');
    dirs.push(runtimeDir, projectOne, projectTwo);
    writeGraphifyFixture(projectOne);
    mkdirSync(join(projectTwo, 'src'), { recursive: true });
    writeFileSync(join(projectTwo, 'src', 'omega.ts'), 'export function omega() {\n  return 1;\n}\n', 'utf8');

    const graphDbOne = openGraphDb({ baseDir: projectOne, dbBaseDir: runtimeDir });
    const graphDbTwo = openGraphDb({ baseDir: projectTwo, dbBaseDir: runtimeDir });
    try {
      graphDbOne.update();
      graphDbTwo.update({ mode: 'native-source' });

      expect(graphDbOne.status()).toMatchObject({
        baseDir: projectOne,
        nodeCount: 3,
        edgeCount: 2,
        reportCommunityCount: 2,
      });
      expect(graphDbOne.query({ query: 'alpha', limit: 1 }).results[0]?.node.id).toBe('alpha');
      expect(graphDbTwo.status().baseDir).toBe(projectTwo);
      expect(graphDbTwo.query({ query: 'omega', limit: 1 }).results[0]?.node.label).toBe('omega()');
      expect(graphDbTwo.query({ query: 'alpha', limit: 1 }).results).toHaveLength(0);
    } finally {
      graphDbOne.close();
      graphDbTwo.close();
    }
  });

  it('parses graph report communities separately from graph node community ids', () => {
    const report = parseGraphReport(`## Summary
- 10 nodes · 5 edges · 1 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 0 edges (avg confidence: 0)
- Token cost: 0 input · 0 output

### Community 99 - "Community 99"
Cohesion: 0.12
Nodes (3): a(), b(), c()
`);
    expect(report.communities).toEqual([{ id: 99, name: 'Community 99', cohesion: 0.12, nodeCount: 3, preview: ['a()', 'b()', 'c()'] }]);
    expect(report.stats.summaryCommunities).toBe(1);
  });
});
