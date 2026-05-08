import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { openGraphDb, type GraphDbHandle, type GraphEdgeRecord, type GraphNodeRecord } from './graph-db.js';

export type FileSearchGraphHit = {
  score?: unknown;
  source?: unknown;
  chunk?: {
    filePath?: unknown;
    content?: unknown;
    startLine?: unknown;
    endLine?: unknown;
    language?: unknown;
  };
};

export type FileSearchGraphContext = {
  available: boolean;
  fileNode?: GraphContextNode;
  nearestSymbols?: GraphContextNode[];
  importsFrom?: string[];
  relations?: GraphContextEdge[];
};

export type GraphContextNode = {
  id: string;
  label: string;
  sourceFile?: string;
  sourceLocation?: string;
  kind?: string;
};

export type GraphContextEdge = {
  source: string;
  target: string;
  relation: string;
  sourceFile?: string;
  sourceLocation?: string;
};

export type FileSearchGraphLimits = {
  nearestSymbols?: number;
  importsFrom?: number;
  relations?: number;
};

export type FileSearchGraphContextOptions = {
  baseDir: string;
  dbBaseDir?: string;
  graphDb?: GraphDbHandle;
  limits?: FileSearchGraphLimits;
};

const DEFAULT_LIMITS = {
  nearestSymbols: 5,
  importsFrom: 10,
  relations: 10,
};

type DbLike = GraphDbHandle['db'];

type FileGraphEntry = {
  sourceFile: string;
  fileNode: GraphContextNode;
  importsFrom: string[];
  relations: GraphContextEdge[];
  symbols: Array<GraphContextNode & { line: number }>;
};

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function graphProjectKey(baseDir: string): string {
  const resolved = resolve(baseDir);
  const hash = createHash('sha1').update(resolved).digest('hex').slice(0, 12);
  return `project:${basename(resolved)}-${hash}`;
}

function normalizeRelativeSourceFile(baseDir: string, filePath: unknown): string | undefined {
  if (typeof filePath !== 'string') return undefined;
  const trimmed = filePath.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return undefined;
  const resolvedBase = resolve(baseDir);
  const resolvedFile = isAbsolute(trimmed) ? resolve(trimmed) : resolve(resolvedBase, trimmed);
  if (resolvedFile !== resolvedBase && !resolvedFile.startsWith(`${resolvedBase}${sep}`)) return undefined;
  const rel = relative(resolvedBase, resolvedFile);
  return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : undefined;
}

function lineNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return undefined;
  const sourceLocation = value.match(/^L(\d+)$/i);
  if (sourceLocation) return Number(sourceLocation[1]);
  const trailing = value.match(/:(\d+)$/);
  return trailing ? Number(trailing[1]) : undefined;
}

function nodeFromRow(row: Record<string, unknown>): GraphNodeRecord {
  return {
    id: String(row.id),
    label: String(row.label),
    fileType: typeof row.file_type === 'string' ? row.file_type : undefined,
    sourceFile: typeof row.source_file === 'string' ? row.source_file : undefined,
    sourceLocation: typeof row.source_location === 'string' ? row.source_location : undefined,
    community: typeof row.community === 'number' ? Math.trunc(row.community) : undefined,
    normLabel: typeof row.norm_label === 'string' ? row.norm_label : undefined,
    kind: typeof row.kind === 'string' ? row.kind : undefined,
  };
}

function edgeFromRow(row: Record<string, unknown>): GraphEdgeRecord {
  return {
    id: String(row.id),
    source: String(row.source),
    target: String(row.target),
    relation: String(row.relation),
    confidence: typeof row.confidence === 'string' ? row.confidence : undefined,
    confidenceScore: typeof row.confidence_score === 'number' ? row.confidence_score : undefined,
    weight: typeof row.weight === 'number' ? row.weight : undefined,
    sourceFile: typeof row.source_file === 'string' ? row.source_file : undefined,
    sourceLocation: typeof row.source_location === 'string' ? row.source_location : undefined,
  };
}

function graphNode(node: GraphNodeRecord): GraphContextNode {
  return {
    id: node.id,
    label: node.label,
    ...(node.sourceFile ? { sourceFile: node.sourceFile } : {}),
    ...(node.sourceLocation ? { sourceLocation: node.sourceLocation } : {}),
    ...(node.kind ? { kind: node.kind } : {}),
  };
}

function graphEdge(edge: GraphEdgeRecord): GraphContextEdge {
  return {
    source: edge.source,
    target: edge.target,
    relation: edge.relation,
    ...(edge.sourceFile ? { sourceFile: edge.sourceFile } : {}),
    ...(edge.sourceLocation ? { sourceLocation: edge.sourceLocation } : {}),
  };
}

function findFileNode(db: DbLike, projectKey: string, sourceFile: string): GraphContextNode | undefined {
  const row = db.prepare(`
    /* file-search-graph:file-node */
    SELECT * FROM graph_nodes
    WHERE project_key = ?
      AND (id = ? OR source_file = ? OR label = ?)
    ORDER BY
      CASE
        WHEN id = ? THEN 0
        WHEN kind = 'file' THEN 1
        WHEN source_file = ? THEN 2
        ELSE 3
      END,
      id ASC
    LIMIT 1
  `).get(projectKey, `file:${sourceFile}`, sourceFile, sourceFile, `file:${sourceFile}`, sourceFile) as Record<string, unknown> | undefined;
  return row ? graphNode(nodeFromRow(row)) : undefined;
}

