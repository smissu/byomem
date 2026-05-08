import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { buildNativeSourceGraph } from './graph-builder.js';

const DEFAULT_GRAPH_DB_FILE = 'byomem-graph.sqlite';
const GRAPH_SCHEMA_VERSION = 1;

export interface GraphDbOptions {
  baseDir?: string;
  dbBaseDir?: string;
  dbFile?: string;
  readonly?: boolean;
}

export interface GraphNodeRecord {
  id: string;
  label: string;
  fileType?: string;
  sourceFile?: string;
  sourceLocation?: string;
  community?: number;
  normLabel?: string;
  kind?: string;
}

export interface GraphEdgeRecord {
  id?: string;
  source: string;
  target: string;
  relation: string;
  confidence?: string;
  confidenceScore?: number;
  weight?: number;
  sourceFile?: string;
  sourceLocation?: string;
}

export interface GraphCommunityRecord {
  id: number;
  name: string;
  cohesion?: number;
  nodeCount?: number;
  preview?: string[];
}

export interface GraphReportStats {
  reportDate?: string;
  corpusFiles?: number;
  corpusWordsApprox?: number;
  summaryNodes?: number;
  summaryEdges?: number;
  summaryCommunities?: number;
  extractedPercent?: number;
  inferredPercent?: number;
  ambiguousPercent?: number;
  inferredEdges?: number;
  averageInferredConfidence?: number;
  tokenInput?: number;
  tokenOutput?: number;
  godNodeCount: number;
  isolatedNodeCount?: number;
  thinCommunityCount: number;
  suggestedQuestionCount: number;
}

export interface GraphStatus {
  dbPath: string;
  baseDir: string;
  projectKey: string;
  nodeCount: number;
  edgeCount: number;
  reportCommunityCount: number;
  nodeCommunityCount: number;
  relationCounts: Record<string, number>;
  confidenceCounts: Record<string, number>;
  lastImport?: {
    source: string;
    importedAt: string;
    fingerprint: string;
    nodeCount: number;
    edgeCount: number;
    reportCommunityCount: number;
    reportStats?: GraphReportStats;
  };
}

export interface GraphQueryOptions {
  query: string;
  limit?: number;
}

export interface GraphExplainOptions {
  query: string;
  limit?: number;
}

export interface GraphPathOptions {
  source: string;
  target: string;
  maxDepth?: number;
}

export interface GraphUpdateOptions {
  baseDir?: string;
  graphJsonPath?: string;
  reportPath?: string;
  mode?: 'auto' | 'graphify-export' | 'native-source';
  allowNativeDowngrade?: boolean;
}

export interface GraphImportResult {
  source: string;
  dbPath: string;
  baseDir: string;
  projectKey: string;
  fingerprint: string;
  nodeCount: number;
  edgeCount: number;
  reportCommunityCount: number;
  reportStats?: GraphReportStats;
  skipped?: boolean;
  skipReason?: string;
}

export interface GraphDbHandle {
  path: string;
  baseDir: string;
  db: BetterSqliteDatabase;
  close(): void;
  status(): GraphStatus;
  importGraph(input: GraphImportInput): GraphImportResult;
  update(options?: GraphUpdateOptions): GraphImportResult;
  query(options: GraphQueryOptions): GraphQueryResult;
  explain(options: GraphExplainOptions): GraphExplainResult;
  pathQuery(options: GraphPathOptions): GraphPathResult;
}

export interface GraphImportInput {
  source: string;
  baseDir?: string;
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
  reportCommunities?: GraphCommunityRecord[];
  reportStats?: GraphReportStats;
  raw?: unknown;
}

export interface GraphQueryResult {
  query: string;
  results: Array<{
    node: GraphNodeRecord;
    score: number;
    inDegree: number;
    outDegree: number;
    edges: GraphEdgeRecord[];
  }>;
  status: Pick<GraphStatus, 'nodeCount' | 'edgeCount' | 'reportCommunityCount'>;
}

export interface GraphExplainResult {
  query: string;
  node?: GraphNodeRecord;
  matches: GraphQueryResult['results'];
  incoming: GraphEdgeRecord[];
  outgoing: GraphEdgeRecord[];
  reportCommunity?: GraphCommunityRecord;
}

