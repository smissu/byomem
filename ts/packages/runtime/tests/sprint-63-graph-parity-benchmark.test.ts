import { afterEach, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGraphDb, type GraphDbHandle, type GraphEdgeRecord, type GraphNodeRecord } from '../src/graph-db.js';

type ExpectedOverlap = {
  nodes?: string[];
  files?: string[];
  edges?: Array<{ source: string; target: string; relation: string }>;
};

type GraphNodeFixture = {
  id: string;
  label: string;
  file_type: string;
  source_file: string;
  source_location: string;
  community: number;
  norm_label: string;
};

type GraphEdgeFixture = {
  source: string;
  target: string;
  _src: string;
  _tgt: string;
  relation: string;
  confidence: 'EXTRACTED' | 'INFERRED';
  confidence_score: number;
  weight: number;
  source_file: string;
  source_location: string;
};

const FILES = {
  operationsServer: 'ts/packages/runtime/src/mcp/operations-server.ts',
  readonlyServer: 'ts/packages/runtime/src/mcp/readonly-server.ts',
  operationsTools: 'ts/packages/runtime/src/mcp/operations-tools.ts',
  readonlyTools: 'ts/packages/runtime/src/mcp/readonly-tools.ts',
  graphDb: 'ts/packages/runtime/src/graph-db.ts',
  fileSearchIndex: 'ts/packages/runtime/src/file-search-index.ts',
  fileSearchDb: 'ts/packages/runtime/src/file-search-db.ts',
} as const;

const NODE = {
  operationsServerFile: 'ts_packages_runtime_src_mcp_operations_server_ts',
  readonlyServerFile: 'ts_packages_runtime_src_mcp_readonly_server_ts',
  operationsToolsFile: 'ts_packages_runtime_src_mcp_operations_tools_ts',
  readonlyToolsFile: 'ts_packages_runtime_src_mcp_readonly_tools_ts',
  graphDbFile: 'ts_packages_runtime_src_graph_db_ts',
  fileSearchIndexFile: 'ts_packages_runtime_src_file_search_index_ts',
  fileSearchDbFile: 'ts_packages_runtime_src_file_search_db_ts',
  operationsBuildRuntimeContext: 'mcp_operations_server_buildruntimecontext',
  readonlyBuildRuntimeContext: 'mcp_readonly_server_buildruntimecontext',
  operationsGetRuntimeContext: 'mcp_operations_server_getruntimecontext',
  readonlyGetRuntimeContext: 'mcp_readonly_server_getruntimecontext',
  createOperationsMcpServer: 'mcp_operations_server_createoperationsmcpserver',
  registerOperationsTools: 'mcp_operations_tools_registeroperationstools',
  byomemGraphUpdate: 'mcp_operations_tools_byomem_graph_update',
  registerReadOnlyTools: 'mcp_readonly_tools_registerreadonlytools',
  byomemGraphQuery: 'mcp_readonly_tools_byomem_graph_query',
  openGraphDb: 'src_graph_db_opengraphdb',
  parseGraphReport: 'src_graph_db_parsegraphreport',
  fileSearchIndex: 'src_file_search_index_filesearchindex',
  buildFileSearchIndex: 'src_file_search_index_buildfilesearchindex',
  openFileSearchDb: 'src_file_search_db_openfilesearchdb',
} as const;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function graphNode(id: string, label: string, sourceFile: string, line: number, community: number): GraphNodeFixture {
  return {
    id,
    label,
    file_type: 'code',
    source_file: sourceFile,
    source_location: `L${line}`,
    community,
    norm_label: label.toLowerCase(),
  };
}

function graphEdge(source: string, target: string, relation: string, sourceFile: string, line: number, confidence: 'EXTRACTED' | 'INFERRED' = 'EXTRACTED'): GraphEdgeFixture {
  return {
    source,
    target,
    _src: source,
    _tgt: target,
    relation,
    confidence,
    confidence_score: confidence === 'EXTRACTED' ? 1 : 0.8,
    weight: 1,
    source_file: sourceFile,
    source_location: `L${line}`,
  };
}