function findSymbols(db: DbLike, projectKey: string, sourceFile: string): Array<GraphContextNode & { line: number }> {
  const rows = db.prepare(`
    SELECT * FROM graph_nodes
    WHERE project_key = ?
      AND source_file = ?
      AND id != ?
      AND COALESCE(kind, '') NOT IN ('file', 'import')
    ORDER BY id ASC
  `).all(projectKey, sourceFile, `file:${sourceFile}`) as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const node = nodeFromRow(row);
    const line = lineNumber(node.sourceLocation) ?? lineNumber(node.id);
    return line === undefined ? [] : [{ ...graphNode(node), line }];
  });
}

function findRelations(db: DbLike, projectKey: string, fileNodeId: string, limit: number): GraphContextEdge[] {
  const rows = db.prepare(`
    SELECT * FROM graph_edges
    WHERE project_key = ?
      AND source = ?
      AND relation IN ('contains', 'imports_from')
    ORDER BY relation ASC, target ASC, source_location ASC
    LIMIT ?
  `).all(projectKey, fileNodeId, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => graphEdge(edgeFromRow(row)));
}

function findImportsFrom(db: DbLike, projectKey: string, fileNodeId: string, limit: number): string[] {
  const rows = db.prepare(`
    SELECT COALESCE(target_node.label, edge.target) AS value
    FROM graph_edges edge
    LEFT JOIN graph_nodes target_node
      ON target_node.project_key = edge.project_key
     AND target_node.id = edge.target
    WHERE edge.project_key = ?
      AND edge.source = ?
      AND edge.relation = 'imports_from'
    ORDER BY value ASC
    LIMIT ?
  `).all(projectKey, fileNodeId, limit) as Array<{ value: string }>;
  return rows.map((row) => String(row.value));
}

function nearestSymbolsForHit(symbols: Array<GraphContextNode & { line: number }>, hit: FileSearchGraphHit, limit: number): GraphContextNode[] {
  const startLine = typeof hit.chunk?.startLine === 'number' ? hit.chunk.startLine : undefined;
  const endLine = typeof hit.chunk?.endLine === 'number' ? hit.chunk.endLine : startLine;
  const distance = (line: number): number => {
    if (startLine === undefined || endLine === undefined) return 0;
    if (line >= startLine && line <= endLine) return 0;
    return Math.min(Math.abs(line - startLine), Math.abs(line - endLine));
  };
  return [...symbols]
    .sort((a, b) => distance(a.line) - distance(b.line) || a.line - b.line || a.id.localeCompare(b.id) || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map(({ line: _line, ...node }) => node);
}

function unavailable<T extends FileSearchGraphHit>(hit: T): T & { graph: FileSearchGraphContext } {
  return { ...hit, graph: { available: false } };
}

function buildFileEntry(db: DbLike, projectKey: string, sourceFile: string, limits: Required<FileSearchGraphLimits>): FileGraphEntry | undefined {
  const fileNode = findFileNode(db, projectKey, sourceFile);
  if (!fileNode) return undefined;
  return {
    sourceFile,
    fileNode,
    importsFrom: findImportsFrom(db, projectKey, fileNode.id, limits.importsFrom),
    relations: findRelations(db, projectKey, fileNode.id, limits.relations),
    symbols: findSymbols(db, projectKey, sourceFile),
  };
}

export async function enrichFileSearchHitsWithGraph<T extends FileSearchGraphHit>(
  hits: T[],
  options: FileSearchGraphContextOptions,
): Promise<Array<T & { graph: FileSearchGraphContext }>> {
  const limits = {
    nearestSymbols: positiveLimit(options.limits?.nearestSymbols, DEFAULT_LIMITS.nearestSymbols),
    importsFrom: positiveLimit(options.limits?.importsFrom, DEFAULT_LIMITS.importsFrom),
    relations: positiveLimit(options.limits?.relations, DEFAULT_LIMITS.relations),
  };
  const baseDir = resolve(options.baseDir);
  let ownedGraphDb: GraphDbHandle | undefined;
  let graphDb = options.graphDb;
  try {
    if (!graphDb) {
      graphDb = openGraphDb({ baseDir, dbBaseDir: options.dbBaseDir, readonly: true });
      ownedGraphDb = graphDb;
    }
    const db = graphDb.db;
    const projectKey = graphProjectKey(baseDir);
    const perFile = new Map<string, FileGraphEntry | undefined>();
    return hits.map((hit) => {
      const sourceFile = normalizeRelativeSourceFile(baseDir, hit.chunk?.filePath);
      if (!sourceFile) return unavailable(hit);
      if (!perFile.has(sourceFile)) perFile.set(sourceFile, buildFileEntry(db, projectKey, sourceFile, limits));
      const entry = perFile.get(sourceFile);
      if (!entry) return unavailable(hit);
      return {
        ...hit,
        graph: {
          available: true,
          fileNode: entry.fileNode,
          nearestSymbols: nearestSymbolsForHit(entry.symbols, hit, limits.nearestSymbols),
          importsFrom: entry.importsFrom,
          relations: entry.relations,
        },
      };
    });
  } catch {
    return hits.map((hit) => unavailable(hit));
  } finally {
    ownedGraphDb?.close();
  }
}