export interface GraphPathResult {
  source: string;
  target: string;
  maxDepth: number;
  found: boolean;
  path: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
}

type GraphifyNode = {
  id?: unknown;
  label?: unknown;
  file_type?: unknown;
  source_file?: unknown;
  source_location?: unknown;
  community?: unknown;
  norm_label?: unknown;
};

type GraphifyEdge = {
  source?: unknown;
  target?: unknown;
  _src?: unknown;
  _tgt?: unknown;
  relation?: unknown;
  confidence?: unknown;
  confidence_score?: unknown;
  weight?: unknown;
  source_file?: unknown;
  source_location?: unknown;
};

function resolveDefaultRuntimeBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BYOMEM_RUNTIME_BASE_DIR?.trim();
  return override ? resolve(override) : resolve(homedir(), '.byomem', 'runtime');
}

export function resolveDefaultGraphDbPath(options: Pick<GraphDbOptions, 'dbBaseDir' | 'dbFile'> = {}): string {
  const dbFile = options.dbFile?.trim() || DEFAULT_GRAPH_DB_FILE;
  if (dbFile === ':memory:') return dbFile;
  if (dbFile.startsWith('/') || dbFile.startsWith('.')) return resolve(dbFile);
  const dbBaseDir = options.dbBaseDir?.trim() ? resolve(options.dbBaseDir) : resolveDefaultRuntimeBaseDir();
  return resolve(dbBaseDir, dbFile);
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeInteger(value: unknown): number | undefined {
  const parsed = normalizeNumber(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

function normalizeGraphLabel(label: string): string {
  return label.trim().toLowerCase();
}

function stableId(parts: Array<string | undefined>): string {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part ?? '').update('\0');
  return hash.digest('hex').slice(0, 24);
}

function graphProjectKey(baseDir: string): string {
  const resolved = resolve(baseDir);
  const hash = createHash('sha1').update(resolved).digest('hex').slice(0, 12);
  return `project:${basename(resolved)}-${hash}`;
}

function tableColumns(db: BetterSqliteDatabase, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

function dropLegacyUnscopedGraphTables(db: BetterSqliteDatabase): void {
  const graphNodesColumns = tableColumns(db, 'graph_nodes');
  if (graphNodesColumns.size > 0 && !graphNodesColumns.has('project_key')) {
    db.exec(`
      DROP TABLE IF EXISTS graph_nodes_fts;
      DROP TABLE IF EXISTS graph_edges;
      DROP TABLE IF EXISTS graph_nodes;
      DROP TABLE IF EXISTS graph_report_communities;
      DROP TABLE IF EXISTS graph_imports;
    `);
  }
}

function ensureGraphSchema(db: BetterSqliteDatabase): void {
  dropLegacyUnscopedGraphTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR REPLACE INTO graph_schema_meta(key, value) VALUES ('schema_version', '${GRAPH_SCHEMA_VERSION}');

    CREATE TABLE IF NOT EXISTS graph_imports (
      project_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      source TEXT NOT NULL,
      base_dir TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      node_count INTEGER NOT NULL,
      edge_count INTEGER NOT NULL,
      report_community_count INTEGER NOT NULL,
      report_stats_json TEXT,
      PRIMARY KEY(project_key, fingerprint)
    );

    CREATE TABLE IF NOT EXISTS graph_nodes (
      project_key TEXT NOT NULL,
      id TEXT NOT NULL,
      label TEXT NOT NULL,
      file_type TEXT,
      source_file TEXT,
      source_location TEXT,
      community INTEGER,
      norm_label TEXT,
      kind TEXT,
      raw_json TEXT,
      PRIMARY KEY(project_key, id)
    );

    CREATE TABLE IF NOT EXISTS graph_edges (
      project_key TEXT NOT NULL,
      id TEXT NOT NULL,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      relation TEXT NOT NULL,
      confidence TEXT,
      confidence_score REAL,
      weight REAL,
      source_file TEXT,
      source_location TEXT,
      raw_json TEXT,
      PRIMARY KEY(project_key, id)
    );

    CREATE TABLE IF NOT EXISTS graph_report_communities (
      project_key TEXT NOT NULL,
      id INTEGER NOT NULL,
      name TEXT NOT NULL,
      cohesion REAL,
      node_count INTEGER,
      preview_json TEXT,
      PRIMARY KEY(project_key, id)
    );

    CREATE INDEX IF NOT EXISTS graph_edges_project_source_idx ON graph_edges(project_key, source);
    CREATE INDEX IF NOT EXISTS graph_edges_project_target_idx ON graph_edges(project_key, target);
    CREATE INDEX IF NOT EXISTS graph_edges_project_relation_idx ON graph_edges(project_key, relation);
    CREATE INDEX IF NOT EXISTS graph_nodes_project_norm_label_idx ON graph_nodes(project_key, norm_label);
    CREATE INDEX IF NOT EXISTS graph_nodes_project_community_idx ON graph_nodes(project_key, community);
  `);
}

function nodeFromRow(row: Record<string, unknown>): GraphNodeRecord {
  return {
    id: String(row.id),
    label: String(row.label),
    fileType: normalizeText(row.file_type),
    sourceFile: normalizeText(row.source_file),
    sourceLocation: normalizeText(row.source_location),
    community: normalizeInteger(row.community),
    normLabel: normalizeText(row.norm_label),
    kind: normalizeText(row.kind),
  };
}

function edgeFromRow(row: Record<string, unknown>): GraphEdgeRecord {
  return {
    id: String(row.id),
    source: String(row.source),
    target: String(row.target),
    relation: String(row.relation),
    confidence: normalizeText(row.confidence),
    confidenceScore: normalizeNumber(row.confidence_score),
    weight: normalizeNumber(row.weight),
    sourceFile: normalizeText(row.source_file),
    sourceLocation: normalizeText(row.source_location),
  };
}

function communityFromRow(row: Record<string, unknown>): GraphCommunityRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    cohesion: normalizeNumber(row.cohesion),
    nodeCount: normalizeInteger(row.node_count),
    preview: JSON.parse(String(row.preview_json ?? '[]')) as string[],
  };
}

function graphFingerprint(input: GraphImportInput): string {
  const hash = createHash('sha256');
  hash.update(input.source).update('\0');
  hash.update(String(input.nodes.length)).update('\0');
  hash.update(String(input.edges.length)).update('\0');
  for (const node of input.nodes) hash.update(node.id).update('\0').update(node.label).update('\0');
  for (const edge of input.edges) hash.update(edge.source).update('\0').update(edge.target).update('\0').update(edge.relation).update('\0');
  return hash.digest('hex');
}

function importGraph(db: BetterSqliteDatabase, dbPath: string, baseDir: string, input: GraphImportInput): GraphImportResult {
  const projectKey = graphProjectKey(baseDir);
  const fingerprint = graphFingerprint(input);
  const importedAt = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM graph_edges WHERE project_key = ?').run(projectKey);
    db.prepare('DELETE FROM graph_nodes WHERE project_key = ?').run(projectKey);
    db.prepare('DELETE FROM graph_report_communities WHERE project_key = ?').run(projectKey);
    const insertNode = db.prepare(`
      INSERT INTO graph_nodes(project_key, id, label, file_type, source_file, source_location, community, norm_label, kind, raw_json)
      VALUES (@projectKey, @id, @label, @fileType, @sourceFile, @sourceLocation, @community, @normLabel, @kind, @rawJson)
    `);
    const insertEdge = db.prepare(`
      INSERT INTO graph_edges(project_key, id, source, target, relation, confidence, confidence_score, weight, source_file, source_location, raw_json)
      VALUES (@projectKey, @id, @source, @target, @relation, @confidence, @confidenceScore, @weight, @sourceFile, @sourceLocation, @rawJson)
    `);
    const insertCommunity = db.prepare(`
      INSERT INTO graph_report_communities(project_key, id, name, cohesion, node_count, preview_json)
      VALUES (@projectKey, @id, @name, @cohesion, @nodeCount, @previewJson)
    `);
    for (const node of input.nodes) {
      insertNode.run({
        projectKey,
        ...node,
        fileType: node.fileType ?? null,
        sourceFile: node.sourceFile ?? null,
        sourceLocation: node.sourceLocation ?? null,
        community: node.community ?? null,
        normLabel: node.normLabel ?? normalizeGraphLabel(node.label),
        kind: node.kind ?? null,
        rawJson: JSON.stringify(node),
      });
    }
    for (const edge of input.edges) {
      const id = edge.id ?? stableId([edge.source, edge.target, edge.relation, edge.sourceFile, edge.sourceLocation]);
      insertEdge.run({
        projectKey,
        ...edge,
        id,
        confidence: edge.confidence ?? null,
        confidenceScore: edge.confidenceScore ?? null,
        weight: edge.weight ?? null,
        sourceFile: edge.sourceFile ?? null,
        sourceLocation: edge.sourceLocation ?? null,
        rawJson: JSON.stringify({ ...edge, id }),
      });
    }
    for (const community of input.reportCommunities ?? []) {
      insertCommunity.run({
        projectKey,
        id: community.id,
        name: community.name,
        cohesion: community.cohesion ?? null,
        nodeCount: community.nodeCount ?? null,
        previewJson: JSON.stringify(community.preview ?? []),
      });
    }
    db.prepare(`
      INSERT OR REPLACE INTO graph_imports(project_key, fingerprint, source, base_dir, imported_at, node_count, edge_count, report_community_count, report_stats_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(projectKey, fingerprint, input.source, baseDir, importedAt, input.nodes.length, input.edges.length, input.reportCommunities?.length ?? 0, input.reportStats ? JSON.stringify(input.reportStats) : null);
  });
  transaction();
  return {
    source: input.source,
    dbPath,
    baseDir,
    projectKey,
    fingerprint,
    nodeCount: input.nodes.length,
    edgeCount: input.edges.length,
    reportCommunityCount: input.reportCommunities?.length ?? 0,
    reportStats: input.reportStats,
  };
}

function parseGraphifyGraphJson(raw: unknown, baseDir: string): Pick<GraphImportInput, 'nodes' | 'edges' | 'raw'> {
  if (!raw || typeof raw !== 'object') throw new Error('graph.json must be an object');
  const graph = raw as { nodes?: unknown; links?: unknown };
  if (!Array.isArray(graph.nodes)) throw new Error('graph.json missing nodes array');
  if (!Array.isArray(graph.links)) throw new Error('graph.json missing links array');
  const nodes = (graph.nodes as GraphifyNode[]).map((node, index) => {
    const id = normalizeText(node.id);
    const label = normalizeText(node.label);
    if (!id || !label) throw new Error(`graph.json node ${index} missing id or label`);
    return {
      id,
      label,
      fileType: normalizeText(node.file_type),
      sourceFile: relativizeSourceFile(normalizeText(node.source_file), baseDir),
      sourceLocation: normalizeText(node.source_location),
      community: normalizeInteger(node.community),
      normLabel: normalizeText(node.norm_label) ?? normalizeGraphLabel(label),
      kind: 'graphify-node',
    };
  });
  const edges = (graph.links as GraphifyEdge[]).map((edge, index) => {
    const source = normalizeText(edge.source) ?? normalizeText(edge._src);
    const target = normalizeText(edge.target) ?? normalizeText(edge._tgt);
    const relation = normalizeText(edge.relation);
    if (!source || !target || !relation) throw new Error(`graph.json edge ${index} missing source, target, or relation`);
    return {
      id: stableId([source, target, relation, normalizeText(edge.source_file), normalizeText(edge.source_location)]),
      source,
      target,
      relation,
      confidence: normalizeText(edge.confidence),
      confidenceScore: normalizeNumber(edge.confidence_score),
      weight: normalizeNumber(edge.weight),
      sourceFile: relativizeSourceFile(normalizeText(edge.source_file), baseDir),
      sourceLocation: normalizeText(edge.source_location),
    };
  });
  return { nodes, edges, raw };
}

function relativizeSourceFile(sourceFile: string | undefined, baseDir: string): string | undefined {
  if (!sourceFile) return undefined;
  const resolvedBase = resolve(baseDir);
  const resolvedSource = resolve(sourceFile);
  if (resolvedSource.startsWith(`${resolvedBase}${sep}`)) return relative(resolvedBase, resolvedSource);
  return sourceFile;
}

export function parseGraphReport(content: string): { communities: GraphCommunityRecord[]; stats: GraphReportStats } {
  const reportDate = content.match(/^# Graph Report[^\n]*\(([^)]+)\)/m)?.[1];
  const corpus = content.match(/^- ([\d,]+) files · ~([\d,]+) words/m);
  const summary = content.match(/^- ([\d,]+) nodes · ([\d,]+) edges · ([\d,]+) communities detected/m);
  const extraction = content.match(/^- Extraction: ([\d.]+)% EXTRACTED · ([\d.]+)% INFERRED · ([\d.]+)% AMBIGUOUS · INFERRED: ([\d,]+) edges \(avg confidence: ([\d.]+)\)/m);
  const tokenCost = content.match(/^- Token cost: ([\d,]+) input · ([\d,]+) output/m);
  const communities: GraphCommunityRecord[] = [];
  const communityPattern = /^### Community (\d+) - "([^"]+)"\nCohesion: ([\d.]+)\nNodes \((\d+)\): ([^\n]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = communityPattern.exec(content)) !== null) {
    communities.push({
      id: Number(match[1]),
      name: match[2],
      cohesion: Number(match[3]),
      nodeCount: Number(match[4]),
      preview: match[5].split(',').map((part) => part.trim()).filter(Boolean),
    });
  }
  return {
    communities,
    stats: {
      reportDate,
      corpusFiles: corpus ? Number(corpus[1].replaceAll(',', '')) : undefined,
      corpusWordsApprox: corpus ? Number(corpus[2].replaceAll(',', '')) : undefined,
      summaryNodes: summary ? Number(summary[1].replaceAll(',', '')) : undefined,
      summaryEdges: summary ? Number(summary[2].replaceAll(',', '')) : undefined,
      summaryCommunities: summary ? Number(summary[3].replaceAll(',', '')) : undefined,
      extractedPercent: extraction ? Number(extraction[1]) : undefined,
      inferredPercent: extraction ? Number(extraction[2]) : undefined,
      ambiguousPercent: extraction ? Number(extraction[3]) : undefined,
      inferredEdges: extraction ? Number(extraction[4].replaceAll(',', '')) : undefined,
      averageInferredConfidence: extraction ? Number(extraction[5]) : undefined,
      tokenInput: tokenCost ? Number(tokenCost[1].replaceAll(',', '')) : undefined,
      tokenOutput: tokenCost ? Number(tokenCost[2].replaceAll(',', '')) : undefined,
      godNodeCount: (content.match(/^\d+\. `[^`]+` - \d+ edges$/gm) ?? []).length,
      isolatedNodeCount: (() => {
        const isolated = content.match(/- \*\*(\d+) isolated node\(s\):/);
        return isolated ? Number(isolated[1]) : undefined;
      })(),
      thinCommunityCount: (content.match(/^- \*\*Thin community /gm) ?? []).length,
      suggestedQuestionCount: (content.match(/^- \*\*.+\?\*\*$/gm) ?? []).length,
    },
  };
}

function importGraphifyExport(db: BetterSqliteDatabase, dbPath: string, baseDir: string, graphJsonPath: string, reportPath?: string): GraphImportResult {
  const raw = JSON.parse(readFileSync(graphJsonPath, 'utf8')) as unknown;
  const graphInput = parseGraphifyGraphJson(raw, baseDir);
  const report = reportPath && existsSync(reportPath) ? parseGraphReport(readFileSync(reportPath, 'utf8')) : undefined;
  return importGraph(db, dbPath, baseDir, {
    source: 'graphify-export',
    baseDir,
    nodes: graphInput.nodes,
    edges: graphInput.edges,
    reportCommunities: report?.communities,
    reportStats: report?.stats,
    raw,
  });
}

function updateGraph(db: BetterSqliteDatabase, dbPath: string, defaultBaseDir: string, options: GraphUpdateOptions = {}): GraphImportResult {
  const baseDir = resolve(options.baseDir ?? defaultBaseDir);
  const graphJsonPath = options.graphJsonPath ? resolve(options.graphJsonPath) : join(baseDir, 'graphify-out', 'graph.json');
  const reportPath = options.reportPath ? resolve(options.reportPath) : join(baseDir, 'graphify-out', 'GRAPH_REPORT.md');
  const mode = options.mode ?? 'native-source';
  if ((mode === 'auto' || mode === 'graphify-export') && existsSync(graphJsonPath)) {
    return importGraphifyExport(db, dbPath, baseDir, graphJsonPath, reportPath);
  }
  if (mode === 'graphify-export') throw new Error(`graphify export not found: ${graphJsonPath}`);
  const nativeGraph = buildNativeSourceGraph(baseDir);
  const current = status(db, dbPath, baseDir);
  const materiallySmaller = current.nodeCount > 0
    && (nativeGraph.nodes.length < current.nodeCount * 0.8 || nativeGraph.edges.length < current.edgeCount * 0.8);
  if (materiallySmaller && !options.allowNativeDowngrade) {
    return {
      source: current.lastImport?.source ?? 'existing-graph',
      dbPath,
      baseDir,
      projectKey: current.projectKey,
      fingerprint: current.lastImport?.fingerprint ?? stableId([current.projectKey, String(current.nodeCount), String(current.edgeCount)]),
      nodeCount: current.nodeCount,
      edgeCount: current.edgeCount,
      reportCommunityCount: current.reportCommunityCount,
      reportStats: current.lastImport?.reportStats,
      skipped: true,
      skipReason: `native-source output (${nativeGraph.nodes.length} nodes/${nativeGraph.edges.length} edges) is materially smaller than existing graph (${current.nodeCount} nodes/${current.edgeCount} edges)`,
    };
  }
  return importGraph(db, dbPath, baseDir, nativeGraph);
}

function latestImport(db: BetterSqliteDatabase, projectKey: string): GraphStatus['lastImport'] | undefined {
  const row = db.prepare('SELECT * FROM graph_imports WHERE project_key = ? ORDER BY imported_at DESC LIMIT 1').get(projectKey) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    source: String(row.source),
    importedAt: String(row.imported_at),
    fingerprint: String(row.fingerprint),
    nodeCount: Number(row.node_count),
    edgeCount: Number(row.edge_count),
    reportCommunityCount: Number(row.report_community_count),
    reportStats: row.report_stats_json ? JSON.parse(String(row.report_stats_json)) as GraphReportStats : undefined,
  };
}

function status(db: BetterSqliteDatabase, dbPath: string, baseDir: string): GraphStatus {
  const projectKey = graphProjectKey(baseDir);
  const nodeCount = Number((db.prepare('SELECT COUNT(*) AS count FROM graph_nodes WHERE project_key = ?').get(projectKey) as { count: number }).count);
  const edgeCount = Number((db.prepare('SELECT COUNT(*) AS count FROM graph_edges WHERE project_key = ?').get(projectKey) as { count: number }).count);
  const reportCommunityCount = Number((db.prepare('SELECT COUNT(*) AS count FROM graph_report_communities WHERE project_key = ?').get(projectKey) as { count: number }).count);
  const nodeCommunityCount = Number((db.prepare('SELECT COUNT(DISTINCT community) AS count FROM graph_nodes WHERE project_key = ? AND community IS NOT NULL').get(projectKey) as { count: number }).count);
  const relationCounts: Record<string, number> = {};
  const confidenceCounts: Record<string, number> = {};
  for (const row of db.prepare('SELECT relation, COUNT(*) AS count FROM graph_edges WHERE project_key = ? GROUP BY relation').all(projectKey) as Array<{ relation: string; count: number }>) relationCounts[row.relation] = row.count;
  for (const row of db.prepare("SELECT COALESCE(confidence, 'UNKNOWN') AS confidence, COUNT(*) AS count FROM graph_edges WHERE project_key = ? GROUP BY confidence").all(projectKey) as Array<{ confidence: string; count: number }>) confidenceCounts[row.confidence] = row.count;
  return { dbPath, baseDir, projectKey, nodeCount, edgeCount, reportCommunityCount, nodeCommunityCount, relationCounts, confidenceCounts, lastImport: latestImport(db, projectKey) };
}

function degreeCounts(db: BetterSqliteDatabase, projectKey: string, nodeId: string): { inDegree: number; outDegree: number } {
  const inDegree = Number((db.prepare('SELECT COUNT(*) AS count FROM graph_edges WHERE project_key = ? AND target = ?').get(projectKey, nodeId) as { count: number }).count);
  const outDegree = Number((db.prepare('SELECT COUNT(*) AS count FROM graph_edges WHERE project_key = ? AND source = ?').get(projectKey, nodeId) as { count: number }).count);
  return { inDegree, outDegree };
}

function adjacentEdges(db: BetterSqliteDatabase, projectKey: string, nodeId: string, limit: number): GraphEdgeRecord[] {
  return (db.prepare(`
    SELECT * FROM graph_edges
    WHERE project_key = ? AND (source = ? OR target = ?)
    ORDER BY weight DESC, relation ASC
    LIMIT ?
  `).all(projectKey, nodeId, nodeId, limit) as Array<Record<string, unknown>>).map(edgeFromRow);
}

function queryGraph(db: BetterSqliteDatabase, baseDir: string, options: GraphQueryOptions): GraphQueryResult {
  const projectKey = graphProjectKey(baseDir);
  const query = options.query.trim();
  if (!query) throw new Error('graph query is required');
  const limit = options.limit ?? 10;
  const like = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const rows = db.prepare(`
    SELECT n.*,
      CASE
        WHEN lower(n.label) = lower(?) THEN 100
        WHEN lower(n.norm_label) = lower(?) THEN 90
        WHEN lower(n.label) LIKE lower(?) THEN 60
        WHEN lower(COALESCE(n.source_file, '')) LIKE lower(?) THEN 35
        ELSE 10
      END AS score
    FROM graph_nodes n
    WHERE n.project_key = ?
      AND (lower(n.label) LIKE lower(?) ESCAPE '\\'
      OR lower(COALESCE(n.norm_label, '')) LIKE lower(?) ESCAPE '\\'
      OR lower(COALESCE(n.source_file, '')) LIKE lower(?) ESCAPE '\\')
    ORDER BY score DESC, label ASC
    LIMIT ?
  `).all(query, query, like, like, projectKey, like, like, like, limit) as Array<Record<string, unknown>>;
  const results = rows.map((row) => {
    const node = nodeFromRow(row);
    const degree = degreeCounts(db, projectKey, node.id);
    return {
      node,
      score: Number(row.score),
      ...degree,
      edges: adjacentEdges(db, projectKey, node.id, 5),
    };
  });
  const current = status(db, '', baseDir);
  return { query, results, status: { nodeCount: current.nodeCount, edgeCount: current.edgeCount, reportCommunityCount: current.reportCommunityCount } };
}

function explainGraph(db: BetterSqliteDatabase, baseDir: string, options: GraphExplainOptions): GraphExplainResult {
  const projectKey = graphProjectKey(baseDir);
  const matches = queryGraph(db, baseDir, { query: options.query, limit: options.limit ?? 5 }).results;
  const node = matches[0]?.node;
  if (!node) return { query: options.query, matches, incoming: [], outgoing: [] };
  const incoming = (db.prepare('SELECT * FROM graph_edges WHERE project_key = ? AND target = ? ORDER BY weight DESC, relation ASC LIMIT ?').all(projectKey, node.id, options.limit ?? 10) as Array<Record<string, unknown>>).map(edgeFromRow);
  const outgoing = (db.prepare('SELECT * FROM graph_edges WHERE project_key = ? AND source = ? ORDER BY weight DESC, relation ASC LIMIT ?').all(projectKey, node.id, options.limit ?? 10) as Array<Record<string, unknown>>).map(edgeFromRow);
  const reportCommunity = node.community === undefined ? undefined : (() => {
    const row = db.prepare('SELECT * FROM graph_report_communities WHERE project_key = ? AND id = ?').get(projectKey, node.community) as Record<string, unknown> | undefined;
    return row ? communityFromRow(row) : undefined;
  })();
  return { query: options.query, node, matches, incoming, outgoing, reportCommunity };
}

function resolveNodeForPath(db: BetterSqliteDatabase, baseDir: string, value: string): GraphNodeRecord | undefined {
  const projectKey = graphProjectKey(baseDir);
  const exact = db.prepare('SELECT * FROM graph_nodes WHERE project_key = ? AND (id = ? OR lower(label) = lower(?) OR lower(norm_label) = lower(?)) LIMIT 1').get(projectKey, value, value, value) as Record<string, unknown> | undefined;
  if (exact) return nodeFromRow(exact);
  return queryGraph(db, baseDir, { query: value, limit: 1 }).results[0]?.node;
}

function pathGraph(db: BetterSqliteDatabase, baseDir: string, options: GraphPathOptions): GraphPathResult {
  const projectKey = graphProjectKey(baseDir);
  const maxDepth = options.maxDepth ?? 4;
  const source = resolveNodeForPath(db, baseDir, options.source);
  const target = resolveNodeForPath(db, baseDir, options.target);
  if (!source || !target) return { source: options.source, target: options.target, maxDepth, found: false, path: source ? [source] : [], edges: [] };
  const queue: Array<{ id: string; nodePath: string[]; edgePath: GraphEdgeRecord[] }> = [{ id: source.id, nodePath: [source.id], edgePath: [] }];
  const seen = new Set([source.id]);
  const edgeStmt = db.prepare('SELECT * FROM graph_edges WHERE project_key = ? AND (source = ? OR target = ?) ORDER BY weight DESC, relation ASC LIMIT 200');
  while (queue.length) {
    const current = queue.shift()!;
    if (current.id === target.id) {
      const placeholders = current.nodePath.map(() => '?').join(',');
      const nodeRows = db.prepare(`SELECT * FROM graph_nodes WHERE project_key = ? AND id IN (${placeholders})`).all(projectKey, ...current.nodePath) as Array<Record<string, unknown>>;
      const byId = new Map(nodeRows.map((row) => [String(row.id), nodeFromRow(row)]));
      return { source: source.id, target: target.id, maxDepth, found: true, path: current.nodePath.map((id) => byId.get(id)).filter((node): node is GraphNodeRecord => Boolean(node)), edges: current.edgePath };
    }
    if (current.edgePath.length >= maxDepth) continue;
    for (const edge of (edgeStmt.all(projectKey, current.id, current.id) as Array<Record<string, unknown>>).map(edgeFromRow)) {
      const nextId = edge.source === current.id ? edge.target : edge.source;
      if (seen.has(nextId)) continue;
      seen.add(nextId);
      queue.push({ id: nextId, nodePath: [...current.nodePath, nextId], edgePath: [...current.edgePath, edge] });
    }
  }
  return { source: source.id, target: target.id, maxDepth, found: false, path: [source], edges: [] };
}

export function openGraphDb(options: GraphDbOptions = {}): GraphDbHandle {
  const baseDir = resolve(options.baseDir ?? process.cwd());
  const path = resolveDefaultGraphDbPath(options);
  const readOnly = Boolean(options.readonly);
  if (!readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const missingReadonlyDiskDb = readOnly && path !== ':memory:' && !existsSync(path);
  const db = missingReadonlyDiskDb
    ? new Database(':memory:')
    : new Database(path, readOnly ? { readonly: true, fileMustExist: path !== ':memory:' } : undefined);
  if (!readOnly || missingReadonlyDiskDb) ensureGraphSchema(db);
  return {
    path,
    baseDir,
    db,
    close(): void {
      db.close();
    },
    status(): GraphStatus {
      return status(db, path, baseDir);
    },
    importGraph(input: GraphImportInput): GraphImportResult {
      if (readOnly) throw new Error('graph DB is read-only');
      return importGraph(db, path, resolve(input.baseDir ?? baseDir), input);
    },
    update(options?: GraphUpdateOptions): GraphImportResult {
      if (readOnly) throw new Error('graph DB is read-only');
      return updateGraph(db, path, baseDir, options);
    },
    query(options: GraphQueryOptions): GraphQueryResult {
      return queryGraph(db, baseDir, options);
    },
    explain(options: GraphExplainOptions): GraphExplainResult {
      return explainGraph(db, baseDir, options);
    },
    pathQuery(options: GraphPathOptions): GraphPathResult {
      return pathGraph(db, baseDir, options);
    },
  };
}