function writeGraphifyStyleFixture(projectDir: string): void {
  const graphDir = join(projectDir, 'graphify-out');
  mkdirSync(graphDir, { recursive: true });
  const nodes: GraphNodeFixture[] = [
    graphNode(NODE.operationsServerFile, 'operations-server.ts', FILES.operationsServer, 1, 4),
    graphNode(NODE.readonlyServerFile, 'readonly-server.ts', FILES.readonlyServer, 1, 4),
    graphNode(NODE.operationsToolsFile, 'operations-tools.ts', FILES.operationsTools, 1, 4),
    graphNode(NODE.readonlyToolsFile, 'readonly-tools.ts', FILES.readonlyTools, 1, 4),
    graphNode(NODE.graphDbFile, 'graph-db.ts', FILES.graphDb, 1, 7),
    graphNode(NODE.fileSearchIndexFile, 'file-search-index.ts', FILES.fileSearchIndex, 1, 0),
    graphNode(NODE.fileSearchDbFile, 'file-search-db.ts', FILES.fileSearchDb, 1, 0),
    graphNode(NODE.operationsBuildRuntimeContext, 'buildRuntimeContext()', FILES.operationsServer, 21, 4),
    graphNode(NODE.readonlyBuildRuntimeContext, 'buildRuntimeContext()', FILES.readonlyServer, 17, 4),
    graphNode(NODE.operationsGetRuntimeContext, 'getRuntimeContext()', FILES.operationsServer, 61, 4),
    graphNode(NODE.readonlyGetRuntimeContext, 'getRuntimeContext()', FILES.readonlyServer, 43, 4),
    graphNode(NODE.createOperationsMcpServer, 'createOperationsMcpServer()', FILES.operationsServer, 66, 4),
    graphNode(NODE.registerOperationsTools, 'registerOperationsTools()', FILES.operationsTools, 322, 4),
    graphNode(NODE.byomemGraphUpdate, 'byomem_graph_update', FILES.operationsTools, 398, 4),
    graphNode(NODE.registerReadOnlyTools, 'registerReadOnlyTools()', FILES.readonlyTools, 36, 4),
    graphNode(NODE.byomemGraphQuery, 'byomem_graph_query', FILES.readonlyTools, 111, 4),
    graphNode(NODE.openGraphDb, 'openGraphDb()', FILES.graphDb, 765, 7),
    graphNode(NODE.parseGraphReport, 'parseGraphReport()', FILES.graphDb, 471, 7),
    graphNode(NODE.fileSearchIndex, 'FileSearchIndex', FILES.fileSearchIndex, 672, 0),
    graphNode(NODE.buildFileSearchIndex, 'buildFileSearchIndex()', FILES.fileSearchIndex, 1110, 0),
    graphNode(NODE.openFileSearchDb, 'openFileSearchDb()', FILES.fileSearchDb, 1582, 0),
  ];
  const links: GraphEdgeFixture[] = [
    graphEdge(NODE.operationsServerFile, NODE.operationsBuildRuntimeContext, 'contains', FILES.operationsServer, 21),
    graphEdge(NODE.readonlyServerFile, NODE.readonlyBuildRuntimeContext, 'contains', FILES.readonlyServer, 17),
    graphEdge(NODE.operationsServerFile, NODE.operationsGetRuntimeContext, 'contains', FILES.operationsServer, 61),
    graphEdge(NODE.readonlyServerFile, NODE.readonlyGetRuntimeContext, 'contains', FILES.readonlyServer, 43),
    graphEdge(NODE.operationsServerFile, NODE.createOperationsMcpServer, 'contains', FILES.operationsServer, 66),
    graphEdge(NODE.operationsToolsFile, NODE.registerOperationsTools, 'contains', FILES.operationsTools, 322),
    graphEdge(NODE.operationsToolsFile, NODE.byomemGraphUpdate, 'contains', FILES.operationsTools, 398),
    graphEdge(NODE.readonlyToolsFile, NODE.registerReadOnlyTools, 'contains', FILES.readonlyTools, 36),
    graphEdge(NODE.readonlyToolsFile, NODE.byomemGraphQuery, 'contains', FILES.readonlyTools, 111),
    graphEdge(NODE.graphDbFile, NODE.openGraphDb, 'contains', FILES.graphDb, 765),
    graphEdge(NODE.graphDbFile, NODE.parseGraphReport, 'contains', FILES.graphDb, 471),
    graphEdge(NODE.fileSearchIndexFile, NODE.fileSearchIndex, 'contains', FILES.fileSearchIndex, 672),
    graphEdge(NODE.fileSearchIndexFile, NODE.buildFileSearchIndex, 'contains', FILES.fileSearchIndex, 1110),
    graphEdge(NODE.fileSearchDbFile, NODE.openFileSearchDb, 'contains', FILES.fileSearchDb, 1582),
    graphEdge(NODE.operationsBuildRuntimeContext, NODE.operationsGetRuntimeContext, 'calls', FILES.operationsServer, 62),
    graphEdge(NODE.readonlyBuildRuntimeContext, NODE.readonlyGetRuntimeContext, 'calls', FILES.readonlyServer, 44),
    graphEdge(NODE.createOperationsMcpServer, NODE.registerOperationsTools, 'calls', FILES.operationsServer, 70, 'INFERRED'),
    graphEdge(NODE.registerOperationsTools, NODE.openGraphDb, 'calls', FILES.operationsTools, 409, 'INFERRED'),
    graphEdge(NODE.registerOperationsTools, NODE.byomemGraphUpdate, 'method', FILES.operationsTools, 398),
    graphEdge(NODE.registerReadOnlyTools, NODE.openGraphDb, 'calls', FILES.readonlyTools, 99, 'INFERRED'),
    graphEdge(NODE.registerReadOnlyTools, NODE.byomemGraphQuery, 'method', FILES.readonlyTools, 111),
    graphEdge(NODE.buildFileSearchIndex, NODE.fileSearchIndex, 'calls', FILES.fileSearchIndex, 1111, 'INFERRED'),
    graphEdge(NODE.fileSearchIndex, NODE.openFileSearchDb, 'calls', FILES.fileSearchIndex, 720, 'INFERRED'),
    graphEdge(NODE.operationsServerFile, NODE.operationsToolsFile, 'imports_from', FILES.operationsServer, 7),
    graphEdge(NODE.operationsToolsFile, NODE.graphDbFile, 'imports_from', FILES.operationsTools, 3),
    graphEdge(NODE.readonlyToolsFile, NODE.graphDbFile, 'imports_from', FILES.readonlyTools, 3),
    graphEdge(NODE.fileSearchIndexFile, NODE.fileSearchDbFile, 'imports_from', FILES.fileSearchIndex, 4),
  ];
  writeFileSync(join(graphDir, 'graph.json'), JSON.stringify({ directed: true, multigraph: true, graph: {}, nodes, links, hyperedges: [] }), 'utf8');
  writeFileSync(join(graphDir, 'GRAPH_REPORT.md'), `# Graph Report - sprint-63-parity-fixture  (2026-05-07)

## Corpus Check
- 7 files · ~1,400 words

## Summary
- ${nodes.length} nodes · ${links.length} edges · 3 communities detected
- Extraction: 85% EXTRACTED · 15% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. \`registerOperationsTools()\` - 3 edges
2. \`buildRuntimeContext()\` - 2 edges

## Communities

### Community 0 - "File Search"
Cohesion: 0.20
Nodes (4): FileSearchIndex, buildFileSearchIndex(), openFileSearchDb(), file-search-index.ts

### Community 4 - "MCP Runtime"
Cohesion: 0.24
Nodes (12): buildRuntimeContext(), getRuntimeContext(), registerOperationsTools(), registerReadOnlyTools()

### Community 7 - "Graph Runtime"
Cohesion: 0.30
Nodes (3): graph-db.ts, openGraphDb(), parseGraphReport()

## Suggested Questions

- **How does graph update connect to graph persistence?**
`, 'utf8');
}

function allFiles(nodes: GraphNodeRecord[]): string[] {
  return nodes.map((node) => node.sourceFile).filter((file): file is string => Boolean(file));
}

function assertNodeFileOverlap(nodes: GraphNodeRecord[], expected: ExpectedOverlap): void {
  if (expected.nodes) {
    const ids = new Set(nodes.map((node) => node.id));
    for (const id of expected.nodes) expect(ids.has(id), `expected node ${id}`).toBe(true);
  }
  if (expected.files) {
    const files = new Set(allFiles(nodes));
    for (const file of expected.files) expect(files.has(file), `expected file ${file}`).toBe(true);
  }
}

function assertEdgeOverlap(edges: GraphEdgeRecord[], expected: ExpectedOverlap): void {
  if (!expected.edges) return;
  for (const edge of expected.edges) {
    expect(
      edges.some((candidate) => candidate.source === edge.source && candidate.target === edge.target && candidate.relation === edge.relation),
      `expected edge ${edge.source} --${edge.relation}--> ${edge.target}`,
    ).toBe(true);
  }
}

describe('Sprint 63 graphify-style parity and benchmark coverage', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function openFixtureGraph(): GraphDbHandle {
    const runtimeDir = tempDir('byomem-sprint-63-graph-parity-runtime-');
    const projectDir = tempDir('byomem-sprint-63-graph-parity-project-');
    dirs.push(runtimeDir, projectDir);
    writeGraphifyStyleFixture(projectDir);
    const graphDb = openGraphDb({ baseDir: projectDir, dbBaseDir: runtimeDir });
    graphDb.update({ mode: 'graphify-export' });
    return graphDb;
  }

  it('asserts graphify-style query/explain/path overlap on expected nodes, files, and edges', () => {
    const graphDb = openFixtureGraph();
    try {
      const queryCases: Array<{ name: string; run: () => { nodes: GraphNodeRecord[]; edges: GraphEdgeRecord[] }; expected: ExpectedOverlap }> = [
        {
          name: 'architecture query for MCP runtime context',
          run: () => {
            const result = graphDb.query({ query: 'buildRuntimeContext', limit: 5 });
            return { nodes: result.results.map((entry) => entry.node), edges: result.results.flatMap((entry) => entry.edges) };
          },
          expected: {
            nodes: [NODE.operationsBuildRuntimeContext, NODE.readonlyBuildRuntimeContext],
            files: [FILES.operationsServer, FILES.readonlyServer],
            edges: [{ source: NODE.operationsBuildRuntimeContext, target: NODE.operationsGetRuntimeContext, relation: 'calls' }],
          },
        },
        {
          name: 'graph persistence query',
          run: () => {
            const result = graphDb.query({ query: 'openGraphDb', limit: 5 });
            return { nodes: result.results.map((entry) => entry.node), edges: result.results.flatMap((entry) => entry.edges) };
          },
          expected: {
            nodes: [NODE.openGraphDb],
            files: [FILES.graphDb],
            edges: [{ source: NODE.registerOperationsTools, target: NODE.openGraphDb, relation: 'calls' }],
          },
        },
        {
          name: 'file-search graph query',
          run: () => {
            const result = graphDb.query({ query: 'FileSearchIndex', limit: 5 });
            return { nodes: result.results.map((entry) => entry.node), edges: result.results.flatMap((entry) => entry.edges) };
          },
          expected: {
            nodes: [NODE.fileSearchIndex],
            files: [FILES.fileSearchIndex],
            edges: [{ source: NODE.buildFileSearchIndex, target: NODE.fileSearchIndex, relation: 'calls' }],
          },
        },
        {
          name: 'report parser query',
          run: () => {
            const result = graphDb.query({ query: 'parseGraphReport', limit: 5 });
            return { nodes: result.results.map((entry) => entry.node), edges: result.results.flatMap((entry) => entry.edges) };
          },
          expected: {
            nodes: [NODE.parseGraphReport],
            files: [FILES.graphDb],
          },
        },
        {
          name: 'operations update explain',
          run: () => {
            const result = graphDb.explain({ query: 'registerOperationsTools()', limit: 10 });
            return { nodes: [result.node, ...result.matches.map((entry) => entry.node)].filter((node): node is GraphNodeRecord => Boolean(node)), edges: [...result.incoming, ...result.outgoing] };
          },
          expected: {
            nodes: [NODE.registerOperationsTools],
            files: [FILES.operationsTools],
            edges: [
              { source: NODE.createOperationsMcpServer, target: NODE.registerOperationsTools, relation: 'calls' },
              { source: NODE.registerOperationsTools, target: NODE.openGraphDb, relation: 'calls' },
            ],
          },
        },
        {
          name: 'readonly graph tool explain',
          run: () => {
            const result = graphDb.explain({ query: 'registerReadOnlyTools()', limit: 10 });
            return { nodes: [result.node, ...result.matches.map((entry) => entry.node)].filter((node): node is GraphNodeRecord => Boolean(node)), edges: [...result.incoming, ...result.outgoing] };
          },
          expected: {
            nodes: [NODE.registerReadOnlyTools],
            files: [FILES.readonlyTools],
            edges: [{ source: NODE.registerReadOnlyTools, target: NODE.openGraphDb, relation: 'calls' }],
          },
        },
        {
          name: 'operations context path',
          run: () => {
            const result = graphDb.pathQuery({ source: NODE.operationsBuildRuntimeContext, target: NODE.operationsGetRuntimeContext, maxDepth: 2 });
            return { nodes: result.path, edges: result.edges };
          },
          expected: {
            nodes: [NODE.operationsBuildRuntimeContext, NODE.operationsGetRuntimeContext],
            files: [FILES.operationsServer],
            edges: [{ source: NODE.operationsBuildRuntimeContext, target: NODE.operationsGetRuntimeContext, relation: 'calls' }],
          },
        },
        {
          name: 'operations graph update persistence path',
          run: () => {
            const result = graphDb.pathQuery({ source: NODE.registerOperationsTools, target: NODE.openGraphDb, maxDepth: 2 });
            return { nodes: result.path, edges: result.edges };
          },
          expected: {
            nodes: [NODE.registerOperationsTools, NODE.openGraphDb],
            files: [FILES.operationsTools, FILES.graphDb],
            edges: [{ source: NODE.registerOperationsTools, target: NODE.openGraphDb, relation: 'calls' }],
          },
        },
      ];

      expect(queryCases).toHaveLength(8);
      for (const testCase of queryCases) {
        const actual = testCase.run();
        assertNodeFileOverlap(actual.nodes, testCase.expected);
        assertEdgeOverlap(actual.edges, testCase.expected);
      }
    } finally {
      graphDb.close();
    }
  });

  it('keeps graphify-style in-process graph queries inside a stable benchmark envelope', () => {
    const graphDb = openFixtureGraph();
    try {
      const operations = [
        () => graphDb.query({ query: 'buildRuntimeContext', limit: 5 }),
        () => graphDb.query({ query: 'openGraphDb', limit: 5 }),
        () => graphDb.query({ query: 'FileSearchIndex', limit: 5 }),
        () => graphDb.explain({ query: 'registerOperationsTools()', limit: 10 }),
        () => graphDb.explain({ query: 'registerReadOnlyTools()', limit: 10 }),
        () => graphDb.pathQuery({ source: NODE.operationsBuildRuntimeContext, target: NODE.operationsGetRuntimeContext, maxDepth: 2 }),
        () => graphDb.pathQuery({ source: NODE.registerOperationsTools, target: NODE.openGraphDb, maxDepth: 2 }),
      ];
      const times: number[] = [];
      for (let iteration = 0; iteration < 30; iteration += 1) {
        const startedAt = performance.now();
        for (const operation of operations) operation();
        times.push(performance.now() - startedAt);
      }
      const averageMs = times.reduce((total, value) => total + value, 0) / times.length;
      expect(averageMs).toBeLessThan(25);
    } finally {
      graphDb.close();
    }
  });
});
